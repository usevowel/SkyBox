import { initSync, vm_init, vm_on_connect, vm_on_message, vm_get_state } from './wasm_glue.js';
import wasmModule from 'worker.wasm';

// Register callout handlers (same as mcf-worker, capture sends for verification)
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

            // ── Test 3: Callout registration ──
            if (typeof globalThis.__skybox_send !== 'function') throw new Error('__skybox_send not registered');
            if (typeof globalThis.__skybox_broadcast !== 'function') throw new Error('__skybox_broadcast not registered');
            if (typeof globalThis.__skybox_close !== 'function') throw new Error('__skybox_close not registered');

            sentMessages.length = 0;
            const requestData = JSON.stringify({
                method: 'GET', path: '/ws', matched_route: null,
                route_params: {}, raw_query: null, query: {},
                cookies: {}, headers: { upgrade: 'websocket' },
                body: [], full_url: 'ws://localhost:8787/ws'
            });

            // ── Test 4: vm_on_connect triggers callout (send) ──
            vm_on_connect('conn-1', requestData);
            if (sentMessages.length === 0) throw new Error('No callout after connect');
            const firstCallout = sentMessages.shift();
            if (firstCallout.type !== 'send') throw new Error('Expected send callout, got ' + firstCallout.type);
            if (!firstCallout.connection_id) throw new Error('Missing connection_id in send callout');
            const welcomeText = JSON.parse(firstCallout.text);
            if (welcomeText.type !== 'state') throw new Error('Expected state in welcome, got ' + welcomeText.type);

            // ── Test 5: vm_on_message triggers callout (broadcast) ──
            sentMessages.length = 0;
            vm_on_message('conn-1', 0, new TextEncoder().encode(JSON.stringify({ action: 'increment' })));
            if (sentMessages.length === 0) throw new Error('No callout after message');
            const msgCallout = sentMessages.shift();
            if (msgCallout.type !== 'broadcast') throw new Error('Expected broadcast callout, got ' + msgCallout.type);
            if (!msgCallout.sender_connection_id) throw new Error('Missing sender_connection_id in broadcast');
            const updateText = JSON.parse(msgCallout.text);
            if (typeof updateText.count !== 'number') throw new Error('Missing count in broadcast');

            // ── Test 6: vm_get_state returns valid JSON ──
            const stateJson = vm_get_state();
            const state = JSON.parse(stateJson);
            if (typeof state.count !== 'number') throw new Error('Missing count in persisted state');
            if (state.count !== updateText.count) throw new Error('Persisted state mismatch: ' + state.count + ' vs ' + updateText.count);

            // ── Test 7: Second connection works ──
            sentMessages.length = 0;
            vm_on_connect('conn-2', requestData);
            if (sentMessages.length === 0) throw new Error('No callout after second connect');

            return new Response('OK: all infra tests passed');
        } catch (err) {
            return new Response('Error: ' + (err.message || err) + ' | stack=' + (err.stack || ''), { status: 500 });
        }
    },
};
