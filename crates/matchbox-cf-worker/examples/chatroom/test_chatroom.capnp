using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "test", worker = .testWorker)],
  sockets = [(name = "http", address = "*:8789", http = (), service = "test")],
);
const testWorker :Workerd.Worker = (
  modules = [
    (name = "test_chatroom.js", esModule = embed "test_chatroom.js"),
    (name = "wasm_glue.js", esModule = embed "wasm_glue.js"),
    (name = "worker.wasm", wasm = embed "dist/worker.wasm"),
  ],
  compatibilityDate = "2025-01-01",
);
