# Runtime Adapter — The `matchbox-cf-worker` Crate

## Worker Lifecycle

### 1. Initialization (`init_worker`)

Called once when the Cloudflare isolates spins up (or on the first request if
using default lazy loading).

```rust
static VM: OnceLock<RefCell<VM>> = OnceLock::new();

#[wasm_bindgen]
pub fn init_worker(bytecode: &[u8]) -> Result<(), JsValue> {
    console_error_panic_hook::set_once();
    let mut chunk: Chunk = postcard::from_bytes(bytecode)
        .map_err(|e| js_sys::Error::new(&format!("Bytecode deserialize: {}", e)))?;
    chunk.reconstruct_functions();

    let mut vm = VM::new();
    vm.load_stdlib();                        // Load prelude BIFs
    vm.init_binding_bifs();                  // Register cf-binding BIFs
    vm.interpret(chunk)
        .map_err(|e| js_sys::Error::new(&format!("Init error: {}", e)))?;

    VM.set(RefCell::new(vm))
        .map_err(|_| js_sys::Error::new("VM already initialized"))
}
```

### 2. Request Handling (`handle_request`)

Converts the incoming request into a BoxLang struct, dispatches to the
`handleRequest` (or configured entry point), then converts the response.

```rust
#[wasm_bindgen]
pub async fn handle_request(
    method: &str,
    path: &str,
    headers_json: &str,
    body: Option<Vec<u8>>,
    query_json: &str,
    binding_accessor_json: &str,
) -> Result<JsValue, JsValue> {
    let vm_ref = VM.get().ok_or_else(|| {
        js_sys::Error::new("VM not initialized — call init_worker first")
    })?;
    let mut vm = vm_ref.borrow_mut();

    // 1. Build the BxValue event struct
    let event = build_event_struct(&mut vm, method, path, headers_json, body, query_json);

    // 2. Set binding accessors in global scope
    let bindings: HashMap<String, serde_json::Value> =
        serde_json::from_str(binding_accessor_json).unwrap_or_default();
    for (ns, bifs) in bindings {
        vm.set_global(ns, bx_value_from_serialized(&mut vm, &bifs));
    }

    // 3. Find the entry function
    let entry_fn_name = get_entry_function_name(&mut vm);
    let func = vm.get_global(&entry_fn_name)
        .ok_or_else(|| js_sys::Error::new(&format!("Entry function '{}' not found", entry_fn_name)))?;

    // 4. Call the function on the VM fiber scheduler
    let future = vm.start_call_function_value(func, vec![event])
        .map_err(|e| js_sys::Error::new(&format!("Call error: {}", e)))?;

    // 5. Pump the event loop until complete
    loop {
        vm.pump_until_blocked()
            .map_err(|e| js_sys::Error::new(&format!("Pump error: {}", e)))?;

        match vm.future_state(future) {
            HostFutureState::Pending => {
                // Yield back to JS event loop
                yield_to_js_host().await;
            }
            HostFutureState::Completed(value) => {
                // 6. Convert BxValue → JSON response
                return Ok(serialize_response(&mut vm, &value));
            }
            HostFutureState::Failed(error) => {
                let msg = vm.format_error_value(error);
                return Err(js_sys::Error::new(&msg).into());
            }
        }
    }
}
```

### 3. The Event Struct

The request event is exposed to BoxLang code as a struct:

```boxlang
// What BoxLang handler functions receive
{
    method: "GET",
    path: "/api/users",
    query: { name: "John", page: "1" },
    headers: { "content-type": "application/json", ... },
    body: "",  // raw body bytes (base64 or Uint8Array proxy)
    // Cloudflare-specific:
    cf: {
        colo: "DFW",
        country: "US",
        city: "Dallas",
        clientIp: "203.0.113.1",
        // ... other cf- properties
    }
}
```

### 4. Response Contract

The handler function must return a struct with this shape:

```boxlang
{
    status: 200,              // HTTP status code
    headers: {                 // Response headers
        "content-type": "text/html"
    },
    body: "<h1>Hello</h1>"    // string or byte array
}
```

### 5. Async Event Pump

Since Cloudflare Workers have a synchronous `fetch()` handler but the VM uses
cooperative fibers, we need to yield back to the JS event loop:

```rust
async fn yield_to_js_host() {
    let promise = js_sys::Promise::new(&mut |resolve, _reject| {
        let win = web_sys::window().unwrap();
        win.set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, 0)
            .unwrap();
    });
    wasm_bindgen_futures::JsFuture::from(promise).await.unwrap();
}
```

This allows the VM to schedule multiple async operations (e.g. parallel
`fetch()` calls from the Cloudflare Workers runtime via bindings) without
blocking.

### 6. App Server Mode (Routed)

For the `web.server()`/ColdBox-style app server pattern (similar to ESP32's
embedded runtime), the adapter should also support a routed entry mode:

- Pre-parse the BoxLang app's route table at compile time
- Embed route metadata alongside bytecode
- At runtime, the adapter acts as a router, invoking the correct route handler

This mode adds more complexity but enables porting full ColdBox/CFML-style
applications. It should be Phase 2.

### 7. Error Handling

```rust
fn format_vm_error(vm: &VM, error: BxValue) -> String {
    // Walk the error value's stack trace if available
    // Fall back to format_error_value
    vm.format_error_value(error)
}
```

Errors should always be serializable to a structured JSON response:

```json
{
    "error": true,
    "message": "Division by zero",
    "type": "boxlang.runtime.DivisionByZero",
    "stack": [
        {"file": "src/index.bxs", "line": 42, "function": "calculate"}
    ]
}
```

### 8. Warmup / Cold Start Mitigation

Cloudflare isolates can have noticeable cold starts. Strategies:

1. **Custom Section Bytecode**: Embed bytecode in a custom WASM section so it's
   available immediately without a separate network fetch
2. **Isolate Warmup**: Use `wrangler.toml` `[durable_objects]` or cron triggers
   to keep the isolate warm
3. **Lazy VM Init**: Only parse bytecode on first request; return a 307 to a
   warmup URL on the first call
4. **Snapshot**: Investigate whether V8 snapshots can include a pre-parsed VM
   (future research)

### 9. WebSocket Support

Cloudflare Workers supports WebSocket via the `WebSocket` pair API. The adapter
should support `web.server()` WebSocket routes:

- Map `ws://` upgrades through the same routing mechanism
- Expose `event.webSocket` on upgrade requests
- Pump the VM fiber per WebSocket message

This is Phase 3 material.
