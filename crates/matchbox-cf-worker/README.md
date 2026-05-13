# matchbox-cf-worker — BoxLang WebSockets on Cloudflare Workers

Run [SocketBox-style](https://github.com/ortus-solutions/matchbox) BoxLang
WebSocket applications on **Cloudflare Workers + Durable Objects** with near-zero
cold start, automatic hibernation, and full access to the Hibernation WebSocket API.

## Prerequisites

- **Rust** (nightly) with `wasm32-unknown-unknown` target
- **wasm-bindgen** CLI v0.2.114 (`cargo install wasm-bindgen-cli --version 0.2.114`)
- **Node.js** 18+ with **npm** (for `wrangler` and `workerd`)
- **wrangler** (`npx wrangler`) — for dev and deploy to Cloudflare
- **workerd** (`npx workerd`) — for local testing without Cloudflare account

## Quick Start

### 1. Write a BoxLang WebSocket Listener

```boxlang
// EchoListener.bx
class EchoListener {
    function onConnect(required channel) {
        channel.sendMessage("Welcome to Echo!");
    }
    function onMessage(required message, required channel) {
        channel.sendMessage("echo:" & message);
    }
    function onClose(required channel) {}
}
```

### 2. Build the WASM worker

```bash
bash crates/matchbox-cf-worker/examples/build.sh \
    examples/myapp \
    examples/myapp/EchoListener.bx \
    EchoListener
```

This runs the full pipeline: `cargo build --target wasm32 → wasm-bindgen → cf-worker-builder (embed BoxLang bytecode)`.

### 3. Test locally with workerd

Create `test_myapp.capnp` and `test_myapp.js`, then:

```bash
npx workerd serve test_myapp.capnp
curl http://localhost:8787/
```

### 4. Deploy to Cloudflare

```bash
cd examples/myapp
npx wrangler deploy
```

## Project Structure

```
crates/matchbox-cf-worker/
├── Cargo.toml                 # Crate config (cdylib + rlib, WASM target)
├── README.md                  # This file
├── AGENTS.md                  # Developer conventions & BIF constraints
├── src/
│   ├── lib.rs                 # Public module declarations
│   ├── types.rs               # Core types (WebSocketConfig, RequestData, CalloutMessage)
│   ├── channel.rs             # CfWebSocketChannelObject (BxNativeObject impl)
│   ├── do_adapter.rs          # DoState + CalloutBridge implementations
│   ├── wasm_exports.rs        # #[wasm_bindgen] exports
│   └── wasm_metadata.rs       # WASM custom section read/write
├── shell/
│   ├── mcf-worker.js          # Cloudflare Worker + DO entry point
│   └── wrangler.toml          # Template wrangler config
├── examples/
│   ├── build.sh               # Full build pipeline script
│   ├── run-workerd-test.sh    # Run all workerd integration tests
│   ├── echo/                  # Basic echo server
│   ├── counter/               # Stateful counter (demoes DO state persistence)
│   ├── chatroom/              # Multi-client chat with broadcast
│   ├── moonphase/             # Moon phase calculator (JSON responses)
│   ├── romannumeral/          # Roman numeral converter
│   ├── jsonfmt/               # JSON validator (manual parsing, no deserializeJSON)
│   ├── textanalyzer/          # Word/sentence frequency analyzer
│   └── todo/                  # Collaborative todo list
├── samples/                   # Reference BoxLang listener snippets
└── tests/
    └── websocket_test.rs      # Rust-native test suite
```

## Demos

All demos are tested end-to-end under `workerd`. Each has automated tests in its directory.

| Demo | Description | Commands | Test |
|------|-------------|----------|------|
| **echo** | Basic echo server | anything | manual |
| **counter** | Stateful click counter | `increment`, `view` | `OK: all infra tests passed` |
| **chatroom** | Multi-client chat | `msg:text`, `nick:name` | `OK: state keys=messages,room,usercount,users` |
| **moonphase** | Moon phase calculator | `now`, `list`, `help` | `OK: phase=Waxing Crescent ill=10 list=8` |
| **romannumeral** | Roman↔integer converter | `toint MMXXV`, `sort III,II,IV,IX` | `OK: toint=2025, sort=II,III,IV,IX` |
| **jsonfmt** | JSON structural validator | `validate {...}`, `count [...]` | `OK: valid=true invalid=false` |
| **textanalyzer** | Word/sentence/text analysis | `analyze TEXT`, `words TEXT` | `OK: words=4 freq=hello` |
| **todo** | Collaborative todo list | `add task`, `done 1`, `del 1`, `list`, `clear` | `OK: add+list+done passed` |

## Build Pipeline

```
┌──────────────┐    ┌───────────────┐    ┌────────────────────┐
│  BoxLang .bx │───▶│  cf-worker-   │───▶│  dist/worker.wasm  │
│  source code │    │  builder      │    │  (custom sections) │
└──────────────┘    │  (CLI)        │    └────────────────────┘
                    │               │
┌──────────────┐    │  Compiles BX, │    ┌────────────────────┐
│  Rust WASM   │───▶│  serializes   │───▶│  skybox:chunk      │
│  (cargo)     │    │  bytecode,    │    │  (BoxLang bytecode)│
└──────────────┘    │  embeds into  │    └────────────────────┘
                    │  WASM custom  │    ┌────────────────────┐
┌──────────────┐    │  sections     │───▶│  skybox:ws_config  │
│  wasm-       │───▶│               │    │  (JSON config)     │
│  bindgen     │    └───────────────┘    └────────────────────┘
└──────────────┘
```

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Worker fetch()                                              │
│  ─── validates Upgrade: websocket header                     │
│  ─── routes to DO via idFromName("default")                  │
└──────────────────────┬───────────────────────────────────────┘
                       │ WebSocketPair
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  Durable Object: MatchBoxWebSocketDO                         │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  BoxLang VM (single, shared across all connections)   │    │
│  │  ┌────────────────────────────────────────────────┐   │    │
│  │  │ Listener instance (your class)                  │   │    │
│  │  │  variables.state = shared across ALL WS conns   │   │    │
│  │  └────────────────────────────────────────────────┘   │    │
│  │                                                       │    │
│  │  CfWebSocketChannelObject (per-connection):           │    │
│  │  • sendMessage / sendJson / sendBytes                 │    │
│  │  • broadcastMessage / broadcastJson / broadcastBytes  │    │
│  │  • close, getId, getPath, getUrl, getHTTPHeader       │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  DO Storage (SQLite, survives hibernation):                  │
│  • "listener_state" → { count: 3 }                           │
│  • "connections" → { conn-uuid: { path, headers } }         │
│                                                              │
│  WebSocket connections (up to 32,768 per DO):                │
│  ┌──────┐ ┌──────┐ ┌──────┐   ← ctx.getWebSockets()         │
│  │conn1 │ │conn2 │ │conn3 │                                 │
│  └──────┘ └──────┘ └──────┘                                 │
└──────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### One DO per app, not per connection
Unlike naive implementations that create one Durable Object per WebSocket
connection, this adapter uses **one DO per app** sharing a single BoxLang VM.
This matches how the native MatchBox server works (one thread, one VM,
`HashMap<id, Sender>` for broadcast).

### Hibernation API (not the standard WebSocket API)
The DO uses `ctx.acceptWebSocket(server)` instead of
`server.accept()`. This allows the DO to **hibernate** when idle — clients
stay connected but the DO is evicted from memory. No billable duration
accrues until the next message arrives.

### Broadcast via getWebSockets()
Broadcast iterates `ctx.getWebSockets()`, the native DO way to
find all connected WebSockets.

## Listener API

### Required methods

```boxlang
class MyListener {
    function onConnect(required channel) { }
    function onMessage(required message, required channel) { }
    function onClose(required channel) { }
}
```

### Channel Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `sendMessage` | `sendMessage(text)` | Send a text message to this connection |
| `sendText` | `sendText(text)` | Alias for sendMessage |
| `sendJson` | `sendJson(value)` | Serialize a value to JSON and send as text |
| `sendBytes` | `sendBytes(bytes)` | Send binary data to this connection |
| `broadcastMessage` | `broadcastMessage(text)` | Send text to all connections except sender |
| `broadcastText` | `broadcastText(text)` | Alias for broadcastMessage |
| `broadcastJson` | `broadcastJson(value)` | Serialize to JSON and broadcast |
| `broadcastBytes` | `broadcastBytes(bytes)` | Broadcast binary data |
| `close` | `close([code[, reason]])` | Close this connection |
| `getId` | `getId()` | Return this connection's unique ID |
| `getPath` | `getPath()` | Return the request path |
| `getUrl` | `getUrl()` | Return the full request URL |
| `getHTTPHeader` | `getHTTPHeader(name[, default])` | Get an HTTP header value |

## Creating a New Project

```bash
# 1. Create example directory
mkdir -p examples/myapp
cd examples/myapp

# 2. Write your listener
cat > MyListener.bx << 'EOF'
class MyListener {
    function onConnect(required channel) {
        channel.sendJson({"type":"welcome","service":"My App"});
    }
    function onMessage(required message, required channel) {
        channel.sendMessage("You said: " & message);
    }
    function onClose(required channel) {}
}
EOF

# 3. Copy shell files
cp ../../shell/mcf-worker.js ./
cp ../../shell/wrangler.toml ./

# 4. Create package.json
cat > package.json << 'EOF'
{
  "name": "skybox-app",
  "scripts": {
    "build": "bash ../build.sh . MyListener.bx MyListener",
    "test:workerd": "node test_myapp.js",
    "dev": "npx wrangler dev --port 8787 --local",
    "deploy": "npx wrangler deploy"
  }
}
EOF

# 5. Build
npm run build

# 6. Dev
npm run dev
```

## Wrangler Configuration

```toml
name = "skybox-app"
main = "mcf-worker.js"
compatibility_date = "2025-01-01"
account_id = "your-account-id"

[[durable_objects.bindings]]
name = "WEBSOCKET_DO"
class_name = "MatchBoxWebSocketDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["MatchBoxWebSocketDO"]
```

> **Note**: The WASM module is imported via ES module import in `mcf-worker.js`:
> ```js
> import wasmModule from './worker.wasm';
> ```
> On first `wrangler dev`, create a symlink so wrangler can resolve the import:
> ```bash
> ln -sf dist/worker.wasm worker.wasm
> ```

## WASM BIF Limitations

BoxLang on the `wasm32-unknown-unknown` target has limited BIF support.
The following BIFs are **not available**:

| Unavailable BIF | Alternative |
|----------------|-------------|
| `deserializeJSON` | Manual structural validation (see jsonfmt demo) |
| `int(string)` | N/A — avoid string-to-int conversion |
| `val(string)` | N/A — avoid string-to-number conversion |
| `asc(char)` | Character comparison: `c >= "0" && c <= "9"` |
| `chr(num)` | N/A |
| `dateFormat`, `parseDateTime` | N/A |
| `year`, `month`, `day` | N/A |
| `pi`, `sin`, `abs` | Compute manually |
| `reReplace` | Manual character filtering (see textanalyzer demo) |
| `replace` | Manual iteration (see textanalyzer demo) |

## Testing

### Workerd (no Cloudflare account needed)

Each example has a workerd capnp config and a test JS file. Run individual tests:

```bash
# Start workerd
cd examples/moonphase
npx workerd serve test_moonphase.capnp

# In another terminal
curl http://localhost:8790/
```

### Wrangler dev

```bash
cd examples/moonphase
npx wrangler dev --port 8787 --local
# Connect via WebSocket:
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8787/');
ws.on('message', d => console.log(d.toString()));
ws.on('open', () => ws.send('now'));
"
```

## Limits & Constraints

| Constraint | Value | Notes |
|-----------|-------|-------|
| Max WS per DO | 32,768 | Hard limit from Hibernation API |
| Memory per DO | 128 MB | Shared between VM + connections |
| DO storage ops | 1,000/sec | Limit `storage.put()` calls |
| WS message size | 1 MB | Hard limit from Workers |
| Attachment size | 2,048 bytes | `serializeAttachment` limit |
