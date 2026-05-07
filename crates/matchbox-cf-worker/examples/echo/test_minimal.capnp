using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "test", worker = .testWorker)],
  sockets = [(name = "http", address = "*:8787", http = (), service = "test")],
);
const testWorker :Workerd.Worker = (
  modules = [(name = "test.js", esModule = embed "test_minimal.js")],
  compatibilityDate = "2024-01-01",
);
