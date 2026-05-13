using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "romannumeral", worker = .romannumeralWorker),
  ],
  sockets = [
    (name = "http", address = "*:8791", http = (), service = "romannumeral"),
  ],
);

const romannumeralWorker :Workerd.Worker = (
  modules = [
    (name = "mcf-worker.js", esModule = embed "mcf-worker.js"),
    (name = "wasm_glue.js", esModule = embed "wasm_glue.js"),
    (name = "worker.wasm", wasm = embed "dist/worker.wasm"),
  ],
  compatibilityDate = "2025-01-01",
  durableObjectNamespaces = [
    (className = "MatchBoxWebSocketDO", uniqueKey = "do-matchbox-romannumeral", enableSql = true),
  ],
  durableObjectStorage = (inMemory = void),
  bindings = [
    (name = "WEBSOCKET_DO", durableObjectNamespace = "MatchBoxWebSocketDO"),
  ],
);
