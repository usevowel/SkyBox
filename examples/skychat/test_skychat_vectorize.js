import { initSync, vm_init, vm_on_connect, vm_on_message, vm_get_state, vm_complete_async } from './wasm_glue.js';
import wasmModule from 'worker.wasm';

const sentMessages = [];
const bindingCalls = [];

globalThis.__skybox_send = function(calloutJson) {
    const msg = JSON.parse(calloutJson);
    sentMessages.push({ connection_id: msg.connection_id, text: msg.text });
    return JSON.stringify({ success: true });
};
globalThis.__skybox_broadcast = function() { return JSON.stringify({ success: true }); };
globalThis.__skybox_close = function() { return JSON.stringify({ success: true }); };
globalThis.__skybox_get_section = function(name) {
    const sections = WebAssembly.Module.customSections(wasmModule, name);
    if (sections.length === 0) return null;
    return new Uint8Array(sections[0]);
};

// Mock Vectorize
const mockVectorize = { store: [] };

// Mock D1
const mockD1 = { store: new Map() };

let pendingResolve = null;

globalThis.__skybox_binding_call = function(calloutJson) {
    const msg = JSON.parse(calloutJson);
    bindingCalls.push(msg);

    if (msg.action === 'vectorize_upsert') {
        const vectors = JSON.parse(msg.args.vectors);
        for (const v of vectors) {
            const idx = mockVectorize.store.findIndex(e => e.id === v.id);
            if (idx >= 0) mockVectorize.store[idx] = v;
            else mockVectorize.store.push(v);
        }
        const ar = JSON.stringify([{ async_id: msg.async_id, data: { count: vectors.length } }]);
        if (pendingResolve) pendingResolve();
        pendingResolve = () => vm_complete_async(ar);
        setTimeout(() => { if (pendingResolve) { pendingResolve(); pendingResolve = null; } }, 10);
        return JSON.stringify({ success: true, async_id: msg.async_id });
    }
    if (msg.action === 'vectorize_query') {
        const vector = JSON.parse(msg.args.vector);
        const topK = parseInt(msg.args.topK || '5');
        const results = mockVectorize.store.map(v => {
            const dot = v.values.reduce((s, a, i) => s + a * (vector[i] || 0), 0);
            const mag1 = Math.sqrt(v.values.reduce((s, a) => s + a * a, 0));
            const mag2 = Math.sqrt(vector.reduce((s, a) => s + a * a, 0));
            const cosim = mag1 && mag2 ? dot / (mag1 * mag2) : 0;
            const score = 1 - ((1 - cosim) / 2);
            return { id: v.id, score, values: v.values, metadata: v.metadata || {} };
        });
        results.sort((a, b) => b.score - a.score);
        const data = { count: Math.min(topK, results.length), matches: results.slice(0, topK) };
        const ar = JSON.stringify([{ async_id: msg.async_id, data }]);
        setTimeout(() => vm_complete_async(ar), 10);
        return JSON.stringify({ success: true, async_id: msg.async_id });
    }
    if (msg.action === 'embed') {
        const dims = 4;
        const input = msg.args.input;
        const data = typeof input === 'string'
            ? Array.from({ length: dims }, () => Math.random())
            : input.map(t => Array.from({ length: dims }, () => Math.random()));
        const ar = JSON.stringify([{ async_id: msg.async_id, data }]);
        setTimeout(() => vm_complete_async(ar), 10);
        return JSON.stringify({ success: true, async_id: msg.async_id });
    }
    if (msg.action === 'query') {
        const sql = msg.args.sql;
        const results = [];
        if (sql.includes('COUNT')) {
            results.push({ cnt: mockD1.store.size });
        } else if (sql.includes('SELECT')) {
            for (const [id, row] of mockD1.store.entries()) {
                results.push({ id, text: row.text, metadata: row.metadata || '{}' });
            }
        }
        const ar = JSON.stringify([{ async_id: msg.async_id, data: results }]);
        setTimeout(() => vm_complete_async(ar), 10);
        return JSON.stringify({ success: true, async_id: msg.async_id });
    }
    if (msg.action === 'execute') {
        const sql = msg.args.sql || '';
        const params = msg.args.params || [];
        if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) {
            // no-op for schema
        } else if (sql.includes('INSERT') && params.length >= 2) {
            mockD1.store.set(params[0], { text: params[1], metadata: params[2] || '{}' });
        }
        const ar = JSON.stringify([{ async_id: msg.async_id, data: 1 }]);
        setTimeout(() => vm_complete_async(ar), 10);
        return JSON.stringify({ success: true, async_id: msg.async_id });
    }
    return JSON.stringify({ success: false, error: `Unknown action: ${msg.action}` });
};

export default {
    async fetch(request, env, ctx) {
        try {
            initSync({ module: wasmModule });

            const configBytes = WebAssembly.Module.customSections(wasmModule, 'skybox:ws_config')[0];
            const chunkBytes = new Uint8Array(WebAssembly.Module.customSections(wasmModule, 'skybox:chunk')[0]);
            const configJson = new TextDecoder().decode(configBytes);

            vm_init(configJson, chunkBytes);

            const requestData = JSON.stringify({
                method: 'GET', path: '/ws', matched_route: null,
                route_params: {}, raw_query: null, query: {},
                cookies: {}, headers: { upgrade: 'websocket' },
                body: "", full_url: 'ws://localhost:8787/ws'
            });

            // Connect and seed
            sentMessages.length = 0;
            bindingCalls.length = 0;
            vm_on_connect('user-1', requestData);

            // Verify welcome is sent
            const welcomes = sentMessages.filter(m => {
                try { const p = JSON.parse(m.text); return p.type === 'welcome'; }
                catch(_) { return false; }
            });
            if (welcomes.length === 0) throw new Error('No welcome on connect');

            // Verify Vectorize upsert was called (RAG seeding)
            const upserts = bindingCalls.filter(m => m.action === 'vectorize_upsert');
            if (upserts.length === 0) throw new Error('No vectorize upsert during RAG seed');

            // Send a chat message
            sentMessages.length = 0;
            vm_on_message('user-1', 0, new TextEncoder().encode('What is BoxLang?'));

            // Verify RAG context was retrieved
            const rags = sentMessages.filter(m => {
                try { const p = JSON.parse(m.text); return p.type === 'rag_debug'; }
                catch(_) { return false; }
            });
            if (rags.length > 0) {
                const rag = JSON.parse(rags[0].text);
                if (rag.matches === undefined) throw new Error('rag_debug missing matches');
            }

            // Verify Vectorize query was called (RAG retrieval)
            const queries = bindingCalls.filter(m => m.action === 'vectorize_query');
            if (queries.length === 0) throw new Error('No vectorize query during RAG retrieval');

            return new Response('OK: All skychat Vectorize RAG tests passed');
        } catch (err) {
            return new Response('FAIL: ' + err.message + '\n' + (err.stack || ''), { status: 500 });
        }
    }
};
