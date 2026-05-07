# Implementation Roadmap

## Phase 1 — Core Adapter (Weeks 1–3)

**Goal:** A BoxLang function can be called from a Cloudflare Worker and return
an HTTP response.

### Tasks

- [ ] Create `crates/matchbox-cf-worker` crate
- [ ] Implement `init_worker(bytecode)` — loads bytecode from custom WASM section
- [ ] Implement `handle_request(...)` — converts request → BxValue, dispatches,
      converts response → JSON
- [ ] Add `--target cf-worker` to the MatchBox CLI
- [ ] Add stub registration in `src/stubs.rs`
- [ ] Add bytecode embedding via custom WASM section
- [ ] Add the JS shell minimal template (`mcf-worker.js`)
- [ ] Build a "Hello World" working end-to-end

### Deliverable

```bash
matchbox --target cf-worker hello.bxs --output dist/worker.wasm
wrangler dev
curl http://localhost:8787/hello
# → "Hello from BoxLang!"
```

### Size Budget

| Artifact | Target | Max |
|----------|--------|-----|
| `worker.wasm` | 120 KB | 250 KB |
| Cold start | 50 ms | 200 ms |
| First request | 100 ms | 500 ms |

---

## Phase 2 — Binding Support (Weeks 4–5)

**Goal:** BoxLang code can read/write KV, R2, D1, and environment variables.

### Tasks

- [ ] Implement callout protocol (WASM ↔ JS message passing)
- [ ] Add `cf.kv()`, `cf.r2()`, `cf.d1()`, `cf.env()`, `cf.var()` BIFs (Rust)
- [ ] Add JS-side callout handler in the shell
- [ ] Add binding accessor serialization in the JS shell
- [ ] Write test fixtures for each binding type
- [ ] Build error handling for missing/unconfigured bindings

### Deliverable

```boxlang
function handleRequest(event) {
    var data = cf.kv("DATA").get("key");
    return { status: 200, body: data };
}
```

---

## Phase 3 — App Server / Routing (Weeks 6–7)

**Goal:** The `web.server()` / ColdBox-style routed app pattern works on
Cloudflare Workers.

### Tasks

- [ ] Embed route table metadata alongside bytecode
- [ ] Implement server-side router in the adapter
- [ ] Support `:param` path segments
- [ ] Support `event.renderJson()`, `event.renderHtml()` etc.
- [ ] Support method-specific handlers (`index.get.bxs`, `user.post.bxs`)
- [ ] Add compile-time route validation for cf-worker target
- [ ] Add BIF shims for app-server helpers (cookies, sessions via KV)

### Deliverable

```
# Directory-based routing
src/
├── index.bxs            # GET /
├── users/
│   ├── index.bxs        # GET /users
│   └── [id].bxs         # GET /users/:id
└── api/
    └── data.post.bxs    # POST /api/data
```

---

## Phase 4 — Production Readiness (Weeks 8–9)

**Goal:** Production-grade error handling, observability, and performance.

### Tasks

- [ ] Structured error responses (JSON error with stack trace)
- [ ] Logging: forward `console.log` / `systemOut` to wrangler logs
- [ ] Tail Workers support (wrangler tail shows BoxLang logs)
- [ ] `wasm-opt -Oz` integration in the build pipeline
- [ ] Cold-start optimization: lazy init, warmup endpoint
- [ ] Binary size regression tests in CI
- [ ] Documentation: getting started guide, binding reference, migration guide

---

## Phase 5 — Advanced Features (Weeks 10+)

### WebSocket Support

- [ ] Map WebSocket upgrade in JS shell
- [ ] Implement `event.webSocket` in BoxLang
- [ ] Pump VM per WebSocket message
- [ ] Durable Object integration for stateful WebSockets

### Scheduled Tasks (Cron Triggers)

- [ ] Support `@scheduled` handler in BoxLang
- [ ] Map Cloudflare cron triggers to the scheduled handler
- [ ] Implement `event.cron` struct

### Queue Consumer

- [ ] Support `onQueueEvent` handler
- [ ] Implement `msg.ack()` and `msg.retry()`

### Durable Objects

- [ ] Create a DO-friendly VM instance
- [ ] Implement `cf.durableObject()` accessor
- [ ] Support DO storage API via callout protocol

### Service Bindings

- [ ] Implement `cf.service("name").fetch(request)` for service-to-service calls

### Assets (Experimental Workers Static Assets)

- [ ] Integrate with Cloudflare Workers Static Assets for `.bxm` and static files
- [ ] Enable `--webroot` equivalent via assets API

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| WASM binary too large | Medium | High | Aggressive tree-shaking, `wasm-opt`, feature flags |
| Workers WASI constraints block VM | Low | High | Use `wasm32-unknown-unknown` with custom exports, not WASI |
| Binding callout overhead too high | Medium | Medium | Batch callouts, reduce round-trips |
| Fiber scheduler doesn't yield correctly on Workers | Medium | High | Unit-test pump loop with mock JS host |
| `workerd` removes/changes WASM support | Low | Very High | Monitor CF changelog; contribute to CF Workers WASM WG |
| MatchBox upstream changes break adapter | Medium | Medium | Pin version in CI; contribute adapter upstream |
| Cold start exceeds 1s on free tier | High | Medium | Warmup strategies, paid tier with reserved memory |
