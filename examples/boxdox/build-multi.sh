#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== BoxDox Multi-File Build ==="

BOXDOX_CONTENT="${BOXDOX_CONTENT:-/home/k/Git/BoxLang/box-dox/content}"

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

if [ -d "$BOXDOX_CONTENT" ]; then
    echo "[5b/5] Copying BoxDocs content to assets..."
    mkdir -p "$ASSETS_DIR/content"
    cp -rf "$BOXDOX_CONTENT/"* "$ASSETS_DIR/content/"
    CONTENT_COUNT=$(find "$ASSETS_DIR/content" -type f | wc -l)
    echo "  Copied $CONTENT_COUNT content files"

    echo "[5c/5] Generating nav-tree.json..."
    python3 -c "
import sys, json, os
rootdir = '$ASSETS_DIR/content'
def build(dirpath):
    name = os.path.basename(dirpath) if dirpath != rootdir else 'content'
    rel = os.path.relpath(dirpath, rootdir)
    path = '' if rel == '.' else rel
    entry = {'name': name, 'path': path, 'type': 'directory', 'children': []}
    items = sorted(os.listdir(dirpath))
    for item in items:
        full = os.path.join(dirpath, item)
        if os.path.isdir(full):
            entry['children'].append(build(full))
        else:
            ext = os.path.splitext(item)[1].lower()
            is_md = ext in ('.md','.mdx')
            is_img = ext in ('.png','.jpg','.jpeg','.gif','.svg','.ico')
            relpath = os.path.relpath(full, rootdir)
            entry['children'].append({'name': item, 'path': relpath, 'type': 'file', 'ext': ext, 'is_markdown': is_md, 'is_image': is_img})
    return entry
with open('$ASSETS_DIR/nav-tree.json','w') as f: json.dump(build(rootdir), f, indent=2)
"
    echo "  Generated nav-tree.json"
fi

bash "$PROJECT_ROOT/crates/matchbox-cf-worker/examples/build.sh" \
    "$SCRIPT_DIR" \
    "$MERGED_FILE" \
    "BoxDoxListener" \
    "" \
    "$SCRIPT_DIR/state.json"

ln -sf dist/worker.wasm "$SCRIPT_DIR/worker.wasm"
echo "  Symlinked: $SCRIPT_DIR/worker.wasm -> dist/worker.wasm"
