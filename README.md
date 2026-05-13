# SkyBox

BoxLang on Cloudflare Workers — run [BoxLang](https://boxlang.io) WebSocket and HTTP applications at the edge with near-zero cold starts, Durable Object persistence, and automatic hibernation.

SkyBox compiles BoxLang `.bx` source files into WebAssembly and deploys them as Cloudflare Workers. The project builds on the [MatchBox](https://github.com/ortus-solutions/matchbox) BoxLang runtime.

## Naming Convention

All deployed Cloudflare Workers must follow the naming convention: **`skybox-<app>`**

- `skybox-chatroom`, `skybox-todo`, `skybox-echo`, `skybox-counter`
- The `name` field in `wrangler.toml` must always begin with `skybox-`
- The `box skybox init` command automatically prepends `skybox-` when scaffolding new projects

## Quick Start

```bash
# Build an example worker
cd crates/matchbox-cf-worker
bash examples/build.sh examples/todo examples/todo/sources/TodoListener.bx TodoApp

# Deploy
cd examples/todo
npx wrangler deploy
```

## Project Structure

```
crates/
  matchbox-cf-worker/    # Rust crate + WASM adapter + example workers
  cf-worker-builder/     # CLI to embed BoxLang bytecode into WASM
skybox-cli/              # CommandBox module for scaffolding/deploying
vendor/matchbox/         # MatchBox BoxLang runtime (submodule)
docs/                    # Documentation site (Astro/Starlight)
```

## Available Demos

echo, counter, chatroom, moonphase, romannumeral, jsonfmt, textanalyzer, todo

## License

MIT
