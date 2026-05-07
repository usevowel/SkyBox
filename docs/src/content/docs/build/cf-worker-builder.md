---
title: cf-worker-builder CLI
description: Reference for the BoxLang-to-WASM embedding tool.
---

```
USAGE:
    cf-worker-builder --source <path> --listener-class <name> --input <wasm> --output <wasm>

REQUIRED:
    --source <path>          Path to the .bx source file
    --listener-class <name>  Name of the listener class
    --input <path>           Path to the input WASM binary
    --output <path>          Path to write the output WASM

OPTIONS:
    --ws-uri <uri>           WebSocket URI (default: /ws)
    --handler <path>         Handler filename (default: WebSocket.bx)
    --state <json>           Initial listener state JSON
    --state-file <path>      Path to JSON file with initial state
```

## Custom Sections

The tool embeds two WASM custom sections:

### `skybox:chunk`
Postcard-serialized BoxLang `Chunk` (bytecode). Read at VM init and loaded as the listener class.

### `skybox:ws_config`
JSON configuration:

```json
{
  "uri": "/ws",
  "listenerClass": "EchoListener",
  "listenerState": {},
  "handler": "WebSocket.bx"
}
```

Read by `mcf-worker.js` at startup and passed to `vm_init()`.
