# Build Pipeline — From BoxLang to Cloudflare Worker

## Overview

The build pipeline takes BoxLang source code and produces a single `.wasm` file
(with embedded bytecode) that runs on Cloudflare Workers.

```
.box. files  ──►  matchbox compile  ──►  .bxb bytecode  ──►  embed in WASM
                                                                │
                                                          ┌─────┘
                                                          ▼
                                          matchbox-cf-worker.wasm
                                                          │
                                                          ▼
                                              wrangler deploy
```

---

## Phase 1: Develop the `matchbox-cf-worker` Crate

### New Crate: `crates/matchbox-cf-worker`

This will be the runner stub — analogous to `matchbox-runner` for native and
`matchbox-wasi-http-runner` for WASI, but targeting Cloudflare Workers.

**Location:** `crates/matchbox-cf-worker/`

**Cargo.toml skeleton:**

```toml
[package]
name = "matchbox_cf_worker"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["cdylib"]

[dependencies]
matchbox_vm = { path = "../matchbox-vm", default-features = false, features = [] }
postcard = { version = "1.0", features = ["alloc", "use-std"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
anyhow = "1.0"

[target.'cfg(target_arch = "wasm32")'.dependencies]
wasm-bindgen = "=0.2.114"
js-sys = "0.3.77"

[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

**Key design decisions:**
- `default-features = false` on `matchbox_vm` — no JIT (Cranelift is large),
  no `bif-io` (no filesystem), no `bif-jni`, no `bif-http` (use worker
  `fetch()` instead), no `bif-cli` (no terminal)
- Enable `bif-crypto` — useful for web, and sha2 compiles fine to WASM
- `wasm32-unknown-unknown` target — not `wasm32-wasip2` — so we have full
  control over exports via `#[wasm_bindgen]`

**Exports (via `#[wasm_bindgen]`):**

```rust
// Called once at worker startup to load embedded bytecode
#[wasm_bindgen]
pub fn init_worker(bytecode: &[u8]) -> Result<(), JsValue>;

// Called for each incoming HTTP request
#[wasm_bindgen]
pub async fn handle_request(
    method: &str,
    path: &str,
    headers_json: &str,
    body: Option<Vec<u8>>,
    query_json: &str,
    binding_accessor_json: &str,  // pre-resolved binding values from JS
) -> Result<JsValue, JsValue>;   // returns { status, headers, body }

// Cleanup / stats (optional)
#[wasm_bindgen]
pub fn worker_stats() -> String;
```

---

## Phase 2: MatchBox CLI Integration

Add a new target to the existing `matchbox` CLI:

```
matchbox --target cf-worker my_app.bxs --output dist/worker.wasm
```

This should:

1. Compile all `.bxs` / `.bxm` source to postcard-serialized `Chunk`
2. Read the pre-compiled `matchbox_cf_worker.wasm` stub from `stubs/`
3. Embed the bytecode into a custom WASM section (e.g. `"matchbox:bytecode"`)
4. (Optionally) run `wasm-opt -Oz` to minimize binary size
5. Output the final `.wasm` file

**Stub registration** (in `src/stubs.rs`):

```rust
stubs.insert("cf-worker", include_bytes!("../stubs/runner_stub_cf_worker.wasm"));
```

---

## Phase 3: JS Shell Generation

When producing a worker, also generate (or the user writes) a minimal JS shell:

```js
// mcf-worker.js — the Cloudflare Workers entry point
import wasmModule from './worker.wasm';

let vm = null;
let initPromise = null;

export default {
    async fetch(request, env, ctx) {
        if (!vm) {
            if (!initPromise) {
                initPromise = (async () => {
                    const instance = await wasmModule();
                    // bytecode is in a custom section read by init_worker
                    vm = instance;
                })();
            }
            await initPromise;
        }

        const url = new URL(request.url);
        const body = request.method === 'GET' || request.method === 'HEAD'
            ? null
            : new Uint8Array(await request.arrayBuffer());

        const headers = {};
        request.headers.forEach((v, k) => { headers[k] = v; });

        const bindingAccessor = {
            // Serialize env bindings so Rust can read them
            kv: serializeBindings(env, 'KV_'),
            r2: serializeBindings(env, 'R2_'),
            d1: serializeBindings(env, 'D1_'),
            queue: serializeBindings(env, 'QUEUE_'),
            secrets: serializeBindings(env, 'SECRET_'),
            vars: serializeBindings(env, 'VAR_'),
        };

        const result = await vm.handle_request(
            request.method,
            url.pathname + url.search,
            JSON.stringify(headers),
            body,
            JSON.stringify(Object.fromEntries(url.searchParams)),
            JSON.stringify(bindingAccessor),
        );

        return new Response(result.body, {
            status: result.status,
            headers: result.headers,
        });
    },
};
```

---

## Phase 4: Wrangler Integration

### wrangler.toml

```toml
name = "my-boxlang-app"
main = "mcf-worker.js"
compatibility_date = "2025-01-01"

[[wasm_modules]]
name = "worker"
path = "dist/worker.wasm"

# Bindings
[[kv_namespaces]]
binding = "KV_MYSTORE"
id = "abc123"

[[r2_buckets]]
binding = "R2_ASSETS"
bucket_name = "my-assets"

[[d1_databases]]
binding = "D1_DB"
database_name = "my-db"
database_id = "xxx"
```

### Build Script (package.json or box.json)

```json
{
    "scripts": {
        "build:worker": "matchbox --target cf-worker src/index.bxs --output dist/worker.wasm",
        "deploy": "npm run build:worker && wrangler deploy",
        "dev": "matchbox --target cf-worker src/index.bxs --output dist/worker.wasm --watch && wrangler dev"
    }
}
```

---

## Phase 5: Example — Hello World BoxLang Worker

**src/index.bxs:**

```boxlang
function handleRequest( event ) {
    var name = event.url.name ?: "World";
    return {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<h1>Hello #name#!</h1>"
    };
}
```

**Build & deploy:**

```bash
matchbox --target cf-worker src/index.bxs --output dist/worker.wasm
wrangler deploy
```

---

## Binary Size Targets

| Component | Size |
|-----------|------|
| VM core (stack + fiber scheduler + types) | ~80 KB |
| Compiler (excluded, not embedded) | 0 KB |
| BIFs (selected: array, struct, string, math, crypto) | ~40 KB |
| Standard library (prelude) | ~20 KB |
| User bytecode | variable |
| cf-worker runtime shims | ~15 KB |
| **Total (typical app)** | **~155–200 KB** |
| After `wasm-opt -Oz` | **~120–160 KB** |

This is well within the Cloudflare Workers 1 MB free tier WASM limit and
the 128 MB total memory limit.
