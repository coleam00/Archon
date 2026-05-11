---
description: Start Archon from the feature branch, use agent-browser to verify the fix works correctly
argument-hint: (none - reads from artifacts)
---

# E2E Testing: Feature Branch (Verify Fix)

Start Archon from the **feature branch** (this worktree) and use browser automation to verify that the bug is fixed and the UI/UX is correct. Take screenshots as evidence.

**CRITICAL**: You MUST use the `agent-browser` CLI for ALL browser interactions. Load the `/agent-browser` skill for the full command reference.

**CRITICAL**: You MUST clean up ALL spawned processes before finishing. Record PIDs and kill them in Phase 4. Orphaned processes from previous E2E runs may still be running — check and kill them first.

**CRITICAL — SESSION ISOLATION**: This workflow runs in parallel with other validate-pr instances.
You MUST use `--session $WORKFLOW_ID` on EVERY `agent-browser` command to isolate your browser session.
Example: `agent-browser --session $WORKFLOW_ID open "http://..."`, `agent-browser --session $WORKFLOW_ID snapshot -i`, etc.

**ABSOLUTELY FORBIDDEN — NEVER DO ANY OF THESE**:
- `taskkill //F //IM chrome.exe` or ANY variant that kills chrome by image name — this kills the USER's browser
- `taskkill //F //IM node.exe` or `taskkill //F //IM bun.exe` — this kills Claude Code, the Archon server, and all other workflows
- `pkill chrome`, `pkill node`, `pkill bun`, or any broad process-name kill
- `agent-browser close` without `--session $WORKFLOW_ID` — this kills OTHER workflows' browser sessions
- Any "kill everything" or "kill all" escalation pattern — if agent-browser isn't working, SKIP E2E testing and note it in your report
- If agent-browser fails to connect after 2 attempts, STOP trying and write your findings based on code review only

---

## Phase 0: Kill Orphaned Processes from Previous E2E Run

Before starting, clean up any leftover processes from the main branch E2E test:

```bash
BACKEND_PORT=$(cat $ARTIFACTS_DIR/.backend-port | tr -d '\n')
FRONTEND_PORT=$(cat $ARTIFACTS_DIR/.frontend-port | tr -d '\n')

# Kill by PID files from main E2E run
for pidfile in "$ARTIFACTS_DIR/.e2e-main-backend-pid" "$ARTIFACTS_DIR/.e2e-main-frontend-pid"; do
  if [ -f "$pidfile" ]; then
    PID=$(cat "$pidfile" | tr -d '\n')
    echo "Killing leftover main E2E PID $PID"
    kill "$PID" 2>/dev/null || taskkill //F //T //PID "$PID" 2>/dev/null || true
  fi
done

# Kill anything still on our ports
for PORT in $BACKEND_PORT $FRONTEND_PORT; do
  fuser -k "$PORT/tcp" 2>/dev/null || true
  lsof -ti:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
  netstat -ano 2>/dev/null | grep ":$PORT " | grep LISTENING | awk '{print $5}' | sort -u | while read pid; do
    taskkill //F //T //PID "$pid" 2>/dev/null || true
  done
done
sleep 2
echo "Orphan cleanup complete"
```

---

## Phase 1: Load Context

### 1.1 Read Artifacts

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number | tr -d '\n')
BACKEND_PORT=$(cat $ARTIFACTS_DIR/.backend-port | tr -d '\n')
FRONTEND_PORT=$(cat $ARTIFACTS_DIR/.frontend-port | tr -d '\n')
WORKTREE_PATH=$(cat $ARTIFACTS_DIR/.worktree-path | tr -d '\n')
echo "PR: #$PR_NUMBER"
echo "Backend port: $BACKEND_PORT"
echo "Frontend port: $FRONTEND_PORT"
echo "Feature branch path: $WORKTREE_PATH"
```

### 1.2 Read Main Branch Test Results

```bash
cat $ARTIFACTS_DIR/e2e-main.md 2>/dev/null || echo "No main branch E2E results available"
```

This tells you:
- Which bugs were reproduced on main (you need to verify they're FIXED here)
- Which test cases to re-run
- What screenshots to compare against

### 1.3 Read Code Reviews

```bash
cat $ARTIFACTS_DIR/code-review-main.md 2>/dev/null || echo ""
cat $ARTIFACTS_DIR/code-review-feature.md 2>/dev/null || echo ""
```

---

## Phase 2: Start Archon on Feature Branch

### 2.1 Install Dependencies (if needed)

```bash
WORKTREE_PATH=$(cat $ARTIFACTS_DIR/.worktree-path | tr -d '\n')
cd "$WORKTREE_PATH" && bun install --frozen-lockfile 2>/dev/null || bun install
```

### 2.2 Start Backend on Custom Port

**IMPORTANT**: Record the PID so we can kill it later. Redirect output to /dev/null to prevent terminal spawning.

```bash
WORKTREE_PATH=$(cat $ARTIFACTS_DIR/.worktree-path | tr -d '\n')
BACKEND_PORT=$(cat $ARTIFACTS_DIR/.backend-port | tr -d '\n')

cd "$WORKTREE_PATH" && PORT=$BACKEND_PORT bun run --filter @archon/server dev > "$ARTIFACTS_DIR/.e2e-feature-backend.log" 2>&1 &
BACKEND_PID=$!
echo "$BACKEND_PID" > "$ARTIFACTS_DIR/.e2e-feature-backend-pid"
echo "Backend started with PID: $BACKEND_PID"

# Poll until healthy (max 60s)
MAX_WAIT=60
WAITED=0
until curl -sf "http://localhost:$BACKEND_PORT/api/health" > /dev/null 2>&1; do
  if [ $WAITED -ge $MAX_WAIT ]; then
    echo "ERROR: Backend did not become healthy within ${MAX_WAIT}s"
    echo "Last log lines:"
    tail -20 "$ARTIFACTS_DIR/.e2e-feature-backend.log" 2>/dev/null || true
    exit 1
  fi
  sleep 2
  WAITED=$((WAITED + 2))
done
echo "Backend healthy after ${WAITED}s"
curl -s "http://localhost:$BACKEND_PORT/api/health" | head -c 200
echo ""
```

### 2.3 Start Frontend on Custom Port

```bash
WORKTREE_PATH=$(cat $ARTIFACTS_DIR/.worktree-path | tr -d '\n')
BACKEND_PORT=$(cat $ARTIFACTS_DIR/.backend-port | tr -d '\n')
FRONTEND_PORT=$(cat $ARTIFACTS_DIR/.frontend-port | tr -d '\n')

cd "$WORKTREE_PATH/packages/web" && PORT=$BACKEND_PORT npx vite --port $FRONTEND_PORT --host > "$ARTIFACTS_DIR/.e2e-feature-frontend.log" 2>&1 &
FRONTEND_PID=$!
echo "$FRONTEND_PID" > "$ARTIFACTS_DIR/.e2e-feature-frontend-pid"
echo "Frontend started with PID: $FRONTEND_PID"

# Poll until serving (max 60s)
MAX_WAIT=60
WAITED=0
until curl -sf "http://localhost:$FRONTEND_PORT" > /dev/null 2>&1; do
  if [ $WAITED -ge $MAX_WAIT ]; then
    echo "ERROR: Frontend did not become ready within ${MAX_WAIT}s"
    echo "Last log lines:"
    tail -20 "$ARTIFACTS_DIR/.e2e-feature-frontend.log" 2>/dev/null || true
    exit 1
  fi
  sleep 2
  WAITED=$((WAITED + 2))
done
echo "Frontend ready after ${WAITED}s"
curl -s "http://localhost:$FRONTEND_PORT" | head -c 100
echo ""
```

### 2.4 Seed Test Data (if needed)

```bash
BACKEND_PORT=$(cat $ARTIFACTS_DIR/.backend-port | tr -d '\n')

# Check if codebases exist
CODEBASE_COUNT=$(curl -s "http://localhost:$BACKEND_PORT/api/codebases" | grep -c '"id"' || echo 0)

if [ "$CODEBASE_COUNT" -eq 0 ]; then
  WORKTREE_PATH=$(cat $ARTIFACTS_DIR/.worktree-path | tr -d '\n')
  curl -s -X POST "http://localhost:$BACKEND_PORT/api/codebases" \
    -H "Content-Type: application/json" \
    -d "{\"path\": \"$WORKTREE_PATH\"}"
fi
```

---

## Phase 3: Browser Testing (Verify Fix)

### 3.1 Load the Agent-Browser Skill

**YOU MUST LOAD THE AGENT-BROWSER SKILL NOW.** Use `/agent-browser` or invoke the skill. This gives you the full command reference for browser automation.

### 3.2 Core Browser Workflow

```bash
# 1. Open the Archon UI (ALWAYS use --session)
FRONTEND_PORT=$(cat $ARTIFACTS_DIR/.frontend-port | tr -d '\n')
agent-browser --session $WORKFLOW_ID open "http://localhost:$FRONTEND_PORT"

# 2. Wait for the app to load
agent-browser --session $WORKFLOW_ID wait --load networkidle

# 3. Get interactive elements
agent-browser --session $WORKFLOW_ID snapshot -i

# 4. Take a screenshot of initial state
agent-browser --session $WORKFLOW_ID screenshot "$ARTIFACTS_DIR/e2e-feature-01-initial.png"
```

### 3.3 Re-Run All Test Cases from Main

For EVERY test case that was run on main, re-run it on the feature branch:

1. **Same preconditions** — set up identical starting state
2. **Same reproduction steps** — follow the exact same actions
3. **Verify the fix** — the bug should NOT be present now
4. **Capture evidence** — screenshot at same points as main for side-by-side comparison
5. **Read each screenshot** — use the Read tool to visually inspect
6. **Compare with main** — explicitly note what's different

### 3.4 Additional UX Validation

Beyond just checking the bug is fixed, validate the overall experience:

1. **Happy path works** — the normal user flow is smooth
2. **Edge cases** — try unusual inputs, rapid clicks, page refreshes
3. **Visual quality** — no layout issues, colors correct, text readable
4. **Responsiveness** — resize the viewport, check different sizes:
   ```bash
   agent-browser --session $WORKFLOW_ID set viewport 1920 1080
   agent-browser --session $WORKFLOW_ID screenshot "$ARTIFACTS_DIR/e2e-feature-desktop.png"
   agent-browser --session $WORKFLOW_ID set viewport 768 1024
   agent-browser --session $WORKFLOW_ID screenshot "$ARTIFACTS_DIR/e2e-feature-tablet.png"
   ```
5. **No regressions** — other features near the fix still work correctly

### 3.5 API Cross-Verification

```bash
BACKEND_PORT=$(cat $ARTIFACTS_DIR/.backend-port | tr -d '\n')

# Verify data integrity matches UI
curl -s "http://localhost:$BACKEND_PORT/api/conversations" | head -c 500
```

---

## Phase 4: Cleanup and Report

**CRITICAL: You MUST complete cleanup before writing findings. Orphaned processes will accumulate and crash the system.**

### 4.1 Close Browser

```bash
# ALWAYS use --session to only close YOUR browser, not other workflows'
agent-browser --session $WORKFLOW_ID close 2>/dev/null || true
```

### 4.2 Stop Feature Branch Archon (Cross-Platform)

Kill processes by PID (recorded in Phase 2) AND by port (fallback). This works on both Windows and Unix.

```bash
BACKEND_PORT=$(cat $ARTIFACTS_DIR/.backend-port | tr -d '\n')
FRONTEND_PORT=$(cat $ARTIFACTS_DIR/.frontend-port | tr -d '\n')

# Kill by recorded PID (primary method — both main and feature PIDs)
for pidfile in "$ARTIFACTS_DIR/.e2e-feature-backend-pid" "$ARTIFACTS_DIR/.e2e-feature-frontend-pid" "$ARTIFACTS_DIR/.e2e-main-backend-pid" "$ARTIFACTS_DIR/.e2e-main-frontend-pid"; do
  if [ -f "$pidfile" ]; then
    PID=$(cat "$pidfile" | tr -d '\n')
    echo "Killing PID $PID from $pidfile"
    kill "$PID" 2>/dev/null || taskkill //F //T //PID "$PID" 2>/dev/null || true
  fi
done

# Fallback: kill by port (handles child processes the PID kill might miss)
for PORT in $BACKEND_PORT $FRONTEND_PORT; do
  echo "Cleaning up port $PORT..."
  fuser -k "$PORT/tcp" 2>/dev/null || true
  lsof -ti:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
  netstat -ano 2>/dev/null | grep ":$PORT " | grep LISTENING | awk '{print $5}' | sort -u | while read pid; do
    taskkill //F //T //PID "$pid" 2>/dev/null || true
  done
done

sleep 2
echo "Cleanup complete — verify ports are free:"
netstat -ano 2>/dev/null | grep -E ":($BACKEND_PORT|$FRONTEND_PORT) " | grep LISTENING || echo "All ports free"
```

### 4.3 Write Findings

Write to `$ARTIFACTS_DIR/e2e-feature.md`:

```markdown
# E2E Test Results: Feature Branch

**PR**: #{number}
**Branch**: {feature-branch} @ {commit}
**Backend Port**: {port}
**Frontend Port**: {port}
**Screenshots**: $ARTIFACTS_DIR/e2e-feature-*.png

## Test Summary

| Test Case | Main Result | Feature Result | Fix Verified? |
|-----------|-------------|----------------|---------------|
| {test 1} | BUG REPRODUCED | FIXED | YES / NO |
| {test 2} | BUG REPRODUCED | FIXED | YES / NO |

## Detailed Findings

### Test 1: {description}
**Main branch**: {bug behavior — reference e2e-main screenshot}
**Feature branch**: {fixed behavior — reference e2e-feature screenshot}
**Fix verified**: YES / NO / PARTIAL
**Screenshot comparison**: `e2e-main-{N}.png` vs `e2e-feature-{N}.png`

### Test 2: {description}
{Same structure...}

## UX Quality Assessment

| Aspect | Rating (1-5) | Notes |
|--------|-------------|-------|
| Visual correctness | {n} | {details} |
| Responsiveness | {n} | {details} |
| Edge case handling | {n} | {details} |
| Error states | {n} | {details} |
| Performance feel | {n} | {details} |

## Regressions Found
{Any new issues introduced by the fix, or NONE}

## Additional Observations
{Any other UX improvements or issues noticed}

## Fix Confidence
**HIGH / MEDIUM / LOW**

{Overall confidence that the fix works correctly and completely}
```

---

## Success Criteria

- **ARCHON_STARTED**: Backend and frontend running on feature branch code
- **ALL_TESTS_RERUN**: Every test case from main branch E2E re-executed
- **FIX_VERIFIED**: Each bug confirmed fixed (or documented as still present)
- **UX_VALIDATED**: Visual quality, responsiveness, edge cases checked
- **NO_REGRESSIONS**: No new issues introduced
- **ARCHON_STOPPED**: Processes killed, ports freed — **VERIFY ports are free before finishing**
- **ARTIFACT_WRITTEN**: `$ARTIFACTS_DIR/e2e-feature.md` created
