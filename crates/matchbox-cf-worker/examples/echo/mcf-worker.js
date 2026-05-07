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

// ── Worker Entry Point ──────────────────────────────────────────────

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // Health check endpoint
        if (url.pathname === '/__health') {
            return new Response('OK', { status: 200 });
        }

        // Only handle WebSocket upgrades
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('Expected WebSocket upgrade', {
                status: 426,
                statusText: 'Upgrade Required',
                headers: { 'Content-Type': 'text/plain' },
            });
        }

        // Route to the DO
        const doId = env.WEBSOCKET_DO.idFromName('default');
        const stub = env.WEBSOCKET_DO.get(doId);

        return stub.fetch(request);
    },
};

// ── Durable Object ──────────────────────────────────────────────────

export class MatchBoxWebSocketDO {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
        this.initialized = false;

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
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('Expected WebSocket upgrade', { status: 426 });
        }

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
            body: [],
            full_url: request.url,
        };

        server.serializeAttachment({ id: connectionId, request: requestData });

        const connections = (await this.ctx.storage.get('connections')) || {};
        connections[connectionId] = requestData;
        await this.ctx.storage.put('connections', connections);

        this.ctx.acceptWebSocket(server);

        currentDO = this;
        try {
            vm_on_connect(
                connectionId,
                JSON.stringify(requestData),
            );
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
            vm_on_message(
                att.id,
                isText ? 0 : 1,
                msgBytes,
            );

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
