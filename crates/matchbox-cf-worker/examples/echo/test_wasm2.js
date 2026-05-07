import wasmModule from 'worker.wasm';

export default {
    async fetch(request, env, ctx) {
        try {
            // Try to use customSections directly (without wasm-bindgen)
            const sections = WebAssembly.Module.customSections(wasmModule, 'skybox:chunk');
            const configSections = WebAssembly.Module.customSections(wasmModule, 'skybox:ws_config');
            
            let msg = 'OK: chunk=' + sections.length + ' config=' + configSections.length;
            
            // Try to instantiate directly
            const instance = await WebAssembly.instantiate(wasmModule);
            msg += ' inst=' + Object.keys(instance.exports).filter(k => k.startsWith('vm_')).join(',');
            
            return new Response(msg);
        } catch (err) {
            return new Response('Error: ' + err.message + ' | ' + (err.stack || ''), { status: 500 });
        }
    },
};
