---
name: skybox-beads
description: Track work and store project knowledge using beads (bd) on the SkyBox project. Use for task tracking, issue management, persistent memory, and beads-skill integration.
license: MIT
compatibility: opencode
metadata:
  project: SkyBox
  workflow: beads
---

# SkyBox Beads Workflow

This project uses **bd (beads)** for ALL task tracking and persistent knowledge.

## Quick Reference

```bash
bd ready              # Find available work (no blockers)
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd dolt push          # Push beads data to remote
```

## Persistent Memory

Store project knowledge that survives across sessions:

```bash
bd remember "text"                     # Store (auto-generated key)
bd remember "text" --key my-key        # Store with custom key
bd recall my-key                       # Retrieve full content
bd memories                            # List all memory keys
bd memories <search>                   # Search memories
bd forget my-key                       # Delete a memory
```

**Rule**: Knowledge → memories (`bd remember`), Work → issues (`bd create`)

## Slash Commands (beads-skill)

The beads-skill provides Claude Code-style slash commands:

| Command | Purpose |
|---------|---------|
| `/beads:ready` | Show unblocked issues |
| `/beads:create-issue` | Create a new issue |
| `/beads:show` | Display issue details |
| `/beads:plan` | Plan tasks with dependencies |
| `/beads:start-work` | Start working on an issue |
| `/beads:finish-work` | Complete issues |
| `/beads:status` | Project status dashboard |
| `/beads:deps` | Manage dependencies |
| `/beads:pm` | Run Project Manager audit |

## Recommended Skills

Install these globally via the Vercel skills CLI:

```bash
npx skills add https://github.com/vercel-labs/skills --skill find-skills
npx skills add https://github.com/different-ai/openwork --skill opencode-primitives
```

| Skill | Purpose |
|-------|---------|
| **find-skills** | Discover and install the right skill for any task |
| **opencode-primitives** | Reference for OpenCode config, plugins, MCP servers, and skills development |

## Session Close Protocol

When ending a session:

1. **File issues** for remaining work
2. **Run quality gates** (tests, builds)
3. **Close completed issues**: `bd close <id>`
4. **Push**: `git pull --rebase && bd dolt push && git push`
5. **Verify**: `git status` shows up to date
