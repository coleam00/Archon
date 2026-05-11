---
name: validate-ui
description: |
  Comprehensive end-to-end validation of the Archon Web UI using browser automation and codebase review.
  Use when: User wants to validate, test, or audit the Archon web interface, find UI/UX bugs,
  test workflow management, verify parallel agent orchestration, or run comprehensive browser-based E2E tests.
  Triggers: "validate ui", "test the ui", "e2e test", "browser test", "validate archon",
            "test archon ui", "ui audit", "ux review", "comprehensive test", "validate everything".
  Capability: Starts Archon, runs exhaustive browser automation tests via agent-browser CLI,
  performs codebase review, and produces a detailed bug/UX report.
  NOT for: Unit tests (use `bun test`), CLI-only validation (use /validation:validate-simple).
argument-hint: "[focus-area]"
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Task
---

# Archon Web UI — Comprehensive E2E Validation

Run exhaustive end-to-end browser automation tests and codebase review of the Archon Web UI.
The goal: determine whether Archon is doing the best it possibly can to solve the problem of
managing parallel agents, executing custom workflows, and providing full visibility into agent work.

Optional focus argument: `$ARGUMENTS` (e.g., "workflows", "chat", "projects"). If empty, run ALL sections.

---

## Phase 0: Environment Setup

### 0.1 Kill Old Archon Processes

```bash
# Kill any running Archon dev servers (backend + frontend)
pkill -f "bun.*dev:server" 2>/dev/null || true
pkill -f "bun.*dev:web" 2>/dev/null || true
pkill -f "bun.*packages/server" 2>/dev/null || true
pkill -f "bun.*packages/web" 2>/dev/null || true
pkill -f "vite.*5173" 2>/dev/null || true

# Kill any leftover processes on our ports
lsof -ti:3090 | xargs kill -9 2>/dev/null || true
lsof -ti:5173 | xargs kill -9 2>/dev/null || true

# Wait for ports to free up
sleep 2

# Verify ports are free
! lsof -i:3090 && ! lsof -i:5173 && echo "Ports 3090 and 5173 are free" || echo "WARNING: Ports still in use"
```

### 0.2 Install agent-browser (if needed)

```bash
# Check if agent-browser is available
which agent-browser 2>/dev/null || npx agent-browser --version 2>/dev/null

# If not installed globally, install it:
# npm install -g agent-browser && agent-browser install
# On WSL2/Linux, use --with-deps to get Chromium system dependencies:
# agent-browser install --with-deps

# IMPORTANT: Do NOT use bunx — Bun skips postinstall scripts that agent-browser needs.
# Use npx or global npm install.
```

### 0.3 Start Archon Backend + Frontend

Start both services. Backend must be up before frontend SSE connections work.

```bash
# From the repo root: /path/to/archon

# Start backend (port 3090)
cd /path/to/archon && bun run dev:server &
sleep 5  # Wait for server initialization + DB

# Verify backend is healthy
curl -s http://localhost:3090/api/health | head -c 200

# Start frontend (port 5173)
cd /path/to/archon && bun run dev:web &
sleep 5  # Wait for Vite dev server

# Verify frontend is serving
curl -s http://localhost:5173 | head -c 200
```

**URLs:**
- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:3090/api`
- SSE streams: `http://localhost:3090/api/stream/{conversationId}` (bypasses Vite proxy in dev)

### 0.4 Seed Test Data (if needed)

Check if there are existing codebases and conversations. If empty, create test data:

```bash
# Check existing codebases
curl -s http://localhost:3090/api/codebases | python3 -m json.tool 2>/dev/null || curl -s http://localhost:3090/api/codebases

# Register the current repo as a codebase (if none exist)
curl -s -X POST http://localhost:3090/api/codebases \
  -H "Content-Type: application/json" \
  -d '{"path": "/path/to/archon"}'

# Create a test conversation
curl -s -X POST http://localhost:3090/api/conversations \
  -H "Content-Type: application/json" \
  -d '{}' | python3 -m json.tool 2>/dev/null
```

---

## Phase 1: Browser Automation — End-to-End Testing

Use the `agent-browser` CLI for all browser interactions. Follow the snapshot-refs workflow:
1. `agent-browser open <url>` — navigate
2. `agent-browser snapshot -i` — get interactive elements with refs
3. Interact using refs (click, fill, etc.)
4. Re-snapshot after navigation or DOM changes

Take screenshots at each major test point: `agent-browser screenshot /tmp/archon-test-{name}.png`

### Test Suite 1: Dashboard (Route: `/`)

**1.1 Initial Load**
- Open `http://localhost:5173`
- Verify dashboard renders: stats cards (Running Workflows, Conversations, System Status)
- Check system health indicator shows "Healthy" (green)
- Screenshot the full dashboard

**1.2 Stats Accuracy**
- Compare "Running Workflows" count against `GET /api/workflows/runs?status=running`
- Compare "Conversations" count against `GET /api/conversations`
- Verify numbers update after creating new data

**1.3 Recent Items**
- Verify "Recent Conversations" list shows up to 10 items
- Verify "Recent Workflow Runs" list shows up to 10 items
- Click a conversation — verify navigation to `/chat/{id}`
- Click a workflow run — verify navigation to `/workflows/runs/{id}`
- Use browser back button — verify return to dashboard

**1.4 Empty State**
- If no conversations/runs exist: verify the empty state with "New Chat" CTA renders
- Click "New Chat" from empty state — verify navigation to `/chat`

### Test Suite 2: Project Management

**2.1 Add Project (GitHub URL)**
- Click the `+` button next to "Projects" in the sidebar
- Fill in a GitHub URL (e.g., `https://github.com/anthropics/claude-code`)
- Submit and verify the project appears in the sidebar
- Verify the project is auto-selected

**2.2 Add Project (Local Path)**
- Click `+` again
- Fill in a local path (e.g., `/path/to/archon`)
- Submit and verify the project appears
- Verify deduplication: if the path was already registered, it should not create a duplicate

**2.3 Select/Deselect Project**
- Click a project in the sidebar — verify it becomes selected (highlighted)
- Verify the sidebar content switches to `ProjectDetail` view (shows project name, repo URL, conversations scoped to project, workflow runs)
- Click "All Projects" — verify sidebar switches to `AllConversationsView` (all conversations, no project filter)
- Verify `localStorage` persists selection across page refresh

**2.4 Delete Project**
- Hover over a project — verify the trash icon appears
- Click trash — verify confirmation dialog appears
- Confirm deletion — verify project is removed from list
- Verify conversations and runs associated with the project are handled gracefully

**2.5 Project Selector in Collapsible**
- When a project is selected, verify the collapsible header shows the project name
- Click the chevron to expand — verify other projects are listed
- Switch projects via the collapsible — verify the view updates

### Test Suite 3: Chat Interface

**3.1 New Chat (No Project)**
- Click "New Chat" in sidebar (with no project selected)
- Verify empty chat interface renders with message input
- Type a message and send
- Verify: user message appears right-aligned, assistant "thinking" dots appear
- Verify: conversation is created and URL updates to `/chat/{conversationId}`
- Verify: conversation appears in sidebar

**3.2 New Chat (With Project)**
- Select a project first
- Click "New Chat"
- Send a message (e.g., `/status`)
- Verify: conversation is scoped to the selected project
- Verify: project context (cwd, codebase) is attached

**3.3 Slash Commands**
- Send `/status` — verify response shows session status
- Send `/help` — verify help text renders in markdown
- Send `/commands` — verify command list renders
- Send `/getcwd` — verify working directory is shown
- Verify: commands execute instantly (no "thinking" animation needed)

**3.4 Message Rendering**
- Send a message that triggers a markdown response from the AI
- Verify: code blocks render with syntax highlighting
- Verify: tables render properly in assistant messages
- Verify: links open in new tabs (`target="_blank"`)
- Verify: blockquotes render with left border
- Verify: inline code renders with monospace font
- Send a very long message — verify no layout overflow

**3.5 Streaming & Real-time Updates**
- Send a message that triggers an AI response
- Verify: blinking cursor appears during streaming
- Verify: text appears incrementally (not all at once)
- Verify: lock indicator shows "Agent is working..."
- Verify: lock indicator hides when response completes
- Verify: message `isStreaming` flag clears on completion

**3.6 Tool Call Cards**
- Send a message that triggers tool usage (e.g., a code question in a project context)
- Verify: tool call cards appear below the assistant message
- Verify: card shows tool name and input summary
- Click to expand a tool card — verify full input JSON and output render
- Verify: running tools show spinner animation and primary border
- Verify: completed tools show duration badge
- Test "Show N more lines" for long tool outputs

**3.7 Error Handling**
- Trigger an error condition (e.g., send a message with no AI credentials configured)
- Verify: error card renders with AlertCircle icon
- Verify: error classification badge shows (transient/fatal)
- Verify: suggested actions are listed
- Verify: the chat remains functional after an error

**3.8 Queue Position**
- If possible, trigger multiple concurrent messages to the same conversation
- Verify: queue position indicator appears ("Position N in queue")
- Verify: the lock indicator updates when the queue advances

**3.9 Auto-scroll Behavior**
- Scroll up during a streaming response
- Verify: auto-scroll stops (respects user scroll position)
- Verify: "Jump to bottom" button appears
- Click "Jump to bottom" — verify scroll snaps to latest message
- Scroll back to bottom manually — verify auto-scroll resumes

**3.10 Conversation Navigation**
- Create multiple conversations
- Click between them in the sidebar
- Verify: each conversation loads its own message history
- Verify: messages are not leaked between conversations
- Verify: the correct conversation is highlighted in the sidebar

### Test Suite 4: Conversation Management

**4.1 Rename Conversation**
- Hover over a conversation in the sidebar — verify pencil icon appears
- Click pencil — verify inline edit input appears
- Type a new title and press Enter
- Verify: title updates in sidebar and in the chat header
- Press Escape during rename — verify it cancels without saving

**4.2 Delete Conversation**
- Hover over a conversation — verify trash icon appears
- Click trash — verify confirmation dialog appears
- Confirm deletion — verify conversation is removed
- If the deleted conversation was active: verify redirect to `/`
- Verify: soft-delete (conversation is hidden, not destroyed)

**4.3 Auto-title**
- Create a new conversation and send a non-command message
- Wait 2-3 seconds
- Verify: the conversation title updates automatically based on the first message
- Verify: title is truncated to ~80 characters

**4.4 Search**
- Type in the sidebar search bar
- Verify: conversations are filtered by title match
- Clear search — verify all conversations reappear
- Press `/` key — verify search input focuses
- Press Escape — verify search clears

### Test Suite 5: Workflow Management

**5.1 Workflow List Page (`/workflows`)**
- Navigate to `/workflows`
- Verify: "Available Workflows" tab shows all discovered workflows
- Verify: each workflow card shows name and description
- Verify: "Recent Runs" tab shows recent workflow runs
- Verify: running workflows show a pulsing dot on the "Recent Runs" tab label

**5.2 Invoke Workflow from Workflows Page**
- Click on a workflow card (e.g., `archon-assist`)
- Verify: inline run panel expands with project selector and message input
- Select a project from the dropdown
- Type a message and click "Run"
- Verify: conversation is created and navigation goes to `/chat/{conversationId}`
- Verify: workflow execution begins (messages appear from the AI)

**5.3 Invoke Workflow from Sidebar (WorkflowInvoker)**
- Select a project in the sidebar
- Verify: workflow dropdown appears in `ProjectDetail` view
- Select a workflow from the dropdown
- Type a message and submit
- Verify: new conversation created, navigation to chat, workflow runs

**5.4 Workflow Router (Agent Orchestrator)**
- In a project chat, send a natural language message (e.g., "Help me understand the authentication flow")
- Verify: the router detects the intent and routes to the appropriate workflow
- Verify: workflow dispatch status message appears (e.g., "Dispatching workflow: archon-assist (background)")
- Verify: `WorkflowDispatchInline` badge appears with spinner
- Verify: clicking the dispatch badge navigates to the workflow run or worker conversation

**5.5 Workflow Progress in Chat**
- While a workflow is running, verify `WorkflowProgressCard` appears in the chat
- Verify: compact mode shows workflow name, step count, elapsed time
- Verify: elapsed timer updates every second
- Click "Open Full View" — verify navigation to `/workflows/runs/{runId}`
- Verify: returning to chat still shows the progress card

**5.6 Workflow Execution Page (`/workflows/runs/:runId`)**
- Navigate to an active or completed workflow run
- Verify: header shows workflow name, status, and elapsed time
- Verify: step progress panel (left side) shows all steps with status icons
- Click different steps — verify the log panel (right side) updates
- Verify: "Chat" link back to parent conversation works
- For dispatched workflows: verify `WorkflowLogs` renders the worker conversation messages

**5.7 Parallel Agent Steps**
- Run a workflow with parallel agents (e.g., `archon-comprehensive-pr-review` has 5 parallel agents)
- Verify: `ParallelBlockView` renders showing parent step and nested agent list
- Verify: each agent shows its own status (pending/running/completed/failed)
- Verify: overall block status derives correctly (any failed = failed, any running = running, all complete = complete)
- Verify: progress counter shows `(completed/total agents)`

**5.8 Loop Iterations**
- Run a loop workflow (e.g., `archon-test-loop` or `archon-ralph-fresh`)
- Verify: `LoopIterationView` renders with iteration counter
- Verify: progress bar fills proportionally (current/max)
- Verify: each iteration shows status
- Verify: completion signal (`<promise>COMPLETE</promise>`) ends the loop

**5.9 Workflow Artifacts**
- After a workflow completes that produces artifacts (PR URLs, commits, branches)
- Verify: `ArtifactSummary` component renders at the bottom
- Verify: URLs are clickable links opening in new tabs
- Verify: artifact type icons are correct (PR, Commit, Branch, File)

**5.10 Workflow Stale Detection**
- During a running workflow, if the SSE connection drops briefly
- Verify: `stale` indicator appears on the workflow card
- Verify: polling fallback kicks in (checks every 15 seconds)
- Verify: stale state clears when fresh data arrives

**5.11 Cancel Workflow**
- While a workflow is running, look for "Cancel" button
- If present: click and verify the workflow status changes to failed/cancelled
- If not present: note this as a UX gap

### Test Suite 6: Project-Scoped Views

**6.1 Project Detail — Conversations**
- Select a project
- Verify: only conversations scoped to that project appear
- Create a new chat within the project
- Verify: the new conversation appears in the filtered list
- Verify: conversations from other projects are NOT shown

**6.2 Project Detail — Workflow Runs**
- Verify: workflow runs scoped to the selected project appear
- Verify: runs are sorted by priority: failed > running > completed
- Click a run — verify navigation to `/workflows/runs/{id}`
- Verify: conversation status dots show on conversations with active runs

**6.3 Cross-Project Navigation**
- Start a workflow in Project A
- Switch to Project B in the sidebar
- Verify: Project A's workflow is not visible in Project B's view
- Switch back to Project A — verify the workflow run is still visible
- Click "All Projects" — verify you can see conversations from all projects

### Test Suite 7: SSE & Real-time Infrastructure

**7.1 SSE Connection**
- Open browser DevTools Network tab (via `agent-browser eval` or console)
- Verify: EventSource connection to `/api/stream/{conversationId}` is established
- Verify: heartbeat events arrive every ~30 seconds
- Verify: connection state is OPEN (readyState 1)

**7.2 SSE Reconnection**
- Kill the backend server temporarily
- Verify: the UI shows a disconnected state (grey dot in header)
- Restart the backend
- Verify: SSE reconnects automatically
- Verify: the connection indicator turns green again
- Verify: buffered messages are delivered on reconnect

**7.3 Multiple Tabs**
- Open the same conversation in two browser tabs (use `agent-browser --session` for parallel)
- Send a message from tab 1
- Verify: response streams in BOTH tabs (SSE fan-out via stream registry replacement)
- Note: the web adapter replaces old streams on new connections, so only the latest tab gets live SSE

### Test Suite 8: UI/UX Quality Audit

**8.1 Visual Hierarchy & Dark Theme**
- Screenshot the full app at different states
- Verify: text hierarchy (primary/secondary/tertiary) is readable
- Verify: interactive elements have clear hover states
- Verify: accent colors (blue-purple) are used consistently
- Verify: success (green), warning (amber), error (red) colors are correct
- Verify: borders and dividers create clear visual separation

**8.2 Loading States**
- Observe loading states when:
  - Dashboard is loading
  - Conversation messages are loading
  - Workflows list is loading
  - Workflow runs are fetching
- Verify: all loading states show appropriate feedback (spinners, skeletons, or text)
- Verify: no blank/flash-of-unstyled-content moments

**8.3 Empty States**
- Check empty states for:
  - No conversations (dashboard + sidebar)
  - No projects registered
  - No workflows available
  - No workflow runs
  - No messages in a conversation
- Verify: each empty state has a helpful message and CTA

**8.4 Responsiveness**
- Set viewport to different sizes:
  ```bash
  agent-browser set viewport 1920 1080  # Desktop
  agent-browser set viewport 1366 768   # Laptop
  agent-browser set viewport 1024 768   # Tablet landscape
  agent-browser set viewport 768 1024   # Tablet portrait
  agent-browser set viewport 375 812    # Mobile
  ```
- At each size: screenshot and check for layout breakage, overflow, truncation

**8.5 Sidebar Resize**
- Drag the sidebar resize handle
- Verify: sidebar width changes smoothly (240-400px range)
- Verify: width persists in localStorage across refresh
- Verify: content reflows properly at different sidebar widths

**8.6 Keyboard Navigation**
- Press `/` — verify search focuses
- Press `Escape` — verify search clears
- Press `Enter` in message input — verify sends message
- Press `Shift+Enter` — verify inserts newline (does NOT send)
- Tab through interactive elements — verify focus order is logical

**8.7 Copy/Clipboard**
- Click the working directory path in the chat header
- Verify: path copies to clipboard
- Verify: visual feedback (tooltip or flash) indicates copy succeeded

**8.8 External Links**
- Click "Open in IDE" button (VSCode link)
- Verify: `vscode://file/...` URL is constructed correctly
- Click links in assistant messages — verify they open in new tabs

### Test Suite 9: Edge Cases & Stress Tests

**9.1 Rapid Message Sending**
- Send multiple messages in quick succession (before previous responses complete)
- Verify: messages are queued properly (no duplicate or lost messages)
- Verify: lock indicator shows queue position
- Verify: responses arrive in order

**9.2 Long Content**
- Send a message that produces very long output (e.g., "List all files in the project")
- Verify: markdown renders without layout overflow
- Verify: code blocks have horizontal scroll
- Verify: `WorkflowResultCard` truncation works (500 chars / 8 lines with "Show more")
- Verify: tool call output truncation works (20 lines shown, expandable)

**9.3 Special Characters**
- Send messages with special characters: `<script>alert('xss')</script>`, markdown chars `*_[]()`, emoji
- Verify: no XSS vulnerability (HTML is escaped)
- Verify: markdown renders correctly
- Verify: emoji displays properly

**9.4 Browser Refresh During Streaming**
- While AI is streaming a response, refresh the page
- Verify: on reload, historical messages are loaded from the API
- Verify: any in-progress response is not lost (persisted segments appear)
- Verify: SSE reconnects and picks up new events

**9.5 Concurrent Workflows**
- Launch 2-3 workflows simultaneously (different projects or same project)
- Verify: each workflow tracks independently
- Verify: workflow progress cards in respective chats are correct
- Verify: no cross-contamination of events between workflows

**9.6 Network Latency**
- Add artificial network latency if possible
- Verify: UI remains responsive during slow responses
- Verify: loading indicators appear for slow API calls
- Verify: no timeout errors in normal usage

---

## Phase 2: Codebase Review

Read the source code of every component and module listed below. For each, evaluate:
- **Correctness**: Are there logic bugs, race conditions, or broken state transitions?
- **UX quality**: Does the component provide good feedback, handle edge cases, feel polished?
- **Performance**: Are there unnecessary re-renders, missing memoization, or expensive operations?
- **Accessibility**: Are interactive elements properly labeled? Keyboard navigable?
- **Error handling**: Are errors caught, displayed, and recoverable?

### Frontend Files to Review

| File | Focus Areas |
|------|-------------|
| `packages/web/src/App.tsx` | Route config, error boundary, QueryClient settings |
| `packages/web/src/components/chat/ChatInterface.tsx` | SSE handler correctness, message state management, new-chat flow, workflow dispatch handling |
| `packages/web/src/components/chat/MessageList.tsx` | Auto-scroll, WorkflowDispatchInline polling, WorkflowResultCard truncation |
| `packages/web/src/components/chat/MessageBubble.tsx` | Markdown rendering, streaming cursor, thinking dots |
| `packages/web/src/components/chat/ToolCallCard.tsx` | Expand/collapse, running state animation, output truncation |
| `packages/web/src/components/chat/WorkflowProgressCard.tsx` | Timer accuracy, compact vs full mode, stale indicator |
| `packages/web/src/components/chat/LockIndicator.tsx` | Show/hide transitions, queue position display |
| `packages/web/src/components/chat/MessageInput.tsx` | Enter vs Shift+Enter, auto-resize, disabled state |
| `packages/web/src/components/layout/Sidebar.tsx` | Resize drag, project add flow, search, new chat, localStorage persistence |
| `packages/web/src/components/sidebar/ProjectDetail.tsx` | Scoped queries, conversation status dots, workflow run sorting |
| `packages/web/src/components/sidebar/WorkflowInvoker.tsx` | Workflow fetch, create conversation + run flow, error handling |
| `packages/web/src/components/sidebar/AllConversationsView.tsx` | Search filtering, codebase map construction, "New Chat" |
| `packages/web/src/components/sidebar/ProjectSelector.tsx` | Delete confirmation, "All Projects" button |
| `packages/web/src/components/conversations/ConversationItem.tsx` | Rename inline edit, delete flow, active state highlighting |
| `packages/web/src/components/workflows/WorkflowList.tsx` | Two-tab layout, inline run panel, running indicator pulse |
| `packages/web/src/components/workflows/WorkflowExecution.tsx` | Initial data reconstruction from events, live SSE overlay, worker vs parent flows |
| `packages/web/src/components/workflows/WorkflowLogs.tsx` | Read-only chat view, SSE handlers, message filtering by timestamp |
| `packages/web/src/components/workflows/StepProgress.tsx` | Step list rendering, parallel block delegation, active step highlight |
| `packages/web/src/components/workflows/StepLogs.tsx` | Virtual scrolling, auto-scroll, metadata header |
| `packages/web/src/components/workflows/ArtifactSummary.tsx` | Artifact type icons, URL links, path display |
| `packages/web/src/components/workflows/LoopIterationView.tsx` | Progress bar math, max iteration capping |
| `packages/web/src/components/workflows/ParallelBlockView.tsx` | Overall status derivation, nested agent list |
| `packages/web/src/hooks/useSSE.ts` | Text batching (50ms flush), reconnection, handler ref stability |
| `packages/web/src/hooks/useWorkflowStatus.ts` | Workflow state map, polling fallback (15s), stale detection |
| `packages/web/src/hooks/useAutoScroll.ts` | Scroll threshold (50px), user scroll-up detection |
| `packages/web/src/lib/api.ts` | SSE_BASE_URL calculation, error handling, 404 swallowing |
| `packages/web/src/lib/types.ts` | SSEEvent union completeness, ChatMessage fields, WorkflowState shape |
| `packages/web/src/lib/message-cache.ts` | Cache key correctness, memory management |
| `packages/web/src/contexts/ProjectContext.tsx` | Stale project ID cleanup, codebase polling interval |

### Backend Files to Review

| File | Focus Areas |
|------|-------------|
| `packages/server/src/routes/api.ts` | Endpoint correctness, CORS, SSE heartbeat loop, workflow run endpoint, codebase deduplication |
| `packages/server/src/adapters/web.ts` | sendMessage category filtering, structured event handling, lock event flushing |
| `packages/server/src/adapters/web/persistence.ts` | Segment splitting logic, tool call duration tracking, flush timing, 50-segment cap |
| `packages/server/src/adapters/web/transport.ts` | Stream replacement race condition fix, buffer limits (100 msg / 200 conv), zombie reaper |
| `packages/server/src/adapters/web/workflow-bridge.ts` | Event mapping completeness, bridge subscription lifecycle, parent forwarding |
| `packages/core/src/orchestrator/orchestrator.ts` | Router prompt construction, background dispatch fire-and-forget, isolation resolution |
| `packages/core/src/workflows/executor.ts` | Stale workflow detection (15min), step session continuity, parallel Promise.all, loop completion signal |
| `packages/core/src/workflows/router.ts` | Case-insensitive matching, multiline regex, fallback behavior |
| `packages/core/src/workflows/event-emitter.ts` | Listener error isolation, max listener cap, run registration lifecycle |

### Review Checklist

For every file reviewed, note findings in these categories:

1. **Bugs** — Logic errors, race conditions, state inconsistencies, crashes
2. **UX Issues** — Missing feedback, confusing interactions, unclear states, dead ends
3. **Performance** — Unnecessary re-renders, missing React.memo/useMemo/useCallback, expensive computations in render
4. **Accessibility** — Missing ARIA labels, focus management gaps, screen reader issues
5. **Error Handling** — Unhandled promise rejections, missing try/catch, silent failures
6. **Code Quality** — Dead code, TODOs, inconsistent patterns, missing types

---

## Phase 3: Report

After completing all tests and reviews, produce a structured report:

### Report Format

```markdown
# Archon Web UI Validation Report

**Date**: {date}
**Tester**: Claude Code (agent-browser + codebase review)
**Archon Version**: {git commit hash}
**Screenshots**: /tmp/archon-test-*.png

## Executive Summary
{2-3 sentences: overall quality assessment, critical issues count, UX rating}

## Critical Bugs (P0)
{Bugs that break core functionality or lose data}

## Major Issues (P1)
{Issues that significantly degrade the experience}

## Minor Issues (P2)
{Polish items, edge cases, visual inconsistencies}

## UX Recommendations
{Suggestions for improving the user experience — not just bugs but "could be better"}

## Accessibility Findings
{Keyboard nav gaps, ARIA issues, contrast problems}

## Performance Observations
{Slow renders, unnecessary work, optimization opportunities}

## Codebase Quality Notes
{Dead code, inconsistencies, architectural concerns}

## What's Working Well
{Positive findings — features that are solid, patterns that are good}

## Detailed Test Results

### Dashboard Tests
| Test | Status | Notes |
|------|--------|-------|
| 1.1 Initial Load | PASS/FAIL | ... |
...

### Project Management Tests
...

### Chat Interface Tests
...

### Workflow Management Tests
...
```

### Key Question to Answer

> **Is Archon currently doing the best it possibly can to solve the problem of managing a lot of agents in parallel and executing custom workflows with full visibility?**

Specifically evaluate:
- Can users easily see what all their agents are doing at a glance?
- Is workflow status visible and understandable without clicking through multiple pages?
- Can users quickly navigate between the orchestrator chat, individual workflow runs, and task logs?
- Is the experience of kicking off a workflow through the router intuitive?
- Are parallel agents presented clearly with their individual status?
- Does the UI surface errors and issues prominently enough?
- Is the overall information architecture logical for someone managing 5-10 concurrent agents?

---

## Execution Notes

- Run all `agent-browser` commands via the Bash tool
- Use `npx agent-browser` if not installed globally
- After each navigation, re-snapshot (`agent-browser snapshot -i`) to get fresh refs
- Take screenshots liberally — save to `/tmp/archon-test-{section}-{name}.png`
- If a test fails, document it immediately and continue to the next test
- Use `agent-browser wait --load networkidle` after actions that trigger API calls
- For SSE testing, use `agent-browser eval` to check EventSource state
- Remember: WSL2 headless mode works fine — no display server needed
- Close the browser session when done: `agent-browser close`
