---
title: System Architecture
description: How the BoxLang VM runs inside a Cloudflare Durable Object.
---

```
┌──────────────────────────────────────────────────────────────┐
│  Worker fetch()                                              │
│  ─── validates Upgrade: websocket header                     │
│  ─── routes to DO via idFromName("default")                  │
└──────────────────────┬───────────────────────────────────────┘
                       │ WebSocketPair
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  Durable Object: MatchBoxWebSocketDO                         │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  BoxLang VM (single, shared across all connections)   │    │
│  │  ┌────────────────────────────────────────────────┐   │    │
│  │  │ Listener instance (your class)                  │   │    │
│  │  │  variables.state = shared across ALL WS conns   │   │    │
│  │  └────────────────────────────────────────────────┘   │    │
│  │                                                       │    │
│  │  CfWebSocketChannelObject (per-connection):           │    │
│  │  • sendMessage / sendJson / sendBytes                 │    │
│  │  • broadcastMessage / broadcastJson / broadcastBytes  │    │
│  │  • close, getId, getPath, getUrl, getHTTPHeader       │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  DO Storage (SQLite, survives hibernation):                  │
│  • "listener_state" → { count: 3 }                           │
│  • "connections" → { conn-uuid: { path, headers } }         │
│                                                              │
│  WebSocket connections (up to 32,768 per DO):                │
│  ┌──────┐ ┌──────┐ ┌──────┐   ← ctx.getWebSockets()         │
│  │conn1 │ │conn2 │ │conn3 │                                 │
│  └──────┘ └──────┘ └──────┘                                 │
└──────────────────────────────────────────────────────────────┘
```

## Design Decisions

### One DO per app
Unlike naive implementations that create one Durable Object per WebSocket connection, this adapter uses **one DO per app** sharing a single BoxLang VM. This matches how the native MatchBox server works (one thread, one VM, `HashMap<id, Sender>` for broadcast).

### Hibernation API
The DO uses `ctx.acceptWebSocket(server)` instead of `server.accept()`. This lets the DO **hibernate** when idle — clients stay connected but the DO is evicted from memory. No billable duration accrues until the next message arrives.

### Broadcast via getWebSockets()
Broadcast iterates `ctx.getWebSockets()`, the native DO way to find all connected WebSockets.
