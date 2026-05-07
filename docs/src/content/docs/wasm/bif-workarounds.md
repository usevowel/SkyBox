---
title: BIF Workarounds
description: Code examples for working around unavailable BIFs on WASM.
---

## Manual JSON Validation (instead of `deserializeJSON`)

```boxlang
function isValidJson(required str) {
    var t = trim(str);
    var braceCount = 0;
    var bracketCount = 0;
    var inString = false;
    var firstNonSpace = "";
    var lastNonSpace = "";

    for (var i = 1; i <= len(t); i = i + 1) {
        var c = mid(t, i, 1);
        if (c == "\\" && inString) { /* skip escaped */ continue; }
        if (c == '"') { inString = !inString; continue; }
        if (inString) continue;
        if (c == "{") braceCount = braceCount + 1;
        else if (c == "}") braceCount = braceCount - 1;
        else if (c == "[") bracketCount = bracketCount + 1;
        else if (c == "]") bracketCount = bracketCount - 1;
        if (firstNonSpace == "" && c != " ") firstNonSpace = c;
        if (c != " ") lastNonSpace = c;
    }
    if (inString) return false;
    if (braceCount != 0) return false;
    if (bracketCount != 0) return false;
    if (firstNonSpace != "{" && firstNonSpace != "[") return false;
    return true;
}
```

## Manual Character Filtering (instead of `reReplace`)

```boxlang
function keepAlphanumeric(required str) {
    var out = "";
    for (var i = 1; i <= len(str); i = i + 1) {
        var c = mid(str, i, 1);
        if ((c >= "0" && c <= "9") || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z")) {
            out = out & c;
        }
    }
    return out;
}
```

## Manual Count (instead of `replace` / `reReplace`)

```boxlang
function countNonSpace(required str) {
    var count = 0;
    for (var i = 1; i <= len(str); i = i + 1) {
        if (mid(str, i, 1) != " ") count = count + 1;
    }
    return count;
}
```

## Manual `abs`

```boxlang
var diff = phase - 0.5;
if (diff < 0) diff = 0 - diff;
return round((1 - 2 * diff) * 100);
```

## String Comparison for IDs (instead of `int`/`val`)

```boxlang
// Compare IDs as strings
if (id & "" == "1" & "") { ... }
```
