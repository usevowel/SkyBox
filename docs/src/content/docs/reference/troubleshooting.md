---
title: Troubleshooting
description: Common issues and solutions.
---

## WASM Build Fails

- Check `wasm-bindgen` version matches the crate version in `Cargo.toml`
- Ensure `wasm32-unknown-unknown` target is installed: `rustup target add wasm32-unknown-unknown`
- Check for `Instant::now()` usage — must use `web_time::Instant` on WASM

## Workerd Test Fails

- Check capnp syntax (trailing commas and semicolons)
- Ensure WASM file exists at expected path
- Check custom sections: `wasm-objdump -x dist/worker.wasm | grep skybox`
- If `wrangler dev` works but `workerd` doesn't, check the module name in capnp

## Wrangler Dev Fails

| Error | Fix |
|-------|-----|
| `ENOENT worker.wasm` | `ln -sf dist/worker.wasm worker.wasm` |
| "Wasm binding" error | Remove `[wasm_modules]` from `wrangler.toml` |
| "DO class not found" | Check `[[durable_objects.bindings]]` and `[[migrations]]` |

## WebSocket Won't Connect

- Worker returns `426 Upgrade Required` for plain HTTP — this is expected
- Check wrangler/workerd console for runtime errors
- Use Node.js ws package: `node -e "new (require('ws'))('ws://localhost:8787/').on('message',d=>console.log(d.toString())).on('open',function(){this.send('hello')})"`
