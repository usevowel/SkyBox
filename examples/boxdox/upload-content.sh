#!/usr/bin/env bash
# Upload box-dox/content to R2 bucket + generate nav-tree.json
#
# Usage:
#   bash upload-content.sh              # dry-run
#   bash upload-content.sh --execute    # actually upload
set -euo pipefail

BOXDOX_CONTENT="${BOXDOX_CONTENT:-/home/k/Git/BoxLang/box-dox/content}"
BUCKET="${BUCKET:-skybox-boxdox-content}"
EXECUTE="${1:-}"

if [ ! -d "$BOXDOX_CONTENT" ]; then
    echo "ERROR: Content directory not found: $BOXDOX_CONTENT"
    echo "Set BOXDOX_CONTENT env var"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMPDIR=$(mktemp -d) ; trap 'rm -rf "$TMPDIR"' EXIT

get_mime() {
    case "${1,,}" in
        *.md|*.mdx)       echo "text/markdown" ;;
        *.html)           echo "text/html" ;;
        *.css)            echo "text/css" ;;
        *.js)             echo "application/javascript" ;;
        *.json)           echo "application/json" ;;
        *.png)            echo "image/png" ;;
        *.jpg|*.jpeg)     echo "image/jpeg" ;;
        *.gif)            echo "image/gif" ;;
        *.svg)            echo "image/svg+xml" ;;
        *.ico)            echo "image/x-icon" ;;
        *.webp)           echo "image/webp" ;;
        *.woff2)          echo "font/woff2" ;;
        *.txt)            echo "text/plain" ;;
        *.yaml|*.yml)     echo "application/x-yaml" ;;
        *.xml)            echo "application/xml" ;;
        *.wasm)           echo "application/wasm" ;;
        *)                echo "application/octet-stream" ;;
    esac
}

cd "$BOXDOX_CONTENT"
ALL_FILES=$(find . -type f | sort)
FILE_COUNT=$(echo "$ALL_FILES" | wc -l)

echo "── Generating nav-tree.json ..."
python3 -c "
import sys, json, os
def build():
    root = {'name': 'content', 'path': '', 'type': 'directory', 'children': []}
    dirs = {'': root}
    for line in sys.stdin:
        path = line.strip().lstrip('./')
        if not path: continue
        parts = path.split('/')
        fn = parts[-1]
        pp = ''
        pn = root
        for i in range(len(parts)-1):
            pp = pp + '/' + parts[i] if pp else parts[i]
            if pp not in dirs:
                n = {'name': parts[i], 'path': pp, 'type': 'directory', 'children': []}
                dirs[pp] = n; pn['children'].append(n)
            pn = dirs[pp]
        ext = os.path.splitext(fn)[1].lower()
        pn['children'].append({'name': fn, 'path': path, 'type': 'file', 'ext': ext,
            'is_markdown': ext in ('.md','.mdx'), 'is_image': ext in ('.png','.jpg','.jpeg','.gif','.svg','.ico')})
    return root
with open('$TMPDIR/nav-tree.json','w') as f: json.dump(build(), f, indent=2)
" <<< "$ALL_FILES"

echo "  Found $FILE_COUNT files"

if [ "$EXECUTE" != "--execute" ]; then
    echo ""
    echo "  DRY RUN. Pass --execute to upload."
    echo "  To upload: bash upload-content.sh --execute"
    echo ""
    echo "  Files that would be uploaded:"
    echo "$ALL_FILES" | head -20
    [ "$FILE_COUNT" -gt 20 ] && echo "  ... and $(($FILE_COUNT - 20)) more"
    exit 0
fi

echo "── Uploading to R2 bucket: $BUCKET ──"
COUNT=0
while IFS= read -r relpath; do
    relpath="${relpath#./}"
    r2key="content/$relpath"
    mime=$(get_mime "$relpath")
    wrangler r2 object put "$BUCKET/$r2key" --file "$relpath" --ct "$mime" >/dev/null 2>&1
    COUNT=$((COUNT + 1))
    [ $((COUNT % 100)) -eq 0 ] && echo "  $COUNT files..."
done <<< "$ALL_FILES"

echo "  Uploading nav-tree.json..."
wrangler r2 object put "$BUCKET/nav-tree.json" --file "$TMPDIR/nav-tree.json" >/dev/null 2>&1

echo ""
echo "── Complete: $COUNT files uploaded to $BUCKET ──"
