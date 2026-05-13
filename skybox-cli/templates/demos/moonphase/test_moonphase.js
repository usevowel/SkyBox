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
            const rd = JSON.stringify({method:'GET',path:'/ws',matched_route:null,route_params:{},raw_query:null,query:{},cookies:{},headers:{upgrade:'websocket'},body:[],full_url:'ws://localhost:8790/ws'});
            vm_on_connect('c1',rd);
            msgs.length = 0;
            // Test: help
            vm_on_message('c1',0,new TextEncoder().encode('help'));
            const h = JSON.parse(msgs[0].text);
            if (h.type !== 'help') return new Response('FAIL help: '+JSON.stringify(h),{status:500});
            // Test: now
            msgs.length = 0;
            vm_on_message('c1',0,new TextEncoder().encode('now'));
            const r1 = JSON.parse(msgs[0].text);
            if (r1.type !== 'result' || !r1.phaseName) return new Response('FAIL now: '+JSON.stringify(r1),{status:500});
            // Test: list
            msgs.length = 0;
            vm_on_message('c1',0,new TextEncoder().encode('list'));
            const r2 = JSON.parse(msgs[0].text);
            if (r2.phases.length !== 8) return new Response('FAIL list count: '+JSON.stringify(r2),{status:500});
            // Test: unknown
            msgs.length = 0;
            vm_on_message('c1',0,new TextEncoder().encode('unknown'));
            const r3 = JSON.parse(msgs[0].text);
            if (r3.type !== 'error') return new Response('FAIL unknown: '+JSON.stringify(r3),{status:500});
            return new Response('OK: phase='+r1.phaseName+' ill='+r1.illumination+' list='+r2.phases.length);
        } catch(e) { return new Response('Error: '+(e.message||e),{status:500}); }
    },
};
