#!/usr/bin/env bash
# e2e-cursor-live.sh — Live end-to-end gate for the Cursor community provider.
#
# Proves Archon routes to a real @cursor/sdk local agent: repo file read,
# multi-node DAG, persist_session resume, orchestrator chat, and assist path.
#
# Prerequisites:
#   - CURSOR_API_KEY in ~/.archon/.env (CLI does not load repo-root .env)
#   - Linked CLI: cd packages/cli && bun link
#   - Local Cursor runtime (Cursor app / SDK local executor)
#   - npm rebuild sqlite3 (if @cursor/sdk local runtime fails to start)
#
# Usage: bun run e2e:cursor:live   (from repo root)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ARCHON_HOME="${ARCHON_HOME:-$HOME/.archon}"
SESSION_SCOPE="cursor-live-e2e"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

step=0
run_step() {
  step=$((step + 1))
  echo ""
  echo "────────────────────────────────────────"
  echo "Step ${step}: $1"
  echo "────────────────────────────────────────"
}

fail() {
  echo -e "${RED}✗${NC} $1" >&2
  exit 1
}

pass() {
  echo -e "${GREEN}✓${NC} $1"
}

warn() {
  echo -e "${YELLOW}!${NC} $1"
}

# Resolve archon CLI (linked global or bun fallback)
if command -v archon >/dev/null 2>&1; then
  ARCHON=(archon)
else
  warn "archon not in PATH — using bun run cli"
  ARCHON=(bun run cli)
fi

echo "Cursor Live E2E"
echo "==============="
echo "Repo:  $ROOT"
echo "Home:  $ARCHON_HOME"

# ─── Prerequisites ───────────────────────────────────────────────────────────

run_step "Prerequisites"

if ! command -v bun >/dev/null 2>&1; then
  fail "bun is required"
fi

if ! "${ARCHON[@]}" version >/dev/null 2>&1; then
  fail "archon CLI not available. Run: cd packages/cli && bun link"
fi
pass "archon CLI: $("${ARCHON[@]}" version 2>/dev/null | head -1)"

# Load user-scoped secrets (CLI path)
if [[ -f "$ARCHON_HOME/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ARCHON_HOME/.env" 2>/dev/null || true
  set +a
fi

if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  fail "CURSOR_API_KEY not set. Add it to $ARCHON_HOME/.env"
fi
pass "CURSOR_API_KEY is set"

# Best-effort sqlite3 rebuild for @cursor/sdk local runtime under Bun
if command -v npm >/dev/null 2>&1; then
  if ! npm rebuild sqlite3 >/dev/null 2>&1; then
    warn "npm rebuild sqlite3 failed — local Cursor runtime may not start"
  else
    pass "sqlite3 bindings rebuilt"
  fi
else
  warn "npm not found — skip sqlite3 rebuild (run: npm rebuild sqlite3 if SDK fails)"
fi

# ─── Step 1: Fast smoke ──────────────────────────────────────────────────────

run_step "e2e-cursor-smoke (connectivity)"
SMOKE_OUT="$("${ARCHON[@]}" workflow run e2e-cursor-smoke --no-worktree "smoke" 2>&1)" || {
  echo "$SMOKE_OUT"
  fail "e2e-cursor-smoke failed"
}
echo "$SMOKE_OUT"
echo "$SMOKE_OUT" | grep -q "PASS:" || fail "e2e-cursor-smoke: expected PASS in output"
pass "e2e-cursor-smoke passed"

# ─── Step 2: Live DAG ────────────────────────────────────────────────────────

run_step "e2e-cursor-live (local runtime + all node types)"
LIVE_OUT="$(LOG_LEVEL=debug "${ARCHON[@]}" workflow run e2e-cursor-live --no-worktree "live" --verbose 2>&1)" || {
  echo "$LIVE_OUT"
  fail "e2e-cursor-live failed"
}
echo "$LIVE_OUT"
echo "$LIVE_OUT" | grep -q "PASS: all node types + local runtime verified" || fail "live assert did not pass"
pass "e2e-cursor-live passed"

# ─── Step 3–4: Session resume ────────────────────────────────────────────────

run_step "e2e-cursor-session seed (persist_session)"
# Clear prior session for this scope so seed/recall is deterministic
"${ARCHON[@]}" workflow reset-sessions e2e-cursor-session --scope "$SESSION_SCOPE" --yes >/dev/null 2>&1 || true

SEED_OUT="$("${ARCHON[@]}" workflow run e2e-cursor-session --no-worktree \
  --conversation-id "$SESSION_SCOPE" \
  "Remember the codeword ARCHON_LIVE. Reply with exactly: stored." 2>&1)" || {
  echo "$SEED_OUT"
  fail "e2e-cursor-session seed failed"
}
echo "$SEED_OUT"
echo "$SEED_OUT" | grep -qi "stored" || fail "session seed: expected 'stored' in output"
pass "session seed passed"

run_step "e2e-cursor-session recall (Agent.resume via persist_session)"
RECALL_OUT="$("${ARCHON[@]}" workflow run e2e-cursor-session --no-worktree \
  --conversation-id "$SESSION_SCOPE" \
  "What codeword did I ask you to remember? Reply with only that word." 2>&1)" || {
  echo "$RECALL_OUT"
  fail "e2e-cursor-session recall failed"
}
echo "$RECALL_OUT"
echo "$RECALL_OUT" | grep -qi "ARCHON_LIVE" || fail "session recall: expected ARCHON_LIVE in output"
pass "session recall passed"

# Cleanup persisted session
"${ARCHON[@]}" workflow reset-sessions e2e-cursor-session --scope "$SESSION_SCOPE" --yes >/dev/null 2>&1 || true

# ─── Step 5: Orchestrator chat ───────────────────────────────────────────────

run_step "archon chat (orchestrator → Cursor provider)"
CHAT_OUT="$(DEFAULT_AI_ASSISTANT=cursor "${ARCHON[@]}" chat "What is 2+2? Reply with only the number." 2>&1)" || {
  echo "$CHAT_OUT"
  fail "archon chat failed"
}
echo "$CHAT_OUT"
echo "$CHAT_OUT" | grep -q "4" || fail "archon chat: expected '4' in output"
pass "archon chat passed"

# ─── Step 6: Assist path ─────────────────────────────────────────────────────

run_step "archon-assist workflow (command node → Cursor)"
ASSIST_OUT="$("${ARCHON[@]}" workflow run assist --no-worktree \
  "What is 2+2? Reply with only the number." 2>&1)" || {
  echo "$ASSIST_OUT"
  fail "archon-assist failed"
}
echo "$ASSIST_OUT"
echo "$ASSIST_OUT" | grep -q "4" || fail "archon-assist: expected '4' in output"
pass "archon-assist passed"

echo ""
echo -e "${GREEN}All Cursor live E2E steps passed.${NC}"
