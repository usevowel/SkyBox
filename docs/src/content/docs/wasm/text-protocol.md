---
title: Text Protocol Design
description: Why all demos use text commands instead of JSON messages.
---

Because `deserializeJSON` is unavailable on WASM, all demos use **text-based command protocols** instead of JSON-formatted messages.

## Command Routing Pattern

```boxlang
var parts = listToArray(message, " ");
var cmd = lcase(trim(parts[1] ?: ""));

if (cmd == "add") {
    var taskText = "";
    for (var i = 2; i <= arrayLen(parts); i = i + 1) {
        if (i > 2) taskText = taskText & " ";
        taskText = taskText & parts[i];
    }
    // ... add task logic
}
if (cmd == "list") { /* ... */ }
if (cmd == "help" || cmd == "") { /* show help */ }
```

## Response Format

Use `sendJson()` for structured responses (structs are serialized to JSON internally by the VM):

```boxlang
// RECOMMENDED: Structured JSON response
channel.sendJson({
    "type": "result",
    "action": "analyze",
    "wordCount": 42,
    "sentenceCount": 3
});

// Acceptable for simple cases:
channel.sendMessage("Phase: " & phaseName);
```
