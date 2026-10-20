#!/bin/sh
# Builds a tiny launcher that runs only dist/index.js with the current node.
# Grant Full Disk Access to the launcher instead of to node. Re-run (and re-grant) after moving the repo or changing node.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
OUT="${1:-$HOME/.local/share/imessage-mcp/imessage-mcp-launcher}"
mkdir -p "$(dirname "$OUT")"
cc -O2 -DNODE_PATH="\"$NODE\"" -DSERVER_PATH="\"$ROOT/dist/index.js\"" -o "$OUT" "$ROOT/launcher.c"
codesign --force --sign - --identifier com.imessage-mcp.launcher "$OUT"
echo "Built $OUT"
