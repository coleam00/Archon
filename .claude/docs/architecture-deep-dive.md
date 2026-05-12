# Architecture Deep Dive

> **Purpose**: End-to-end flow traces across the entire Archon system with file:line references.
> **When to use**: Understanding how data flows between packages, debugging cross-system issues, onboarding.
> **Size**: ~500 lines — use a scout sub-agent to check relevance before loading.

---

## 1. Message Flow: Routing Agent Architecture

The orchestrator is a **routing agent** — most messages go through an AI call that decides how to handle them, not a command dispatcher.

```
Slack event
  → SlackAdapter.start() registers app_mention + message handlers (adapter.ts:244)
  → Authorization check: isSlackUserAuthorized() (adapter.ts:249)
  → void this.messageHandler(event) — fire-and-forget (adapter.ts:264)
    → lockManager.acquireLock(conversationId, handler) (conversation-lock.ts:59)
      → handleMessage(platform, conversationId, text) (orchestrator-agent.ts:383)
        → db.getOrCreateConversation() (orchestrator-agent.ts:394)
        → inheritThreadContext() — if child thread, copy parent's codebase/cwd (orchestrator-agent.ts:400)
        → generateAndSetTitle() — fire-and-forget for non-slash messages (orchestrator-agent.ts:409)

        IF message.startsWith('/') AND command in [help, status, reset, workflow, register-project]:
          → Deterministic handling via commandHandler.handleCommand() (orchestrator-agent.ts:430)
          → If result.workflow → handleWorkflowRunCommand() → dispatchOrchestratorWorkflow()
          → Return response directly, no AI involved

        ALL OTHER MESSAGES (including unknown slash commands):
          → codebaseDb.listCodebases() + discoverAllWorkflows() (orchestrator-agent.ts:448-449)
          → buildFullPrompt() (orchestrator-agent.ts:450)
            → If conversation has codebase → buildProjectScopedPrompt() (prompt-builder.ts:153)
            → Otherwise → buildOrchestratorPrompt() (prompt-builder.ts:116)
            → Prompt includes: registered projects, discovered workflows, /invoke-workflow format
          → sessionDb.getActiveSession() → transitionSession('first-message') if none (orchestrator-agent.ts:462)
          → getAgentProvider(conversation.ai_assistant_type) (orchestrator-agent.ts:470)
          → cwd = getArchonWorkspacesPath() (orchestrator-agent.ts:458)
          → handleBatchMode() or handleStreamMode() based on getStreamingMode()

          AI responds with natural language ± structured commands:
            → filterToolIndicators(assistantMessages) — strip emoji-prefixed tool noise (orchestrator-agent.ts:711)
            → parseOrchestratorCommands() (orchestrator-agent.ts:719)
              → If /invoke-workflow found → dispatchOrchestratorWorkflow()
              → If /register-project found → handleRegisterProject()
              → Otherwise → send remaining text to user via platform.sendMessage()
```

**Key decision points:**
- `getStreamingMode()` → Slack returns `'batch'`, Web returns `'stream'`
- `buildFullPrompt()` → project-scoped prompt if conversation has codebase attached, otherwise global orchestrator prompt listing all projects
- `parseOrchestratorCommands()` → AI decides whether to dispatch a workflow or just respond conversationally
- Session resume: `session.assistant_session_id` passed to SDK's `options.resume`
- Only 5 commands are deterministic — everything else is AI-routed, even slash commands

---

## 2. Workflow Execution: `/workflow run archon-fix-github-issue #42`

```
User message starts with /workflow
  → commandHandler.handleCommand() (orchestrator-agent.ts:422)
  → discoverWorkflowsWithConfig() finds matching workflow by name (loader.ts:1013)
  → Returns CommandResult with result.workflow = { definition, args }
  → handleWorkflowRunCommand() (orchestrator-agent.ts:888)
    → dispatchOrchestratorWorkflow() (orchestrator-agent.ts:192)
      → validateAndResolveIsolation() → see Flow #3
      → For non-web: executeWorkflow() directly (orchestrator-agent.ts:249)
      → For web: dispatchBackgroundWorkflow() → worker conversation + fire-and-forget (orchestrator.ts:336)
```

**Inside `executeWorkflow()` (executor.ts):**
```
  → deps.store.createWorkflowRun() — DB row
  → getWorkflowEventEmitter().registerRun(runId, conversationId)
  → Resolve provider/model from config
  → Create artifactsDir and logDir

  IF isDagWorkflow:
    → executeDagWorkflow() (dag-executor.ts)
      → buildTopologicalLayers() — Kahn's algorithm
      → For each layer: Promise.allSettled(nodes)
        → Per node: checkTriggerRule() → evaluateCondition(when)
        → bash node: execFileAsync('bash', ['-c', script])
        → AI node: resolveNodeProviderAndModel() → aiClient.sendQuery()
        → Store output in nodeOutputs map for $nodeId.output

  IF isLoopWorkflow:
    → for i = 1..max_iterations:
      → substituteVariables(prompt) → aiClient.sendQuery()
      → detectCompletionSignal(output, until) → break if found

  IF isStepWorkflow:
    → for each step:
      → SingleStep: executeStepInternal()
        → loadCommandPrompt(cwd, commandName) — search repo then bundled defaults
        → substituteWorkflowVariables() — $ARGUMENTS, $ARTIFACTS_DIR, etc.
        → withIdleTimeout(aiClient.sendQuery(), idleTimeout)
        → Stream or batch AI output to platform
      → ParallelBlock: Promise.all(executeStepInternal per sub-step)
```

**Event emission:** Each step/node emits `step_started`, `step_completed`, `node_started`, etc. through `WorkflowEventEmitter` → `WorkflowEventBridge` → SSE to web UI.

---

## 3. Isolation Resolution: 7-Step Worktree Algorithm

```
validateAndResolveIsolation() (orchestrator.ts:108)
  → IsolationResolver.resolve(request) (resolver.ts:100)

Step 1: Existing env — store.getById(envId) + worktreeExists()
  → If valid: { status: 'resolved', method: 'existing' }
  → If stale: markDestroyedBestEffort() → { status: 'stale_cleaned' } → caller retries

Step 2: No codebase — { status: 'none', cwd: '/workspace' }

Step 3: Workflow reuse — store.findActiveByWorkflow(codebaseId, workflowType, workflowId)
  → If valid: { method: 'workflow_reuse' }

Step 4: Linked issue — iterate hints.linkedIssues, find active 'issue' env
  → If found: { method: 'linked_issue_reuse' }

Step 5: PR branch adoption — findWorktreeByBranch(canonicalPath, prBranch)
  → If found: store.create({ adopted: true }) → { method: 'branch_adoption' }

Step 6: Limit check — store.countActiveByCodebase() vs maxWorktrees (25)
  → If at limit: cleanup.makeRoom() → re-check → blocked if still full

Step 7: Create new — provider.create(isolationRequest) → store.create()
  → If store.create() fails: destroy orphaned worktree → re-throw
```

**WorktreeProvider.create() internals (worktree.ts:56):**
```
  → generateBranchName(request) — issue-N, thread-{hash}, task-{slug}, etc.
  → getWorktreePath() — ~/.archon/workspaces/{owner}/{repo}/worktrees/{branch}
  → findExisting() — check path or PR branch for adoption
  → syncWorkspaceBeforeCreate() — git fetch origin {baseBranch}
  → git worktree add {path} -b {branch} origin/{baseBranch}
  → copyConfiguredFiles() — .archon/ + config.worktree.copyFiles
```

---

## 4. Session Lifecycle: State Machine

**Session transitions are immutable** — never mutated, only deactivated and replaced.

```
First message → transitionSession('first-message')
  → INSERT new session (parent_session_id = null)
  → assistant_session_id = null (no SDK session yet)

AI call completes → tryPersistSessionId(session.id, sdkSessionId)
  → UPDATE assistant_session_id for resume on next message

Next message → getActiveSession() returns existing
  → sendQuery(..., session.assistant_session_id) — SDK resumes

/reset → transitionSession('reset-requested')
  → Deactivates current session (ended_reason = 'reset-requested')
  → Does NOT create new session immediately
  → Next message triggers 'first-message' → new session

Plan → Execute transition:
  → detectPlanToExecuteTransition() checks commandName === 'execute' && lastCommand === 'plan-feature'
  → transitionSession('plan-to-execute') — ONLY trigger that immediately creates new session
  → Old session deactivated + new session created atomically in one DB transaction
```

**TransitionTrigger values:**
`'first-message'`, `'plan-to-execute'`, `'isolation-changed'`, `'codebase-changed'`, `'codebase-cloned'`, `'cwd-changed'`, `'reset-requested'`, `'context-reset'`, `'repo-removed'`, `'worktree-removed'`, `'conversation-closed'`

**Audit trail:** `getSessionChain(sessionId)` walks `parent_session_id` links via recursive CTE.

---

## 5. Database Layer: IDatabase Abstraction

**Auto-detection (connection.ts:30-46):**
```
DATABASE_URL set → PostgresAdapter (pg.Pool, max: 10)
Otherwise → SqliteAdapter (bun:sqlite, WAL mode, busy_timeout: 5000)
```

**Query flow:**
- PostgreSQL: `$1`, `$2` placeholders work natively
- SQLite: `convertPlaceholders()` replaces `$N` with `?` and reorders params; strips `::jsonb` casts

**Namespaced exports pattern:**
```typescript
import * as conversationDb from '@archon/core/db/conversations';
import * as sessionDb from '@archon/core/db/sessions';

await conversationDb.getOrCreateConversation(platformType, conversationId);
await sessionDb.transitionSession(conversationId, trigger, options);
```

**Dialect differences:**
| Feature | SQLite | PostgreSQL |
|---------|--------|-----------|
| `now()` | `datetime('now')` | `NOW()` |
| `jsonMerge(col, $N)` | `json_patch(col, $N)` | `col \|\| $N::jsonb` |
| UUID | `crypto.randomUUID()` | `gen_random_uuid()` |

---

## 6. Configuration Loading: 4-Layer Merge

```
Layer 1: Code defaults (config-loader.ts:165)
  → botName: 'Archon', assistant: 'claude', concurrency.maxConversations: 10

Layer 2: Global config (~/.archon/config.yaml)
  → loadGlobalConfig() — cached after first load
  → Overrides: botName, defaultAssistant, assistants.*, streaming modes

Layer 3: Repo config ({repoPath}/.archon/config.yaml)
  → loadRepoConfig() — read fresh each time (not cached)
  → Overrides: assistant, assistants.*, commands.folder, defaults.*, worktree.baseBranch

Layer 4: Environment variables (highest precedence)
  → BOT_DISPLAY_NAME, DEFAULT_AI_ASSISTANT
  → TELEGRAM_STREAMING_MODE, DISCORD_STREAMING_MODE, SLACK_STREAMING_MODE
  → MAX_CONCURRENT_CONVERSATIONS
```

**Workflow model resolution priority:**
1. Per-node `model` (DAG mode)
2. Workflow-level `model` (YAML)
3. Config `assistants.{provider}.model`
4. SDK default

---

## 7. Web UI Data Flow: React → SSE → Server

### REST Data (TanStack Query v5)
```
React component → useQuery({ queryKey, queryFn })
  → apiClient.listConversations() — fetch('/api/conversations')
  → Server: Hono route handler → DB query → JSON response
  → TanStack Query caches, polls, invalidates
```

### SSE Streaming
```
React: useSSE(conversationId)
  → new EventSource(`${SSE_BASE_URL}/api/stream/${conversationId}`)
  → Server: streamSSE(c, async (stream) => {
      transport.registerStream(conversationId, stream)
      stream.onAbort(() => transport.removeStream(...))
    })

Event flow:
  AI client yields content → WebAdapter.sendMessage()
    → persistence.appendText() — buffer for DB
    → transport.emit(conversationId, { type: 'text', content })
      → stream.writeSSE({ data: JSON.stringify(event) })

  Client receives:
    → eventSource.onmessage → parseSSEEvent()
    → switch(data.type):
      'text' → 50ms debounce buffer → handlers.onText()
      'tool_call' → flush text → handlers.onToolCall()
      'tool_result' → flush text → handlers.onToolResult()
      'conversation_lock' → handlers.onLockChange()
      'workflow_step' → handlers.onWorkflowStep()
      'dag_node' → handlers.onDagNode()
      'retract' → clear buffer → handlers.onRetract()
```

### Workflow Progress (Background Workflows)
```
Workflow executor emits events → WorkflowEventEmitter singleton
  → WorkflowEventBridge subscribes → mapWorkflowEvent()
  → For background workflows: bridgeWorkerEvents(workerConvId, parentConvId)
    → Routes worker events to parent's SSE stream
  → transport.emitWorkflowEvent(parentConvId, sseEvent)
    → SSE to React → WorkflowProgressCard updates
```

### Reconnect Grace Period
`SSETransport.removeStream()` schedules cleanup after `RECONNECT_GRACE_MS = 5000ms`. If client reconnects within 5s (browser navigation), `registerStream()` cancels cleanup timer — persistence state preserved.

---

## Cross-Cutting Patterns

### Lazy Logger
Every module defers logger creation to avoid test mock timing issues:
```typescript
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog() { return (cachedLog ??= createLogger('module')); }
```

### `execFileAsync` (not `exec`)
All git subprocess calls use `packages/git/src/exec.ts` — avoids shell injection, provides consistent timeout handling.

### Structured Event Side-Channel
`IPlatformAdapter.sendStructuredEvent?()` — optional method only `WebAdapter` implements. Orchestrator and executor check `if (platform.sendStructuredEvent)` before calling. Sends raw SDK tool call objects to SSE separately from formatted text.

### `isWebAdapter()` Type Guard
Narrows `IPlatformAdapter` to `WebAdapter` for web-specific methods: `setConversationDbId()`, `setupEventBridge()`, `emitRetract()`.

---

## Key File Reference

| Flow | Key Files |
|------|-----------|
| Message entry | `adapters/src/chat/slack/adapter.ts`, `server/src/index.ts` |
| Orchestration | `core/src/orchestrator/orchestrator-agent.ts`, `core/src/orchestrator/orchestrator.ts` |
| Locking | `core/src/utils/conversation-lock.ts` |
| AI providers | `core/src/providers/claude.ts`, `core/src/providers/factory.ts` |
| Commands | `core/src/handlers/command-handler.ts` |
| Sessions | `core/src/db/sessions.ts`, `core/src/state/session-transitions.ts` |
| Workflows | `workflows/src/executor.ts`, `workflows/src/dag-executor.ts`, `workflows/src/loader.ts` |
| Isolation | `isolation/src/resolver.ts`, `isolation/src/providers/worktree.ts` |
| Database | `core/src/db/connection.ts`, `core/src/db/adapters/sqlite.ts`, `core/src/db/adapters/postgres.ts` |
| Config | `core/src/config/config-loader.ts` |
| SSE streaming | `server/src/adapters/web/transport.ts`, `server/src/adapters/web/workflow-bridge.ts` |
| Web UI hooks | `web/src/hooks/useSSE.ts`, `web/src/lib/api.ts` |
