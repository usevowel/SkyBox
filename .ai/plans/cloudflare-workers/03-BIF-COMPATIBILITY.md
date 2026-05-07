# BIF Compatibility Matrix

## Fully Supported (compile as-is to WASM)

| BIF Family | BIFs | Notes |
|------------|------|-------|
| **Array** | `arrayNew`, `arrayLen`, `arrayAppend`, `arrayPrepend`, `arrayDeleteAt`, `arrayInsertAt`, `arrayClear`, `arrayIsEmpty`, `arraySort`, `arrayFind`, `arrayFindAll`, `arrayFilter`, `arrayMap`, `arrayReduce`, `arrayEach`, `arrayToList`, `arrayAvg`, `arraySum`, `arraySlice` | Pure in-memory operations |
| **Struct** | `structNew`, `structCount`, `structKeyArray`, `structKeyExists`, `structDelete`, `structInsert`, `structAppend`, `structCopy`, `structIsEmpty`, `structSort`, `structEach`, `structMap`, `structFilter`, `structFindKey`, `structFindValue` | Pure in-memory operations |
| **String** | `len`, `mid`, `left`, `right`, `find`, `findNoCase`, `replace`, `replaceNoCase`, `replaceList`, `compare`, `compareNoCase`, `trim`, `lTrim`, `rTrim`, `ucase`, `lcase`, `reverse`, `chr`, `asc`, `val`, `toString`, `toBinary`, `toBase64`, `hash`, `hash40`, `wrap`, `stripTags` | All string primitives |
| **Math** | `abs`, `int`, `round`, `ceil`, `floor`, `max`, `min`, `sqr`, `sqrt`, `exp`, `log`, `log10`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `rand`, `randRange`, `bitAnd`, `bitOr`, `bitXor`, `bitNot`, `bitShLN`, `bitShRN` | No native dependencies |
| **Conversion** | `toNumeric`, `toBoolean`, `jsonSerialize`, `jsonDeserialize`, `toBase64`, `toBinary`, `toString` | Pure computation |
| **Date/Time** | `now`, `dateFormat`, `timeFormat`, `dateDiff`, `dateAdd`, `datePart`, `day`, `month`, `year`, `hour`, `minute`, `second`, `createDate`, `createDateTime`, `createTime`, `createODBCDate`, `createODBCDateTime`, `parseDateTime`, `isDate`, `dateCompare` | `web-time` + `chrono` — WASM compatible |
| **Crypto** | `hash`, `hmac`, `encrypt`, `decrypt`, `generateSecretKey` | sha2, hmac work in WASM |
| **Decision** | `isDefined`, `isNull`, `isBoolean`, `isNumeric`, `isDate`, `isArray`, `isStruct`, `isString`, `isObject`, `isSimpleValue`, `isValid`, `isJSON`, `isBinary`, `isNumericDate` | Pure type checks |
| **Closure/Functional** | `lambda`, `closure`, `function`, `runAsync`, `asyncRun`, `asyncAll`, `asyncAny` | Core VM features |

---

## Partially Supported (need shims)

| BIF Family | BIFs | Limitation | Solution |
|------------|------|------------|----------|
| **HTTP** | `http` (internal) | Standard `reqwest` pulls in tokio, which is large for WASM | Replace with `web-sys` `fetch()` via JS bridge, or implement minimal fetch in JS shell |
| **JSON** | `deserializeJSON`, `serializeJSON` | Works | Already supported |
| **Query** | `queryNew`, `queryAddRow`, `querySetCell`, `querySort` | In-memory only | Works in WASM if implemented in pure Rust (no SQL) |
| **File** (subset) | `fileRead`, `fileWrite` | No filesystem on Workers | Re-implement against R2 or KV bindings |

---

## Not Supported (disable at compile time)

These BIFs call native APIs that have no equivalent on Cloudflare Workers:

| BIF Family | Reason | Error Guidance |
|------------|--------|----------------|
| **File I/O** (`bif-io`) | No filesystem (`walkdir`, `fs_extra`) | "Filesystem not available on Cloudflare Workers. Use R2 or KV bindings." |
| **JNI** (`bif-jni`) | No JVM (`jni` crate) | "JNI is not supported on Cloudflare Workers." |
| **CLI/Terminal** (`bif-cli`) | No terminal (`crossterm`) | "Terminal I/O is not available on Cloudflare Workers." |
| **Datasource/DB** (`bif-datasource`) | No raw TCP sockets (`postgres`, `r2d2`) | "Use D1 binding for database access." |
| **HTTP Client** (`bif-http`) | `reqwest` uses tokio | "Use `cf.fetch()` binding for outbound HTTP." |
| **JIT** (`jit`) | Cranelift is too large (~MB+) | "JIT is not available in WASM builds." |
| **ZIP** (`bif-zip`) | `zip` crate may work but limited by FS | "File compression not available on Workers." |
| **Threading** (`thread`) | No OS threads in WASM | "Use `runAsync` with cooperative fibers." |

---

## Addressing Not-Supported BIFs at Compile Time

When compiling with `--target cf-worker`, the compiler should:

1. **Tree-shake** — Only include BIFs that are actually referenced in user code
2. **Validate** — If a user calls a not-supported BIF, emit a compile-time error:
   ```
   Error: 'fileRead' is not available for target 'cf-worker'.
   Filesystem access is not supported. Use R2 or KV bindings instead.
   ```
3. **Stub generation** — Optionally generate a shim file that maps BIF names
   to guidance messages for runtime inspection.

The `no shaking` / `--keep` / `--no-std-lib` flags from the main CLI already
support this kind of target-specific feature gating.
