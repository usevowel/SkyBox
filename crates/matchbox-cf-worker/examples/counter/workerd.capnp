using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "counter", worker = .counterWorker),
  ],
  sockets = [
    (name = "http", address = "*:8788", http = (), service = "counter"),
  ],
);

const counterWorker :Workerd.Worker = (
  modules = [
    (name = "mcf-worker.js", esModule = embed "mcf-worker.js"),
    (name = "wasm_glue.js", esModule = embed "wasm_glue.js"),
    (name = "worker.wasm", wasm = embed "dist/worker.wasm"),
  ],
  compatibilityDate = "2025-01-01",
  durableObjectNamespaces = [
    (className = "MatchBoxWebSocketDO", uniqueKey = "do-matchbox-counter", enableSql = true),
  ],
  durableObjectStorage = (inMemory = void),
  bindings = [
    (name = "WEBSOCKET_DO", durableObjectNamespace = "MatchBoxWebSocketDO"),
  ],
);
