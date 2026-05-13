---
title: Wrangler Configuration
description: How to configure wrangler.toml for a matchbox-cf-worker project.
---

```toml
name = "my-boxlang-ws-app"
main = "mcf-worker.js"
compatibility_date = "2025-01-01"
account_id = "your-account-id"

# DO NOT add [wasm_modules] — the WASM is imported natively
# via `import wasmModule from './worker.wasm'` in mcf-worker.js

# Static assets (CSS, JS, images — optional, uncomment if needed)
# [assets]
# directory = "dist/assets"

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

## Static Assets (`[assets]` section)

If your app has a Web UI with CSS/JS files, add an `[assets]` section:

```toml
[assets]
directory = "dist/assets"
```

This tells Cloudflare to serve files from `dist/assets/` at the edge **before** the Worker runs:

| Request | Serves |
|---------|--------|
| `/css/style.css` | `dist/assets/css/style.css` |
| `/js/chat.js` | `dist/assets/js/chat.js` |

If an asset path doesn't match, the request falls through to the Worker. The Worker `fetch()` also includes a fallback: `env.ASSETS.fetch(request)` for programmatic access.

Assets are copied during the build step (see [Build Pipeline](/build/pipeline)).
