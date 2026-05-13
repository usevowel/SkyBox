# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

* * *

## SkyBox

### [Unreleased]

#### SkyBox Core

##### 🥊 New Features

- **Initial open-source release**: SkyBox — compile BoxLang to WebAssembly for Cloudflare Workers.
- **`matchbox-cf-worker`**: Rust crate providing the MatchBox VM as a Cloudflare Workers Durable Object shell.
- **`cf-worker-builder`**: CLI tool that compiles `.bx` source to bytecode, embeds it as WASM custom sections.
- **`mcf-worker.js`**: JS shell with WebSocket DO, HTTP routing, static asset serving, and async D1 callout bridge.
- **Multi-file build support**: Concatenate `.bx` sources, embed as single chunk.
- **Web UI via `onHttpGet`**: BoxLang listeners can serve HTML directly from WASM.
- **D1 database bridge**: Async callout mechanism for D1 queries from BoxLang on WASM.
- **Demo apps**: echo, counter, chatroom, moonphase, romannumeral, jsonfmt, textanalyzer, todo.

## Packages

### mx-ai [0.1.0]

#### 🥊 New Features

- **MatchBox AI Module**: Initial release of `mx-ai`, a lightweight port of `bx-ai` for MatchBox/WASM targets.
  - **`openRouterChat()` Rust BIF**: Async HTTP bridge to OpenRouter API via the Cloudflare Workers callout mechanism.
  - **API Surface Stubs**: All `bx-ai` BIFs stubbed with clear "Not available on MatchBox/WASM" messages.

#### 📚 Reference

- `bx-ai` (v3.1.0) added as git submodule at `refs/bx-ai/` for API reference.
  - Full API surface mapping stored in beads memory at `bd recall bx-ai-api-surface`.

* * *

[unreleased]: https://github.com/usevowel/SkyBox/compare/v0.0.0...HEAD
