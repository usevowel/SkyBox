# Testing Strategy

## Unit Tests (Rust)

### In `crates/matchbox-cf-worker/`

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_struct_construction() {
        let event = build_event_struct("GET", "/test?q=1", r#"{"host":"example.com"}"#,
                                       None, r#"{"q":"1"}"#);
        assert_eq!(event.get("method"), "GET");
        assert_eq!(event.get("path"), "/test");
    }

    #[test]
    fn test_response_serialization() {
        let response = build_response(200, r#"{"content-type":"text/plain"}"#, "OK");
        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["status"], 200);
        assert_eq!(json["body"], "OK");
    }

    #[test]
    fn test_bytecode_roundtrip() {
        // Compile a simple BoxLang source, serialize, deserialize, run
        let source = r#"function handleRequest(event) { return { status: 200 }; }"#;
        let ast = parser::parse(source, Some("test")).unwrap();
        let mut compiler = Compiler::new("test");
        let chunk = compiler.compile(&ast, source).unwrap();
        let bytes = postcard::to_stdvec(&chunk).unwrap();
        let mut restored: Chunk = postcard::from_bytes(&bytes).unwrap();
        restored.reconstruct_functions();
        // Should not panic
    }
}
```

### BIF Compatibility Tests

For each BIF that should work on Workers:

```rust
#[test]
fn test_array_bifs_in_wasm_context() {
    // Exercise array BIFs without filesystem or network
    let vm = VM::new();
    let result = vm.eval("arrayLen([1,2,3])").unwrap();
    assert_eq!(result.as_i64(), Some(3));
}
```

---

## Integration Tests (Node.js + wrangler)

### Local dev server smoke tests

```bash
# Build the worker
matchbox --target cf-worker test/fixtures/hello.bxs --output /tmp/test-worker.wasm

# Start wrangler dev and test
wrangler dev --port 8788 &
sleep 3
curl -s http://localhost:8788/hello
# Expected: {"status":200,"body":"Hello World"}
kill %1
```

### Test Fixtures

```
test/fixtures/
├── hello.bxs                    # Basic request/response
├── kv-test.bxs                  # KV binding access
├── r2-test.bxs                  # R2 binding access
├── error.bxs                    # Runtime error handling
├── async.bxs                    # runAsync usage
├── routing.bxs                  # web.server() routing
└── cf-props.bxs                 # cf-* property access
```

### Node.js Test Runner (Jest or Vitest)

```js
// test/integration/worker.test.js
import { unstable_dev } from 'wrangler';

describe('BoxLang Worker', () => {
    let worker;

    beforeAll(async () => {
        worker = await unstable_dev('dist/mcf-worker.js', {
            config: 'wrangler.toml',
            experimental: { local: true },
        });
    });

    afterAll(async () => {
        await worker.stop();
    });

    test('GET / returns 200 with message', async () => {
        const resp = await worker.fetch('/');
        expect(resp.status).toBe(200);
        const body = await resp.json();
        expect(body.message).toBe('Hello from BoxLang!');
    });

    test('missing route returns 404', async () => {
        const resp = await worker.fetch('/nonexistent');
        expect(resp.status).toBe(404);
    });

    test('POST with JSON body is parsed', async () => {
        const resp = await worker.fetch('/echo', {
            method: 'POST',
            body: JSON.stringify({ name: 'BoxLang' }),
            headers: { 'Content-Type': 'application/json' },
        });
        const body = await resp.json();
        expect(body.name).toBe('BoxLang');
    });
});
```

---

## E2E Tests (Deployed)

Using `wrangler deploy` to a staging environment, then running assertions:

```bash
# Deploy to staging
wrangler deploy --env staging

# Run E2E tests
curl -s https://staging.my-boxlang-worker.workers.dev/ | grep "Hello"

# Or use Playwright for more complex scenarios
npx playwright test e2e/
```

---

## WASM Binary Size Regression Tests

```bash
# Check that we stay under budget
MAX_WASM_SIZE=250000  # 250 KB
WASM_SIZE=$(stat -f%z dist/worker.wasm)
if [ $WASM_SIZE -gt $MAX_WASM_SIZE ]; then
    echo "ERROR: WASM binary too large: $WASM_SIZE bytes (max $MAX_WASM_SIZE)"
    exit 1
fi
```

---

## VM Compatibility Tests

Run the existing MatchBox test suite against the cf-worker build:

```bash
# Only tests that don't require disabled BIFs
cargo test -p matchbox-cf-worker --release
```

The existing test suite in `matchbox-compiler` and `matchbox-vm` already
covers the parser, compiler, and VM semantics. The cf-worker integration
tests only need to validate the adapter layer.
