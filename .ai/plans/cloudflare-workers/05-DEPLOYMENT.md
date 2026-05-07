# Deployment and Developer Workflow

## Project Structure Convention

Recommended layout for a BoxLang Cloudflare Workers project:

```
my-boxlang-worker/
├── src/
│   ├── index.bxs          # Main entry point (exports handleRequest)
│   ├── handlers/
│   │   ├── users.bxs
│   │   └── products.bxs
│   └── lib/
│       ├── models.bxs
│       └── utils.bxs
├── static/                 # Static assets (optional, for R2)
│   └── index.html
├── dist/
│   ├── worker.wasm         # Compiled WASM output
│   └── mcf-worker.js       # JS shell (generated or hand-written)
├── box.json                # MatchBox project config
├── package.json            # wrangler + tooling
├── wrangler.toml           # Cloudflare Workers config
└── .gitignore
```

---

## box.json (MatchBox Configuration)

```json
{
    "name": "my-boxlang-worker",
    "version": "1.0.0",
    "type": "cf-worker",
    "matchbox": {
        "entryPoint": "handleRequest",
        "bifs": ["array", "struct", "string", "math", "crypto", "json"],
        "stripSource": true,
        "optimize": "oz"
    }
}
```

---

## wrangler.toml

```toml
name = "my-boxlang-worker"
main = "dist/mcf-worker.js"
compatibility_date = "2025-05-01"

# WASM module referenced by mcf-worker.js
[[wasm_modules]]
name = "matchbox-vm"
path = "dist/worker.wasm"

# Bindings
[[kv_namespaces]]
binding = "KV_DATA"
id = "abcd1234"

[[r2_buckets]]
binding = "R2_ASSETS"
bucket_name = "my-boxlang-assets"

[[d1_databases]]
binding = "D1_DB"
database_name = "app-db"
database_id = "efgh5678"

[env.production]
vars = { APP_ENV = "production" }

[env.staging]
vars = { APP_ENV = "staging" }
```

---

## package.json Scripts

```json
{
    "scripts": {
        "build": "matchbox --target cf-worker src/index.bxs --output dist/worker.wasm",
        "dev": "matchbox --target cf-worker src/index.bxs --output dist/worker.wasm && wrangler dev",
        "deploy": "npm run build && wrangler deploy",
        "preview": "npm run build && wrangler deploy --dry-run"
    },
    "devDependencies": {
        "wrangler": "^4.0.0"
    }
}
```

---

## Development Workflow (Watch Mode)

```bash
# Terminal 1: Watch and recompile BoxLang sources
matchbox --target cf-worker src/index.bxs --output dist/worker.wasm --watch

# Terminal 2: Run wrangler dev (uses dist/worker.wasm)
wrangler dev --ip 127.0.0.1 --port 8787
```

The `--watch` flag from the existing MatchBox CLI should be extended for
`cf-worker` — when it detects a file change:

1. Recompiles `.bxs` files
2. Re-embeds bytecode into `dist/worker.wasm`
3. Touches `dist/mcf-worker.js` to trigger wrangler's HMR

---

## CI/CD Pipeline (GitHub Actions Example)

```yaml
name: Deploy BoxLang Worker

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: true

      - name: Install MatchBox CLI
        run: |
          curl -sSL https://raw.githubusercontent.com/ortus-boxlang/matchbox/master/install/install.sh | bash
          echo "$HOME/.matchbox/bin" >> $GITHUB_PATH

      - name: Build BoxLang Worker
        run: matchbox --target cf-worker src/index.bxs --output dist/worker.wasm

      - name: Deploy to Cloudflare Workers
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CF_API_TOKEN }}
```

---

## Environment-Specific Overrides

Use wrangler's environment support for different deployments:

```bash
# Deploy to staging
wrangler deploy --env staging

# Deploy to production
wrangler deploy --env production
```

Each environment can have different KV namespaces, R2 buckets, and vars.

---

## Warmup Strategy

To reduce cold start latency:

1. **Cron trigger** — Keep the isolate warm by pinging every 60 seconds:
   ```toml
   [triggers]
   crons = ["*/1 * * * *"]
   ```

2. **Warmup URL** — The worker returns instantly on warmup pings:
   ```boxlang
   if (event.path == "/__warmup") {
       return { status: 204, headers: {}, body: "" };
   }
   ```

3. **Workers Paid Tier** — Reserved memory isolates eliminate cold starts.
