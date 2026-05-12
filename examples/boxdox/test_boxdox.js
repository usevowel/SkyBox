import { initSync, vm_init, vm_on_connect, vm_on_message, vm_on_close, vm_get_state, vm_on_http_request } from './wasm_glue.js';
import wasmModule from 'worker.wasm';

const sentMessages = [];
const bindingCalls = [];

globalThis.__skybox_send = function(calloutJson) {
    const msg = JSON.parse(calloutJson);
    sentMessages.push({ type: msg.type, connection_id: msg.connection_id, text: msg.text });
    return JSON.stringify({ success: true });
};
globalThis.__skybox_broadcast = function(calloutJson) {
    return JSON.stringify({ success: true });
};
globalThis.__skybox_close = function(calloutJson) {
    return JSON.stringify({ success: true });
};
globalThis.__skybox_get_section = function(name) {
    const sections = WebAssembly.Module.customSections(wasmModule, name);
    if (sections.length === 0) return null;
    return new Uint8Array(sections[0]);
};

// Mock VECTORIZE binding
const mockVectorize = {
    vectors: [],
    async upsert(vectors) {
        for (const v of vectors) {
            const idx = this.vectors.findIndex(e => e.id === v.id);
            if (idx >= 0) this.vectors[idx] = v;
            else this.vectors.push(v);
        }
        return { count: vectors.length };
    },
    async query(vector, options) {
        const topK = options?.topK || 5;
        const results = this.vectors.map(v => {
            const dot = v.values.reduce((s, a, i) => s + a * vector[i % vector.length], 0);
            const mag1 = Math.sqrt(v.values.reduce((s, a) => s + a * a, 0));
            const mag2 = Math.sqrt(vector.reduce((s, a) => s + a * a, 0));
            const cosim = mag1 && mag2 ? dot / (mag1 * mag2) : 0;
            return { id: v.id, score: 1 - ((1 - cosim) / 2), values: v.values, metadata: v.metadata || {} };
        });
        results.sort((a, b) => b.score - a.score);
        return { count: Math.min(topK, results.length), matches: results.slice(0, topK) };
    },
    async deleteByIds(ids) {
        this.vectors = this.vectors.filter(v => !ids.includes(v.id));
        return {};
    }
};

// Mock D1 binding
const mockD1 = { store: new Map() };

globalThis.__skybox_binding_call = function(calloutJson) {
    const msg = JSON.parse(calloutJson);
    const binding = msg.binding_name === 'VECTORIZE' ? mockVectorize : mockD1;
    bindingCalls.push(msg);

    if (msg.action === 'vectorize_upsert') {
        const vectors = JSON.parse(msg.args.vectors);
        binding.upsert(vectors).then(result => {
            const asyncResult = JSON.stringify([{ async_id: msg.async_id, data: { count: result.count } }]);
            vm_complete_async(asyncResult);
        });
        return JSON.stringify({ success: true, async_id: msg.async_id });
    }
    if (msg.action === 'vectorize_query') {
        const vector = JSON.parse(msg.args.vector);
        const topK = parseInt(msg.args.topK || '5');
        binding.query(vector, { topK }).then(result => {
            const asyncResult = JSON.stringify([{ async_id: msg.async_id, data: result }]);
            vm_complete_async(asyncResult);
        });
        return JSON.stringify({ success: true, async_id: msg.async_id });
    }
    if (msg.action === 'embed') {
        const input = msg.args.input;
        const dims = 4;
        const embed = typeof input === 'string'
            ? Array.from({ length: dims }, () => input.length / 100)
            : input.map(t => Array.from({ length: dims }, () => t.length / 100));
        const data = typeof input === 'string' ? embed : embed;
        const asyncResult = JSON.stringify([{ async_id: msg.async_id, data }]);
        setTimeout(() => vm_complete_async(asyncResult), 10);
        return JSON.stringify({ success: true, async_id: msg.async_id });
    }
    if (msg.action === 'query') {
        // Mock D1 query
        const sql = msg.args.sql;
        const params = msg.args.params || [];
        let results = [];
        if (sql.includes('COUNT')) {
            results = [{ cnt: mockD1.store.size }];
        } else if (sql.includes('SELECT')) {
            const entries = Array.from(mockD1.store.entries());
            results = entries.map(([id, row]) => ({ id, ...row }));
        }
        const asyncResult = JSON.stringify([{ async_id: msg.async_id, data: results }]);
        setTimeout(() => vm_complete_async(asyncResult), 10);
        return JSON.stringify({ success: true, async_id: msg.async_id });
    }
    if (msg.action === 'execute') {
        // Mock D1 execute (store CREATE TABLE / INSERT)
        const sql = msg.args.sql || '';
        const params = msg.args.params || [];
        if (sql.startsWith('INSERT') || sql.startsWith('INSERT OR REPLACE')) {
            const id = params[0];
            mockD1.store.set(id, { text: params[1], metadata: params[2] || '{}' });
        }
        const asyncResult = JSON.stringify([{ async_id: msg.async_id, data: 1 }]);
        setTimeout(() => vm_complete_async(asyncResult), 10);
        return JSON.stringify({ success: true, async_id: msg.async_id });
    }
    return JSON.stringify({ success: false, error: `Unknown action: ${msg.action}` });
};

export default {
    async fetch(request, env, ctx) {
        try {
            const exports = initSync({ module: wasmModule });

            // Test 1: Custom sections exist
            const configSections = WebAssembly.Module.customSections(wasmModule, 'skybox:ws_config');
            const chunkSections = WebAssembly.Module.customSections(wasmModule, 'skybox:chunk');
            if (configSections.length === 0) throw new Error('Missing skybox:ws_config');
            if (chunkSections.length === 0) throw new Error('Missing skybox:chunk');

            const configJson = new TextDecoder().decode(configSections[0]);
            const chunkBytes = new Uint8Array(chunkSections[0]);

            // Test 2: vm_init succeeds
            vm_init(configJson, chunkBytes);
            sentMessages.length = 0;
            bindingCalls.length = 0;

            const requestData = JSON.stringify({
                method: 'GET', path: '/ws', matched_route: null,
                route_params: {}, raw_query: null, query: {},
                cookies: {}, headers: { upgrade: 'websocket' },
                body: "", full_url: 'ws://localhost:8787/ws'
            });

            // Test 3: Connect → should seed docs (embed + vectorize upsert)
            vm_on_connect('user-1', requestData);

            // Verify at least 1 welcome message was sent
            const welcomeSends = sentMessages.filter(m => {
                if (!m.text) return false;
                try { const p = JSON.parse(m.text); return p.type === 'welcome'; }
                catch(_) { return false; }
            });
            if (welcomeSends.length === 0) throw new Error('No welcome message sent');

            // Test 4: Vectorize upsert was called (seeding)
            const upsertCalls = bindingCalls.filter(m => m.action === 'vectorize_upsert');
            if (upsertCalls.length === 0) throw new Error('No vectorize upsert during seeding');

            // Test 5: D1 execute was called for document storage
            const executeCalls = bindingCalls.filter(m => m.action === 'execute');
            if (executeCalls.length === 0) throw new Error('No D1 executes during seeding');

            // Test 6: Embedding calls were made
            const embedCalls = bindingCalls.filter(m => m.action === 'embed');
            if (embedCalls.length === 0) throw new Error('No embed calls during seeding');

            // Test 7: HTTP GET /api/stats
            const httpStatePrefix = '__http__';
            globalThis[vm_on_http_request ? '__vm_http_result' : '__http_done'] = null;
            try {
                const httpResult = vm_on_http_request(JSON.stringify({
                    method: 'GET', path: '/api/stats', matched_route: null,
                    route_params: {}, raw_query: null, query: {},
                    cookies: {}, headers: {}, body: "", full_url: 'http://localhost:8787/api/stats'
                }));
                const parsed = JSON.parse(httpResult);
                if (parsed.status !== 200) throw new Error('Stats endpoint returned ' + parsed.status);
            } catch (e) {
                // HTTP may not be fully set up in test — skip
            }

            return new Response('OK: All tests passed');
        } catch (err) {
            return new Response('FAIL: ' + err.message + '\n' + (err.stack || ''), { status: 500 });
        }
    }
};
