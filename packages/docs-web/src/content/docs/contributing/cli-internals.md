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

1. `isolationCleanupMergedCommand` calls `cleanupMergedWorktrees` for each codebase.
2. `judgeBranchForRemoval` first checks base ancestry and patch equivalence, requiring
   coverage of both the branch ref and worktree HEAD. Otherwise it checks the branch-name PR. A merged PR authorizes
   removal only if its head covers every existing local tip: worktree HEAD and
   recorded branch ref (`isRevCoveredBy`). With neither tip left, its state suffices.
3. If branch lookup cannot prove coverage, `getPrsForCommit` discovers candidates
   from HEAD and then the branch tip, querying equal tips only once. A merged
   candidate must cover both tips by itself. An open branch PR does not suppress
   a covering merged candidate, and coverage is never combined across PR heads.
4. Missing candidate heads are fetched from the configured remote. A comparison
   failure allows later candidates to be tried, but remains an error if none
   proves coverage. Lookup failure produces `pr-unavailable`; both failures keep
   the environment and prevent scheduled stale deletion.
5. Without eligible proof, an open PR produces `open-pr`; otherwise the verdict is
   `unmerged`, or `unjudgeable` when the branch ref is gone and no PR answers.
   Manual merged cleanup reports all of these. Ordinary `unmerged` can still
   proceed through the scheduled age policy and its unpushed-commit checks.
6. A `merged` or explicitly included `pr-closed` verdict reaches `checkRemoval`: dirty worktrees and running, pending,
   or paused owners stay. A failed run's lock may be released by this settlement.
   `provider.destroy` removes the worktree and local branch, then retires the
   registration. Remote branches are retained with a warning because ownership
   cannot be proved after retirement.

Manual `includeClosed` also authorizes closed PRs whose head covers every local tip,
with a `pr-closed` verdict and `PR closed` release reason. Scheduled cleanup does not
opt in. If base inspection fails, an eligible PR can independently prove coverage;
otherwise the error retains the worktree. The optional `gh` CLI currently
provides GitHub evidence. Missing `gh` or an unsupported remote supplies no PR
proof; an applicable lookup that fails is unavailable evidence, never an empty
successful response. No pack branch naming is used.

**Code:** `packages/core/src/services/cleanup/` — `merge-verdict.ts`,
`merged-sweep.ts`, `scheduled-sweep.ts`, `run-lock.ts` and `remove-environment.ts`.
PR reads live in `packages/isolation/src/pr-state.ts`; ancestry and head fetching
live in `packages/git/src/branch.ts`.

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
3. **Branch verification:** Read the current local branch. Refuse a different branch or detached
   HEAD, naming the requested branch, actual branch, and path without changing the checkout.
4. **Reuse:** If found, healthy, and on the requested branch (warns if `--from` was specified but not applied)
5. **Create:** If not found or unhealthy -- passes a `taskBranch: { kind: 'new', fromBranch }`
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
