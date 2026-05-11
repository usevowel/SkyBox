---
name: bx-ai-to-mx-ai
description: Port BoxLang AI (BXAI) built-in functions to the MatchBox/WASM runtime (MXAI). Use when implementing a new mx-ai BIF, converting a BXAI model for WASM, debugging conversion errors, or adding Rust→JS bridge functionality.
license: MIT
compatibility: opencode
metadata:
  project: SkyBox
  workflow: conversion
---

# BXAI → MXAI Conversion Skill

Port BoxLang AI features from the JVM-based BXAI (`refs/bx-ai/`) to the MatchBox/WASM runtime (`packages/mx-ai/`).

## Conversion Levels

| Level | When to Use | Pattern |
|-------|-------------|---------|
| **Pass-through** | Pure BoxLang, no JVM deps | Copy `.bx` file, keep API identical |
| **Stub + delegate** | Uses `createObject("java:...")`, closures, file I/O, HTTP | Write stub that throws `UnsupportedInMatchBox` |
| **Rust→JS bridge** | Needs real HTTP/D1/AI via Cloudflare bindings | Implement in `src/bifs.rs`, add `handleXxx()` on DO in `mcf-worker.js` |
| **Pure-BoxLang port** | Uses BXAI models that are pure BoxLang (TextChunker, vector memory) | Copy, strip Java imports, replace `createObject` with WASM-compatible alternatives |

## Porting Checklist

1. Find reference: `refs/bx-ai/src/main/bx/bifs/<name>.bx`
2. Check deps: `createObject("java:...")`, `new JavaClass()`, `httpRequest`, `fileRead/Write`?
3. Choose level (table above), create `packages/mx-ai/bifs/<name>.bx`
4. Preserve the `@BoxBIF` annotation and function signature exactly
5. For Rust→JS: register in `src/bifs.rs`, add `handleXxx()` on DO, wire `__skybox_binding_call`
6. For stub-only BIFs that delegate elsewhere (like `aiChat`→`openRouterChat`), add a clear error message with the alternative BIF name

## Key Reference Files

| File | Purpose |
|------|---------|
| `packages/mx-ai/bifs/` | All MXAI BIF implementations (target) |
| `refs/bx-ai/src/main/bx/bifs/` | All BXAI BIF implementations (source) |
| `refs/bx-ai/src/main/bx/models/` | BXAI model classes |
| `packages/mx-ai/models/` | MXAI model classes (ported) |
| `crates/matchbox-cf-worker/src/bifs.rs` | Rust-side BIF definitions |
| `crates/matchbox-cf-worker/shell/mcf-worker.js` | JS shell with DO handlers |

## Agentic Tool Calling (Next Port)

To bring `aiTool.bx` and `aiAgent.bx` from stub to functional:

1. **Tool registry**: Rust-side `HashMap<String, ToolDef>` in `src/bifs.rs`
2. **DO handler**: `handleToolCall()` method on `MatchBoxWebSocketDO`
3. **Binding call**: Wire `__skybox_binding_call` dispatch for `register_tool`, `call_tool`, `list_tools`
4. **BoxLang BIF**: `aiTool.bx` creates a tool struct and registers via `__skybox_binding_call`
5. **AI integration**: Modify `streamOpenRouter()` to include tool definitions in the API call
6. **Tool results**: `sendMessage()` fallback for tool results (returned to AI, not user)
