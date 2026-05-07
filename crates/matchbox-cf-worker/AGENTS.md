# AGENTS.md — matchbox-cf-worker Developer Guide

## Build Pipeline

The build pipeline has 4 steps orchestrated by `examples/build.sh`:

```bash
bash examples/build.sh <example-dir> <bx-source> <listener-class> [state-json] [state-file]
```

| Step | Tool | Output |
|------|------|--------|
| 1 | `cargo build --target wasm32-unknown-unknown --release` | `target/.../matchbox_cf_worker.wasm` |
| 2 | `wasm-bindgen --target web` | `bindgen/matchbox_cf_worker_bg.wasm` + JS glue |
| 3 | `cargo run -p cf-worker-builder` | `dist/worker.wasm` (embeds BoxLang bytecode as custom sections) |
| 4 | Copy JS glue | `wasm_glue.js` (wasm-bindgen output renamed) |

## BoxLang Listener Conventions

### File format
- Listener files use **`.bx`** extension (standalone BoxLang source)
- No `import boxlang.web` or app bootstrap code needed
- The class is compiled directly by `matchbox_compiler`

### Class structure
```boxlang
class MyListener {
    // REQUIRED: Called when a new WebSocket connects
    function onConnect(required channel) { }

    // REQUIRED: Called when a text or binary message arrives
    function onMessage(required message, required channel) { }

    // REQUIRED: Called when a WebSocket closes
    function onClose(required channel) { }

    // OPTIONAL: Helper functions for your logic
    function myHelper(required arg) { }
}
```

### Variable persistence (`variables.xxx`)
- Class-level `variables.xxx` state is shared across ALL WebSocket connections
- State is persisted to DO storage after each `onMessage` call
- On hibernation wake, state is restored from DO storage
- **IMPORTANT**: Class-level variable initialization (e.g. `variables.romanMap = {...}`) does NOT persist across restarts on WASM. Always use the lazy-init pattern:
  ```boxlang
  // DO this:
  variables.visits = (variables.visits ?: 0) + 1;

  // NOT this:
  variables.romanMap = {"I": 1, "V": 5};  // won't persist!
  ```

### Protocol design (text commands, NOT JSON)
Because `deserializeJSON` is unavailable on WASM, **use text-based command protocols**:

```boxlang
// RECOMMENDED: Text command routing
var parts = listToArray(message, " ");
var cmd = lcase(trim(parts[1] ?: ""));
if (cmd == "add") { /* use parts[2..end] */ }
if (cmd == "list") { /* ... */ }

// AVOID: JSON message parsing (requires deserializeJSON)
// This won't work on WASM!
```

### Response format
Use `sendJson()` for structured responses (structs are serialized to JSON internally):

```boxlang
// Structured response (RECOMMENDED)
channel.sendJson({"type":"result","action":"analyze","wordCount":42});

// Plain text (acceptable for simple cases)
channel.sendMessage("Phase: " & phaseName);
```

## WASM BIF Availability

### Available BIFs
These BIFs work on the WASM target:

`trim`, `len`, `mid`, `lcase`, `ucase`, `listToArray`, `arrayAppend`, `arrayLen`,
`arrayDeleteAt`, `isArray`, `isStruct`, `isNull`, `isNumeric`, `isBoolean`,
`max`, `min`, `round`, `floor`, `ceiling`, `serializeJSON`, `structNew`,
`arrayNew`, `toString`, `now`, `&` (concat), `+ - * /`, `== != < > <= >=`

String/char comparison operators also work:
```boxlang
if (c >= "0" && c <= "9") { ... }  // Works
```

### Unavailable BIFs and their alternatives

#### `deserializeJSON`
- **NOT available on WASM**
- Alternative: Manual structural validation (see `examples/jsonfmt/JsonFormatterListener.bx`)
- Check balanced braces/brackets, quote matching, first/last non-space chars

#### `int(string)` and `val(string)`
- **NOT available on WASM**
- Avoid string-to-number conversion entirely
- For ID comparison, use string concatenation:
  ```boxlang
  if (id & "" == "1" & "") { ... }  // compare as strings
  ```

#### `asc(char)` and `chr(num)`
- **NOT available on WASM**
- Alternative: Direct character comparison
  ```boxlang
  if (c >= "a" && c <= "z") { ... }
  ```
- See `textanalyzer` demo's `keepAlphanumeric()` function

#### `reReplace` and `replace`
- **NOT available on WASM**
- Alternative: Manual iteration (see `textanalyzer` demo)
  ```boxlang
  function keepAlphanumeric(required str) {
      var out = "";
      for (var i = 1; i <= len(str); i = i + 1) {
          var c = mid(str, i, 1);
          if ((c >= "0" && c <= "9") || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z")) {
              out = out & c;
          }
      }
      return out;
  }
  ```

#### `pi`, `sin`, `abs`
- **NOT available on WASM**
- Alternative: Use literal values and manual computation
  ```boxlang
  // Manual abs
  var diff = phase - 0.5;
  if (diff < 0) diff = 0 - diff;
  ```

## Workerd Testing

Each example has a test configuration in `.capnp` format and a JS test file.

### Test structure
- `test_{name}.capnp` — workerd config that embeds the test JS + WASM + glue
- `test_{name}.js` — test script using `vm_on_connect` / `vm_on_message` to simulate WebSocket events

### Running a test
```bash
# Start workerd on port 8787
npx workerd serve test_{name}.capnp

# Curl triggers the test
curl http://localhost:8787/

# Check response — should be "OK: ..." for pass, or "FAIL: ..." or status 500 for failure
```

### Test patterns
```javascript
import { initSync, vm_init, vm_on_connect, vm_on_message } from './wasm_glue.js';
import wasmModule from 'worker.wasm';

const msgs = [];
globalThis.__skybox_send = function(c) {
    const m = JSON.parse(c);
    msgs.push({t:m.type, text:m.text});
    return JSON.stringify({success:true});
};
// ... other globals ...

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

### State handling in tests
For tests that modify state:
1. Clear `msgs` array between calls
2. Check each response in sequence
3. The DO's `currentDO` is simulated by the global callout functions

## Wrangler Deploy

### Configuration
```toml
name = "my-app"
main = "mcf-worker.js"
compatibility_date = "2025-01-01"
account_id = "your-account-id"

[[durable_objects.bindings]]
name = "WEBSOCKET_DO"
class_name = "MatchBoxWebSocketDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["MatchBoxWebSocketDO"]
```

> **Note**: Do NOT add `[wasm_modules]` to `wrangler.toml`. The WASM module is
> imported directly via `import wasmModule from './worker.wasm'` in JS.
> Wrangler/esbuild handles the import natively.
> For `wrangler dev --local`, ensure `worker.wasm` resolves (symlink to `dist/worker.wasm`).

### Deploy flow
```bash
npm run build     # Build the WASM
npx wrangler deploy
```

### Dev flow
```bash
npm run build
ln -sf dist/worker.wasm worker.wasm   # first time only
npx wrangler dev --local
```

## Creating a New Example

1. Create directory: `examples/myapp/`
2. Write `MyListener.bx` with your BoxLang class
3. Copy `shell/mcf-worker.js` to `examples/myapp/mcf-worker.js`
4. Copy `shell/wrangler.toml` to `examples/myapp/wrangler.toml`, edit app name
5. Create `examples/myapp/package.json` with build/test scripts
6. Build: `bash examples/build.sh examples/myapp examples/myapp/MyListener.bx MyListener`
7. Create workerd test files (optional):
   - `test_myapp.js` — ES module with workerd-compatible imports
   - `test_myapp.capnp` — workerd config pointing to the test JS

## Debugging Tips

### WASM build fails
- Check `wasm-bindgen` version (must match crate version in Cargo.toml)
- Ensure `wasm32-unknown-unknown` target is installed: `rustup target add wasm32-unknown-unknown`
- Check for `Instant::now()` usage — must use `web_time::Instant` on WASM

### Workerd test fails
- Check `workerd` capnp syntax (especially trailing commas and semicolons)
- Ensure WASM file exists at expected path
- Check that custom sections are present: `wasm-objdump -x dist/worker.wasm | grep skybox`
- If `wrangler dev` works but `workerd` doesn't, check the module name in capnp matches the JS import

### Wrangler dev fails
- "ENOENT worker.wasm" → create symlink: `ln -sf dist/worker.wasm worker.wasm`
- "Wasm binding" error → remove `[wasm_modules]` from wrangler.toml
- "DO class not found" → check `[[durable_objects.bindings]]` and `[[migrations]]` in wrangler.toml

### WebSocket won't connect
- Check the `fetch()` handler returns 426 for non-WebSocket requests (expected)
- Use `wscat` or Node.js ws package to test: `node -e "new (require('ws'))('ws://localhost:8787/').on('message',d=>console.log(d.toString())).on('open',function(){this.send('hello')})"`
- Check wrangler/workerd console for runtime errors
