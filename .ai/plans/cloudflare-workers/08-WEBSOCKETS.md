# Phase 5 — WebSocket Support (SocketBox Bridge)

## Overview

Bridge the MatchBox **SocketBox-style** WebSocket API (`app.enableWebSockets()`,
`onConnect`/`onMessage`/`onClose` listener class, `channel.sendMessage()` /
`channel.broadcastMessage()` etc.) onto Cloudflare Workers **WebSockets** +
**Durable Objects (Hibernation API)**.

The fundamental architectural difference: MatchBox runs a single OS thread with
a blocking mpsc event loop and a shared `HashMap<connection_id, Sender>` for
broadcast. Cloudflare Workers have no threads — instead, a single **Durable
Object** hosts all WebSocket connections for an app using the **Hibernation
API**, with `acceptWebSocket()` + `getWebSockets()` replacing both the mpsc
event loop and the outbound sender HashMap.

---

## SocketBox API Reference (what we're porting)

### BoxLang-side (user code)

```boxlang
// Standard SocketBox-style listener class
class ChatRoom {
    function configure() {
        variables.room = "lobby";
        variables.clicks = 0;
    }

    function onConnect(required channel) {
        channel.sendMessage("welcome to " & variables.room);
    }

    function onMessage(required message, required channel) {
        variables.clicks++;
        channel.broadcastJson({
            "room": variables.room,
            "clicks": variables.clicks,
            "message": message
        });
    }

    function onClose(required channel) {
        channel.broadcastMessage("user left");
    }
}

import boxlang.web;

app = web.server();
listener = new ChatRoom();
listener.configure();
app.enableWebSockets("/ws", listener);
```

### Channel methods (the surface to preserve)

| Method | SocketBox (MatchBox) | CF Workers + DO |
|--------|---------------------|-----------------|
| `sendMessage(text)` / `sendText(text)` | Send via `UnboundedSender` in shared HashMap | `webSocket.send(text)` on the specific WS from `getWebSockets()` |
| `broadcastMessage(text)` / `broadcastText(text)` | Iterate all senders in shared HashMap | `for ws of getWebSockets() { ws.send(text) }` |
| `sendJson(value)` | Serialize to JSON, send as text | Same principle |
| `broadcastJson(value)` | Serialize to JSON, iterate all senders | Same principle via `getWebSockets()` |
| `sendBytes(bytes)` | Send binary via `UnboundedSender` | `ws.send(bytes)` (binary ArrayBuffer → Uint8Array) |
| `broadcastBytes(bytes)` | Iterate all senders | Same via `getWebSockets()` |
| `close([code[, reason]])` | Send `Close` frame via sender | `ws.close(code, reason)` |
| `getId()` | Return `connection_id` | Return stored connection UUID (from `deserializeAttachment()`) |
| `getPath()` | Return `request.path` | Return stored request path (from attachment) |
| `getUrl()` | Return `request.full_url` | Return stored request URL (from attachment) |
| `getHTTPHeader(name[, default])` | Lookup in `request.headers` | Return from stored headers (from attachment) |

---

## Architecture: Single Durable Object with Hibernation API

### MatchBox (current)

```
┌──────────────────────────────────────────┐
│  Single OS Thread                         │
│  ┌──────────────────────────────────┐     │
│  │  One VM                           │     │
│  │  ┌──────────────────────────────┐│     │
│  │  │ Listener instance            ││     │
│  │  │  variables.clicks = 3        ││     │
│  │  │  variables.prefix = "echo:"  ││     │
│  │  └──────────────────────────────┘│     │
│  │  ┌──────┐ ┌──────┐ ┌──────┐     │     │
│  │  │conn1 │ │conn2 │ │conn3 │     │     │
│  │  │sndr  │ │sndr  │ │sndr  │     │     │
│  │  └──────┘ └──────┘ └──────┘     │     │
│  │  HashMap<connection_id, Sender>  │     │
│  └──────────────────────────────────┘     │
│                                           │
│  ✓ Shared instance state (all see clicks) │
│  ✓ O(1) broadcast (HashMap iteration)     │
│  ✓ Synchronous mutation (no races)        │
└──────────────────────────────────────────┘
```

### Cloudflare Workers — Correct Architecture (Hibernation API)

```
┌──────────────────────────────────────────────────────────────┐
│  Worker fetch()  (stateless entry point, routes WS upgrade   │
│  to DO via DO namespace .get(idFromName("default")).fetch()) │
└──────────────────────┬───────────────────────────────────────┘
                       │ Upgrade: websocket
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  Durable Object: Single DO instance for the app/room          │
│  (uses Hibernation API: acceptWebSocket, getWebSockets)      │
│                                                               │
│  Constructor (runs on every wake from hibernation):           │
│  1. Initialize BoxLang VM (load chunk, instantiate listener)  │
│  2. Rehydrate state from DO storage (listener state vars)     │
│  3. Restore WS set from DO storage (connection metadata map)  │
│  4. Restore per-connection request metadata from storage      │
│  5. Set up WebSocket auto-response (ping/pong without waking) │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐     │
│  │  BoxLang VM (single, shared across all connections)   │     │
│  │  ┌────────────────────────────────────────────────┐  │     │
│  │  │ Listener instance                              │  │     │
│  │  │  variables.clicks = 3   ← shared across WSs    │  │     │
│  │  │  variables.prefix = "echo:"                    │  │     │
│  │  └────────────────────────────────────────────────┘  │     │
│  │                                                       │     │
│  │  CfWebSocketChannelObject {                          │     │
│  │    connection_id: stored per-WS in storage map       │     │
│  │    request_data: stored per-WS in storage map        │     │
│  │    do_id: "default"                                   │     │
│  │    getWebSockets(): calls ctx.getWebSockets()        │     │
│  │  }                                                   │     │
│  └──────────────────────────────────────────────────────┘     │
│                                                               │
│  DO Storage (SQLite-backed, survives hibernation):            │
│  ┌──────────────────────────────────────────────────────┐     │
│  │  "listener_state" → { clicks: 3, prefix: "echo:" }   │     │
│  │  "connections" → {                                    │     │
│  │    "conn-uuid-1": { path: "/ws", headers: {...} },   │     │
│  │    "conn-uuid-2": { path: "/ws", headers: {...} },   │     │
│  │  }                                                    │     │
│  └──────────────────────────────────────────────────────┘     │
│                                                               │
│  WebSocket connections (up to 32,768 per DO):                 │
│  ┌──────┐ ┌──────┐ ┌──────┐                                  │
│  │conn1 │ │conn2 │ │conn3 │ ← via ctx.getWebSockets()        │
│  └──────┘ └──────┘ └──────┘                                  │
│                                                               │
│  ✓ Shared VM instance state (clicks seen by all)              │
│  ✓ Broadcast = iterate getWebSockets() — O(n) but natively WS│
│  ✓ Hibernation: DO sleeps when idle, connections stay alive   │
│  ✓ No extra DO fetches needed for broadcast                   │
│  ✓ Per-connection metadata stored via serializeAttachment     │
└──────────────────────────────────────────────────────────────┘
```

### DO Lifecycle ↔ SocketBox Event Mapping

| DO Lifecycle / Runtime Event | SocketBox Event Triggered |
|---|---|
| `DO.fetch()` with `Upgrade: websocket` → `acceptWebSocket(server)` | `onConnect(channel)` — called from `fetch()` |
| `DO.webSocketMessage(ws, msg)` | `onMessage(message, channel)` |
| `DO.webSocketClose(ws, code, reason, wasClean)` | `onClose(channel)` |
| `DO.webSocketError(ws, error)` | `onClose(channel)` (with error info) |
| DO constructor (on every wake from hibernation) | Restore VM + listener state from DO storage |
| DO alarm (if needed) | Periodic state sync, connection health checks |

### How the Hibernation API replaces MatchBox internals

| MatchBox concept | MatchBox implementation | CF Workers replacement |
|---|---|---|
| Event loop | `while let Ok(cmd) = commands.recv()` — blocking mpsc | DO's `webSocketMessage`/`webSocketClose` handlers are invoked by the runtime |
| Outbound sender map | `HashMap<connection_id, UnboundedSender<WebSocketOutbound>>` | `this.ctx.getWebSockets()` returns all active WS objects; send directly |
| Thread safety | Single thread, `Rc<RefCell<HashMap>>` | DO is single-threaded by runtime guarantee |
| Per-connection request data | `WebSocketChannelObject.request` field | `ws.serializeAttachment({...})` / `ws.deserializeAttachment()` |
| Connection registry | `vm.struct_new()` storing channels by connection_id | DO storage key `"connections"` plus `serializeAttachment` |
| Listener state | `vm.set_instance_variables_json()` rehydrates from snapshot | DO storage key `"listener_state"` rehydrated on constructor call |
| Ping/pong | Manual in `tokio::select!` | `ctx.setWebSocketAutoResponse("ping", "pong")` — free, no wake |
| `onConnect` error → close(1011) | `send_websocket_close(outbound.clone(), id, 1011, ...)` | `ws.close(1011, "Internal error")` |

---

## Two Entry Points (both must be covered)

### Entry Point A: Script API (`app.enableWebSockets()`)

Used when running via `matchbox run --app app.bxs` (or `--target cf-worker`).

The app script calls `app.enableWebSockets(uri, listener)`. During compilation
(runtime), the listener's class name and instance variables are snapshotted into
`WebSocketConfig`:

```rust
// app_server.rs:1380-1385
app.websocket = Some(WebSocketConfig {
    uri: "/ws",
    listener_class: "ChatRoom",      // vm.instance_class_name(listener)
    listener_state: { "room": "lobby", "clicks": 0 },  // vm.instance_variables_json(listener)
    handler: "WebSocket.bx",          // default
});
```

For the `cf-worker` target: the entire compiled chunk (containing both the app
logic and the listener class) is embedded in the WASM custom section, along
with the `WebSocketConfig` as metadata. The JS shell reads this metadata to
configure the DO class.

### Entry Point B: JSON Config (`boxlang.json` → `config.websocket`)

Used when running via `matchbox run --webroot .` (or equivalent).

The `boxlang.json` config contains a `websocket` section:

```json
{
    "websocket": {
        "uri": "/ws",
        "listenerClass": "EchoListener",
        "listenerState": {},
        "handler": "WebSocket.bx"
    }
}
```

This path (lib.rs:418-469) finds the handler script file (case-insensitively)
in the webroot, parses and compiles it, then spawns a runtime. The handler
script typically contains the listener class definition:

```boxlang
// WebSocket.bx
class EchoListener {
    function onConnect(channel) {
        channel.sendMessage("welcome");
    }
    function onMessage(msg, channel) {
        channel.sendMessage("echo:" & msg);
    }
    function onClose(channel) {}
}
```

For the `cf-worker` target: the handler script must be compiled and the chunk
embedded in the WASM binary alongside the `WebSocketConfig`. The JS shell loads
this config at DO construction time.

---

## Implementation Tasks

### Task 1: JS Shell — DO Class with Hibernation API

**File:** `mcf-worker.js`

```javascript
export class MatchBoxWebSocketDO extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        // On wake from hibernation, the VM + listener state must be restored.
        // We block concurrency during init to prevent race conditions.
        this.ctx.blockConcurrencyWhile(async () => {
            await this.initializeVM();
        });
    }

    async initializeVM() {
        // 1. Read WebSocketConfig from WASM metadata
        const wsConfig = this.getWasmMetadata("websocket_config");

        // 2. Load the compiled chunk from WASM custom section
        const chunk = this.getWasmMetadata("compiled_chunk");

        // 3. Call WASM export: vm_init(chunk_ptr, chunk_len, config_json)
        //    This creates the VM, instantiates the listener class,
        //    sets instance variables from listenerState.
        this.vmPtr = wasm.exports.vm_init(chunk, JSON.stringify(wsConfig));

        // 4. Rehydrate shared listener state from DO storage
        const storedState = await this.ctx.storage.get("listener_state");
        if (storedState) {
            wasm.exports.vm_set_state(this.vmPtr, JSON.stringify(storedState));
        }

        // 5. Restore per-connection metadata from DO storage
        const connections = await this.ctx.storage.get("connections") || {};
        for (const ws of this.ctx.getWebSockets()) {
            const att = ws.deserializeAttachment();
            if (att && connections[att.id]) {
                // Re-register this connection in the VM's channel struct
                wasm.exports.vm_register_connection(
                    this.vmPtr, att.id, JSON.stringify(connections[att.id])
                );
            }
        }

        // 6. Set up auto-response for ping/pong
        this.ctx.setWebSocketAutoResponse(
            new WebSocketRequestResponsePair("ping", "pong")
        );
    }

    async fetch(request) {
        // Only handle WebSocket upgrade requests
        if (request.headers.get("Upgrade") !== "websocket") {
            return new Response("Expected WebSocket upgrade", { status: 426 });
        }

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        const connectionId = crypto.randomUUID();

        // Build RequestData from the HTTP request
        const requestData = {
            method: request.method,
            path: new URL(request.url).pathname,
            headers: Object.fromEntries(request.headers),
            query: Object.fromEntries(new URL(request.url).searchParams),
            full_url: request.url,
        };

        // Store per-connection metadata so it survives hibernation
        server.serializeAttachment({ id: connectionId, request: requestData });

        // Persist in DO storage for restoration on wake
        const connections = await this.ctx.storage.get("connections") || {};
        connections[connectionId] = requestData;
        await this.ctx.storage.put("connections", connections);

        // Accept the WebSocket via Hibernation API
        // This replaces both ws.accept() and addEventListener('message', ...)
        this.ctx.acceptWebSocket(server);

        // Call the BoxLang listener's onConnect
        wasm.exports.vm_on_connect(
            this.vmPtr,
            connectionId,
            JSON.stringify(requestData)
        );

        return new Response(null, {
            status: 101,
            webSocket: client,
        });
    }

    async webSocketMessage(ws, message) {
        const att = ws.deserializeAttachment();
        if (!att) return;

        if (typeof message === "string") {
            wasm.exports.vm_on_message(
                this.vmPtr, att.id, 0, message  // 0 = text type
            );
        } else {
            // binary message — pass as bytes
            wasm.exports.vm_on_message(
                this.vmPtr, att.id, 1, new Uint8Array(message)  // 1 = binary type
            );
        }
    }

    async webSocketClose(ws, code, reason, wasClean) {
        const att = ws.deserializeAttachment();
        if (!att) return;

        wasm.exports.vm_on_close(this.vmPtr, att.id, code, reason);

        // Clean up per-connection metadata
        const connections = await this.ctx.storage.get("connections") || {};
        delete connections[att.id];
        await this.ctx.storage.put("connections", connections);
    }

    async webSocketError(ws, error) {
        // Treat errors as closes
        const att = ws.deserializeAttachment();
        if (att) {
            wasm.exports.vm_on_close(this.vmPtr, att.id, 1011, error.message);
        }
    }
}
```

- [ ] Implement `MatchBoxWebSocketDO` class in the JS shell
- [ ] Implement `blockConcurrencyWhile` in constructor for safe VM init
- [ ] Implement `fetch()` with `acceptWebSocket()` Hibernation API
- [ ] Implement `webSocketMessage()`, `webSocketClose()`, `webSocketError()` handlers
- [ ] Implement `serializeAttachment()` / `deserializeAttachment()` for per-connection metadata
- [ ] Implement DO storage persistence for connections map and listener state
- [ ] Implement `setWebSocketAutoResponse()` for ping/pong

### Task 2: WASM Exports — DO Lifecycle Functions

**File:** `crates/matchbox-cf-worker/src/do_adapter.rs`

| WASM Export | Called by JS | Purpose |
|---|---|---|
| `vm_init` | DO constructor | Create VM, load chunk, instantiate listener, set state |
| `vm_set_state` | DO constructor | Rehydrate listener instance state from DO storage |
| `vm_register_connection` | DO constructor | Re-register a connection channel after DO wake from hibernation |
| `vm_on_connect` | DO.fetch() | Call `listener.onConnect(channel)` |
| `vm_on_message` | DO.webSocketMessage() | Call `listener.onMessage(message, channel)` |
| `vm_on_close` | DO.webSocketClose() | Call `listener.onClose(channel)`, clean up |
| `channel_send` | CfWebSocketChannelObject | Send text/binary on a specific WS (called via callout to JS) |
| `channel_close` | CfWebSocketChannelObject | Close a specific WS (called via callout to JS) |
| `channel_broadcast` | CfWebSocketChannelObject | Broadcast to all WS on this DO (called via callout to JS) |
| `get_connections` | DO constructor | Return the connections map for re-registration |

- [ ] `vm_init(chunk_ptr, chunk_len, config_json) → vm_ptr`
  - Deserialize `WebSocketConfig`, load chunk, instantiate listener class
  - Store listener in VM global (`__websocketlistener`)
  - Create channel registry struct (`__websocketconnections`)
  - Return opaque pointer to VM (for JS-side tracking)
- [ ] `vm_set_state(vm_ptr, state_json)` — set listener instance variables
- [ ] `vm_register_connection(vm_ptr, connection_id, request_json)`
  - Build `CfWebSocketChannelObject` and store in channel registry struct
- [ ] `vm_on_connect(vm_ptr, connection_id, request_json)`
  - Look up channel by connection_id, call `listener.onConnect(channel)`
  - This is a **sync** call from JS — no blocking. The VM runs the BoxLang
    `onConnect` code, which may call `channel.sendMessage()` → callout to JS
    → `webSocket.send()`.
- [ ] `vm_on_message(vm_ptr, connection_id, msg_type, message)`
  - msg_type: 0 = text (String), 1 = binary (Vec<u8>)
  - Convert to `BxValue`, call `listener.onMessage(message, channel)`
- [ ] `vm_on_close(vm_ptr, connection_id, code, reason)`
  - Call `listener.onClose(channel)`, remove from channel registry struct
- [ ] `channel_send(vm_ptr, connection_id, msg_type, message)`
  - Callout to JS: `await this.sendToWS(connectionId, message)`
- [ ] `channel_broadcast(vm_ptr, sender_connection_id, msg_type, message)`
  - Callout to JS: `await this.broadcastToAll(senderConnectionId, message)`
- [ ] `channel_close(vm_ptr, connection_id, code, reason)`
  - Callout to JS: `await this.closeWS(connectionId, code, reason)`

### Task 3: CfWebSocketChannelObject (BxNativeObject)

**File:** `crates/matchbox-cf-worker/src/channel.rs`

Reimplements `WebSocketChannelObject` from `websocket.rs` but with callout-based
send/broadcast/close instead of mpsc senders:

```rust
pub struct CfWebSocketChannelObject {
    pub connection_id: String,
    pub request: RequestData,
    pub do_id: String,
}
```

| BoxLang method | Implementation |
|---|---|
| `sendMessage(text)` | Callout: `channel_send(connection_id, type=0, text)` → JS calls `ws.send(text)` |
| `sendJson(value)` | Serialize to JSON string via `bx_to_json()`, then callout `channel_send` |
| `sendBytes(bytes)` | Callout: `channel_send(connection_id, type=1, bytes)` → JS calls `ws.send(bytes)` |
| `broadcastMessage(text)` | Callout: `channel_broadcast(connection_id, type=0, text)` → JS iterates `getWebSockets()` |
| `broadcastJson(value)` | Serialize to JSON, callout `channel_broadcast` |
| `broadcastBytes(bytes)` | Callout `channel_broadcast` with type=1 |
| `close(code, reason)` | Callout: `channel_close(connection_id, code, reason)` → JS calls `ws.close()` |
| `getId()` | Return `self.connection_id` as BxValue string |
| `getPath()` | Return `self.request.path` |
| `getUrl()` | Return `self.request.full_url` |
| `getHTTPHeader(name, default)` | Lookup in `self.request.headers` HashMap |

- [ ] Implement `BxNativeObject` for `CfWebSocketChannelObject`
- [ ] Implement all SocketBox channel methods via callout protocol
- [ ] Implement `bx_to_json` / `json_to_bx` for `sendJson`/`broadcastJson`

### Task 4: JS Shell — Callout Handlers

**File:** `mcf-worker.js` (inside `MatchBoxWebSocketDO`)

- [ ] `async sendToWS(connectionId, type, message)`:
  - Find the WS by iterating `this.ctx.getWebSockets()` and checking
    `ws.deserializeAttachment()?.id === connectionId`
  - If type=0 (text): `ws.send(message)`
  - If type=1 (binary): `ws.send(new Uint8Array(message))`
- [ ] `async broadcastToAll(senderConnectionId, type, message)`:
  - For each `ws` in `this.ctx.getWebSockets()`:
    - Skip the sender: `ws.deserializeAttachment()?.id === senderConnectionId`
    - Send to the rest
  - Performance note: `getWebSockets()` is O(n), send is O(n). Acceptable up
    to thousands of connections per DO.
- [ ] `async closeWS(connectionId, code, reason)`:
  - Find WS by attachment ID, call `ws.close(code, reason)`
- [ ] **Connection metadata persistence on close**: After `ws.close()`, the
    runtime triggers `webSocketClose()` automatically, where we clean up storage.

### Task 5: Two-Path Build — Script API vs JSON Config

**File:** `crates/matchbox-cf-worker/src/build.rs`

- [ ] **Script API path** (`matchbox build --target cf-worker --app app.bxs`):
  - Compile `app.bxs` to chunk, extract `WebSocketConfig` from VM state after
    script execution
  - Embed chunk + WebSocketConfig in WASM custom sections
- [ ] **JSON config path** (`matchbox build --target cf-worker --webroot .`):
  - Read `boxlang.json`, find `config.websocket`
  - Find and compile the handler script (`WebSocket.bx` by default)
  - Embed the handler chunk + WebSocketConfig in WASM custom sections
  - Warn if no `websocket` config found (no WebSocket support will be compiled)
- [ ] Both paths generate:
  - `wrangler.toml` with DO binding for `MatchBoxWebSocketDO`
  - The JS shell template configured with the DO class
  - Migration config with `new_sqlite_classes: ["MatchBoxWebSocketDO"]`

### Task 6: WASM Metadata Sections

- [ ] Add `WebSocketConfig` serialization to WASM custom section `"websocket_config"`:
  ```rust
  // In the compiler/packer
  let config_json = serde_json::to_string(&WebSocketConfig {
      uri: "/ws",
      listener_class: "ChatRoom",
      listener_state: { ... },
      handler: "WebSocket.bx",
  });
  wasm_section("websocket_config", config_json.as_bytes());
  ```
- [ ] Ensure the compiled chunk is also embedded (it contains the listener class
    bytecode that the DO's VM will interpret).
- [ ] JS shell reads these sections in the DO constructor.

### Task 7: Listener Instance State Persistence

A critical challenge: in MatchBox, the listener instance state is in-memory and
persists for the lifetime of the thread. On Workers, the DO can hibernate and
lose its in-memory state.

- [ ] After every `onMessage` call, serialize the listener's instance variables
    and write to DO storage:
    ```javascript
    // Called after vm_on_message returns
    const newState = wasm.exports.vm_get_state(this.vmPtr);
    await this.ctx.storage.put("listener_state", JSON.parse(newState));
    ```
- [ ] **Optimization:** Use `storage.put()` with `{ noCache: true }` to avoid
    unnecessarily caching large state objects. For high-throughput apps, batch
    state writes to once per N messages or use alarm-based periodic sync.
- [ ] **Warning:** Writing to DO storage on every message is expensive (1,000
    ops/sec limit). Document this. For apps that don't need shared state, skip
    persistence entirely.

### Task 8: Tests

- [ ] **Unit test**: `CfWebSocketChannelObject` method dispatch (all 11 methods)
- [ ] **Unit test**: DO VM lifecycle — `vm_init` → `vm_on_connect` → `vm_on_message`
    → `vm_on_close` cycle within a mock DO
- [ ] **Unit test**: Broadcast iterates all registered WS connections
- [ ] **Unit test**: State persistence round-trip — `vm_get_state` after
    listener modifies variables
- [ ] **Unit test**: Hibernation recovery — serialize VM state, destroy VM,
    re-create VM from saved state, verify listener state is intact
- [ ] **Integration test**: `wrangler dev` with echo WebSocket:
    - Connect via `wscat`, send message, verify echo response
    - Connect two clients, verify broadcast reaches both
    - Verify `onClose` fires on client disconnect
- [ ] **Integration test**: Listener state persistence:
    - Connect client A, send increment
    - Connect client B, verify shared counter
    - Disconnect both, reconnect, verify state from DO storage
- [ ] **Integration test**: JSON config path:
    - Write `boxlang.json` with websocket config and `WebSocket.bx`
    - Build and deploy, verify WS endpoint works

### Task 9: Documentation

- [ ] Document the two entry points (script API vs JSON config)
- [ ] Document SocketBox API methods that work identically
- [ ] Document behavioral differences from MatchBox:
    - **DO storage write limits** (1,000 ops/sec) — apps with high-frequency
      state mutations need batching
    - **Hibernation** — DO can sleep; in-memory state is lost but DO storage
      persists it. Constructor runs on every wake.
    - **Deployment disconnects all WebSockets** — deploys restart DOs
    - **32,768 WS per DO limit** — soft cap, memory constrained
    - **128 MB per DO memory limit** — affects number of connections + VM size
    - **`serializeAttachment` 2,048 byte limit** — request metadata only, not
      for large state
- [ ] SocketBox to Cloudflare Workers migration guide
- [ ] Example: chat room with `broadcastMessage`
- [ ] Example: stateful counter with DO storage persistence
- [ ] Example: echo server (minimal)

---

## Key Differences from Original Architect (Correction)

The **most important insight** from the second-pass analysis:

| Aspect | Original Plan (wrong) | Corrected Plan |
|--------|----------------------|----------------|
| DO model | One DO per WebSocket connection | One DO for all WS connections (Hibernation API) |
| Broadcast | DO-to-DO `fetch()` fan-out (expensive) | `this.ctx.getWebSockets()` iteration (native, within same DO) |
| Shared state | Impossible (each DO had own VM) | Natural (single VM shared across WS) |
| Cost | One DO per connection = high cost | One DO per app = minimal cost |
| Hibernation | Not considered | Core feature — DO sleeps when idle |
| DO storage | Not considered | Used for listener state + connection metadata |
| Per-WS metadata | Not considered | `serializeAttachment`/`deserializeAttachment` |
| Ping/pong | Manual handling | `setWebSocketAutoResponse` — free, no wake |

The corrected architecture maps **exactly** to MatchBox's internal model:
- MatchBox: 1 thread = 1 VM = 1 listener instance = N connections
- CF DO: 1 DO = 1 VM = 1 listener instance = N WebSockets (via `getWebSockets()`)

The only new concern is **state persistence** across hibernation, which DO
storage handles cleanly.

---

## File-by-File Implementation Plan

```
crates/matchbox-cf-worker/
├── Cargo.toml                          # + WASM bindgen deps
├── src/
│   ├── lib.rs                          # + vm_init/vm_on_connect/etc exports
│   ├── do_adapter.rs                   # NEW: DO lifecycle → BoxLang VM bridge
│   ├── channel.rs                      # NEW: CfWebSocketChannelObject (BxNativeObject)
│   ├── callout.rs                      # (existing) extend for send/broadcast/close
│   ├── wasm_metadata.rs               # NEW: read/write WASM custom sections
│   └── build.rs                        # (existing) extend for WS config extraction
├── shell/
│   ├── mcf-worker.js                   # + MatchBoxWebSocketDO class
│   └── wrangler.toml                   # + DO binding + migration
└── tests/
    └── websocket_test.rs               # NEW
```

---

## Size & Performance Budget

| Metric | Target | Max |
|--------|--------|-----|
| WASM binary increase (DO adapter + channel) | 20 KB | 40 KB |
| DO cold start (constructor: VM init + listener instantiation) | 50 ms | 200 ms |
| DO warm message latency (text, < 1 KB) | 5 ms | 20 ms |
| DO broadcast (10 connections, < 1 KB) | 10 ms | 50 ms |
| DO state persistence per message | 5 ms | 30 ms |
| Memory per DO (idle, hibernated) | 0 (evicted) | — |
| Memory per DO (active, 10 WS, 1 VM) | 1 MB | 5 MB |
| WebSockets per DO | up to 1,000 | 32,768 (hard limit) |

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| VM re-initialization on every hibernation wake adds latency | Medium | Medium | Keep constructor minimal; use `blockConcurrencyWhile` with cached chunk |
| DO storage 1,000 ops/sec limit hit by high-throughput state mutations | Medium | High | Batch state writes; make persistence opt-in BIF (`cf.websocketPersist()`) |
| `getWebSockets()` iteration cost at high connection counts | Low | Medium | Test with 1,000+ connections; optionally use tagged WS groups |
| BoxLang VM memory exceeds DO's 128 MB limit | Low | High | Track VM memory usage; add GC triggers; warn at 64 MB |
| Deployment disconnects all WebSockets | Medium | High | Document in migration guide; recommend graceful reconnect client-side |
| WASM callout overhead per channel method call | Medium | Low | Batch send operations where possible |
