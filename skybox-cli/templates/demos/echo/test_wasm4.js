import { initSync, vm_init, vm_get_state } from './wasm_glue.js';
import wasmModule from 'worker.wasm';

export default {
    async fetch(request, env, ctx) {
        try {
            const exports = initSync({ module: wasmModule });

            // Simple test: call vm_get_state WITHOUT vm_init first
            // This should fail gracefully
            try {
                const state = vm_get_state();
                return new Response('got state: ' + state);
            } catch (err) {
                return new Response('vm_get_state failed (expected): ' + String(err.message ?? err));
            }
        } catch (err) {
            return new Response('Error: ' + String(err.message ?? err) + ' | ' + String(err.stack ?? ''), { status: 500 });
        }
    },
};
