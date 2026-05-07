---
title: Wrangler Dev
description: Test WebSocket apps locally with wrangler dev.
---

```bash
cd examples/myapp
ln -sf dist/worker.wasm worker.wasm   # first time only
npx wrangler dev --local
```

## Testing with WebSocket

```bash
# Using Node.js ws package
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8787/');
ws.on('message', d => console.log(d.toString()));
ws.on('open', () => ws.send('now'));
"
```

## Expected Behaviour

- HTTP requests return `426 Upgrade Required` (expected — WebSocket only)
- WebSocket connections receive the welcome message from `onConnect`
- Text messages trigger `onMessage` and receive the listener's response
