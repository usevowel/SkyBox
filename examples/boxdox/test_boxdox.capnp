using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    ( name = "boxdox-test",
      worker = (
        modules = [
          ( name = "worker.wasm", wasm = embed "dist/worker.wasm" ),
          ( name = "wasm_glue.js", esModule = embed "wasm_glue.js" ),
          ( name = "mcf-worker.js", esModule = embed "test_boxdox.js" ),
        ],
        compatibilityDate = "2025-01-01",
      ),
    ),
  ],
);
