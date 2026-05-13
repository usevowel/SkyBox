---
title: Build Pipeline
description: How a .bx file becomes a deployable worker.wasm.
---

The build pipeline has 4 steps orchestrated by `examples/build.sh`:

```bash
bash examples/build.sh <example-dir> <bx-source> <listener-class> [state-json] [state-file]
```

## Step 1: Compile Rust to WASM

```bash
cargo build -p matchbox-cf-worker --features js --target wasm32-unknown-unknown --release
```

Produces `target/wasm32-unknown-unknown/release/matchbox_cf_worker.wasm` — the BoxLang VM compiled to WebAssembly.

## Step 2: Run wasm-bindgen

```bash
wasm-bindgen <wasm> --out-dir bindgen --target web
```

Generates JS glue code (`wasm_glue.js`) and a processed WASM binary. This handles the JS↔WASM string/pointer conversion layer.

## Step 3: Embed BoxLang Bytecode

```bash
cargo run -p cf-worker-builder -- \
  --source MyListener.bx \
  --listener-class MyListener \
  --input bindgen/matchbox_cf_worker_bg.wasm \
  --output dist/worker.wasm \
  --state '{}'
```

The `cf-worker-builder` CLI tool:
1. Compiles the `.bx` source to a BoxLang `Chunk` (bytecode)
2. Serializes the `Chunk` with `postcard`
3. Embeds it as a WASM custom section `skybox:chunk`
4. Embeds the `WebSocketConfig` JSON as `skybox:ws_config`

## Step 4: Copy JS Glue

```bash
cp bindgen/matchbox_cf_worker.js wasm_glue.js
```

## Static Assets (Optional)

For apps with a Web UI (like the chatroom demo), static assets (CSS, JS, images) are served via Cloudflare's `[assets]` feature:

```
example/
├── assets/
│   ├── css/
│   │   └── style.css          # Source assets
│   └── js/
│       └── chat.js
├── build-multi.sh              # Multi-file build with asset copy step
├── dist/
│   ├── worker.wasm             # Compiled WASM
│   └── assets/                 # Copied during build
│       ├── css/style.css
│       └── js/chat.js
└── wrangler.toml               # [assets] section points to dist/assets
```

The build copies `assets/` → `dist/assets/` before running the standard pipeline:

```bash
# In build-multi.sh:
mkdir -p dist/assets/css dist/assets/js
cp -rf assets/css/* dist/assets/css/
cp -rf assets/js/*  dist/assets/js/
```

The `wrangler.toml` `[assets]` section tells Cloudflare to serve files at the edge:

```toml
[assets]
directory = "dist/assets"
```

- Requests to `/css/style.css` serve `dist/assets/css/style.css`
- Requests to `/js/chat.js` serve `dist/assets/js/chat.js`
- The Worker `fetch()` has a fallback: `if (url.pathname.startsWith('/assets/') && env.ASSETS) return env.ASSETS.fetch(request)`

## Multi-File Builds

For complex apps with multiple `.bx` source files, a `build-multi.sh` script concatenates all sources before the standard pipeline:

1. Concatenate all `.bx` files (e.g. `src/listeners/ChatRoom.bx`, `src/handlers/MessageRouter.bx`)
2. Copy `assets/` → `dist/assets/`
3. Run standard build pipeline on the merged source

## Output

| File | Size | Content |
|------|------|---------|
| `dist/worker.wasm` | ~1.3 MB | BoxLang VM + your bytecode |
| `wasm_glue.js` | ~37 KB | wasm-bindgen JS bindings |
| `dist/assets/` | varies | Static files (CSS, JS) served at edge |
