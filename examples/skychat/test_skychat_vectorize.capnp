using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    ( name = "skychat-test",
      worker = (
        modules = [
          ( name = "worker.wasm", wasm = embed "dist/worker.wasm" ),
          ( name = "wasm_glue.js", esModule = embed "wasm_glue.js" ),
          ( name = "mcf-worker.js", esModule = embed "test_skychat_vectorize.js" ),
        ],
        compatibilityDate = "2025-01-01",
        bindings = [
          ( name = "VECTORIZE", vectorize = "" ),
          ( name = "DB", d1 = "" ),
          ( name = "OPENROUTER_API_KEY", text = "sk-test-key" ),
          ( name = "AI", ai = "" ),
        ],
      ),
    ),
  ],
);
