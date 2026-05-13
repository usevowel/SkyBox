# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd prime` for full workflow context.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd dolt push          # Push beads data to remote
```

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

### Persistent Memory (`bd remember`)

Beads has a built-in memory system for project knowledge that survives across sessions:

```bash
bd remember "text"                     # Store a memory (auto-generated key)
bd remember "text" --key my-key        # Store with custom key
bd recall my-key                       # Retrieve full content by key
bd memories                            # List all memory keys
bd memories <search>                   # Search memories by keyword
bd forget my-key                       # Delete a memory
```

**Rule of thumb**: Knowledge goes in memories, work goes in issues.
- Use `bd remember` for: architecture decisions, BIF workarounds, design patterns, config notes
- Use `bd create` for: tasks, bugs, features, epics to implement
- Memories auto-inject into every session via `bd prime`

### Skills Integration

Beads integrates with AI agent skills via the MCP ecosystem:
- **beads-mcp** (`pip install beads-mcp`) — MCP server exposing all bd commands as structured tools
- **beads-skill** (github.com/mrf/beads-skill) — Claude Code skill with `/beads:*` slash commands and Project Manager agent
- **Agent Skills platform** — Community skills at agent-skills.md

The CLI + hooks approach (used here) is recommended over MCP for shell-based agents — it uses ~1-2k tokens vs 10-50k for MCP schemas.

### Recommended Skills

Install these skills globally via the Vercel skills CLI for a better agent experience:

```bash
npx skills add https://github.com/vercel-labs/skills --skill find-skills --global
npx skills add https://github.com/different-ai/openwork --skill opencode-primitives --global

```

| Skill | Description |
|-------|-------------|
| **find-skills** | Helps agents discover and install the right skill for any task. Use when asking "how do I do X" or "find a skill for X". |
| **opencode-primitives** | Reference for OpenCode skills, plugins, MCP servers, and config-driven behavior. Essential for developing new skills or customizing OpenCode integration. |
| **bx-ai-to-mx-ai** | Port BoxLang AI BIFs to the MatchBox/WASM runtime. Covers conversion levels (pass-through, stub, Rust→JS bridge, pure-BoxLang port), checklist, and key reference files. |

### Skills Worth Creating

These project-specific skills could accelerate development:

| Skill | Purpose |
|-------|---------|
| **mcf-worker-js** | Reference for `mcf-worker.js` patterns: callout bridge, SSE management, DO lifecycle, async pause/resume cycle, binding dispatch |
| **skychat-debugging** | Debugging guide for the skychat demo: SSE vs WS flow, D1 queries, OpenRouter streaming, RAG pipeline |
| **wrangler-deploy** | Deploy workflow reference: versions upload/deploy, two-file copy issue, routing config, environment variables |
| **boxlang-bif-scaffold** | Template for creating new BoxLang BIFs: `@BoxBIF` annotation, `invoke()` signature, argument handling, return types |

## Engineering Philosophy: Leverage Before Build

**Default to using existing crates/libraries before writing custom code.** This applies especially to:

- **Rust crates**: Check crates.io for well-maintained, WASM-compatible libraries before writing custom Rust logic. Vector similarity? Check `innr`, `ndarray`, or `ruvector-core` before hand-rolling. Serialization? Use `serde`/`postcard`. Hash? Use `sha2`.
- **BoxLang modules**: Before implementing new BIFs, check `refs/bx-ai/` — many features (TextChunker, BaseVectorMemory, etc.) exist as pure BoxLang and can be ported with minimal changes.
- **Cloudflare Workers**: Use `env.AI.run()`, `env.DB.prepare()`, etc. via the JS bridge before adding new Rust BIFs. The DO env bindings are the most direct path.
- **npm packages**: Prefer existing npm packages over hand-rolling JS shell code.

**When to write custom code:**
- The crate/library is heavy (e.g., `ndarray` for a 3-line cosine similarity — just write the 3 lines)
- The crate doesn't compile to WASM
- The crate adds more complexity than the 50 lines of Rust it would replace
- There's no crate that fits the use case (e.g., BoxLang BIF scaffolding)

**Rule of thumb**: If a crate solves the problem in 1-2 function calls and is WASM-compatible, use it. If you'd only use 5% of the crate, it's probably lighter to write the code yourself.

## Research Before Planning

**Always research before writing any plan, design doc, or code.** Use web search tools (Exa, Context7, deepwiki) to discover:

- **Best practices & patterns** — Before deciding on an approach, search for current best practices, community conventions, and idiomatic patterns for the language/framework/domain. Don't assume you know the standard approach.
- **Existing libraries & tools** — Search crates.io, npm, PyPI, Maven, etc. for libraries that solve the problem. Evaluate at least 2-3 alternatives before deciding.
- **Reference implementations** — Look for examples in the SkyBox repo (`refs/`), open-source projects, or official docs. Reuse proven patterns rather than inventing from scratch.
- **Avoided-cost analysis** — For each approach, weigh pros and cons: maintenance burden, WASM compatibility, bundle size, API surface, community health, and how much of the library you'd actually use.

**Process:**
1. Search the web / docs for best practices related to the task
2. Search for existing libraries (crates, packages, modules) that could help
3. Compare 2-3 options with explicit pros/cons
4. Only then write a plan or start implementation
5. Store research findings with `bd remember` for future reference

**Don't skip this.** The cost of a wrong architectural decision or a hand-rolled solution where a library exists far exceeds the time to do research upfront.

## BXAI → MXAI Conversion Workflow

This project ports BoxLang AI (`refs/bx-ai/`) BIFs to the MatchBox/WASM runtime
as `packages/mx-ai/`. The conversion follows these patterns:

### Conversion Levels

| Level | Description | Examples |
|-------|-------------|----------|
| **Pass-through** | BIF works identically on WASM (pure BoxLang, no JVM deps) | `aiDocuments()`, `TextChunker`, `BaseVectorMemory` |
| **Stub + delegate** | BIF can't run on WASM; stubs with `throw("UnsupportedInMatchBox")` | `aiChat()`, `aiTool()`, `aiAgent()` |
| **Rust→JS bridge** | BIF implemented in Rust, delegates via `__skybox_binding_call` to JS | `openRouterChat()` — JS does the actual HTTP fetch |
| **Pure-BoxLang port** | Rewrite JVM-dependent BoxLang in pure .bx (no Java classes, no `createObject`) | `D1VectorMemory`, `TextChunker` |

### Porting Checklist

1. **Check BIF availability**: Does the BIF use `createObject("java:...")`, `new JavaClass()`,
   closures-as-callables, HTTP requests, or file I/O? If yes, it needs a delegate or stub.
2. **Check `refs/bx-ai/`**: Find the reference implementation. The API signature must be preserved.
3. **Choose conversion level** using the table above.
4. **For Rust→JS bridge**: Register a new case in `handleBindingCall()` in `mcf-worker.js`,
   add a new `handleXxx()` method on the DO, and implement the Rust-side BIF in `src/bifs.rs`.
5. **For pure-BoxLang port**: Copy the `.bx` file, strip Java imports/`createObject` calls,
   replace `httpRequest()` with the callout bridge, replace `fileRead`/`fileWrite` with
   WASM-compatible alternatives.
6. **Name**: Use the same BIF name and `@BoxBIF` annotation. The module loads BIFs from
   `bifs/` automatically.
7. **Test endpoint**: `openRouterChat()` delegates to JS → verify with E2E AI chat test.
8. **Deploy**: `npx wrangler versions upload && npx wrangler versions deploy --version-id <id> --percentage 100`

### Key Architectural Differences

| Feature | BXAI (JVM BoxLang) | MXAI (MatchBox/WASM) |
|---------|-------------------|---------------------|
| HTTP requests | `httpRequest()` BIF, `createObject("java:...")` | JS callout bridge (`__skybox_binding_call` → DO's `handleBindingCall()`) |
| Database | JDBC datasources | D1 / Turso bindings via JS callout |
| AI models | `aiChat()` with provider config | `openRouterChat()` Rust→JS bridge, or `env.AI.run()` for Workers AI |
| Streaming | SSE from JVM BoxLang server | SSE from DO instance (`this.sseStreams`), or WebSocket push |
| Closures as callables | Full support | Limited — closures can't be passed through WASM boundary easily |
| File system | `fileRead`/`fileWrite` | Not available (Cloudflare Workers has no persistent FS) |
| Caches | `cachePut()`/`cacheGet()` | Durable Objects storage |
| AI Embeddings | `aiEmbed()` via provider config | `env.AI.run('@cf/baai/bge-base-en-v1.5', { text: input })` via JS bridge |
| Tools/Agents | Full `aiTool()`/`aiAgent()` runtime | Stubs — tools need custom Rust→JS bridge implementation |

### Adding a New Agentic Tool-Calling BIF (Next Work Item)

To port `aiTool.bx` from BXAI to MXAI:

1. Design the Rust-side tool registry in `src/bifs.rs` — tools are name+description+closure pairs
2. Add a `handleToolCall` method on the DO in `mcf-worker.js` — executes the tool's JS function
3. Wire `__skybox_binding_call` dispatch for tool actions (register, call, list tools)
4. Implement the `aiTool.bx` BoxLang BIF that creates a tool struct and registers it via callout
5. Add `sendMessage()` fallback for tool results (since tools return to the AI, not the user)
6. Update `streamOpenRouter()` to include tool definitions in the OpenRouter API call

## BXAI API Mirroring Mandate

**MXAI must be a close drop-in for BXAI.** All RAG-related MXAI code must mirror the BXAI API surface at `refs/bx-ai/` (added as a git submodule). Do NOT invent new API shapes — map to existing BXAI interfaces.

### RAG API Surface (from refs/bx-ai/)

#### Key BIFs

| BXAI BIF | MXAI Status | Notes |
|----------|-------------|-------|
| `aiMemory(type, key, userId, conversationId, config)` | TODO — `VectorizeMemory.bx` wrapping `mxaiVectorizeUpsert/Query` | Must return object matching `IVectorMemory` interface |
| `aiEmbed(input, params, options)` | ✅ `aiEmbed.bx` → `mxaiEmbed()` | Already matches BXAI signature |
| `aiDocuments(source, config)` | TODO — port from refs/bx-ai/ | Pure BoxLang, passthrough port |
| `aiChunk(text, options)` | TODO — port from refs/bx-ai/ | Pure BoxLang, passthrough port |

#### IVectorMemory Interface (what `aiMemory("boxvector")` returns)

```boxlang
interface IVectorMemory {
    // Semantic search — THE critical RAG method
    array function getRelevant(
        required string query,
        numeric limit = 5,
        struct filter = {},
        numeric minScore = 0.0,
        string userId = "",
        string conversationId = ""
    );
    // Returns EXACTLY: [{ id, text, score, metadata, embedding }, ...]

    // Raw vector search
    array function findSimilar(
        required array embedding,
        numeric limit = 5,
        struct filter = {},
        string userId = "",
        string conversationId = ""
    );
    // Returns: same format as getRelevant

    // Upsert
    IVectorMemory function addWithId(
        required string id,
        required string text,
        struct metadata = {},
        string userId = "",
        string conversationId = ""
    );

    // Message add (extracts text from struct/string)
    IAiMemory function add(required any message, ...);

    // Batch add
    struct function seed(required array documents, ...);
    // Returns: { added, failed, errors }

    // Lifecycle
    struct function getConfig();
    IAiMemory function configure(required struct config);
    struct function getSummary();
    array function getAll(...);
    IAiMemory function clear(...);
    numeric function count(...);
    struct function getById(required string id);
    boolean function remove(required string id);
    numeric function removeWhere(required struct filter);
    IVectorMemory function createCollection(required string name);
    boolean function collectionExists(required string name);
    IVectorMemory function deleteCollection(required string name);
}
```

**Search result struct format (CRITICAL — must match exactly):**
```boxlang
{
    id: string,          // Vector/document ID
    text: string,        // The document/chunk text content
    score: numeric,      // 0.0 - 1.0 similarity (higher = better)
    metadata: struct,    // User-defined metadata + { userId, conversationId }
    embedding: array     // Full embedding vector (array of floats)
}
```

**Score conversion from Vectorize:**
- Vectorize cosine distance: 0 = identical, 1 = orthogonal, 2 = opposite
- BXAI score: 0.0-1.0 where higher = more similar
- Formula: `bxaiScore = 1 - (vectorizeDistance / 2)`

#### Document Value Object (from refs/bx-ai/)

```boxlang
class Document {
    property id: string;
    property content: string;
    property metadata: struct;
    property embedding: array;

    // Chunking — THE critical method
    array function chunk(numeric chunkSize=1000, numeric overlap=200, string strategy="recursive");
    // Returns array of Document objects with chunk metadata:
    // { chunkIndex, totalChunks, isChunk, parentId, source, loader, loadedAt }

    struct function toStruct();  // { id, content, metadata, embedding, hash, fingerprint }
    static Document function fromStruct(required struct data);
    string function getHash(string algorithm="MD5");
    Document function setContent(required string content);
    Document function setMeta(required string key, required any value);
}
```

#### TextChunker (static utility)

```boxlang
TextChunker.chunk(text, options={chunkSize:2000, overlap:200, strategy:"recursive"})
// Returns array of strings
// Strategies: "recursive" (default), "characters", "words", "sentences", "paragraphs"
// Recursive strategy: paragraphs → sentences → words → characters
```

### Conversion Level for Each BIF

| BIF | Level | Why |
|-----|-------|-----|
| `mxaiVectorizeUpsert` | **Rust→JS bridge** | Calls `env.VECTORIZE.upsert()` — Cloudflare Workers API only available in JS |
| `mxaiVectorizeQuery` | **Rust→JS bridge** | Same — `env.VECTORIZE.query()` is Workers-only |
| `VectorizeMemory.bx` | **Pure-BoxLang port** | Wraps the Rust BIFs in a BXAI-compatible interface class |
| `aiChunk.bx` | **Pass-through** | Pure BoxLang, no JVM deps — identical to BXAI |
| `TextChunker.bx` | **Pass-through** | Pure BoxLang, no JVM deps — identical to BXAI |
| `Document.bx` | **Pass-through** | Pure BoxLang value object — identical to BXAI |
| `aiDocuments.bx` | **Pass-through (with stubs)** | Factory BIF is pure BoxLang; file-based loaders need stubs (no FS on Workers) |

### RAG Data Flow (Cloudflare-native + BXAI-compatible)

```
                   ┌──────────────────┐
                   │   Vectorize       │  Cloudflare's managed
                   │   (cosine dist)   │  vector database
                   └───────┬──────────┘
                           │ env.VECTORIZE.query()
                           │ env.VECTORIZE.upsert()
                           │
              ┌────────────▼────────────┐
              │  mxaiVectorizeQuery()    │  Rust BIFs
              │  mxaiVectorizeUpsert()   │  (BindingCall bridge)
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │  VectorizeMemory.bx      │  BoxLang class
              │  (wraps BIFs to match    │  mirrors IVectorMemory
              │   IVectorMemory API)     │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │  D1 (text lookup)        │  Store chunk text here
              │                          │  Vectorize stores vectors
              └─────────────────────────┘
```

Seed flow: `aiDocuments(source) → .chunkSize(512) → .load()` → `Document[]` → `aiEmbed()` per chunk → `mxaiVectorizeUpsert()` + `d1Execute()` for text

Query flow: `aiEmbed(query)` → `mxaiVectorizeQuery(embedding, topK=5)` → resolve text from D1 → return `[{id, text, score, metadata, embedding}]`

## Web App Testing with agent-browser

Use [agent-browser](https://github.com/vercel-labs/agent-browser) for automated browser testing of SkyBox web apps.

### Installation

```bash
npm install -g agent-browser
agent-browser install    # Downloads Chrome for Testing
```

### Loading Skills

Load the agent-browser skills at the start of each testing session:

```bash
agent-browser skills get core           # Workflows, common patterns, troubleshooting
agent-browser skills get core --full    # Full command reference + templates
agent-browser skills get dogfood        # Exploratory testing / QA / bug hunts
```

### Testing Pattern (Multi-Agent)

For testing WebSocket-based apps with multiple users, use separate `--session` flags:

```bash
# Session 1: User A opens the app
agent-browser --session userA open http://localhost:8787/

# Session 2: User B opens the app  
agent-browser --session userB open http://localhost:8787/

# Interact via each session independently
agent-browser --session userA snapshot
agent-browser --session userB click @e1
```

### Chatroom Testing Quick Start

```bash
# Terminal 1: Start the app
cd crates/matchbox-cf-worker/examples/chatroom
npm run dev

# Terminal 2: Test with agent-browser  
agent-browser --session alice open http://localhost:8787/
agent-browser --session bob open http://localhost:8787/
```

The `--session` flag creates isolated browser instances (separate cookies, storage, state) — each one acts as a distinct user.

## SkyBox CLI Module (`skybox-cli/`)

A CommandBox CLI module for scaffolding, building, and deploying SkyBox apps.

### Module Structure

```
skybox-cli/
├── ModuleConfig.cfc              # CommandBox module descriptor
├── box.json                      # ForgeBox package manifest (type: commandbox-modules)
├── commands/skybox/
│   ├── init.cfc                  # box skybox init — scaffold new project
│   ├── build.cfc                 # box skybox build — compile .bx → WASM
│   ├── dev.cfc                   # box skybox dev — wrangler dev --local
│   ├── deploy.cfc                # box skybox deploy — wrangler deploy
│   └── new.cfc                   # box skybox new — scaffold demo app
├── models/
│   └── SkyBoxService.cfc         # Shared business logic
└── templates/
    └── init/                     # Scaffold templates
        ├── main.bx               # Default BoxLang listener
        ├── wrangler.toml         # Cloudflare Workers config
        ├── package.json          # Build/dev/deploy scripts
        └── build.sh              # Build pipeline wrapper
```

### Commands Reference

| Command | Description |
|---------|-------------|
| `box skybox init [name]` | Scaffold a new SkyBox project |
| `box skybox build` | Build .bx sources into WASM worker |
| `box skybox dev` | Start wrangler dev server |
| `box skybox deploy` | Deploy to Cloudflare Workers |
| `box skybox new <name> <demo>` | Scaffold a demo app from templates |

### Worker Naming Convention

All Cloudflare Workers follow the naming convention: **`skybox-<app>`**
- Examples: `skybox-chatroom`, `skybox-todo`, `skybox-echo`
- The `name` field in `wrangler.toml` must always begin with `skybox-`
- The `box skybox init` command automatically prepends `skybox-` when scaffolding new projects

### Available Demos (for `skybox new`)

echo, counter, chatroom, moonphase, romannumeral, jsonfmt, textanalyzer, todo

### Packaging (ForgeBox)

The module is `type: commandbox-modules` and installs via:
```bash
box install skybox-cli
```

For development, link it:
```bash
cd skybox-cli
package link
reload
```

### Important Notes

- Commands use CFC syntax (not BX) since CommandBox modules use CFML-based ModuleConfig.cfc
- `SkyBoxService.cfc` is injected via WireBox as `SkyBoxService@skybox-cli`
- Templates are served from `templates/init/` relative to `modulePath`
- The `skybox build` command wraps `examples/build.sh` from the SkyBox project
- The `skybox dev` and `skybox deploy` commands assume wrangler is available via npx or local node_modules
- The `skybox new` command copies from `crates/matchbox-cf-worker/examples/<demo>/` when inside the SkyBox repo, otherwise falls back to templates

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
