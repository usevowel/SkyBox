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
        // Try SSE first (primary channel) via DO instance streams
        if (doInstance && doInstance.sseStreams) {
            const text = msg.text;
            if (text !== null) {
                const parsed = JSON.parse(text);
                const eventType = parsed.type || 'message';
                const entry = doInstance.sseStreams.get(msg.connection_id);
                if (entry) {
                    const sseMsg = `event: ${eventType}\ndata: ${JSON.stringify(parsed)}\n\n`;
                    entry.writer.write(entry.encoder.encode(sseMsg));
                    return JSON.stringify({ success: true });
                }
            }
        }
        // Fall back to WebSocket
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

// ── SSE on currentDO ──────────────────────────────────────────────
// SSE streams live on the DO instance (this.sseStreams) because the
// Worker and DO run in separate workerd isolates and cannot share a
// module-level Map. All SSE write helpers go through currentDO.

function globalSSESend(connectionId, eventType, data) {
    const doInstance = currentDO;
    if (!doInstance || !doInstance.sseStreams) return false;
    const entry = doInstance.sseStreams.get(connectionId);
    if (!entry) return false;
    try {
        const msg = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
        entry.writer.write(entry.encoder.encode(msg));
        return true;
    } catch (err) {
        console.error('globalSSESend error:', err);
        doInstance.sseStreams.delete(connectionId);
        return false;
    }
}

// ── Worker Entry Point ──────────────────────────────────────────────

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        // Serve content and nav-tree from static assets
        if (path.startsWith('/content/')) {
            const assetPath = path === '/content/' ? '/content/index.html' : path;
            if (env.ASSETS) return env.ASSETS.fetch(new Request(new URL(assetPath, url.origin)));
            return serveR2(request, env, path.replace('/content/', 'content/'));
        }

        // Nav tree from assets
        if (path === '/api/nav-tree') {
            if (env.ASSETS) return env.ASSETS.fetch(new Request(new URL('/nav-tree.json', url.origin)));
            return serveR2(request, env, 'nav-tree.json', 'application/json');
        }

        // Doc page: read markdown from assets binding, parse, return JSON
        if (path === '/api/page') {
            return handleDocPage(url, env);
        }

        // Debug endpoint to check bindings
        if (path === '/api/debug') {
            let dbTest = 'not tested';
            let r2Test = 'not tested';
            try {
                if (env.DB) {
                    const r = await env.DB.prepare('SELECT 1 as val').all();
                    dbTest = JSON.stringify(r.results);
                }
            } catch (e) { dbTest = 'error: ' + e.message; }
            try {
                if (env.DOCS_BUCKET) {
                    const navObj = await env.DOCS_BUCKET.get('nav-tree.json');
                    r2Test = navObj ? 'nav-tree.json FOUND (' + navObj.size + ' bytes)' : 'nav-tree.json NOT FOUND';
                    const listed = await env.DOCS_BUCKET.list({ limit: 5 });
                    r2Test += ' | listed: ' + JSON.stringify(listed.objects.map(o => o.key));
                }
            } catch (e) { r2Test = 'error: ' + e.message; }

            // Test Vectorize with batch
            let vecTest = 'not tested';
            try {
                if (env.VECTORIZE) {
                    const batchSize = 10;
                    const batch = [];
                    for (let i = 0; i < batchSize; i++) {
                        batch.push({
                            id: 'test-vec-' + i,
                            values: Array.from({ length: 768 }, () => Math.random()),
                            metadata: { idx: i, text: 'test vector '.repeat(20) },
                        });
                    }
                    const r = await env.VECTORIZE.upsert(batch);
                    vecTest = 'batch ' + batchSize + ': ' + JSON.stringify(r);
                }
            } catch (e) { vecTest = 'error: ' + e.message; }
            return new Response(JSON.stringify({
                hasASSETS: !!env.ASSETS,
                hasDB: !!env.DB,
                hasDOCS_BUCKET: !!env.DOCS_BUCKET,
                hasVECTORIZE: !!env.VECTORIZE,
                hasAI: !!env.AI,
                dbTest,
                r2Test,
                vecTest,
            }), { headers: { 'Content-Type': 'application/json' } });
        }

        // Seed endpoint: index all docs from ASSETS/R2 into D1 + Vectorize + Workers AI
        if (path === '/api/seed' && request.method === 'POST') {
            return handleSeed(env);
        }

        // Stats: directly from D1 (BoxLang VM can't unwrap async futures)
        if (path === '/api/stats') {
            try {
                const docResult = await env.DB.prepare('SELECT COUNT(*) as cnt FROM documents').all();
                const chunkResult = await env.DB.prepare('SELECT COUNT(*) as cnt FROM chunks').all();
                return new Response(JSON.stringify({
                    docCount: docResult.results[0]?.cnt || 0,
                    chunkCount: chunkResult.results[0]?.cnt || 0,
                }), { headers: { 'Content-Type': 'application/json' } });
            } catch (e) {
                return new Response(JSON.stringify({ docCount: 0, chunkCount: 0, error: e.message }), { headers: { 'Content-Type': 'application/json' } });
            }
        }

        // Search: embed + Vectorize query directly from JS
        if (path === '/api/search') {
            const query = url.searchParams.get('q') || '';
            if (!query) {
                return new Response(JSON.stringify({ error: 'Missing query parameter q' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
            }
            try {
                // For now, return empty results (embedding requires Workers AI)
                return new Response(JSON.stringify({ query, results: [] }), { headers: { 'Content-Type': 'application/json' } });
            } catch (e) {
                return new Response(JSON.stringify({ query, results: [], error: e.message }), { headers: { 'Content-Type': 'application/json' } });
            }
        }

        // Documents list: directly from D1
        if (path === '/api/documents') {
            try {
                const r = await env.DB.prepare('SELECT id, title, source, tags, created_at FROM documents ORDER BY title').all();
                return new Response(JSON.stringify(r.results), { headers: { 'Content-Type': 'application/json' } });
            } catch (e) {
                return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
            }
        }

        // SSE endpoint: route to DO
        if (path === '/events') {
            const doId = env.WEBSOCKET_DO.idFromName('default');
            const stub = env.WEBSOCKET_DO.get(doId);
            return stub.fetch(request);
        }

        // WebSocket upgrade: route to DO
        if (request.headers.get('Upgrade') === 'websocket') {
            const doId = env.WEBSOCKET_DO.idFromName('default');
            const stub = env.WEBSOCKET_DO.get(doId);
            return stub.fetch(request);
        }

        // Serve the static SPA shell for root
        if (path === '/' || path === '/index.html') {
            return serveSPA(request, env);
        }

        // Everything else → DO (API, WebSocket, SSE)
        const doId = env.WEBSOCKET_DO.idFromName('default');
        const stub = env.WEBSOCKET_DO.get(doId);
        return stub.fetch(request);
    },
};

/**
 * Serve the SPA index.html from the assets directory.
 */
async function serveSPA(request, env) {
    if (env.ASSETS) {
        return env.ASSETS.fetch(new Request('/index.html'));
    }
    return new Response('Not Found', { status: 404 });
}

/**
 * Serve a file from the R2 docs bucket.
 */
async function serveR2(request, env, key, contentType) {
    if (!env.DOCS_BUCKET) {
        return new Response('R2 bucket not configured', { status: 500 });
    }
    try {
        const obj = await env.DOCS_BUCKET.get(key);
        if (!obj) {
            return new Response('Not Found: ' + key, { status: 404 });
        }
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set('Cache-Control', 'public, max-age=86400');
        if (contentType) headers.set('Content-Type', contentType);
        return new Response(obj.body, { headers });
    } catch (err) {
        return new Response(err.message, { status: 500 });
    }
}

/**
 * Handle /api/page?path=... — read markdown from assets binding,
 * parse frontmatter, return JSON.
 */
async function handleDocPage(url, env) {
    const docPath = url.searchParams.get('path') || '';
    if (!docPath) {
        return new Response(JSON.stringify({ error: 'Missing path parameter' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
        });
    }

    const tryPaths = [
        '/content/' + docPath,
        '/content/' + docPath + '/README.md',
        '/content/' + docPath + '.md',
        '/content/' + docPath + '.mdx',
        '/content/' + docPath.replace(/\/$/, '') + '/README.md',
    ];

    for (const p of tryPaths) {
        try {
            const assetReq = new Request(p);
            const resp = await env.ASSETS.fetch(assetReq);
            if (resp.status === 200) {
                const raw = await resp.text();
                if (raw && raw.length > 0) {
                    const parsed = parseDocPage(raw, docPath, p);
                    return new Response(JSON.stringify(parsed), {
                        status: 200, headers: { 'Content-Type': 'application/json' },
                    });
                }
            }
        } catch (_) {}
    }

    return new Response(JSON.stringify({ error: 'Document not found', path: docPath }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * Parse a markdown document: extract frontmatter, title, content, sections for TOC.
 */
function parseDocPage(raw, docPath, r2key) {
    let frontmatter = {};
    let content = raw;
    let title = '';

    // YAML frontmatter between --- markers
    if (raw.startsWith('---')) {
        const endIdx = raw.indexOf('---', 3);
        if (endIdx > 3) {
            const fmRaw = raw.slice(3, endIdx).trim();
            content = raw.slice(endIdx + 3).trim();
            // Simple YAML parsing for common fields
            for (const line of fmRaw.split('\n')) {
                const colonIdx = line.indexOf(':');
                if (colonIdx > 0) {
                    const key = line.slice(0, colonIdx).trim();
                    let val = line.slice(colonIdx + 1).trim();
                    if ((val.startsWith("'") && val.endsWith("'")) ||
                        (val.startsWith('"') && val.endsWith('"'))) {
                        val = val.slice(1, -1);
                    }
                    frontmatter[key] = val;
                }
            }
        }
    }

    // Extract title from frontmatter or first h1
    title = frontmatter['title'] || '';
    if (!title) {
        const h1Match = content.match(/^#\s+(.+)/m);
        if (h1Match) title = h1Match[1].trim();
    }

    // Extract sections for TOC (h2 and h3 headings)
    const sections = [];
    const headingRe = /^(#{2,3})\s+(.+)$/gm;
    let match;
    while ((match = headingRe.exec(content)) !== null) {
        sections.push({
            level: match[1].length,
            text: match[2].trim(),
            anchor: match[2].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        });
    }

    return {
        path: docPath,
        r2key,
        title,
        frontmatter,
        content,    // raw markdown — SPA renders with marked.js
        sections,
    };
}

/**
 * Seed all docs from the Worker URL's static assets into D1 + Vectorize.
 * Assets are deployed via wrangler's [assets] config and served at the worker URL.
 * We use fetch() to loop back through the asset system since there's no direct
 * programmatic ASSETS binding.
 */
async function handleSeed(env) {
    try {
        const origin = 'https://skybox-boxdox.c0d3t3k.workers.dev';
        const readAsset = async (path) => {
            // Priority: R2 bucket → ASSETS binding → worker URL fetch
            if (env.DOCS_BUCKET) {
                // Strip leading slash for R2 keys
                const r2key = path.startsWith('/') ? path.slice(1) : path;
                const obj = await env.DOCS_BUCKET.get(r2key);
                if (obj) return { ok: true, text: () => obj.text(), json: () => obj.json() };
            }
            if (env.ASSETS) {
                const resp = await env.ASSETS.fetch(new Request(new URL(path, origin)));
                if (resp.status === 200) return { ok: true, text: () => resp.text(), json: () => resp.json() };
            }
            const resp = await fetch(new URL(path, origin).href);
            if (resp.status === 200) return { ok: true, text: () => resp.text(), json: () => resp.json() };
            return { ok: false };
        };

        const navResult = await readAsset('/nav-tree.json');
        if (!navResult.ok) {
            return new Response(JSON.stringify({ error: 'nav-tree.json not found' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }
        const navTree = await navResult.json();

        // Collect all markdown files
        const mdFiles = [];
        (function walk(node) {
            if (node.type === 'file' && node.is_markdown) mdFiles.push(node.path);
            if (node.children) node.children.forEach(walk);
        })(navTree);

        // Ensure tables exist
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
            source TEXT DEFAULT '', tags TEXT DEFAULT '',
            metadata TEXT DEFAULT '{}',
            created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
        )`).run();
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS chunks (
            id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, text TEXT NOT NULL,
            chunk_index INTEGER NOT NULL DEFAULT 0,
            metadata TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))
        )`).run();
        await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id)`).run();

        const allChunks = [];
        let docCount = 0;

        for (const filePath of mdFiles) {
            const result = await readAsset('/content/' + filePath);
            if (!result.ok) continue;
            const raw = await result.text();

            let title = filePath.split('/').pop().replace(/\.(md|mdx)$/i, '');
            let content = raw;
            let frontmatter = {};

            if (raw.startsWith('---')) {
                const endIdx = raw.indexOf('---', 3);
                if (endIdx > 3) {
                    const fmRaw = raw.slice(3, endIdx).trim();
                    content = raw.slice(endIdx + 3).trim();
                    for (const line of fmRaw.split('\n')) {
                        const ci = line.indexOf(':');
                        if (ci > 0) {
                            let val = line.slice(ci + 1).trim();
                            if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"')))
                                val = val.slice(1, -1);
                            frontmatter[line.slice(0, ci).trim()] = val;
                        }
                    }
                    title = frontmatter.title || title;
                }
            }

            const docId = 'doc-' + simpleHash(filePath);
            const tags = frontmatter.tags || frontmatter.category || '';

            await env.DB.prepare(
                `INSERT OR REPLACE INTO documents (id, title, content, source, tags, metadata) VALUES (?, ?, ?, ?, ?, ?)`
            ).bind(docId, title, content, filePath, tags, JSON.stringify(frontmatter)).run();
            docCount++;

            const chunks = simpleChunk(content, 500, 100);
            for (let ci = 0; ci < chunks.length; ci++) {
                allChunks.push({ id: docId + '-chunk-' + ci, docId, text: chunks[ci], chunkIndex: ci });
            }
        }

        // Batch embed and store
        let chunkCount = 0;
        if (allChunks.length > 0) {
            const batchSize = 96;
            const AI = env.AI;
            for (let i = 0; i < allChunks.length; i += batchSize) {
                const batch = allChunks.slice(i, i + batchSize);
                const texts = batch.map(c => c.text.slice(0, 512));

                // Generate embeddings — use Workers AI if available, else random
                let embeddings;
                if (AI) {
                    const resp = await AI.run('@cf/baai/bge-base-en-v1.5', { text: texts });
                    embeddings = resp.data || [];
                } else {
                    const dims = 768;
                    embeddings = texts.map(() => Array.from({ length: dims }, () => Math.random()));
                }

                const vecBatch = [];
                const d1Batch = [];
                for (let j = 0; j < embeddings.length; j++) {
                    const c = batch[j];
                    vecBatch.push({
                        id: c.id,
                        values: embeddings[j],
                        metadata: { docId: c.docId, text: c.text.slice(0, 200), chunkIndex: c.chunkIndex },
                    });
                    d1Batch.push(env.DB.prepare(
                        `INSERT OR REPLACE INTO chunks (id, doc_id, text, chunk_index) VALUES (?, ?, ?, ?)`
                    ).bind(c.id, c.docId, c.text, c.chunkIndex));
                }

                if (vecBatch.length > 0) {
                    try {
                        await env.VECTORIZE.upsert(vecBatch);
                    } catch (upsertErr) {
                        // If upsert fails, try one by one
                        console.error('Batch upsert failed, trying individual:', upsertErr.message);
                        for (const v of vecBatch) {
                            try { await env.VECTORIZE.upsert([v]); } catch (e) {
                                console.error('Single upsert failed:', v.id, e.message);
                            }
                        }
                    }
                }
                if (d1Batch.length > 0) await env.DB.batch(d1Batch);
                chunkCount += batch.length;
            }
        }

        return new Response(JSON.stringify({ status: 'ok', docCount, chunkCount, totalFiles: mdFiles.length }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
        });
    }
}

function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h) + str.charCodeAt(i);
        h |= 0;
    }
    return Math.abs(h).toString(36);
}

function simpleChunk(text, chunkSize, overlap) {
    const result = [];
    let pos = 0;
    while (pos < text.length) {
        const end = Math.min(pos + chunkSize, text.length);
        result.push(text.slice(pos, end));
        pos += chunkSize - overlap;
        if (pos >= text.length) break;
    }
    if (result.length === 0) result.push(text);
    return result;
}

// ── Durable Object ──────────────────────────────────────────────────

export class MatchBoxWebSocketDO {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
        this.initialized = false;
        this.pendingAsyncOps = new Map();
        this.nextAsyncOpId = 1;
        this.sseStreams = new Map();
        this.chatHistories = new Map();
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

        // SSE: EventSource sends Accept: text/event-stream
        const accept = request.headers.get('Accept') || '';
        if (accept.includes('text/event-stream')) {
            return this.handleSSE(request);
        }

        // Handle data endpoints directly (BoxLang VM can't unwrap async futures)
        const url = new URL(request.url);
        const path = url.pathname;
        if (path === '/api/stats') {
            try {
                const docResult = await this.env.DB.prepare('SELECT COUNT(*) as cnt FROM documents').all();
                const chunkResult = await this.env.DB.prepare('SELECT COUNT(*) as cnt FROM chunks').all();
                return new Response(JSON.stringify({
                    docCount: docResult.results[0]?.cnt || 0,
                    chunkCount: chunkResult.results[0]?.cnt || 0,
                }), { headers: { 'Content-Type': 'application/json' } });
            } catch (e) {
                return new Response(JSON.stringify({ docCount: 0, chunkCount: 0, error: e.message }), { headers: { 'Content-Type': 'application/json' } });
            }
        }
        if (path === '/api/search') {
            const query = url.searchParams.get('q') || '';
            if (!query) {
                return new Response(JSON.stringify({ error: 'Missing query parameter q' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
            }
            try {
                return new Response(JSON.stringify({ query, results: [] }), { headers: { 'Content-Type': 'application/json' } });
            } catch (e) {
                return new Response(JSON.stringify({ query, results: [], error: e.message }), { headers: { 'Content-Type': 'application/json' } });
            }
        }
        if (path === '/api/documents') {
            try {
                const r = await this.env.DB.prepare('SELECT id, title, source, tags, created_at FROM documents ORDER BY title').all();
                return new Response(JSON.stringify(r.results), { headers: { 'Content-Type': 'application/json' } });
            } catch (e) {
                return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
            }
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

    handleSSE(request) {
        const url = new URL(request.url);
        const cid = url.searchParams.get('cid');
        if (!cid) {
            return new Response('Missing cid parameter', { status: 400 });
        }

        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        const existing = this.sseStreams.get(cid);
        if (existing) {
            try { existing.writer.close(); } catch (_) {}
        }

        this.sseStreams.set(cid, { writer, encoder });

        try {
            writer.write(encoder.encode('event: connected\ndata: {}\n\n'));
        } catch (err) {
            console.error('SSE initial write error:', err);
        }

        request.signal.addEventListener('abort', () => {
            const entry = this.sseStreams.get(cid);
            if (entry && entry.writer === writer) {
                this.sseStreams.delete(cid);
            }
        });

        return new Response(readable, {
            status: 200,
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Access-Control-Allow-Origin': '*',
            },
        });
    }

    async handleWebSocketUpgrade(request) {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        const url = new URL(request.url);
        const connectionId = url.searchParams.get('cid') || crypto.randomUUID();

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
        const connectionId = att.id;

        // Intercept "chat " messages for JS-based RAG pipeline
        if (typeof message === 'string' && message.startsWith('chat ')) {
            const prompt = message.slice(5).trim();
            if (prompt) {
                await this.handleChatRAG(connectionId, prompt);
            }
            return;
        }

        const isText = typeof message === 'string';
        const msgBytes = isText
            ? new TextEncoder().encode(message)
            : new Uint8Array(message);

        currentDO = this;
        try {
            let resultJson = vm_on_message(
                connectionId,
                isText ? 0 : 1,
                msgBytes,
            );
            let result = JSON.parse(resultJson);

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

    async handleChatRAG(connectionId, prompt) {
        if (!this.chatHistories.has(connectionId)) {
            this.chatHistories.set(connectionId, []);
        }
        const history = this.chatHistories.get(connectionId);

        this.sseSend(connectionId, 'user_msg', { type: 'user_msg', content: prompt });

        history.push({ role: 'user', content: prompt });
        if (history.length > 40) {
            history.splice(0, history.length - 40);
        }

        let ragContext = '';
        try {
            const embedding = await this.embedQuery(prompt);
            if (embedding) {
                const matches = await this.queryVectorize(embedding, 5);
                if (matches && matches.length > 0) {
                    const chunkIds = matches.map(m => m.id);
                    const chunkTexts = await this.lookupChunksFromD1(chunkIds);
                    ragContext = chunkTexts.map((t, i) =>
                        `[Source: ${matches[i].metadata?.path || matches[i].id}] Score: ${(matches[i].score * 100).toFixed(0)}%\n${t}`
                    ).join('\n\n');
                }
            }
        } catch (err) {
            console.error('RAG pipeline error:', err);
        }

        const messages = [
            {
                role: 'system',
                content: 'You are a BoxLang documentation assistant. Answer questions about BoxLang, MatchBox, and related technologies.' +
                    (ragContext ? '\n\nRelevant documentation context:\n' + ragContext : ''),
            },
            ...history.slice(-20),
        ];

        const apiKey = this.env.OPENROUTER_API_KEY;
        if (!apiKey) {
            this.sseSend(connectionId, 'error', { type: 'error', body: 'AI service not configured' });
            this.sseSend(connectionId, 'ai_done', { type: 'ai_done' });
            return;
        }

        await this.streamOpenRouter(connectionId, JSON.stringify(messages), 'deepseek/deepseek-v4-flash:free', apiKey);

        history.push({ role: 'assistant', content: '' });
        if (history.length > 40) {
            history.splice(0, history.length - 40);
        }
    }

    async embedQuery(text) {
        if (this.env.AI) {
            try {
                const response = await this.env.AI.run('@cf/baai/bge-base-en-v1.5', { text });
                const data = response?.data || response?.result?.data || [];
                return data[0] || null;
            } catch (err) {
                console.error('Workers AI embed error:', err);
            }
        }
        return null;
    }

    async queryVectorize(vector, topK) {
        if (!this.env.VECTORIZE) return [];
        try {
            const result = await this.env.VECTORIZE.query(vector, { topK, returnMetadata: true, returnValues: false });
            return (result.matches || []).map(m => ({
                id: m.id,
                score: 1 - (m.score / 2),
                metadata: m.metadata || {},
            }));
        } catch (err) {
            console.error('Vectorize query error:', err);
            return [];
        }
    }

    async lookupChunksFromD1(ids) {
        if (!this.env.DB) return ids.map(() => '');
        const texts = [];
        for (const id of ids) {
            try {
                const r = await this.env.DB.prepare('SELECT text FROM chunks WHERE id = ?').bind(id).first();
                texts.push(r?.text || '');
            } catch {
                texts.push('');
            }
        }
        return texts;
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
        // Try SSE first
        if (text !== null) {
            try {
                const parsed = JSON.parse(text);
                const eventType = parsed.type || 'message';
                const entry = this.sseStreams.get(connectionId);
                if (entry) {
                    const msg = `event: ${eventType}\ndata: ${JSON.stringify(parsed)}\n\n`;
                    entry.writer.write(entry.encoder.encode(msg));
                    return;
                }
            } catch (_) {
                // not JSON, fall through to WS
            }
        }

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
    // CRITICAL: Handlers that set pendingAsyncOps MUST run synchronously
    // until pendingAsyncOps.set() is called. Never use `await` before
    // pendingAsyncOps.set() — async handlers return a Promise that
    // stringifies as '{}' by the callout bridge.
    // Pattern: sync dispatch → fire-and-forget async → return sync success.

    handleBindingCall(msg) {
        const binding = this.env[msg.binding_name];

        switch (msg.action) {
            case 'query':     return this.handleD1Query(msg, binding);
            case 'execute':   return this.handleD1Execute(msg, binding);
            case 'embed':     return this.handleEmbedSync(msg);
            case 'turso_query':   return this.handleTursoSync(msg, 'query');
            case 'turso_execute': return this.handleTursoSync(msg, 'execute');
            case 'openrouter':    return JSON.stringify(this.handleOpenRouter(msg, binding));
            case 'vectorize_upsert': return this.handleVectorizeSync(msg, binding, 'upsert');
            case 'vectorize_query':  return this.handleVectorizeSync(msg, binding, 'query');
            case 'vectorize_delete_by_ids': return this.handleVectorizeSync(msg, binding, 'deleteByIds');
            default:
                return JSON.stringify({ success: false, error: `Unknown action: ${msg.action}` });
        }
    }

    // ── Embed Handler (sync dispatch, optionally async) ──────────

    handleEmbedSync(msg) {
        const async_id = msg.async_id;
        if (!this.env.AI) {
            const dims = 4;
            const input = msg.args.input;
            const data = typeof input === 'string'
                ? Array.from({ length: dims }, () => Math.random())
                : (Array.isArray(input) ? input.map(() => Array.from({ length: dims }, () => Math.random())) : []);
            this.pendingAsyncOps.set(async_id, Promise.resolve(data));
            return JSON.stringify({ success: true, async_id });
        }
        this.embedAsync(msg).catch(() => {});
        return JSON.stringify({ success: true, async_id });
    }

    async embedAsync(msg) {
        const async_id = msg.async_id;
        try {
            const model = msg.args.options?.model || '@cf/baai/bge-base-en-v1.5';
            const input = msg.args.input;
            const response = await this.env.AI.run(model, { text: input });
            const data = response?.data || response?.result?.data || [];
            this.pendingAsyncOps.set(async_id, Promise.resolve(data));
        } catch (err) {
            this.pendingAsyncOps.set(async_id, Promise.reject(err.message));
        }
    }

    // ── Turso Handler (sync dispatch, async fetch) ──────────────

    handleTursoSync(msg, mode) {
        const async_id = msg.async_id;
        const sql = msg.args.sql;
        const params = msg.args.params || [];
        if (!this.env.TURSO_URL || !this.env.TURSO_AUTH_TOKEN) {
            this.pendingAsyncOps.set(async_id, Promise.reject('Turso not configured'));
            return JSON.stringify({ success: true, async_id });
        }
        this.tursoAsync(async_id, sql, params, mode).catch(() => {});
        return JSON.stringify({ success: true, async_id });
    }

    async tursoAsync(async_id, sql, params, mode) {
        try {
            const response = await fetch(this.env.TURSO_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.env.TURSO_AUTH_TOKEN}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    requests: [{ type: 'execute', stmt: { sql, args: params.map(p => ({ type: 'text', value: String(p) })) } }],
                }),
            });
            if (!response.ok) throw new Error(`Turso error: ${response.status}`);
            const json = await response.json();
            if (mode === 'query') {
                const rows = json?.results?.[0]?.response?.result?.rows || [];
                this.pendingAsyncOps.set(async_id, Promise.resolve(rows));
            } else {
                const affected = json?.results?.[0]?.response?.result?.affected_count || 0;
                this.pendingAsyncOps.set(async_id, Promise.resolve(affected));
            }
        } catch (err) {
            this.pendingAsyncOps.set(async_id, Promise.reject(err.message));
        }
    }

    // ── Vectorize Handlers (sync dispatch, async fetch) ──────────

    handleVectorizeSync(msg, binding, operation) {
        const async_id = msg.async_id;
        if (!binding) {
            this.pendingAsyncOps.set(async_id, Promise.reject('Vectorize not configured'));
            return JSON.stringify({ success: true, async_id });
        }

        if (operation === 'upsert') {
            const vectors = JSON.parse(msg.args.vectors);
            binding.upsert(vectors).then(r => {
                this.pendingAsyncOps.set(async_id, Promise.resolve(r?.count ?? vectors.length));
            }).catch(err => {
                this.pendingAsyncOps.set(async_id, Promise.reject(err.message));
            });
            return JSON.stringify({ success: true, async_id });
        }

        if (operation === 'query') {
            const vector = JSON.parse(msg.args.vector);
            const topK = parseInt(msg.args.topK || '5', 10);
            const filter = msg.args.filter ? JSON.parse(msg.args.filter) : undefined;
            const queryOptions = { topK, returnValues: true, returnMetadata: true };
            if (filter && Object.keys(filter).length > 0) queryOptions.filter = filter;

            binding.query(vector, queryOptions).then(result => {
                const matches = (result.matches || []).map(m => ({
                    id: m.id,
                    score: 1 - (m.score / 2),
                    metadata: m.metadata || {},
                    values: m.values || [],
                }));
                this.pendingAsyncOps.set(async_id, Promise.resolve({ count: result.count || matches.length, matches }));
            }).catch(err => {
                this.pendingAsyncOps.set(async_id, Promise.reject(err.message));
            });
            return JSON.stringify({ success: true, async_id });
        }

        if (operation === 'deleteByIds') {
            const ids = JSON.parse(msg.args.ids);
            binding.deleteByIds(ids).then(r => {
                this.pendingAsyncOps.set(async_id, Promise.resolve(r));
            }).catch(err => {
                this.pendingAsyncOps.set(async_id, Promise.reject(err.message));
            });
            return JSON.stringify({ success: true, async_id });
        }

        return JSON.stringify({ success: false, error: `Unknown vectorize op: ${operation}` });
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

    // ── OpenRouter Streaming Handler ──────────────────────────────

    handleOpenRouter(msg, binding) {
        const apiKey = binding;
        const connectionId = msg.args.connection_id;
        const messages = msg.args.messages;
        const model = msg.args.model || 'deepseek/deepseek-v4-flash:free';
        const self = this;

        if (!apiKey) {
            console.error('OpenRouter: no API key in binding', msg.binding_name);
            self.sseSend(connectionId, 'error', { type: 'error', body: 'AI service not configured' });
            self.sseSend(connectionId, 'ai_done', { type: 'ai_done' });
        } else {
            this.streamOpenRouter(connectionId, messages, model, apiKey).catch(err => {
                console.error('OpenRouter stream error:', err.message, err.stack);
                self.sseSend(connectionId, 'error', { type: 'error', body: 'AI response failed: ' + err.message });
                self.sseSend(connectionId, 'ai_done', { type: 'ai_done' });
            });
        }

        return { success: true, async_id: 0 };
    }

    sseSend(connectionId, eventType, data) {
        const entry = this.sseStreams.get(connectionId);
        if (entry) {
            try {
                entry.writer.write(entry.encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`));
                return true;
            } catch (err) {
                console.error('sseSend error:', err);
                this.sseStreams.delete(connectionId);
            }
        }
        return this.wsSend(connectionId, JSON.stringify(data));
    }

    wsSend(connectionId, message) {
        for (const ws of this.ctx.getWebSockets()) {
            const att = ws.deserializeAttachment();
            if (att && att.id === connectionId) {
                try {
                    ws.send(message);
                    return true;
                } catch (err) {
                    console.error('wsSend error:', err);
                    return false;
                }
            }
        }
        return false;
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

        this.sseSend(connectionId, 'ai_start', { type: 'ai_start' });

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
                if (data === '[DONE]') break;

                try {
                    const parsed = JSON.parse(data);
                    const content = parsed.choices?.[0]?.delta?.content || '';
                    if (content) {
                        this.sseSend(connectionId, 'ai_chunk', { type: 'ai_chunk', content });
                    }
                } catch {
                    // skip unparseable chunks
                }
            }
        }

        this.sseSend(connectionId, 'ai_done', { type: 'ai_done' });
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
