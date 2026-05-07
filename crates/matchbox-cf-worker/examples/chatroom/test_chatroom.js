import { initSync, vm_init, vm_on_connect, vm_on_message, vm_on_close, vm_get_state } from './wasm_glue.js';
import wasmModule from 'worker.wasm';

const sentMessages = [];
globalThis.__skybox_send = function(calloutJson) {
    const msg = JSON.parse(calloutJson);
    sentMessages.push({ type: msg.type, connection_id: msg.connection_id, text: msg.text });
    return JSON.stringify({ success: true });
};
globalThis.__skybox_broadcast = function(calloutJson) {
    const msg = JSON.parse(calloutJson);
    sentMessages.push({ type: msg.type, sender_connection_id: msg.sender_connection_id, text: msg.text });
    return JSON.stringify({ success: true });
};
globalThis.__skybox_close = function(calloutJson) {
    return JSON.stringify({ success: true });
};

export default {
    async fetch(request, env, ctx) {
        try {
            const exports = initSync({ module: wasmModule });

            // ── Test 1: Custom sections exist ──
            const configSections = WebAssembly.Module.customSections(wasmModule, 'skybox:ws_config');
            const chunkSections = WebAssembly.Module.customSections(wasmModule, 'skybox:chunk');
            if (configSections.length === 0) throw new Error('Missing skybox:ws_config');
            if (chunkSections.length === 0) throw new Error('Missing skybox:chunk');

            const configJson = new TextDecoder().decode(configSections[0]);
            const chunkBytes = new Uint8Array(chunkSections[0]);

            // ── Test 2: vm_init succeeds ──
            vm_init(configJson, chunkBytes);
            sentMessages.length = 0;

            const requestData = JSON.stringify({
                method: 'GET', path: '/ws', matched_route: null,
                route_params: {}, raw_query: null, query: {},
                cookies: {}, headers: { upgrade: 'websocket' },
                body: [], full_url: 'ws://localhost:8787/ws'
            });

            // ── Test 3: First connect → send (welcome) + broadcast (join) ──
            vm_on_connect('user-1', requestData);
            if (sentMessages.length < 2) throw new Error('Expected 2+ callouts on connect, got ' + sentMessages.length);

            const sends = sentMessages.filter(m => m.type === 'send');
            const broadcasts = sentMessages.filter(m => m.type === 'broadcast');
            if (sends.length === 0) throw new Error('Expected at least one send on connect');
            if (broadcasts.length === 0) throw new Error('Expected at least one broadcast on connect');

            const welcomeText = JSON.parse(sends[0].text);
            if (welcomeText.type !== 'welcome') throw new Error('Expected welcome type, got ' + welcomeText.type);

            // ── Test 4: Second connect → more broadcasts ──
            sentMessages.length = 0;
            vm_on_connect('user-2', requestData);
            if (sentMessages.length === 0) throw new Error('No callouts after second connect');

            // ── Test 5: On message → broadcast ──
            sentMessages.length = 0;
            vm_on_message('user-1', 0, new TextEncoder().encode(JSON.stringify({ type: 'text', body: 'Hello' })));
            if (sentMessages.length === 0) throw new Error('No callouts after message');

            // ── Test 6: On close → broadcast ──
            sentMessages.length = 0;
            vm_on_close('user-1');
            if (sentMessages.length === 0) throw new Error('No callouts after close');

            // ── Test 7: vm_get_state works ──
            const stateJson = vm_get_state();
            const state = JSON.parse(stateJson);
            // Verify state is valid (actual values depend on BoxLang WASM behavior)

            return new Response('OK: all infra tests passed, state keys=' + Object.keys(state).join(','));
        } catch (err) {
            return new Response('Error: ' + (err.message || err) + ' | stack=' + (err.stack || ''), { status: 500 });
        }
    },
};
