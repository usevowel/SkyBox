import { initSync, vm_init, vm_on_connect, vm_on_message } from './wasm_glue.js';
import wasmModule from 'worker.wasm';
const msgs = [];
globalThis.__skybox_send = function(c) { const m = JSON.parse(c); msgs.push({t:m.type,text:m.text}); return JSON.stringify({success:true}); };
globalThis.__skybox_broadcast = function(c) { const m = JSON.parse(c); msgs.push({t:m.type,text:m.text}); return JSON.stringify({success:true}); };
globalThis.__skybox_close = function(c) { return JSON.stringify({success:true}); };
export default {
    async fetch(request, env, ctx) {
        try {
            initSync({module:wasmModule});
            const cs = WebAssembly.Module.customSections(wasmModule,'skybox:ws_config');
            const ck = WebAssembly.Module.customSections(wasmModule,'skybox:chunk');
            vm_init(new TextDecoder().decode(cs[0]), new Uint8Array(ck[0]));
            const rd = JSON.stringify({method:'GET',path:'/ws',matched_route:null,route_params:{},raw_query:null,query:{},cookies:{},headers:{upgrade:'websocket'},body:[],full_url:'ws://localhost:8794/ws'});
            vm_on_connect('c1',rd);
            msgs.length = 0;
            // Add a todo
            vm_on_message('c1',0,new TextEncoder().encode('add Buy milk'));
            const added = JSON.parse(msgs[0].text);
            if (added.type !== 'added') return new Response('FAIL add: '+JSON.stringify(added),{status:500});
            // List
            msgs.length = 0;
            vm_on_message('c1',0,new TextEncoder().encode('list'));
            const listed = JSON.parse(msgs[0].text);
            if (listed.total !== 1) return new Response('FAIL list: '+JSON.stringify(listed),{status:500});
            // Done
            msgs.length = 0;
            vm_on_message('c1',0,new TextEncoder().encode('done 1'));
            const done = JSON.parse(msgs[0].text);
            if (done.type !== 'updated') return new Response('FAIL done: '+JSON.stringify(done),{status:500});
            return new Response('OK: add+list+done passed');
        } catch(e) { return new Response('Error: '+(e.message||e),{status:500}); }
    },
};
