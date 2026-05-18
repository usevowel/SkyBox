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

echo "[2/5] Building React frontend with Vite..."
(cd "$SCRIPT_DIR/client" && bun install --frozen-lockfile 2>/dev/null; bun run build 2>&1 | tail -5)
echo "  Vite build complete"

echo "[3/5] Copying BoxDocs content to assets..."
ASSETS_DIR="$SCRIPT_DIR/dist/assets"
mkdir -p "$ASSETS_DIR/content"
if [ -d "$BOXDOX_CONTENT" ]; then
    cp -rf "$BOXDOX_CONTENT/"* "$ASSETS_DIR/content/"
    CONTENT_COUNT=$(find "$ASSETS_DIR/content" -type f | wc -l)
    echo "  Copied $CONTENT_COUNT content files"
fi

echo "[4/5] Generating nav-tree.json..."
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

echo "[5/5] Compiling BoxLang Worker WASM..."
bash "$PROJECT_ROOT/crates/matchbox-cf-worker/examples/build.sh" \
    "$SCRIPT_DIR" \
    "$MERGED_FILE" \
    "BoxDoxListener" \
    "" \
    "$SCRIPT_DIR/state.json"

ln -sf dist/worker.wasm "$SCRIPT_DIR/worker.wasm"
echo "  Symlinked: $SCRIPT_DIR/worker.wasm -> dist/worker.wasm"

# Remove large ONNX WASM (exceeds CF 25 MiB asset limit)
find "$ASSETS_DIR" -name "*ort-wasm*" -delete 2>/dev/null

echo "=== Build Complete ==="
du -sh "$ASSETS_DIR" "$SCRIPT_DIR/dist/worker.wasm"
