import { initSync, vm_init, vm_get_state } from './wasm_glue.js';
import wasmModule from 'worker.wasm';

export default {
    async fetch(request, env, ctx) {
        try {
            const exports = initSync({ module: wasmModule });

            const configJson = JSON.stringify({
                uri: '/ws',
                listenerClass: 'EchoListener',
                listenerState: {},
                handler: 'WebSocket.bx'
            });

            // Get the chunk from custom sections (same as what mcf-worker does)
            const chunkSections = WebAssembly.Module.customSections(wasmModule, 'skybox:chunk');
            const chunkBytes = new Uint8Array(chunkSections[0]);
            
            console.log('chunk size:', chunkBytes.length);
            
            // Try vm_init
            vm_init(configJson, chunkBytes);
            console.log('vm_init OK');
            
            const state = vm_get_state();
            return new Response('vm_init OK, state=' + state);
        } catch (err) {
            return new Response('Error: ' + String(err.message ?? err) + ' | stack=' + String(err.stack ?? ''), { status: 500 });
        }
    },
};
