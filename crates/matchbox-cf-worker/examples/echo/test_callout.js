import { initSync, vm_init, vm_on_connect, vm_get_state } from './wasm_glue.js';
import wasmModule from 'worker.wasm';

// Register callout handlers (same as mcf-worker)
globalThis.__skybox_send = function(calloutJson) {
    console.log('__skybox_send called:', calloutJson);
    return JSON.stringify({ success: true });
};
globalThis.__skybox_broadcast = function(calloutJson) {
    console.log('__skybox_broadcast called:', calloutJson);
    return JSON.stringify({ success: true });
};
globalThis.__skybox_close = function(calloutJson) {
    console.log('__skybox_close called:', calloutJson);
    return JSON.stringify({ success: true });
};

export default {
    async fetch(request, env, ctx) {
        try {
            const exports = initSync({ module: wasmModule });

            const configSections = WebAssembly.Module.customSections(wasmModule, 'skybox:ws_config');
            const configJson = new TextDecoder().decode(configSections[0]);
            
            const chunkSections = WebAssembly.Module.customSections(wasmModule, 'skybox:chunk');
            const chunkBytes = new Uint8Array(chunkSections[0]);

            vm_init(configJson, chunkBytes);

            // Simulate a connection
            const requestData = JSON.stringify({ method: 'GET', path: '/ws', matched_route: null, route_params: {}, raw_query: null, query: {}, cookies: {}, headers: { upgrade: 'websocket' }, body: [], full_url: 'ws://localhost:8787/ws' });
            vm_on_connect('test-conn-1', requestData);
            
            const state = vm_get_state();
            return new Response('vm_on_connect OK, state=' + state);
        } catch (err) {
            return new Response('Error: ' + String(err.message ?? err) + ' | stack=' + String(err.stack ?? ''), { status: 500 });
        }
    },
};
