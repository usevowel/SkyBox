// ═══════════════════════════════════════════════════════════════════════
// mcf-worker.js — MatchBox Cloudflare Workers + Durable Objects Shell
//
// This file provides two exports:
//   1. `default { fetch }` — the stateless Worker entry point that
//      validates and upgrades WebSocket requests, then proxies to the DO.
//   2. `MatchBoxWebSocketDO` — the Durable Object class that hosts the
//      BoxLang VM and manages WebSocket connections via the Hibernation API.
//
// The WASM is loaded via wasm-bindgen's initSync() because workerd imports
// it as a CompiledWasm (WebAssembly.Module), not an instantiated instance.
// ═══════════════════════════════════════════════════════════════════════

// wasm-bindgen generated JS glue — exports initSync + wrapped BIFs
// that handle JS↔WASM string/pointer conversion.
import {
    initSync as initWasmBindgen,
    vm_init,
    vm_set_state,
    vm_get_state,
    vm_register_connection,
    vm_on_connect,
    vm_on_message,
    vm_on_close,
    vm_on_http_request,
    vm_complete_async,
} from './wasm_glue.js';

// In workerd, importing a .wasm file as a CompiledWasm module gives
// a WebAssembly.Module object (NOT a function to call).
import wasmModule from './worker.wasm';

// ── Globals ──────────────────────────────────────────────────────────

/** @type {WebAssembly.Module | null} */
let wasmCompiledModule = null;
/** @type {boolean} */
let wasmInitialized = false;
/** @type {Promise<void> | null} */
let wasmInitPromise = null;

/**
 * Read a WASM custom section as a Uint8Array.
 * customSections() takes a WebAssembly.Module, not an instance.
 */
function getWasmSection(name) {
    if (!wasmCompiledModule) return null;
    const sections = WebAssembly.Module.customSections(wasmCompiledModule, name);
    if (sections.length === 0) return null;
    return new Uint8Array(sections[0]);
}

// Register the section reader on the global so the Rust WASM code can call it.
globalThis.__skybox_get_section = getWasmSection;

// ── Callout handlers ────────────────────────────────────────────────
// These are called by the Rust VM via the WASM callout bridge.
// Serialized field names use snake_case to match Rust's serde defaults.

globalThis.__skybox_send = function (calloutJson) {
    try {
        const msg = JSON.parse(calloutJson);
        const doInstance = currentDO;
        if (!doInstance) {
            return JSON.stringify({ success: false, error: 'No active DO context' });
        }
        doInstance.sendToWS(msg.connection_id, msg.text, msg.binary);
        return JSON.stringify({ success: true });
    } catch (err) {
        return JSON.stringify({ success: false, error: err.message });
    }
};

globalThis.__skybox_broadcast = function (calloutJson) {
    try {
        const msg = JSON.parse(calloutJson);
        const doInstance = currentDO;
        if (!doInstance) {
            return JSON.stringify({ success: false, error: 'No active DO context' });
        }
        doInstance.broadcastToAll(msg.sender_connection_id, msg.text, msg.binary);
        return JSON.stringify({ success: true });
    } catch (err) {
        return JSON.stringify({ success: false, error: err.message });
    }
};

globalThis.__skybox_close = function (calloutJson) {
    try {
        const msg = JSON.parse(calloutJson);
        const doInstance = currentDO;
        if (!doInstance) {
            return JSON.stringify({ success: false, error: 'No active DO context' });
        }
        doInstance.closeWS(msg.connection_id, msg.code, msg.reason);
        return JSON.stringify({ success: true });
    } catch (err) {
        return JSON.stringify({ success: false, error: err.message });
    }
};

/** Tracks the currently active DO instance for callout routing. */
let currentDO = null;

// ── Binding Call Handler ─────────────────────────────────────────

globalThis.__skybox_binding_call = function (calloutJson) {
    try {
        const msg = JSON.parse(calloutJson);
        const doInstance = currentDO;
        if (!doInstance) {
            return JSON.stringify({ success: false, error: 'No active DO context' });
        }
        return doInstance.handleBindingCall(msg);
    } catch (err) {
        return JSON.stringify({ success: false, error: err.message });
    }
};

// ── Worker Entry Point ──────────────────────────────────────────────

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // Health check endpoint
        if (url.pathname === '/__health') {
            return new Response('OK', { status: 200 });
        }

        // Static assets via [assets] binding — served at edge,
        // but if $ASSETS_BINDING is set, fall through to Worker.
        if (url.pathname.startsWith('/assets/') && typeof env.ASSETS !== 'undefined') {
            return env.ASSETS.fetch(request);
        }

        // Route WebSocket upgrades AND web UI requests to the DO
        const isWebSocket = request.headers.get('Upgrade') === 'websocket';
        const isWebUI = request.method === 'GET' && (url.pathname === '/' || url.pathname === '');

        if (isWebSocket || isWebUI) {
            const doId = env.WEBSOCKET_DO.idFromName('default');
            const stub = env.WEBSOCKET_DO.get(doId);
            return stub.fetch(request);
        }

        return new Response('Not Found', {
            status: 404,
            headers: { 'Content-Type': 'text/plain' },
        });
    },
};

// ── Durable Object ──────────────────────────────────────────────────

export class MatchBoxWebSocketDO {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
        this.initialized = false;
        this.pendingAsyncOps = new Map();
        this.nextAsyncOpId = 1;

        this.ctx.blockConcurrencyWhile(async () => {
            await this.initWasm();
            await this.restoreState();
            this.initialized = true;
        });
    }

    async initWasm() {
        if (wasmInitialized) return;

        if (!wasmInitPromise) {
            wasmInitPromise = (async () => {
                wasmCompiledModule = wasmModule;

                // Initialize via wasm-bindgen's initSync
                initWasmBindgen({ module: wasmCompiledModule });
                wasmInitialized = true;

                // Read config and chunk from WASM custom sections
                const configBytes = getWasmSection('skybox:ws_config');
                if (!configBytes) {
                    throw new Error('Missing skybox:ws_config custom section');
                }
                const configJson = new TextDecoder().decode(configBytes);

                const rawChunk = getWasmSection('skybox:chunk');
                if (!rawChunk) {
                    throw new Error('Missing skybox:chunk custom section');
                }
                // Make a detached copy to avoid any ArrayBuffer view issues
                const chunkBytes = new Uint8Array(rawChunk);

                // Initialize the BoxLang VM with the compiled listener
                vm_init(configJson, chunkBytes);
            })();
        }
        await wasmInitPromise;
    }

    async restoreState() {
        const listenerState = await this.ctx.storage.get('listener_state');
        if (listenerState) {
            vm_set_state(JSON.stringify(listenerState));
        }

        const connections = (await this.ctx.storage.get('connections')) || {};

        for (const ws of this.ctx.getWebSockets()) {
            const att = ws.deserializeAttachment();
            if (att && connections[att.id]) {
                vm_register_connection(
                    att.id,
                    JSON.stringify(connections[att.id]),
                );
            }
        }

        if (this.ctx.setWebSocketAutoResponse) {
            this.ctx.setWebSocketAutoResponse(
                new WebSocketRequestResponsePair('ping', 'pong'),
            );
        }
    }

    async fetch(request) {
        // WebSocket upgrade → existing WS handler
        if (request.headers.get('Upgrade') === 'websocket') {
            return this.handleWebSocketUpgrade(request);
        }

        // HTTP request → serve via BoxLang onHttpGet
        return this.handleHttpRequest(request);
    }

    async handleHttpRequest(request) {
        const url = new URL(request.url);
        const bodyBytes = request.body ? new Uint8Array(await request.arrayBuffer()) : [];
        const requestData = {
            method: request.method,
            path: url.pathname,
            matched_route: null,
            route_params: {},
            raw_query: url.search,
            query: Object.fromEntries(url.searchParams),
            cookies: parseCookies(request.headers.get('Cookie') || ''),
            headers: Object.fromEntries(request.headers),
            body: bodyBytes.length > 0 ? new TextDecoder().decode(bodyBytes) : "",
            full_url: request.url,
        };

        currentDO = this;
        try {
            let resultJson = vm_on_http_request(JSON.stringify(requestData));
            let result = JSON.parse(resultJson);

            // Async pause/resume cycle: the VM may yield for D1/embed/Turso calls
            while (result.__paused__ && result.ops) {
                const asyncResults = [];
                for (const op of result.ops) {
                    const promise = this.pendingAsyncOps.get(op.async_id);
                    if (promise) {
                        this.pendingAsyncOps.delete(op.async_id);
                        try {
                            const data = await promise;
                            asyncResults.push({ async_id: op.async_id, data });
                        } catch (e) {
                            asyncResults.push({ async_id: op.async_id, data: null });
                        }
                    }
                }
                resultJson = vm_complete_async(JSON.stringify(asyncResults));
                result = JSON.parse(resultJson);
            }

            const status = result.status || 200;
            const headers = result.headers || { 'Content-Type': 'text/html; charset=utf-8' };
            const body = result.body || '';

            return new Response(body, { status, headers });
        } catch (err) {
            console.error('HTTP request error:', err);
            return new Response('Internal Server Error', { status: 500 });
        } finally {
            currentDO = null;
        }
    }

    async handleWebSocketUpgrade(request) {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        const connectionId = crypto.randomUUID();

        const requestData = {
            method: request.method,
            path: new URL(request.url).pathname,
            matched_route: null,
            route_params: {},
            raw_query: new URL(request.url).search,
            query: Object.fromEntries(new URL(request.url).searchParams),
            cookies: parseCookies(request.headers.get('Cookie') || ''),
            headers: Object.fromEntries(request.headers),
            body: "",
            full_url: request.url,
        };

        server.serializeAttachment({ id: connectionId, request: requestData });

        const connections = (await this.ctx.storage.get('connections')) || {};
        connections[connectionId] = requestData;
        await this.ctx.storage.put('connections', connections);

        this.ctx.acceptWebSocket(server);

        currentDO = this;
        try {
            let resultJson = vm_on_connect(
                connectionId,
                JSON.stringify(requestData),
            );
            let result = JSON.parse(resultJson);

            // Async pause/resume cycle: the VM may yield for D1/embed calls
            while (result.__paused__ && result.ops) {
                const asyncResults = [];
                for (const op of result.ops) {
                    const promise = this.pendingAsyncOps.get(op.async_id);
                    if (promise) {
                        this.pendingAsyncOps.delete(op.async_id);
                        try {
                            const data = await promise;
                            asyncResults.push({ async_id: op.async_id, data });
                        } catch (e) {
                            asyncResults.push({ async_id: op.async_id, data: null });
                        }
                    }
                }
                resultJson = vm_complete_async(JSON.stringify(asyncResults));
                result = JSON.parse(resultJson);
            }
        } catch (err) {
            console.error('WebSocket onConnect error:', err);
            try { server.close(1011, 'Internal error'); } catch (_) {}
        } finally {
            currentDO = null;
        }

        return new Response(null, {
            status: 101,
            webSocket: client,
        });
    }

    async webSocketMessage(ws, message) {
        const att = ws.deserializeAttachment();
        if (!att) return;

        const isText = typeof message === 'string';
        const msgBytes = isText
            ? new TextEncoder().encode(message)
            : new Uint8Array(message);

        currentDO = this;
        try {
            let resultJson = vm_on_message(
                att.id,
                isText ? 0 : 1,
                msgBytes,
            );
            let result = JSON.parse(resultJson);

            // Async pause/resume cycle: the VM may yield for D1/embed calls
            while (result.__paused__ && result.ops) {
                const asyncResults = [];
                for (const op of result.ops) {
                    const promise = this.pendingAsyncOps.get(op.async_id);
                    if (promise) {
                        this.pendingAsyncOps.delete(op.async_id);
                        try {
                            const data = await promise;
                            asyncResults.push({ async_id: op.async_id, data });
                        } catch (e) {
                            asyncResults.push({ async_id: op.async_id, data: null });
                        }
                    }
                }
                resultJson = vm_complete_async(JSON.stringify(asyncResults));
                result = JSON.parse(resultJson);
            }

            const newState = vm_get_state();
            await this.ctx.storage.put('listener_state', JSON.parse(newState));
        } catch (err) {
            console.error('WebSocket onMessage error:', err);
            try { ws.close(1011, 'Internal error'); } catch (_) {}
        } finally {
            currentDO = null;
        }
    }

    async webSocketClose(ws, code, reason, wasClean) {
        const att = ws.deserializeAttachment();
        if (!att) return;

        currentDO = this;
        try {
            vm_on_close(att.id);

            const connections = (await this.ctx.storage.get('connections')) || {};
            delete connections[att.id];
            await this.ctx.storage.put('connections', connections);
        } catch (err) {
            console.error('WebSocket onClose error:', err);
        } finally {
            currentDO = null;
        }
    }

    async webSocketError(ws, error) {
        console.error('WebSocket error:', error);
        const att = ws.deserializeAttachment();
        if (att) {
            await this.webSocketClose(ws, 1011, error.message, false);
        }
    }

    // ── Callout implementations ──

    sendToWS(connectionId, text, binary) {
        for (const ws of this.ctx.getWebSockets()) {
            const att = ws.deserializeAttachment();
            if (att && att.id === connectionId) {
                try {
                    if (text !== null) {
                        ws.send(text);
                    } else if (binary !== null) {
                        ws.send(binary);
                    }
                } catch (err) {
                    console.error('send error:', err);
                }
                return;
            }
        }
    }

    broadcastToAll(senderConnectionId, text, binary) {
        for (const ws of this.ctx.getWebSockets()) {
            const att = ws.deserializeAttachment();
            if (att && att.id !== senderConnectionId) {
                try {
                    if (text !== null) {
                        ws.send(text);
                    } else if (binary !== null) {
                        ws.send(binary);
                    }
                } catch (err) {
                    console.error('broadcast error:', err);
                }
            }
        }
    }

    closeWS(connectionId, code, reason) {
        for (const ws of this.ctx.getWebSockets()) {
            const att = ws.deserializeAttachment();
            if (att && att.id === connectionId) {
                try {
                    ws.close(code, reason);
                } catch (err) {
                    console.error('close error:', err);
                }
                return;
            }
        }
    }

    // ── Binding Call Dispatch ────────────────────────────────────

    handleBindingCall(msg) {
        const binding = this.env[msg.binding_name];

        switch (msg.action) {
            case 'query':     return this.handleD1Query(msg, binding);
            case 'execute':   return this.handleD1Execute(msg, binding);
            case 'embed':     return this.handleEmbed(msg);
            case 'turso_query':   return this.handleTursoQuery(msg);
            case 'turso_execute': return this.handleTursoExecute(msg);
            case 'openrouter':    return JSON.stringify(this.handleOpenRouter(msg, binding));
            default:
                return JSON.stringify({ success: false, error: `Unknown action: ${msg.action}` });
        }
    }

    handleD1Query(msg, binding) {
        const async_id = msg.async_id;
        const sql = msg.args.sql;
        const params = msg.args.params || [];
        const promise = binding.prepare(sql).bind(...params).all();
        this.pendingAsyncOps.set(async_id, promise.then(r => r.results));
        return JSON.stringify({ success: true, async_id });
    }

    handleD1Execute(msg, binding) {
        const async_id = msg.async_id;
        const sql = msg.args.sql;
        const params = msg.args.params || [];
        const promise = binding.prepare(sql).bind(...params).run();
        this.pendingAsyncOps.set(async_id, promise.then(r => r.meta.changes ?? r.meta.changed_db ?? 0));
        return JSON.stringify({ success: true, async_id });
    }

    async handleEmbed(msg) {
        const async_id = msg.async_id;
        if (!this.env.AI) {
            return JSON.stringify({ success: false, error: 'AI binding not configured', async_id });
        }
        try {
            const model = msg.args.options?.model || '@cf/baai/bge-base-en-v1.5';
            const input = msg.args.input;
            const response = await this.env.AI.run(model, { text: input });
            const data = response?.data || response?.result?.data || [];
            this.pendingAsyncOps.set(async_id, Promise.resolve(data));
        } catch (err) {
            this.pendingAsyncOps.set(async_id, Promise.reject(err.message));
        }
        return JSON.stringify({ success: true, async_id });
    }

    async handleTursoQuery(msg) {
        const async_id = msg.async_id;
        const sql = msg.args.sql;
        const params = msg.args.params || [];
        try {
            const response = await this.tursoFetch(sql, params);
            const rows = response?.results?.[0]?.response?.result?.rows || response?.rows || [];
            this.pendingAsyncOps.set(async_id, Promise.resolve(rows));
        } catch (err) {
            this.pendingAsyncOps.set(async_id, Promise.reject(err.message));
        }
        return JSON.stringify({ success: true, async_id });
    }

    async handleTursoExecute(msg) {
        const async_id = msg.async_id;
        const sql = msg.args.sql;
        const params = msg.args.params || [];
        try {
            const response = await this.tursoFetch(sql, params);
            const affected = response?.results?.[0]?.response?.result?.affected_count ||
                response?.affected_count || 0;
            this.pendingAsyncOps.set(async_id, Promise.resolve(affected));
        } catch (err) {
            this.pendingAsyncOps.set(async_id, Promise.reject(err.message));
        }
        return JSON.stringify({ success: true, async_id });
    }

    async tursoFetch(sql, params) {
        const url = this.env.TURSO_URL;
        const token = this.env.TURSO_AUTH_TOKEN;
        if (!url || !token) {
            throw new Error('Turso URL or auth token not configured');
        }
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                requests: [
                    {
                        type: 'execute',
                        stmt: { sql, args: params.map(p => ({ type: 'text', value: String(p) })) },
                    },
                ],
            }),
        });
        if (!response.ok) {
            throw new Error(`Turso error: ${response.status} ${await response.text()}`);
        }
        return response.json();
    }

    // ── OpenRouter Streaming Handler ──────────────────────────────

    handleOpenRouter(msg, binding) {
        const apiKey = binding;
        const connectionId = msg.args.connection_id;
        const messages = msg.args.messages;
        const model = msg.args.model || 'openrouter/free';

        if (!apiKey) {
            console.error('OpenRouter: no API key in binding', msg.binding_name);
            this.sendToWS(connectionId, JSON.stringify({ type: 'error', body: 'AI service not configured' }), null);
            this.sendToWS(connectionId, JSON.stringify({ type: 'ai_done' }), null);
        } else {
            this.streamOpenRouter(connectionId, messages, model, apiKey).catch(err => {
                console.error('OpenRouter stream error:', err.message, err.stack);
                this.sendToWS(connectionId, JSON.stringify({ type: 'error', body: 'AI response failed: ' + err.message }), null);
                this.sendToWS(connectionId, JSON.stringify({ type: 'ai_done' }), null);
            });
        }

        return { success: true, async_id: 0 };
    }

    async streamOpenRouter(connectionId, messagesJson, model, apiKey) {
        const url = 'https://openrouter.ai/api/v1/chat/completions';

        const body = JSON.stringify({
            model,
            messages: JSON.parse(messagesJson),
            stream: true,
        });

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream',
            },
            body,
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenRouter HTTP ${response.status}: ${errText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) continue;
                const data = trimmed.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(data);
                    const content = parsed.choices?.[0]?.delta?.content || '';
                    if (content) {
                        this.sendToWS(connectionId, JSON.stringify({ type: 'ai_chunk', content }), null);
                    }
                } catch {
                    // skip unparseable chunks
                }
            }
        }

        this.sendToWS(connectionId, JSON.stringify({ type: 'ai_done' }), null);
    }
}

// ── Utility ─────────────────────────────────────────────────────────

function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;
    for (const part of cookieHeader.split(';')) {
        const idx = part.indexOf('=');
        if (idx > 0) {
            const key = part.substring(0, idx).trim();
            const val = part.substring(idx + 1).trim();
            cookies[key] = val;
            cookies[key.toLowerCase()] = val;
        }
    }
    return cookies;
}
