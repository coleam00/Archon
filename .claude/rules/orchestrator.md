---
paths:
  - "packages/core/src/orchestrator/**/*.ts"
  - "packages/core/src/handlers/**/*.ts"
  - "packages/core/src/state/**/*.ts"
---

# Orchestrator Conventions

## Message Flow — Routing Agent Architecture

```
Platform message
  → ConversationLockManager.acquireLock()
  → handleMessage() (orchestrator-agent.ts:383)
      → inheritThreadContext() — copy parent's codebase/cwd if child thread
      → Deterministic gate: 11 commands (help, status, reset, workflow, register-project, update-project, remove-project, setproject, commands, init, worktree)
      → Everything else → AI routing call:
          → listCodebases() + discoverAllWorkflows()
          → buildFullPrompt() → buildOrchestratorPrompt() or buildProjectScopedPrompt()
          → AI responds with natural language ± /invoke-workflow or /register-project
          → parseOrchestratorCommands() extracts structured commands from AI response
          → If /invoke-workflow found → dispatchOrchestratorWorkflow()
          → If /register-project found → handleRegisterProject()
          → Otherwise → send AI text to user
```

Lock manager returns `{ status: 'started' | 'queued-conversation' | 'queued-capacity' }`. Always use the return value to decide whether to emit a "queued" notice — never call `isActive()` separately (TOCTOU race).

## Deterministic Commands (command-handler.ts)

Only **11 commands** are handled deterministically:

| Command | Behavior |
|---------|----------|
| `/help` | Show available commands |
| `/status` | Show conversation/session state |
| `/reset` | Deactivate current session |
| `/workflow` | Subcommands: `list`, `run`, `status`, `cancel`, `reload` |
| `/register-project` | Handled inline — creates codebase DB record |
| `/update-project` | Handled inline — updates codebase path |
| `/remove-project` | Handled inline — deletes codebase DB record |
| `/setproject` | Handled inline — binds codebase to conversation (updates codebase_id + cwd) |
| `/commands` | List registered codebase commands |
| `/init` | Scaffold `.archon/` in current repo |
| `/worktree` | Worktree subcommands |

**All other slash commands fall through to the AI router.** Unrecognized commands return an "Unknown command" error.

## Routing AI — Prompt Building (prompt-builder.ts)

The choice between prompts depends on whether the conversation has an attached project:

- **No project** → `buildOrchestratorPrompt()` (prompt-builder.ts:116) — lists all projects equally, asks user to clarify if ambiguous
- **Has project** → `buildProjectScopedPrompt()` (prompt-builder.ts:153) — active project shown first, ambiguous requests default to it

Both prompts include: registered projects, discovered workflows, and the `/invoke-workflow` + `/register-project` format specification.

### `/invoke-workflow` Protocol

The AI emits: `/invoke-workflow <name> --project <project> --prompt "user's intent"`

`parseOrchestratorCommands()` (orchestrator-agent.ts:90) parses this with:
- Workflow name validated against discovered workflows via `findWorkflow()`
- Project name validated via `findCodebaseByName()` — case-insensitive, supports partial path segment match (e.g., `"repo"` matches `"owner/repo"`)
- `--project` must appear before `--prompt`

### `filterToolIndicators()` (orchestrator-agent.ts:163)

Batch mode only. Strips paragraphs starting with emoji tool indicators (🔧💭📝✏️🗑️📂🔍) from accumulated AI response before sending to user.

## Session Transitions

Sessions are **immutable** — never mutated, only deactivated and replaced. The audit trail is via `parent_session_id` + `transition_reason`.

**Only `plan-to-execute` immediately creates a new session.** All other triggers only deactivate; the new session is created on the next AI message.

```typescript
import { getTriggerForCommand, shouldCreateNewSession } from '../state/session-transitions';

const trigger = getTriggerForCommand('reset'); // 'reset-requested'
if (shouldCreateNewSession(trigger)) {
  // plan-to-execute only
}
```

`TransitionTrigger` values: `'first-message'`, `'plan-to-execute'`, `'isolation-changed'`, `'reset-requested'`, `'worktree-removed'`, `'conversation-closed'`.

## Isolation Resolution

`validateAndResolveIsolation()` (orchestrator.ts:108) delegates to `IsolationResolver` and handles:
- Sending contextual messages to the platform (e.g., "Reusing worktree from issue #42")
- Updating the DB (`conversation.isolation_env_id`, `conversation.cwd`)
- Retrying once when a stale reference is found (`stale_cleaned`)
- Throwing `IsolationBlockedError` after platform notification when blocked

When isolation is blocked, **stop all further processing** — `IsolationBlockedError` means the user was already notified.

## Background Workflow Dispatch (Web only)

`dispatchBackgroundWorkflow()` (orchestrator.ts:256) creates a hidden worker conversation (`web-worker-{timestamp}-{random}`), sets up event bridging from worker SSE → parent SSE, pre-creates the workflow run row (prevents 404 on immediate UI navigation), and fires-and-forgets `executeWorkflow()`. On completion, surfaces `result.summary` to the parent conversation.

## Lazy Logger Pattern

All files in this area use the deferred logger pattern — NEVER initialize at module scope:

```typescript
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('orchestrator');
  return cachedLog;
}
```

## Anti-patterns

- Never call `isActive()` and then `acquireLock()` — race condition, use the lock return value
- Never access `conversation.isolation_env_id` directly without going through the resolver
- Never skip `IsolationBlockedError` — it must propagate to stop all further message handling
- Never add platform-specific logic to the orchestrator; it uses `IPlatformAdapter` interface only
- Never transition sessions by mutating them; always deactivate and create a new linked session
- Never assume a slash command is deterministic — only the 10 listed above bypass the AI router
