---
title: BIF Availability
description: Which BoxLang BIFs work on the wasm32-unknown-unknown target.
---

## Available BIFs

These BIFs work on the WASM target:

`trim`, `len`, `mid`, `lcase`, `ucase`, `listToArray`, `arrayAppend`, `arrayLen`,
`arrayDeleteAt`, `isArray`, `isStruct`, `isNull`, `isNumeric`, `isBoolean`,
`max`, `min`, `round`, `floor`, `ceiling`, `serializeJSON`, `structNew`,
`arrayNew`, `toString`, `now`

String/char comparison operators also work:

```boxlang
if (c >= "0" && c <= "9") { ... }  // Works
if (c >= "a" && c <= "z") { ... }  // Works
```

## Unavailable BIFs

| BIF | Alternative |
|-----|-------------|
| `deserializeJSON` | Manual structural validation (see [workarounds](/wasm/bif-workarounds)) |
| `int(string)` | Avoid string-to-number conversion; use `& ""` for comparison |
| `val(string)` | Avoid string-to-number conversion |
| `asc(char)` | Direct character comparison `c >= "a"` |
| `chr(num)` | N/A |
| `dateFormat` | N/A |
| `parseDateTime` | N/A |
| `year`, `month`, `day` | N/A |
| `pi` | Use literal `3.14159` |
| `sin` | N/A |
| `abs` | Manual: `if (x < 0) x = 0 - x` |
| `reReplace` | Manual character iteration |
| `replace` | Manual string rebuild |
