---
title: System Architecture
description: How the BoxLang VM runs inside a Cloudflare Durable Object.
---

```
                        ┌──────────────────────────┐
                        │  Cloudflare Edge          │
                        │  [assets]: dist/assets/   │
                        │  ─── /css/style.css       │
                        │  ─── /js/chat.js          │
                        └──────────┬───────────────┘
                                   │ fall through (no match)
                                   ▼
┌──────────────────────────────────────────────────────────────┐
│  Worker fetch()                                              │
│  ─── health check (/__health)                                │
│  ─── static assets (/assets/*) → env.ASSETS.fetch(request)  │
│  ─── WebSocket upgrade → DO via idFromName("default")        │
│  ─── Web UI GET / → DO (for onHttpGet responses)            │
└──────────────────────┬───────────────────────────────────────┘
                       │ WebSocketPair (or fetch to DO)
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  Durable Object: MatchBoxWebSocketDO                         │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  BoxLang VM (single, shared across all connections)   │    │
│  │  ┌────────────────────────────────────────────────┐   │    │
│  │  │ Listener instance (your class)                  │   │    │
│  │  │  • onConnect / onMessage / onClose (WebSocket)  │   │    │
│  │  │  • onHttpGet(request) → {status,headers,body}   │   │    │
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

### Web UI via onHttpGet and Static Assets

Since 2026-05-07, the BoxLang listener can serve HTML pages via an optional `onHttpGet` method:

```boxlang
function onHttpGet(required struct request) {
    if (request.path == "/") {
        return {
            "status" : 200,
            "headers" : { "Content-Type" : "text/html; charset=utf-8" },
            "body" : renderChatPage()
        };
    }
    // 404 for unknown paths
}
```

CSS and JS should be served as external static assets via Cloudflare's `[assets]` feature rather than embedded as inline strings (which avoids `#` escaping and JS escaping issues). See the [chatroom demo](/demos/overview) for a full example.
