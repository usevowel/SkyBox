---
title: Prerequisites
description: What you need installed before building and deploying.
---

- **Rust** (nightly) with `wasm32-unknown-unknown` target
  ```bash
  rustup target add wasm32-unknown-unknown
  ```

- **wasm-bindgen** CLI v0.2.114
  ```bash
  cargo install wasm-bindgen-cli --version 0.2.114
  ```

- **Node.js** 18+ with npm

- **wrangler** (for Cloudflare dev/deploy)
  ```bash
  npx wrangler
  ```

- **workerd** (for local testing without a Cloudflare account)
  ```bash
  npx workerd
  ```
