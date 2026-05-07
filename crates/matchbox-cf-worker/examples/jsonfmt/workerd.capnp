using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "jsonfmt", worker = .jsonfmtWorker),
  ],
  sockets = [
    (name = "http", address = "*:8792", http = (), service = "jsonfmt"),
  ],
);

const jsonfmtWorker :Workerd.Worker = (
  modules = [
    (name = "mcf-worker.js", esModule = embed "mcf-worker.js"),
    (name = "wasm_glue.js", esModule = embed "wasm_glue.js"),
    (name = "worker.wasm", wasm = embed "dist/worker.wasm"),
  ],
  compatibilityDate = "2025-01-01",
  durableObjectNamespaces = [
    (className = "MatchBoxWebSocketDO", uniqueKey = "do-matchbox-jsonfmt", enableSql = true),
  ],
  durableObjectStorage = (inMemory = void),
  bindings = [
    (name = "WEBSOCKET_DO", durableObjectNamespace = "MatchBoxWebSocketDO"),
  ],
);
