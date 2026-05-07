#!/bin/bash
# run-workerd-test.sh — Run a single workerd test with proper lifecycle
# Usage: run-workerd-test.sh <capnp-config> <port> [max-wait-sec]
set -euo pipefail

CONFIG="$1"
PORT="$2"
MAX_WAIT="${3:-10}"
RESULT_FILE=$(mktemp)

# Start workerd in background
npx workerd serve "$CONFIG" &
WORKERD_PID=$!

# Wait for it to be ready, then fetch
sleep 2
for i in $(seq 1 "$MAX_WAIT"); do
    if curl -s http://localhost:"$PORT"/ > "$RESULT_FILE" 2>/dev/null; then
        break
    fi
    sleep 1
done

# Kill workerd
kill "$WORKERD_PID" 2>/dev/null
wait "$WORKERD_PID" 2>/dev/null || true

# Show result
cat "$RESULT_FILE"
rm -f "$RESULT_FILE"
