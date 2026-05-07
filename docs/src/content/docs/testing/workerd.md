---
title: Workerd Testing
description: How to test demos locally with workerd (no Cloudflare account needed).
---

Each example has a test configuration and a JS test file:

## Test Structure

| File | Purpose |
|------|---------|
| `test_{name}.capnp` | workerd config embedding the test JS + WASM + glue |
| `test_{name}.js` | Test script using VM exports to simulate WebSocket events |

## Running a Test

```bash
# Start workerd on port 8787
npx workerd serve test_{name}.capnp

# Curl triggers the test
curl http://localhost:8787/

# Response — "OK: ..." for pass, "FAIL: ..." or status 500 for failure
```

## Test Pattern

```javascript
import { initSync, vm_init, vm_on_connect, vm_on_message } from './wasm_glue.js';
import wasmModule from 'worker.wasm';

const msgs = [];
globalThis.__skybox_send = function(c) {
    const m = JSON.parse(c);
    msgs.push({t:m.type, text: m.text});
    return JSON.stringify({success:true});
};

// In fetch handler:
initSync({module: wasmModule});
vm_init(configString, chunkBytes);
const rd = JSON.stringify({method:'GET', path:'/ws', ...});
vm_on_connect('c1', rd);
msgs.length = 0;
vm_on_message('c1', 0, new TextEncoder().encode('now'));
const result = JSON.parse(msgs[0].text);
// Assert on result
```

## State Handling

For tests that modify state:
1. Clear `msgs` array between calls
2. Check each response in sequence
3. The `currentDO` is simulated by the global callout functions
