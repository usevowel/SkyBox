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
