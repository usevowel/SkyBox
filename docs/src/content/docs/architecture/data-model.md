---
title: Data Model & Storage
description: How the BoxLang VM state is persisted across hibernation cycles.
---

## DO Storage Keys

The `MatchBoxWebSocketDO` uses two keys in Durable Object storage:

### `listener_state`
The serialized state of your BoxLang listener's `variables` scope. Saved after every `onMessage` call and restored on DO wake.

```json
{
  "visits": 5,
  "todos": [
    {"id": 1, "text": "Buy milk", "done": false}
  ]
}
```

### `connections`
A map of connection metadata keyed by UUID.

```json
{
  "550e8400-e29b-41d4-a716-446655440000": {
    "method": "GET",
    "path": "/ws",
    "headers": {"upgrade": "websocket"}
  }
}
```

## Per-Connection Attachments

Each WebSocket stores a serialized attachment (max 2048 bytes):

```json
{
  "id": "550e8400-...",
  "request": { "path": "/ws", "headers": {...} }
}
```

## Variable Persistence Pattern

Class-level `variables.xxx` state is shared across ALL WebSocket connections. State is persisted to DO storage after each `onMessage` call.

**IMPORTANT on WASM:** Class-level variable initialization (e.g. `variables.romanMap = {...}`) does NOT persist across restarts. Always use the lazy-init pattern:

```boxlang
// DO this:
variables.visits = (variables.visits ?: 0) + 1;

// NOT this — won't persist on WASM:
variables.romanMap = {"I": 1, "V": 5};
```
