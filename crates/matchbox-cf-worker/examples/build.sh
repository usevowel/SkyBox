#!/bin/bash
# build.sh — Full build pipeline for a MatchBox CF Worker example
# Usage: build.sh <example-dir> <bx-source> <listener-class> [state-json] [state-file]
#
# For multi-file BoxLang projects, create `sources/` in the example directory
# and put all .bx files there. They'll be concatenated automatically.
# Otherwise, <bx-source> is a single file.
#
# Arguments:
#   example-dir     Path to the example directory (relative to project root)
#   bx-source       Path to the BoxLang source file (or sources/ dir used)
#   listener-class  Name of the listener class
#   state-json      Optional: initial listener state as JSON string (default: {})
#   state-file      Optional: path to a JSON file with initial state (overrides state-json)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXAMPLE_DIR="$1"
BX_SOURCE="$2"
LISTENER_CLASS="$3"
STATE_JSON="${4:-}"
STATE_FILE="${5:-}"
if [ -z "$STATE_JSON" ] && [ -z "$STATE_FILE" ]; then
    STATE_JSON="{}"
fi

BASE_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
BASE_WASM="$BASE_DIR/target/wasm32-unknown-unknown/release/matchbox_cf_worker.wasm"

echo "=== Build Pipeline ==="
echo "Example:     $EXAMPLE_DIR"
echo "BoxLang src: $BX_SOURCE"
echo "Class:       $LISTENER_CLASS"
echo ""

# Step 1: Build the Rust crate to WASM
echo "[1/4] Building Rust crate to WASM..."
cargo build -p matchbox-cf-worker --features js --target wasm32-unknown-unknown --release 2>&1

# Step 2: Run wasm-bindgen to generate JS glue
echo "[2/4] Running wasm-bindgen..."
BINDGEN_DIR="$EXAMPLE_DIR/bindgen"
mkdir -p "$BINDGEN_DIR"
wasm-bindgen "$BASE_WASM" --out-dir "$BINDGEN_DIR" --target web

# Step 3: Embed BoxLang chunk and config into the processed WASM
echo "[3/4] Embedding BoxLang listener..."

# Handle multi-file sources: if sources/ directory exists, concatenate all .bx files
COMBINED_SOURCE="$EXAMPLE_DIR/.combined.bx"
if [ -d "$EXAMPLE_DIR/sources" ]; then
    echo "  Multi-file mode: concatenating sources/..."
    > "$COMBINED_SOURCE"
    for f in "$EXAMPLE_DIR/sources"/*.bx; do
        echo "    + $(basename "$f")"
        cat "$f" >> "$COMBINED_SOURCE"
        echo "" >> "$COMBINED_SOURCE"
    done
    EFFECTIVE_SOURCE="$COMBINED_SOURCE"
else
    EFFECTIVE_SOURCE="$BX_SOURCE"
fi

if [ -n "$STATE_FILE" ]; then
  STATE_ARG="--state-file $STATE_FILE"
else
  STATE_ARG="--state $STATE_JSON"
fi
cargo run -p cf-worker-builder -- \
  --source "$EFFECTIVE_SOURCE" \
  --listener-class "$LISTENER_CLASS" \
  --input "$BINDGEN_DIR/matchbox_cf_worker_bg.wasm" \
  --output "$EXAMPLE_DIR/dist/worker.wasm" \
  $STATE_ARG

# Clean up combined source
rm -f "$COMBINED_SOURCE"

# Step 4: Copy the JS glue into the example dir
echo "[4/4] Copying JS glue..."
cp "$BINDGEN_DIR/matchbox_cf_worker.js" "$EXAMPLE_DIR/wasm_glue.js"
cp "$BINDGEN_DIR/matchbox_cf_worker.d.ts" "$EXAMPLE_DIR/" 2>/dev/null || true

echo ""
echo "=== Build Complete ==="
echo "  WASM:  $EXAMPLE_DIR/dist/worker.wasm"
echo "  Glue:  $EXAMPLE_DIR/wasm_glue.js"
ls -lh "$EXAMPLE_DIR/dist/worker.wasm"
ls -lh "$EXAMPLE_DIR/wasm_glue.js"
