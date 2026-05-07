---
title: Quick Start
description: Get a BoxLang WebSocket app running on Cloudflare Workers in 5 minutes.
---

## 1. Write a Listener

Create a BoxLang class with three lifecycle methods:

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

## 2. Build the WASM Worker

```bash
bash crates/matchbox-cf-worker/examples/build.sh \
    examples/myapp \
    examples/myapp/EchoListener.bx \
    EchoListener
```

This runs the full pipeline: `cargo build --target wasm32` → `wasm-bindgen` → `cf-worker-builder` (embed BoxLang bytecode as WASM custom sections) → copy JS glue.

## 3. Test Locally

Create a test configuration and run with workerd:

```bash
npx workerd serve test_myapp.capnp
curl http://localhost:8787/
```

Or use wrangler dev:

```bash
cd examples/myapp
ln -sf dist/worker.wasm worker.wasm
npx wrangler dev --local
```

## 4. Connect

```javascript
// Browser or Node.js
const ws = new WebSocket("ws://localhost:8787/");
ws.onmessage = (event) => console.log(event.data);
ws.send("Hello!");
// → "echo:Hello!"
```

## 5. Deploy to Cloudflare

```bash
cd examples/myapp
npx wrangler deploy
```
