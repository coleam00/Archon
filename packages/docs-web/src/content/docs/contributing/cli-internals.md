---
title: CLI Internals
description: Technical reference for the Archon CLI package — entry point flow, command routing, worktree logic, and adapter details.
category: contributing
area: cli
audience: [developer]
status: current
sidebar:
  order: 2
---

Technical reference for understanding CLI internals.

## Package Structure

```
packages/cli/
├── src/
│   ├── cli.ts              # Entry point, argument parsing, routing
│   ├── commands/
│   │   ├── workflow.ts     # workflow list/run/runs/get (approve/reject/status/resume/abandon delegate to @archon/core/operations)
│   │   ├── isolation.ts    # isolation list/cleanup (list/merged-cleanup delegate to @archon/core/operations)
│   │   ├── setup.ts        # setup command implementation
│   │   ├── chat.ts         # chat command implementation
│   │   ├── validate.ts     # validate command implementation
│   │   └── version.ts      # version command
│   └── adapters/
│       └── cli-adapter.ts  # IPlatformAdapter for stdout
└── package.json            # Defines "archon" binary
```

## Entry Point Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ archon <command> [subcommand] [options] [arguments]             │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ strip-cwd-env-boot  (first import, side-effect)                 │
│   stripCwdEnv(): deletes Bun-auto-loaded <cwd>/.env* keys from  │
│   process.env + CLAUDE_CODE_* session markers. Emits            │
│   [archon] stripped N keys from <cwd> (...) when N > 0.         │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ loadArchonEnv(cwd)  — both loads use override: true             │
│   1. ~/.archon/.env        (home scope)                         │
│   2. <cwd>/.archon/.env    (repo scope, wins over home)         │
│   Emits one [archon] loaded N keys from <path> line per file    │
│   when N > 0 and ARCHON_VERBOSE_BOOT=1 or LOG_LEVEL=debug/trace.│
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ cli.ts  Parse arguments                                         │
│                 --cwd, --branch, --no-worktree, --help          │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ cli.ts  Git repository check                                    │
│                 Skip for version/help, validate and resolve to  │
│                 repo root for workflow/isolation commands       │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ cli.ts  Route to command handler                                │
│                 switch(command) → workflow | isolation | version│
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ cli.ts  Exit with code, always closeDatabase()                  │
└─────────────────────────────────────────────────────────────────┘
```

**Code:** `packages/cli/src/cli.ts`

**Git repository check:**
- Commands `workflow`, `isolation`, and `complete` require running from a git repository
- Commands `version`, `help`, `setup`, and `chat` bypass this check
- When in a subdirectory, automatically resolves to repository root
- Exit code 1 if not in a git repository

---

## `workflow list` Flow

```
┌──────────────────────────────────────────────────────────────────┐
│ archon workflow list [name] [--full] [--json]                    │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ workflow.ts  workflowListCommand(cwd, { name, full, json })      │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ @archon/workflows/workflow-discovery                              │
│ discoverWorkflowsWithConfig(cwd, config)                          │
│ - Loads bundled defaults                                         │
│ - Searches .archon/workflows/ recursively                        │
│ - Merges (repo overrides defaults by name)                       │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ Optional name resolution; project errors remain in the result    │
│ full=false: bounded description + structured truncation state    │
│ full=true: exact authored description                            │
└──────────────────────────────┬───────────────────────────────────┘
                               │
               ┌───────────────┴───────────────┐
               │ json=true                     │ json=false
               ▼                               ▼
┌──────────────────────────┐   ┌───────────────────────────────────┐
│ JSON output to stdout    │   │ Human-readable list to stdout     │
│ descriptionTruncated     │   │ shortened descriptions carry     │
│ { workflows, errors }    │   │ the ` [truncated]` marker         │
└──────────────────────────┘   └───────────────────────────────────┘
```

**Code:** `packages/cli/src/commands/workflow.ts`

---

## `workflow run` Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ archon workflow run <name> [message] [--branch X] [--from X] [--no-worktree]│
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ workflow.ts:78-92  Discover & find workflow by name             │
│                    Error if not found (lists available)         │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ workflow.ts:99  Create CLIAdapter for stdout                    │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ workflow.ts:104-133  Database setup                             │
│ - Create conversation: cli-{timestamp}-{random}                 │
│ - Lookup codebase from directory (warn if fails)                │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
                    ┌─────────────┴─────────────┐
                    │                           │
             no --branch                   --branch
                    │                           │
                    ▼                           ▼
┌───────────────────────────┐   ┌───────────────────────────────────┐
│ Use cwd as-is             │   │ workflow.ts:152-168                │
│                           │   │ Auto-detect git repo               │
│                           │   │ Auto-register codebase if needed   │
└─────────────┬─────────────┘   └───────────────┬───────────────────┘
              │                                 │
              │                   ┌─────────────┴─────────────┐
              │                   │                           │
              │            --no-worktree               (default)
              │                   │                           │
              │                   ▼                           ▼
              │   ┌─────────────────────────┐ ┌─────────────────────────┐
              │   │ workflow.ts:171-175     │ │ workflow.ts:177-219     │
              │   │ git.checkout(cwd, branch)│ │ Check existing worktree │
              │   │                         │ │ If healthy → reuse      │
              │   │                         │ │ Else → provider.create()│
              │   │                         │ │ Track in DB             │
              │   └────────────┬────────────┘ └────────────┬────────────┘
              │                │                           │
              └────────────────┴─────────────┬─────────────┘
                                             │
                                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ workflow.ts:235-243  executeWorkflow()                          │
│ - Pass adapter, conversation, workflow, cwd, message            │
│ - Stream AI responses to stdout                                 │
│ - Return success/failure                                        │
└─────────────────────────────────────────────────────────────────┘
```

**Code:** `packages/cli/src/commands/workflow.ts:72-251`

**Worktree Provider:** `packages/isolation/src/providers/worktree.ts`

---

## `workflow event emit` Flow

```
┌──────────────────────────────────────────────────────────────────┐
│ archon workflow event emit --run-id <run-id> --type <type> [...] │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ cli.ts  Validate --run-id, --type (required)                     │
│         Validate --type against WORKFLOW_EVENT_TYPES              │
│         Parse --data as JSON (warn + skip if invalid)            │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ workflow.ts  workflowEventEmitCommand(..., cwd)                   │
│              Resolve an unambiguous run-id prefix                 │
│              Node state: persistWorkflowEvent(...)               │
│              Observability: createWorkflowEvent(...)             │
│              Run-ID resolution may fail                           │
└──────────────────────────────────────────────────────────────────┘
```

**Code:** `packages/cli/src/cli.ts` (case 'event'), `packages/cli/src/commands/workflow.ts:workflowEventEmitCommand`

**Contract:** The shared `isNodeStateEventType` predicate routes node-state events through
`persistWorkflowEvent`, which propagates storage failures. The CLI prints `Event persisted`
only after that write succeeds. Other events use `createWorkflowEvent` and retain best-effort
persistence: `Event submitted (best-effort)` does not guarantee storage. Run-ID resolution
can fail before either write.

---

## `isolation list` Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ archon isolation list                                           │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ isolation.ts:19-57  isolationListCommand()                      │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ @archon/core isolationDb.listAllActiveWithCodebase()            │
│ - Joins isolation_environments with codebases                   │
│ - Returns: path, branch, workflow_type, codebase_name,          │
│            platform, days_since_activity                        │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ isolation.ts:30-55  Group by codebase, print table              │
└─────────────────────────────────────────────────────────────────┘
```

**Code:** `packages/cli/src/commands/isolation.ts:19-57`

---

## `isolation cleanup` Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ archon isolation cleanup [days]                                 │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ isolation.ts:62-99  isolationCleanupCommand(daysStale)          │
│                     default: 7 days                             │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ @archon/core isolationDb.findStaleEnvironments(days)            │
│ - WHERE last_activity_at < now - days                           │
│ - Excludes telegram platform                                    │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ For each stale environment:                                     │
│ 1. provider.destroy(path, options)                              │
│ 2. Update DB status → 'destroyed'                               │
│ 3. Log result                                                   │
└─────────────────────────────────────────────────────────────────┘
```

**Code:** `packages/cli/src/commands/isolation.ts:62-99`

---

## `isolation cleanup --merged` Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ archon isolation cleanup --merged [--include-closed]            │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ isolation.ts  isolationCleanupMergedCommand({ includeClosed })  │
│ For each codebase → cleanupMergedWorktrees(codebaseId, path)    │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                     For each active environment
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ judgeBranchForRemoval() — three-signal union                    │
│  localBranchExists()     gate: (a) and (b) need the local ref   │
│  (a) isBranchMerged()    git ancestry (fast-forward/merge)      │
│  (b) isPatchEquivalent() git cherry  (1-commit squash-merge)    │
│  (c) getPrState()        gh CLI      (MERGED/CLOSED/OPEN/NONE/  │
│                                      UNAVAILABLE)               │
│                                                                 │
│  any git signal          → 'reclaimable' if the worktree HEAD   │
│                            also passes `git cherry <base> HEAD` │
│  MERGED                  → 'reclaimable' if the worktree HEAD   │
│                            and the branch ref (where each       │
│                            exists) are at or behind the PR head │
│  CLOSED                  → same, only if includeClosed          │
│  OPEN                    → 'open-pr', always kept               │
│  UNAVAILABLE             → 'pr-unavailable', kept and reported  │
│  NONE and ref present    → 'unmerged', not reclaimed            │
│  NONE and ref gone       → 'unjudgeable', kept and reported     │
└─────────────────────────────────┬───────────────────────────────┘
                                  │ 'reclaimable'
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ Guard checks: no uncommitted changes, no run can still claim    │
│ the env (getRemovalBlocker)                                     │
│ provider.destroy() → remove worktree + delete remote branch     │
└─────────────────────────────────────────────────────────────────┘
```

Signals are evaluated in order — the first positive match short-circuits to avoid
unnecessary `gh` API calls. The `gh` CLI is a soft dependency: when it is not installed or
the remote is not GitHub, only git signals are used (`NONE`). When `gh` is there but fails
(auth, rate limit, unreadable output) the result is `UNAVAILABLE`, and the environment is
kept and reported rather than passed to the staleness sweep.

A multi-commit squash merge is invisible to both git signals, so PR state is the only
one that sees it. Both git signals also need the local branch ref: once it is gone, the
PR is the only judge, and a branch with no PR is reported as unverifiable instead of
failing the check. A MERGED or CLOSED PR only covers the commits it carried. Run
branch names are reused, and removal deletes both the worktree and the branch, so each
local tip that still exists, the worktree's HEAD and the branch ref, must be the PR's head
commit or an ancestor of it (`isRevCoveredBy`). A detached HEAD or a reused branch with
commits past the PR head is unmerged work. The same holds when git proves the merge: the worktree's
HEAD must also pass `git cherry <base> HEAD`, which answers for both git signals (an
ancestor of the base lists nothing, a squash-merged commit lists as `-`). A HEAD it
cannot answer for is reported as a failed merge check. A PR head pushed from elsewhere and never fetched here is
fetched by SHA from the branch's remote first; if that fetch fails, the check fails and
the worktree is kept, with the fetch error in the reason. The scheduled sweep (`runScheduledCleanup`) makes the same call, so
both paths agree on what counts as merged.

**Code:** `packages/core/src/services/cleanup-service.ts` — `judgeBranchForRemoval()`, `cleanupMergedWorktrees()`, `runScheduledCleanup()`, `getRemovalBlocker()`
**Code:** `packages/isolation/src/pr-state.ts` — `getPrState()`
**Code:** `packages/git/src/branch.ts` — `isPatchEquivalent()`, `localBranchExists()`

---

## CLI Adapter

Implements `IPlatformAdapter` for terminal output.

```
┌─────────────────────────────────────────────────────────────────┐
│ CLIAdapter                                                      │
├─────────────────────────────────────────────────────────────────┤
│ sendMessage(convId, msg) → Output to stdout                     │
│ getStreamingMode()       → 'batch'                              │
│ getPlatformType()        → 'cli'                                │
│ ensureThread()           → passthrough                          │
│ start() / stop()         → no-op                                │
└─────────────────────────────────────────────────────────────────┘
```

**Code:** `packages/cli/src/adapters/cli-adapter.ts:13-47`

---

## Key Dependencies

| Function | Package | Location | Purpose |
|----------|---------|----------|---------|
| `discoverWorkflowsWithConfig(cwd, config)` | `@archon/workflows/workflow-discovery` | `workflows/src/workflow-discovery.ts` | Find and parse workflow YAML |
| `executeWorkflow(...)` | `@archon/workflows/executor` | `workflows/src/executor.ts` | Run workflow steps |
| `getIsolationProvider()` | `@archon/isolation` | `isolation/src/factory.ts` | Get WorktreeProvider singleton |
| `conversationDb.*` | `@archon/core` | `core/src/db/conversations.ts` | Conversation CRUD |
| `codebaseDb.*` | `@archon/core` | `core/src/db/codebases.ts` | Codebase CRUD |
| `isolationDb.*` | `@archon/core` | `core/src/db/isolation-environments.ts` | Worktree tracking |
| `git.*` | `@archon/git` | `packages/git/src/` | Git operations |
| `closeDatabase()` | `@archon/core` | `core/src/db/connection.ts` | Clean shutdown |

---

## Conversation ID Format

CLI conversations use ID format: `cli-{timestamp}-{random}`

Example: `cli-1705932847321-a7f3b2`

Generated at: `packages/cli/src/commands/workflow.ts`

---

## Worktree Reuse Logic

When `--branch` is provided:

1. **Lookup:** `isolationDb.findActiveByWorkflow(codebaseId, 'task', branchName)`
2. **Health check:** `provider.healthCheck(path)` on existing
3. **Reuse:** If found and healthy (warns if `--from` was specified but not applied)
4. **Create:** If not found or unhealthy -- passes a `taskBranch: { kind: 'new', fromBranch }`
   selection to the provider when `--from` is specified. Adoption instead passes
   `taskBranch: { kind: 'existing', branch }`, which checks out that exact local branch
   without creating a child branch or syncing it to a remote.

Worktrees stored at: `~/.archon/workspaces/<owner>/<repo>/worktrees/<branch-slug>/`

**Code:** `packages/cli/src/commands/workflow.ts:177-219`

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (logged to stderr, including not in git repo) |

---

## Database Connection

- Connection opened on first database call
- Always closed in `finally` block after command completes
- **Default: SQLite** at `~/.archon/archon.db` (zero setup, auto-initialized)
- **Optional: PostgreSQL** when `DATABASE_URL` is set (for cloud/advanced deployments)

**Code:** `packages/cli/src/cli.ts`
