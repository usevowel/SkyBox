# MatchBox Cloudflare Workers — Architecture Overview

## Goal

Enable any BoxLang application compiled by MatchBox to be deployed and served as a
[Cloudflare Workers](https://workers.cloudflare.com/) serverless function with
near-zero cold start, minimal WASM payload, and full access to Cloudflare's
binding ecosystem (KV, R2, D1, Queues, etc.).

---

## Existing Foundation

MatchBox already has WASM support via two paths:

| Path | Target | Description |
|------|--------|-------------|
| **Browser (Web)** | `--target wasm` / `--target js` | `wasm32-unknown-unknown` — wasm-bindgen generated JS that loads a WASM bundle and invokes `BoxLangVM` APIs. Used for browser-side execution. |
| **WASI HTTP** | `--target wasi-http` | `wasm32-wasip2` — a `wasi:http/proxy` component that serves a pre-baked webroot. Uses `crates/matchbox-wasi-http-runner`. |

Cloudflare Workers supports the **`wasi:http/proxy`** world (via `workerd`), making
the WASI HTTP runner the closest starting point.

---

## Approach Comparison

### Option A — WASI HTTP Component (Recommended Path)

Compile to `wasm32-wasip2` using the existing `wasi:http/proxy` world that
Cloudflare Workers directly supports.

**Pros:**
- Workers natively understands the `wasi:http/proxy` world
- Reuses the existing `matchbox-wasi-http-runner` crate
- Standard WASI tooling (no wasm-bindgen dependency)
- Works with `wrangler deploy` via `wrangler.toml` pointing to a `.wasm` file

**Cons:**
- Workers' WASI implementation is partial — filesystem (`wasi:filesystem`) is
  not available, some `wasi:io` features differ
- Must audit every WASI call the VM makes and provide a shim layer

### Option B — Custom `fetch()` + JS Glue

Build a purpose-built `matchbox-cf-worker` crate that exposes a single
`handleRequest(name, argsJson)` WASM export and wrap it with a thin JS shim
that implements `fetch(event)` → pumps the VM → returns `new Response()`.

**Pros:**
- Full control over the request/response lifecycle
- No dependency on Workers' WASI implementation details
- Can precisely map Cloudflare bindings into BoxLang scope
- Easier to implement async event pump (VM cooperative scheduling)

**Cons:**
- More custom glue code
- No reuse of the WASI HTTP runner crate

### Recommendation

Use **Option B** for the initial implementation — it gives us maximum control
over the worker lifecycle, bindings, and error handling. The WASI HTTP runner
can serve as a reference but Cloudflare's WASI support is still maturing and
we want a clean, auditable runtime boundary.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────┐
│  wrangler deploy / dev                              │
│  (wrangler.toml)                                    │
└────────────┬────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────┐
│  JS Shell (handlers/mcf-worker.js)                  │
│                                                     │
│  - export default { fetch }                         │
│  - Creates VM on first request (warmup)             │
│  - Converts FetchEvent → BxValue (request struct)   │
│  - Pumps VM event loop                              │
│  - Converts BxValue → Response                      │
│  - Calls Cloudflare binding stubs                   │
└────────────┬────────────────────────────────────────┘
             │  WebAssembly.instantiate()
             ▼
┌─────────────────────────────────────────────────────┐
│  matchbox-cf-worker.wasm                            │
│  (compiled via --target wasm32-unknown-unknown)     │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │  matchbox_vm (JIT-disabled, selected BIFs)   │   │
│  │  - Stack VM + Fiber Scheduler                 │   │
│  │  - Type system (BxValue, BxString, etc.)      │   │
│  └──────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────┐   │
│  │  matchbox-compiler (compile step only)       │   │
│  │  (runs at build time, not in worker)         │   │
│  └──────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────┐   │
│  │  Embedded bytecode (postcard-serialized)     │   │
│  └──────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────┐   │
│  │  cf-worker runtime shims                     │   │
│  │  - request → BxValue converters              │   │
│  │  - binding bridge (KV, R2, D1 stubs)         │   │
│  │  - response ← BxValue converters             │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Data Flow

```
Request ──► JS fetch() ──► wasm_handle_request(json) ──► VM.dispatch(event)
                                                              │
                         ┌────────────────────────────────────┤
                         ▼                                    ▼
                  bx CF_BIFs                           User handler code
                  (binding access)                      (written in BoxLang)
                         │                                    │
                         └────────────────────────────────────┤
                                                              ▼
                                                  VM returns BxValue
                                                              │
                                                              ▼
                    JS Response ◄── wasm_get_response(ptr) ───┘
```

---

## Key Constraints

| Constraint | Implication |
|-----------|-------------|
| 128 MB memory limit | VM must be compiled with `opt-level=z`, `panic=abort`, `lto=true` |
| 10ms CPU time per request (free tier) | Async I/O via VM pump; don't block on `sleep()` |
| 1 MB request/response body (free) | Stream larger bodies via R2 |
| No filesystem | Disable `bif-io`, `bxm` template filesystem lookups |
| No raw TCP | Disable server sockets, `listen()` |
| Sub-request limit (50) | BIFs like `http` requests count toward this |
| WASM cannot call JS directly | JS → WASM calls only; use JS bridge pattern for bindings |
