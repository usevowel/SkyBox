---
title: Wrangler Configuration
description: How to configure wrangler.toml for a matchbox-cf-worker project.
---

```toml
name = "my-boxlang-ws-app"
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

:::caution
Do NOT add `[wasm_modules]` to `wrangler.toml`. The WASM module is imported directly via `import wasmModule from './worker.wasm'` in JS. Wrangler/esbuild handles the import natively.

For `wrangler dev --local`, ensure `worker.wasm` resolves:
```bash
ln -sf dist/worker.wasm worker.wasm
```
:::
