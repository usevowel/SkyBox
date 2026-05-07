import { initSync, vm_init, vm_on_connect, vm_on_message, vm_get_state } from './wasm_glue.js';
import wasmModule from 'worker.wasm';
const sentMessages = [];
globalThis.__skybox_send = function(c) { const m = JSON.parse(c); sentMessages.push({t:m.type,text:m.text}); return JSON.stringify({success:true}); };
globalThis.__skybox_broadcast = function(c) { return JSON.stringify({success:true}); };
globalThis.__skybox_close = function(c) { return JSON.stringify({success:true}); };
export default {
    async fetch(request, env, ctx) {
        try {
            const x = initSync({module:wasmModule});
            const cs = WebAssembly.Module.customSections(wasmModule,'skybox:ws_config');
            const ck = WebAssembly.Module.customSections(wasmModule,'skybox:chunk');
            vm_init(new TextDecoder().decode(cs[0]), new Uint8Array(ck[0]));
            const rd = JSON.stringify({method:'GET',path:'/ws',matched_route:null,route_params:{},raw_query:null,query:{},cookies:{},headers:{upgrade:'websocket'},body:[],full_url:'ws://localhost:8791/ws'});
            vm_on_connect('c1',rd);
            // Test: "toint MMXXV"
            sentMessages.length = 0;
            vm_on_message('c1',0,new TextEncoder().encode('toint MMXXV'));
            const r1 = JSON.parse(sentMessages[0].text);
            if (r1.output !== 2025) return new Response('FAIL toint: ' + JSON.stringify(r1),{status:500});
            // Test: "sort III IX V II"
            sentMessages.length = 0;
            vm_on_message('c1',0,new TextEncoder().encode('sort III IX V II'));
            const r2 = JSON.parse(sentMessages[0].text);
            if (r2.output[0] !== 'II' || r2.output[3] !== 'IX') return new Response('FAIL sort: ' + JSON.stringify(r2),{status:500});
            return new Response('OK: toint=2025, sort=II,III,IV,IX');
        } catch(e) { return new Response('Error: '+(e.message||e),{status:500}); }
    },
};
