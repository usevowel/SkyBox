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

## Vectorize-backed RAG (This Epic)

MXAI RAG uses **Vectorize** (Cloudflare's managed vector DB) instead of hand-rolled cosine similarity. Two Rust→JS bridge BIFs power it:

| BIF | Rust (`bifs.rs`) | JS (`mcf-worker.js`) | Description |
|-----|------------------|----------------------|-------------|
| `mxaiVectorizeUpsert(bindingName, vectors)` | `vectorize_upsert` action | `handleVectorizeUpsert()` — calls `env.VECTORIZE.upsert(vectors)` | Insert/update vectors |
| `mxaiVectorizeQuery(bindingName, queryVector, topK, options)` | `vectorize_query` action | `handleVectorizeQuery()` — calls `env.VECTORIZE.query(queryVector, {topK, returnMetadata, returnValues})` | Search nearest vectors |

**Wranger config:**
```toml
[[vectorize]]
binding = "VECTORIZE"
index_name = "skybox-<app>-index"
```

**Create index:**
```bash
npx wrangler vectorize create skybox-<app>-index --dimensions=768 --metric=cosine
```

### Score Conversion (CRITICAL)

BXAI expects scores as 0.0-1.0 where higher = more similar. Vectorize uses cosine distance:
- Vectorize distance: 0 = identical, 1 = orthogonal, 2 = opposite
- BXAI score: `1 - (vectorizeDistance / 2)`
- Always return scores in BXAI format (0-1, higher=better)

### VectorizeMemory.bx (BoxLang Wrapper)

The VectorizeMemory.bx class wraps the Rust BIFs to match BXAI's `IVectorMemory` interface:

```
mxaiVectorizeUpsert/Query (Rust BIFs)
    ↕ BindingCall bridge
handleVectorizeUpsert/Query (DO methods)
    ↕ env.VECTORIZE.upsert/query (Cloudflare API)
VectorizeMemory.bx (BoxLang class, mirrors IVectorMemory)
    ↕ used by skychat and boxdox demos
```

### Porting RAG BIFs from BXAI to MXAI

| BXAI Source | MXAI Target | Level | Notes |
|-------------|-------------|-------|-------|
| `bifs/aiMemory.bx` | `bifs/aiMemory.bx` | Pure-BoxLang port | Factory that picks VectorizeMemory for "vector" types |
| `models/memory/vector/IVectorMemory.bx` | `models/memory/IVectorMemory.bx` | Pass-through | Interface definition, pure BoxLang |
| `models/memory/vector/BaseVectorMemory.bx` | `models/memory/VectorizeMemory.bx` | Rust→JS bridge | Replaces abstract base with Vectorize-backed impl |
| `models/util/TextChunker.bx` | `models/util/TextChunker.bx` | Pass-through | Pure BoxLang, no changes needed |
| `bifs/aiChunk.bx` | `bifs/aiChunk.bx` | Pass-through | Pure BoxLang, no changes needed |
| `models/loaders/Document.bx` | `models/loaders/Document.bx` | Pass-through | Pure BoxLang value object |
| `bifs/aiDocuments.bx` | `bifs/aiDocuments.bx` | Pass-through (stub loaders) | Factory is pure; file loaders need stubs |
