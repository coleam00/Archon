#!/usr/bin/env bash
# dev-restart.sh — Kill any running Archon dev processes and restart them fresh.
# Run from the repo root: bash scripts/dev-restart.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$(dirname "$REPO_ROOT")/logs"
LOG_FILE="$LOG_DIR/server.log"

mkdir -p "$LOG_DIR"

echo "==> Stopping existing Archon processes..."
pkill -f "bun.*@archon/server.*dev" 2>/dev/null || true
pkill -f "bun.*@archon/web.*dev"    2>/dev/null || true
pkill -f "bun.*dev:server"          2>/dev/null || true
pkill -f "bun.*dev:web"             2>/dev/null || true
# Release port 3090 if anything else is still holding it
fuser -k 3090/tcp 2>/dev/null || true
sleep 1

echo "==> Starting Archon server (logs -> $LOG_FILE)..."
cd "$REPO_ROOT"
PATH="$HOME/.bun/bin:$PATH" bun run dev:server &>"$LOG_FILE" &
SERVER_PID=$!
echo "    server PID: $SERVER_PID"

echo "==> Starting Archon web UI..."
PATH="$HOME/.bun/bin:$PATH" bun run dev:web &
WEB_PID=$!
echo "    web PID:    $WEB_PID"

echo ""
echo "Done. Tail server logs with:"
echo "  tail -f $LOG_FILE"
