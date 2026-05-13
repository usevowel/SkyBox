#!/bin/bash
# Fast parallel upload of BoxDocs content to R2
# Usage: bash upload-content-fast.sh
set -euo pipefail

BOXDOX_CONTENT="${BOXDOX_CONTENT:-/home/k/Git/BoxLang/box-dox/content}"
BUCKET="${BUCKET:-skybox-boxdox-content}"
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-84882f590c2154079d59fbaef6fb382b}"
JOBS="${JOBS:-10}"

if [ ! -d "$BOXDOX_CONTENT" ]; then
    echo "ERROR: Content directory not found: $BOXDOX_CONTENT"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Generate nav-tree.json
echo "── Generating nav-tree.json ..."
cd "$BOXDOX_CONTENT"
ALL_FILES=$(find . -type f | sort)
FILE_COUNT=$(echo "$ALL_FILES" | wc -l)

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

# Upload nav-tree.json
echo "── Uploading nav-tree.json ..."
CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID npx wrangler r2 object put "$BUCKET/nav-tree.json" --file "$TMPDIR/nav-tree.json" --remote >/dev/null 2>&1
echo "  OK"

# Generate upload script with all files
echo "── Uploading $FILE_COUNT files to R2 (${JOBS} parallel jobs) ..."
UPLOAD_SCRIPT="$TMPDIR/upload.sh"
echo '#!/bin/bash' > "$UPLOAD_SCRIPT"
echo 'set -euo pipefail' >> "$UPLOAD_SCRIPT"
echo "ACCOUNT_ID=$ACCOUNT_ID" >> "$UPLOAD_SCRIPT"
echo "BUCKET=$BUCKET" >> "$UPLOAD_SCRIPT"
echo 'f=$1' >> "$UPLOAD_SCRIPT"
echo 'relpath="${f#./}"' >> "$UPLOAD_SCRIPT"
echo 'r2key="content/$relpath"' >> "$UPLOAD_SCRIPT"
echo 'CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID npx wrangler r2 object put "$BUCKET/$r2key" --file "$relpath" --remote >/dev/null 2>&1' >> "$UPLOAD_SCRIPT"
chmod +x "$UPLOAD_SCRIPT"

cd "$BOXDOX_CONTENT"
echo "$ALL_FILES" | xargs -P "$JOBS" -I{} bash "$UPLOAD_SCRIPT" "{}"

echo ""
echo "── Complete: $FILE_COUNT files uploaded to $BUCKET ──"
