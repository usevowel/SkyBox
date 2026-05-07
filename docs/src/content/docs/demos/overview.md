---
title: Demo Applications
description: Overview of all 8 demo applications with test results.
---

All demos are built and tested end-to-end under workerd. Each has automated tests in its directory.

| Demo | Description | Commands | Status |
|------|-------------|----------|--------|
| **Echo** | Basic echo server | any text | Manual |
| **Counter** | Stateful click counter | `increment`, `view`, `incrementBy N` | ✅ |
| **Chat Room** | Multi-client chat | `msg:text`, `nick:name` | ✅ |
| **Moon Phase** | Moon phase calculator | `now`, `list`, `help` | ✅ |
| **Roman Numeral** | Roman↔integer converter | `toint MMXXV`, `sort III,II,IV,IX` | ✅ |
| **JSON Formatter** | JSON structural validator | `validate {...}`, `count [...]` | ✅ |
| **Text Analyzer** | Word/sentence analysis | `analyze TEXT`, `words TEXT` | ✅ |
| **Todo List** | Collaborative todo list | `add task`, `done 1`, `del 1`, `list`, `clear` | ✅ |

All 7 automated tests pass:
```
counter:     OK: all infra tests passed
chatroom:    OK: state keys=messages,room,usercount,users
moonphase:   OK: phase=Waxing Crescent ill=10 list=8
romannumeral: OK: toint=2025, sort=II,III,IV,IX
jsonfmt:     OK: valid=true invalid=false
textanalyzer: OK: words=4 freq=hello
todo:        OK: add+list+done passed
```
