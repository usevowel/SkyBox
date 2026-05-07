import { initSync, vm_init, vm_on_connect, vm_on_message } from './wasm_glue.js';
import wasmModule from 'worker.wasm';
const msgs = [];
globalThis.__skybox_send = function(c) { const m = JSON.parse(c); msgs.push({t:m.type,text:m.text}); return JSON.stringify({success:true}); };
globalThis.__skybox_broadcast = function(c) { return JSON.stringify({success:true}); };
globalThis.__skybox_close = function(c) { return JSON.stringify({success:true}); };
export default {
    async fetch(request, env, ctx) {
        try {
            initSync({module:wasmModule});
            const cs = WebAssembly.Module.customSections(wasmModule,'skybox:ws_config');
            const ck = WebAssembly.Module.customSections(wasmModule,'skybox:chunk');
            vm_init(new TextDecoder().decode(cs[0]), new Uint8Array(ck[0]));
            const rd = JSON.stringify({method:'GET',path:'/ws',matched_route:null,route_params:{},raw_query:null,query:{},cookies:{},headers:{upgrade:'websocket'},body:[],full_url:'ws://localhost:8792/ws'});
            vm_on_connect('c1',rd);
            msgs.length = 0;
            vm_on_message('c1',0,new TextEncoder().encode('validate {"a":1,"b":"hello"}'));
            const r1 = JSON.parse(msgs[0].text);
            if (!r1.valid) return new Response('FAIL validate: '+JSON.stringify(r1),{status:500});
            msgs.length = 0;
            vm_on_message('c1',0,new TextEncoder().encode('validate not-json'));
            const r2 = JSON.parse(msgs[0].text);
            if (r2.valid) return new Response('FAIL invalid: '+JSON.stringify(r2),{status:500});
            return new Response('OK: valid='+r1.valid+' invalid='+r2.valid);
        } catch(e) { return new Response('Error: '+(e.message||e),{status:500}); }
    },
};
