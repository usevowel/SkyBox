import { initSync } from './wasm_glue.js';
import wasmModule from 'worker.wasm';

export default {
    async fetch(request, env, ctx) {
        try {
            const exports = initSync({ module: wasmModule });
            const funcs = Object.keys(exports).filter(k => k.startsWith('vm_'));
            return new Response('initSync OK, funcs: ' + funcs.join(','));
        } catch (err) {
            return new Response('Error: ' + String(err.message ?? err) + ' | ' + String(err.stack ?? ''), { status: 500 });
        }
    },
};
