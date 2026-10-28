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
│   │   ├── workflow.ts     # workflow route module: re-exports every subcommand; reset-sessions/cleanup/event
│   │   ├── workflow-control.ts # workflow resume/abandon/cancel/answer/approve/reject/respond (delegate to @archon/core/operations)
│   │   ├── workflow-query.ts # workflow list/test/status/get/runs/logs/wait
│   │   ├── workflow-run-*.ts # workflow run: select, admit, launch, execute
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
│ loadCliEnv(cwd) — wraps loadArchonEnv with identity protection  │
│   1. ~/.archon/.env        (home scope)                         │
│   2. <cwd>/.archon/.env    (repo scope, exceptions below)       │
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
│ cli.ts  Project resolution                                      │
│                 Honor folder selection and registered folders;  │
│                 otherwise resolve the nearest Git checkout      │
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

Repository env normally overrides home env. The CLI preserves the user-scope `GH_CONFIG_DIR` (including its absence), so repository env cannot redirect the stored gh login. Inside a workflow, inherited GitHub identity values take precedence over both env files, including empty values that disable host credentials. See [forge plugin configuration](/reference/forge/#plugin-configuration).

**Project resolution:**

- `workflow run --folder` uses the supplied canonical directory, even inside Git, and explicitly registers it as a folder project.
- A registered folder and its ordinary descendants resolve to the folder directory. Archon runs folder workflows in place without managing a worktree, branch or PR.
- A Git repository nested inside a registered folder retains its own repository identity. Other Git paths resolve to the nearest repository root, preserving linked-checkout ownership.
- Unregistered non-Git execution requires folder registration; first-use CLI execution uses `workflow run --folder`. Without registration or that flag, execution exits with code 1.
- File-only dry runs and fixture tests can inspect local files without registration. On a readable registry they honor folder ownership; if lookup fails they use the proven Git root or supplied directory. `workflow list` and `validate` retain their Git-root fallback when the registry cannot open.
- `version`, `help`, `setup`, and `chat` bypass project resolution.

---

## `workflow list` Flow

```
┌──────────────────────────────────────────────────────────────────┐
│ archon workflow list [name] [--full] [--json]                    │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ workflow-query.ts  workflowListCommand(cwd, { name, full, json })│
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ @archon/workflows/workflow-discovery                              │
│ discoverWorkflowsWithConfig(cwd, loadConfig, providerRegistry)    │
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

**Code:** `packages/cli/src/commands/workflow-query.ts`

---

## `workflow run` Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ archon workflow run <name> [message] [--branch X] [--detach] …  │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ selectRunWorkflow()                                             │
│ - Locate the run a continuation resumes                         │
│ - Capture the workflow source, then discover from the capture   │
│ - Find the workflow by name (error lists available)             │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ admitRunExecution()   (--dry-run stops before this)             │
│ - Flag, worktree policy, input and capability gates             │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │                           │
                --detach                    (default)
                    │                           │
                    ▼                           ▼
┌───────────────────────────┐   ┌───────────────────────────────────┐
│ launchDetachedOwnedRun()  │   │ prepareForegroundLaunch()         │
│ Pre-flight, write the run │   │ Destination, project, adoption    │
│ row, fork the child       │   │ lane, --resume binding, AI config │
└───────────────────────────┘   └───────────────┬───────────────────┘
                                                │
                                                ▼
                                ┌───────────────────────────────────┐
                                │ provisionWorkspace()              │
                                │ Folder seam, reused --branch      │
                                │ worktree, or a new worktree       │
                                └───────────────┬───────────────────┘
                                                │
                                                ▼
                                ┌───────────────────────────────────┐
                                │ executeOwnedRun()                 │
                                │ Signal guard, progress, engine    │
                                │ submit or resume, wait, teardown, │
                                │ result                            │
                                └───────────────────────────────────┘
```

**Code:** `workflowRunCommand` in `packages/cli/src/commands/workflow-run-owned.ts`, which owns the captured source and the durable-wait loop. The phases live in `workflow-run-admission.ts`, `workflow-run-launch.ts` and `workflow-run-execution.ts` beside it.

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

```text
archon isolation list → isolationListCommand()
  │
  ├─ @archon/core listEnvironments()
  │    ├─ isolationDb.listAllActiveWithCodebase()
  │    ├─ For each codebase: isolationDb.listByCodebaseWithAge()
  │    │    └─ Reconcile missing worktrees, preserving live-run ownership
  │    └─ Return environments grouped by codebase and reconciliation totals
  │
  ├─ Print worktree details and totals (return early if no codebases)
  │
  ├─ @archon/core listContainerEnvironments()
  │    ├─ isolationDb.listActiveContainerEnvironments()
  │    ├─ getRunByIsolationEnvId() for each container
  │    │    └─ Return matched run or null; throw on query/status errors
  │    └─ Build summaries; catch lookup errors and set runStatus: lookup-failed
  │
  └─ Print container details and totals: run status, no run (orphan),
     or run lookup failed
```

**Code:** `packages/cli/src/commands/isolation.ts` (`isolationListCommand`),
`packages/core/src/operations/isolation-operations.ts`
(`listEnvironments`), `packages/core/src/services/cleanup/containers.ts`
(`listContainerEnvironments`), `packages/core/src/db/workflow-run-reads.ts`
(`getRunByIsolationEnvId`).

The container listing matches `metadata.isolation_env_id`; no match does not
establish that cleanup can remove the container. Cleanup checks wider live
ownership. A failed lookup is logged and displayed as `run lookup failed`.

---

## `isolation cleanup` Flow

```text
archon isolation cleanup [days] (default: 7)
  │
  ├─ Reconcile missing worktrees (preserve container rows)
  │
  ├─ findStaleEnvironments(days)
  │    └─ Filter provider = 'worktree'
  │         └─ For each stale worktree:
  │              ├─ Skip environments owned by resumable runs
  │              ├─ Skip any with a commit on no remote (getCleanupRunLock)
  │              └─ provider.destroy(path, options)
  │                   └─ Mark destroyed only after complete removal
  │
  └─ cleanupContainerEnvironments(days), even when no worktrees are stale
       ├─ Skip containers owned by resumable runs
       └─ Container backend removes container and volume
            └─ Mark destroyed only after successful removal
```

**Code:** `isolationCleanupCommand` in `packages/cli/src/commands/isolation.ts`

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
│  any git signal          → 'merged' if the worktree HEAD        │
│                            also passes `git cherry <base> HEAD` │
│  MERGED                  → 'merged' if the worktree HEAD        │
│                            and the branch ref (where each       │
│                            exists) are at or behind the PR head │
│  CLOSED                  → 'pr-closed' the same way, only if    │
│                            includeClosed                        │
│  OPEN                    → 'open-pr', always kept               │
│  UNAVAILABLE             → 'pr-unavailable', kept and reported  │
│  NONE and ref present    → 'unmerged', not reclaimed            │
│  NONE and ref gone       → 'unjudgeable', kept and reported     │
└─────────────────────────────────┬───────────────────────────────┘
                                  │ 'merged' or 'pr-closed'
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ Guard checks: no uncommitted changes, no run lock (checkRemoval │
│ → getCleanupRunLock; a failed run's lock is released by the     │
│ verdict, running/pending/paused runs always lock)               │
│ provider.destroy() → remove worktree and local branch           │
│ → commit registration retirement; retain remote branch         │
└─────────────────────────────────────────────────────────────────┘
```

Completion and merged cleanup retain remote branches, including with force,
because registration ownership cannot be proved after retirement. Retention is
logged as a warning and displayed in both completion and merged-cleanup reports.
Enable GitHub's **Automatically delete head branches** setting for
merged pull requests, or follow [manual remote branch recovery](/reference/cli/#recovering-remote-branch-cleanup).

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

**Code:** `packages/core/src/services/cleanup/` — `judgeBranchForRemoval()` in `merge-verdict.ts`, `cleanupMergedWorktrees()` in `merged-sweep.ts`, `getCleanupRunLock()` in `run-lock.ts`; `runScheduledCleanup()` in `packages/core/src/services/cleanup-service.ts`
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
| `discoverWorkflowsWithConfig(cwd, loadConfig, providerRegistry)` | `@archon/workflows/workflow-discovery` | `workflows/src/workflow-discovery.ts` | Find and parse workflow YAML |
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

The random suffix contains 16 cryptographically random bytes encoded as 32 hex characters.

Generated at: `packages/cli/src/utils/conversation-id.ts`

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

**Code:** `provisionWorktree` in `packages/cli/src/commands/workflow-run-launch.ts`

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success, except for the JSON control refusals noted below. |
| 1 | Error. Answer commands (`answer`, `respond`, `approve`, `reject`) and `resume --detach` also return 1 on refusal. Human-mode diagnostics go to stderr; JSON refusals emit `ok: false` with the reason on stdout. |

Non-detached JSON `resume`, `abandon`, and `cancel` can return 0 with `ok: false`.
Check `ok` when consuming those acknowledgments.

---

## Database Connection

- Connection opened on first database call
- Always closed in `finally` block after command completes
- **Default: SQLite** at `~/.archon/archon.db` (zero setup, auto-initialized)
- **Optional: PostgreSQL** when `DATABASE_URL` is set (for cloud/advanced deployments)

**Code:** `packages/cli/src/cli.ts`
