#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== BoxDox Multi-File Build ==="

MERGED_DIR="$SCRIPT_DIR/.skybox-build"
MERGED_FILE="$MERGED_DIR/merged_source.bx"
mkdir -p "$MERGED_DIR"
rm -f "$MERGED_FILE"

echo "[1/5] Concatenating BoxLang sources..."
for f in "$SCRIPT_DIR/src/listeners/BoxDoxListener.bx"; do
    if [ -f "$f" ]; then
        echo "  + $(basename $(dirname $f))/$(basename $f)"
        cat "$f" >> "$MERGED_FILE"
        echo "" >> "$MERGED_FILE"
    fi
done
echo "  Merged source: $MERGED_FILE ($(wc -c < "$MERGED_FILE") bytes)"

echo "[5/5] Copying static assets..."
ASSETS_DIR="$SCRIPT_DIR/dist/assets"
mkdir -p "$ASSETS_DIR/css" "$ASSETS_DIR/js"
if ls "$SCRIPT_DIR/assets/css/"* >/dev/null 2>&1; then
    cp -rf "$SCRIPT_DIR/assets/css/"* "$ASSETS_DIR/css/"
    echo "  Copied CSS assets"
fi
if ls "$SCRIPT_DIR/assets/js/"* >/dev/null 2>&1; then
    cp -rf "$SCRIPT_DIR/assets/js/"* "$ASSETS_DIR/js/"
    echo "  Copied JS assets"
fi
if [ -f "$SCRIPT_DIR/assets/index.html" ]; then
    cp -f "$SCRIPT_DIR/assets/index.html" "$ASSETS_DIR/index.html"
    echo "  Copied index.html"
fi
echo "  Assets dir: $ASSETS_DIR"

bash "$PROJECT_ROOT/crates/matchbox-cf-worker/examples/build.sh" \
    "$SCRIPT_DIR" \
    "$MERGED_FILE" \
    "BoxDoxListener" \
    "" \
    "$SCRIPT_DIR/state.json"

ln -sf dist/worker.wasm "$SCRIPT_DIR/worker.wasm"
echo "  Symlinked: $SCRIPT_DIR/worker.wasm -> dist/worker.wasm"
