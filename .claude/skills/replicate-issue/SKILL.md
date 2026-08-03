---
name: replicate-issue
description: |
  Replicate and validate a GitHub issue by spinning up Archon, analyzing the issue,
  and systematically testing all described symptoms using browser automation.
  Use when: User wants to reproduce a bug, validate a GitHub issue, confirm a reported problem,
  or investigate whether an issue is real before working on a fix.
  Triggers: "replicate issue", "reproduce issue", "validate issue", "confirm bug",
            "test issue", "can you reproduce", "try to replicate", "verify the bug".
  Capability: Checks out main, pulls latest, starts Archon, reads the GitHub issue,
  then uses agent-browser to systematically test every symptom and produce a findings report.
  NOT for: Fixing issues (use /archon or /exp-piv-loop:fix-issue), general UI testing (use /validate-ui).
argument-hint: "[issue-number]"
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob, WebFetch, Agent
---

# Replicate GitHub Issue

Systematically reproduce and validate a GitHub issue against the live Archon application.
The goal: determine whether the reported behavior is real, identify exact reproduction steps,
discover any related issues, and provide actionable fix recommendations.

**Issue number**: `$ARGUMENTS`

If `$ARGUMENTS` is empty, ask the user for the issue number before proceeding.

---

## Phase 0: Prepare Environment

### 0.1 Switch to Main Branch and Pull Latest

Ensure you are testing against the latest code on `main` so results are accurate.

```bash
cd /path/to/archon

# Stash any local changes to avoid conflicts
git stash 2>/dev/null || true

# Switch to main and pull latest
git checkout main
git pull origin main

echo "On branch: $(git branch --show-current)"
echo "Latest commit: $(git log --oneline -1)"
```

### 0.2 Kill Existing Archon Processes

Free up ports 3090 (backend) and 5173 (frontend) so Archon starts cleanly.

```bash
pkill -f "bun.*dev:server" 2>/dev/null || true
pkill -f "bun.*dev:web" 2>/dev/null || true
pkill -f "bun.*packages/server" 2>/dev/null || true
pkill -f "bun.*packages/web" 2>/dev/null || true
fuser -k 3090/tcp 2>/dev/null || true
fuser -k 5173/tcp 2>/dev/null || true
sleep 2

# Verify ports are free
! fuser 3090/tcp 2>/dev/null && ! fuser 5173/tcp 2>/dev/null && echo "Ports 3090 and 5173 are free" || echo "WARNING: Ports still in use"
```

### 0.3 Start Archon Backend + Frontend

```bash
cd /path/to/archon

# Start both backend and frontend together
bun run dev &
sleep 8

# Verify backend is healthy
curl -s http://localhost:3090/api/health | head -c 200
echo ""

# Verify frontend is serving (port may vary if 5173 is taken)
curl -s http://localhost:5173 | head -c 100 || curl -s http://localhost:5174 | head -c 100
```

**Note**: If port 5173 is taken, Vite auto-increments (5174, 5175, etc.). Check the `bun run dev` output for the actual frontend port and use that throughout.

---

## Phase 1: Analyze the Issue

### 1.1 Read the GitHub Issue

```bash
gh issue view $ARGUMENTS --json title,body,labels,comments,state
```

Parse the issue carefully. Extract:
- **Title and summary**: What is the reported problem?
- **Reproduction steps**: What specific actions trigger the bug?
- **Expected behavior**: What should happen?
- **Actual behavior**: What happens instead?
- **Environment details**: Any specific conditions (browser, OS, timing)?
- **Labels and priority**: How severe is this?
- **Comments**: Any additional context, workarounds, or related issues?

### 1.2 Build a Test Plan

Based on the issue content, create a checklist of specific things to test.
For each symptom described in the issue, define:
1. The exact user journey to reproduce it
2. What to look for (expected vs actual)
3. Screenshots to capture as evidence

---

## Phase 2: Reproduce with Browser Automation

Use the `agent-browser` CLI (NOT Playwright) for all browser interactions.

### Core Workflow

```bash
# 1. Navigate to the page
agent-browser open http://localhost:5173

# 2. Get interactive elements
agent-browser snapshot -i

# 3. Interact using refs from the snapshot
agent-browser click @e1
agent-browser fill @e2 "text"

# 4. Re-snapshot after navigation or DOM changes
agent-browser snapshot -i

# 5. Take screenshots at every significant point
agent-browser screenshot /tmp/issue-$ARGUMENTS-{step-name}.png
```

### Testing Guidelines

- **Take screenshots liberally** — before and after each action, save to `/tmp/issue-$ARGUMENTS-*.png`
- **Read every screenshot** — use the Read tool to visually inspect each screenshot and verify what you see
- **Test the happy path first** — confirm the feature works under normal conditions before testing the bug
- **Follow the exact reproduction steps** from the issue — don't shortcut
- **Test variations** — try the same flow with slight differences (different data, different timing, page refresh)
- **Test adjacent flows** — if the issue is about workflow X, also check workflows Y and Z for similar problems
- **Use curl for API verification** — cross-reference UI state with direct API calls to confirm data accuracy
- **Check after page refresh** — many SSE/real-time bugs only manifest after navigation or refresh
- **Check across conversations** — if the issue involves conversations, test with multiple open conversations
- **Wait for async operations** — use `agent-browser wait` commands for network-dependent operations

### Triggering Workflows (if needed)

If the issue involves workflow execution, use the REST API to trigger background workflows:

```bash
# Create a conversation
CONV_ID=$(curl -s -X POST http://localhost:3090/api/conversations \
  -H "Content-Type: application/json" -d '{}' | jq -r '.conversationId')

# Trigger a workflow (archon-assist is a good general-purpose one)
curl -s -X POST http://localhost:3090/api/workflows/archon-assist/run \
  -H "Content-Type: application/json" \
  -d "{\"conversationId\":\"$CONV_ID\",\"message\":\"Your test message here\"}"
```

### Triggering Chat Messages (if needed)

```bash
curl -s -X POST "http://localhost:3090/api/conversations/$CONV_ID/message" \
  -H "Content-Type: application/json" \
  -d '{"message":"Your test message"}'
```

---

## Phase 3: Document Findings

For each symptom in the issue, record:

| Symptom | Reproduced? | Evidence | Notes |
|---------|-------------|----------|-------|
| {symptom from issue} | YES / NO / PARTIAL | Screenshot path | {details} |

### Severity Classification

- **Confirmed (Reproducible)**: The exact bug described in the issue was reproduced
- **Partially Confirmed**: The symptom appears but under different conditions than described
- **Not Reproduced**: Could not reproduce despite following the described steps
- **Related Issue Found**: A different but related problem was discovered during testing

---

## Phase 4: Investigate Root Cause (if reproduced)

If the issue was reproduced, do a targeted codebase analysis:

1. **Identify the affected components** — which files/hooks/components are involved?
2. **Read the relevant source code** — understand the current implementation
3. **Trace the data flow** — where does the data come from? SSE? REST? React Query? useState?
4. **Identify the root cause** — what specifically causes the observed behavior?
5. **Check for similar patterns** — are other components vulnerable to the same issue?

---

## Phase 5: Recommendations

Provide **multiple fix options** with trade-offs:

### Option Format

For each recommendation:

```markdown
### Option N: {Short title}

**Approach**: {1-2 sentence description}

**Changes required**:
- {file}: {what changes}
- {file}: {what changes}

**Pros**:
- {benefit}

**Cons**:
- {drawback}

**Complexity**: Low / Medium / High
**Risk**: Low / Medium / High
```

Provide at least 2-3 options ranging from quick fix to comprehensive solution.

---

## Phase 6: Cleanup

```bash
# Close the browser
agent-browser close

# Stop Archon (optional — leave running if user wants to continue testing)
# fuser -k 3090/tcp 2>/dev/null
# fuser -k 5173/tcp 2>/dev/null
```

---

## Phase 7: Summary Report

Present a final summary to the user:

```markdown
# Issue #$ARGUMENTS Replication Report

## Issue: {title}
**Status**: Reproduced / Not Reproduced / Partially Reproduced
**Tested on**: main @ {commit hash}

## Reproduction Summary
{2-3 sentences describing what was tested and the outcome}

## Findings
{Detailed findings with screenshot references}

## Root Cause
{If identified — what causes the bug and why}

## Related Issues Discovered
{Any additional problems found during testing}

## Recommendations
{Summary of fix options with recommended approach}
```

---

## Execution Notes

- Always use `agent-browser` (Vercel Agent Browser CLI), NOT Playwright
- Load the `/agent-browser` skill if you need a command reference
- Take screenshots at EVERY significant test point — these are your evidence
- Read screenshots with the Read tool to visually verify what the UI shows
- If reproduction requires long-running operations, be patient — wait for workflows to complete
- Cross-reference browser state with API responses (`curl`) to distinguish UI bugs from backend bugs
- If the issue cannot be reproduced, document what you tried and suggest possible reasons
- Close the browser when finished: `agent-browser close`
