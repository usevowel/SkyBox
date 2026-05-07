#!/bin/bash
# build-multi.sh — Multi-file build for SkyBox ChatRoom
#
# Concatenates all .bx sources from src/ into a single merged source,
# then runs the standard build pipeline.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

echo "=== Multi-File Build ==="
echo "Project root: $PROJECT_ROOT"
echo "Example dir:  $SCRIPT_DIR"

# Step 1: Concatenate all .bx files
MERGED_DIR="$SCRIPT_DIR/.skybox-build"
MERGED_FILE="$MERGED_DIR/merged_source.bx"
mkdir -p "$MERGED_DIR"
rm -f "$MERGED_FILE"

echo "[1/5] Concatenating BoxLang sources..."
for f in "$SCRIPT_DIR/src/Application.bx" \
         "$SCRIPT_DIR/src/listeners/ChatRoom.bx" \
         "$SCRIPT_DIR/src/handlers/MessageRouter.bx" \
         "$SCRIPT_DIR/src/models/ChatState.bx"; do
    if [ -f "$f" ]; then
        echo "  + $(basename $(dirname $f))/$(basename $f)"
        cat "$f" >> "$MERGED_FILE"
        echo "" >> "$MERGED_FILE"
    fi
done

echo "  Merged source: $MERGED_FILE ($(wc -c < "$MERGED_FILE") bytes)"

# Step 2-5: Run standard build pipeline
bash "$PROJECT_ROOT/crates/matchbox-cf-worker/examples/build.sh" \
    "$SCRIPT_DIR" \
    "$MERGED_FILE" \
    "ChatRoom" \
    "" \
    "$SCRIPT_DIR/state.json"
