---
title: Channel API Reference
description: Complete reference for the BoxLang WebSocket channel methods.
---

Your listener receives a `channel` object in `onConnect`, `onMessage`, and `onClose`. This object provides all the methods for interacting with WebSocket connections.

## Sending Messages

| Method | Signature | Description |
|--------|-----------|-------------|
| `sendMessage` | `sendMessage(text)` | Send a text message to this connection |
| `sendText` | `sendText(text)` | Alias for sendMessage |
| `sendJson` | `sendJson(value)` | Serialize a struct to JSON and send as text |
| `sendBytes` | `sendBytes(bytes)` | Send binary data to this connection |

## Broadcasting

| Method | Signature | Description |
|--------|-----------|-------------|
| `broadcastMessage` | `broadcastMessage(text)` | Send text to all connections except sender |
| `broadcastText` | `broadcastText(text)` | Alias for broadcastMessage |
| `broadcastJson` | `broadcastJson(value)` | Serialize to JSON and broadcast |
| `broadcastBytes` | `broadcastBytes(bytes)` | Broadcast binary data |

## Connection Management

| Method | Signature | Description |
|--------|-----------|-------------|
| `close` | `close([code[, reason]])` | Close this connection |
| `getId` | `getId()` | Return this connection's unique ID |

## Request Introspection

| Method | Signature | Description |
|--------|-----------|-------------|
| `getPath` | `getPath()` | Return the request path |
| `getUrl` | `getUrl()` | Return the full request URL |
| `getHTTPHeader` | `getHTTPHeader(name[, default])` | Get an HTTP header value |

## Example

```boxlang
class ChatRoom {
    function onConnect(required channel) {
        channel.sendJson({"type":"welcome","id":channel.getId(),"path":channel.getPath()});
    }
    function onMessage(required message, required channel) {
        channel.broadcastJson({"type":"chat","from":channel.getId(),"text":message});
    }
    function onClose(required channel) {
        channel.broadcastMessage("User " & channel.getId() & " left");
    }
}
```
