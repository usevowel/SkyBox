import { initSync, vm_init, vm_get_state } from './wasm_glue.js';
import wasmModule from 'worker.wasm';

export default {
    async fetch(request, env, ctx) {
        try {
            initSync({ module: wasmModule });

            // Create config JSON
            const configJson = JSON.stringify({
                uri: "/ws",
                listenerClass: "EchoListener",
                listenerState: {},
                handler: "WebSocket.bx"
            });

            // Create minimal chunk bytes (empty valid chunk)
            const chunkBytes = new Uint8Array([0]); // minimal

            vm_init(configJson, chunkBytes);
            const state = vm_get_state();
            return new Response('state: ' + state);
        } catch (err) {
            const msg = String(err?.message ?? err?.toString?.() ?? err);
            const stack = String(err?.stack ?? '');
            return new Response('Error: ' + msg + ' | ' + stack, { status: 500 });
        }
    },
};
