#!/bin/bash
# build-multi.sh — Multi-file build for SkyChat (AI Chat)
#
# Concatenates all .bx sources from src/ into a single merged source,
# copies static assets, then runs the standard build pipeline.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== Multi-File Build ==="
echo "Project root: $PROJECT_ROOT"
echo "Example dir:  $SCRIPT_DIR"

# Step 1: Concatenate all .bx files
MERGED_DIR="$SCRIPT_DIR/.skybox-build"
MERGED_FILE="$MERGED_DIR/merged_source.bx"
mkdir -p "$MERGED_DIR"
rm -f "$MERGED_FILE"

echo "[1/5] Concatenating BoxLang sources..."
for f in "$SCRIPT_DIR/src/listeners/SkychatListener.bx"; do
    if [ -f "$f" ]; then
        echo "  + $(basename $(dirname $f))/$(basename $f)"
        cat "$f" >> "$MERGED_FILE"
        echo "" >> "$MERGED_FILE"
    fi
done

echo "  Merged source: $MERGED_FILE ($(wc -c < "$MERGED_FILE") bytes)"

# Step X: Copy static assets to dist/assets/
echo "[5/5] Copying static assets..."
ASSETS_DIR="$SCRIPT_DIR/dist/assets"
mkdir -p "$ASSETS_DIR/css" "$ASSETS_DIR/js"
if [ -d "$SCRIPT_DIR/assets/css" ]; then
    cp -rf "$SCRIPT_DIR/assets/css/"* "$ASSETS_DIR/css/"
fi
if [ -d "$SCRIPT_DIR/assets/js" ]; then
    cp -rf "$SCRIPT_DIR/assets/js/"* "$ASSETS_DIR/js/"
fi
echo "  Assets copied to $ASSETS_DIR"

# Step 2-5: Run standard build pipeline
bash "$PROJECT_ROOT/crates/matchbox-cf-worker/examples/build.sh" \
    "$SCRIPT_DIR" \
    "$MERGED_FILE" \
    "SkychatListener" \
    "" \
    "$SCRIPT_DIR/state.json"

# Symlink worker.wasm to example root for wrangler dev
ln -sf dist/worker.wasm "$SCRIPT_DIR/worker.wasm"
echo "  Symlinked: $SCRIPT_DIR/worker.wasm -> dist/worker.wasm"
