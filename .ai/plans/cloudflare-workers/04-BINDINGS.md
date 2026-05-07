# Cloudflare Bindings — KV, R2, D1, Queues, etc.

## Architecture

Cloudflare Workers provides bindings via the `env` parameter in `fetch()`. The
JS shell reads `env` and passes binding information into the WASM VM via the
`binding_accessor_json` argument of `handle_request`.

```
env.KV_MYSTORE.get("key")       ──►  JS: proxy call
env.R2_ASSETS.get("key")        ──►  JS: proxy call
env.D1_DB.prepare("SELECT ...") ──►  JS: proxy call
```

Since WASM cannot directly call JS functions, we use a **callout pattern**:

1. WASM emits a JSON-encoded call description into a shared buffer
2. Returns a "pending" state
3. JS shell reads the buffer, executes the Cloudflare API call
4. JS writes the result back
5. WASM reads the result and continues

This is similar to the existing `matchbox_js_host` import pattern in the
`js_bundle_template.js` file.

---

## KV Binding

### BoxLang API

```boxlang
// Get a value
var value = cf.kv("MYSTORE").get("user-preferences");

// Put a value
cf.kv("MYSTORE").set("user-preferences", jsonData);

// Delete a value
cf.kv("MYSTORE").delete("old-key");

// List keys (with options)
var keys = cf.kv("MYSTORE").list({ prefix: "users:", limit: 100 });
```

### Implementation

```rust
// In the VM, registered as BIFs:
fn bif_cf_kv_get(args: &[BxValue], vm: &mut VM) -> Result<BxValue> {
    let store_name = args[0].as_str()?;
    let key = args[1].as_str()?;
    // Write callout to JS buffer
    let callout = serde_json::json!({
        "type": "kv_get",
        "store": store_name,
        "key": key
    });
    vm.js_callout(callout) // returns BxValue::Null or BxValue::String
}

fn bif_cf_kv_set(args: &[BxValue], vm: &mut VM) -> Result<BxValue> {
    // Similar pattern
}
```

The JS shell implements the callout handler:

```js
// Inside the fetch() handler
async function handleCallout(vm, callout) {
    switch (callout.type) {
        case 'kv_get': {
            const ns = env[callout.store];
            const value = await ns.get(callout.key);
            vm.resolveCallout(value);
            break;
        }
        // ...
    }
}
```

---

## R2 Binding

### BoxLang API

```boxlang
// Read an object
var obj = cf.r2("ASSETS").get("images/logo.png");
if (!isNull(obj)) {
    var bytes = obj.body;
    var contentType = obj.httpMetadata.contentType;
}

// Write an object
cf.r2("ASSETS").put("data/report.json", reportJson, {
    httpMetadata: { contentType: "application/json" }
});

// Delete
cf.r2("ASSETS").delete("temp/file.tmp");

// List
var objects = cf.r2("ASSETS").list({ prefix: "images/" });
```

---

## D1 Binding

### BoxLang API

```boxlang
// Query
var result = cf.d1("DB").query("SELECT * FROM users WHERE id = ?", [userId]);

// Prepared statement
var stmt = cf.d1("DB").prepare("INSERT INTO logs (msg, level) VALUES (?, ?)");
stmt.bind(["Hello", "info"]);
var result = stmt.run();

// Batch
cf.d1("DB").batch([
    "INSERT INTO ...",
    "UPDATE ..."
]);
```

**Result struct:**

```boxlang
{
    success: true,
    results: [ { id: 1, name: "Alice" }, ... ],  // for SELECT
    meta: { changes: 1, duration: 0.5 }
}
```

---

## Queues Binding

### BoxLang API

```boxlang
// Send a message
cf.queue("MY_QUEUE").send({
    type: "order.created",
    data: { orderId: 42 }
});

// Send batch
cf.queue("MY_QUEUE").sendBatch([
    { type: "event.one", data: { ... } },
    { type: "event.two", data: { ... } }
]);
```

### Consumer Side (Queue handler)

```boxlang
// In your app, export a queue handler
function onQueueEvent(batch) {
    for (var msg in batch.messages) {
        var body = jsonDeserialize(msg.body);
        // process message
        msg.ack();
    }
}
```

The consumer runs in a separate entry point — the adapter should support
multiple export types:

```js
export default {
    fetch: (request, env, ctx) => { /* HTTP handler */ },
    queue: (batch, env, ctx) => { /* Queue consumer */ },
};
```

---

## Secrets and Environment Variables

### BoxLang API

```boxlang
// Access environment variables
var apiKey = cf.env("API_KEY");
var dbUrl = cf.env("DATABASE_URL");

// Access worker vars
var mode = cf.var("APP_MODE");  // "production"
```

Under the hood, these are just string lookups against the serialized bindings
map passed from the JS shell.

---

## Callout Protocol

### WASM → JS (Callout Request)

```rust
pub enum BindingCallout {
    KvGet { store: String, key: String },
    KvSet { store: String, key: String, value: String },
    KvDelete { store: String, key: String },
    R2Get { bucket: String, key: String },
    R2Put { bucket: String, key: String, body: Vec<u8>, content_type: String },
    R2Delete { bucket: String, key: String },
    D1Query { db: String, sql: String, params: Vec<serde_json::Value> },
    D1Batch { db: String, statements: Vec<String> },
    EnvGet { name: String },
    Fetch { url: String, method: String, headers: HashMap<String,String>, body: Option<Vec<u8>> },
}
```

### JS → WASM (Callout Response)

```js
// JS writes result into a fixed WASM memory buffer
// WASM reads the buffer and converts to BxValue
{
    "ok": true,
    "value": "...",         // or null
    "error": null           // or error string
}
```

---

## Binding Registration at Startup

When `init_worker` is called, the binding accessor functions are registered in
the VM's global scope under the `cf` namespace:

```boxlang
// These are registered at compile time by the cf-worker target
function cf__kv( storeName ) {
    return {
        get: function(key) { /* calls BIF */ },
        set: function(key, value) { /* calls BIF */ },
        delete: function(key) { /* calls BIF */ },
    };
}
// etc.
```

The actual Rust-level BIFs behind these closures perform the callout protocol.
