#!/bin/bash
# build.sh — Build a SkyBox app .bx source into a WASM worker
# Usage: bash build.sh <bx-source> <listener-class> [state-json]
#
# This is a convenience wrapper around the full build pipeline:
#   cargo build → wasm-bindgen → cf-worker-builder → dist/worker.wasm
#
# Run this from your SkyBox app directory (the one with wrangler.toml).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_SCRIPT="$PROJECT_ROOT/crates/matchbox-cf-worker/examples/build.sh"

BX_SOURCE="${1:-src/AppListener.bx}"
LISTENER_CLASS="${2:-AppListener}"
STATE_JSON="${3:-}"

# Build the example
if [ -n "$STATE_JSON" ]; then
    bash "$BUILD_SCRIPT" "$SCRIPT_DIR" "$BX_SOURCE" "$LISTENER_CLASS" "$STATE_JSON"
else
    bash "$BUILD_SCRIPT" "$SCRIPT_DIR" "$BX_SOURCE" "$LISTENER_CLASS"
fi
