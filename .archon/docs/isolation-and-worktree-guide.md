# Isolation & Worktree System Guide

> **Purpose**: Complete reference for how Archon creates, manages, and cleans up git worktrees for parallel development.
> **When to use**: Working on worktree lifecycle, debugging isolation issues, understanding the resolution algorithm.
> **Size**: ~350 lines — use a scout sub-agent to check relevance before loading.

---

## Branded Types (`packages/git/src/types.ts`)

Three branded string types prevent mixing up paths at compile time:

| Type | Factory | Rejects |
|------|---------|---------|
| `RepoPath` | `toRepoPath(s)` | empty string |
| `BranchName` | `toBranchName(s)` | empty string |
| `WorktreePath` | `toWorktreePath(s)` | empty string |

All factories throw `Error` on empty input. Always use these — never pass raw strings where branded types are expected.

---

## Isolation Request Types (`packages/isolation/src/types.ts`)

Five request types, all extending `IsolationRequestBase` (which carries `codebaseId`, `canonicalRepoPath: RepoPath`, optional `description`):

| Type | `workflowType` | Branch Pattern | Usage |
|------|---------------|---------------|-------|
| `IssueIsolationRequest` | `'issue'` | `issue-{identifier}` | GitHub issue |
| `PRIsolationRequest` | `'pr'` | actual PR branch (same-repo) or `pr-{N}-review` (fork) | GitHub PR |
| `ReviewIsolationRequest` | `'review'` | `review-{identifier}` | PR review workflow |
| `ThreadIsolationRequest` | `'thread'` | `thread-{8-hex-hash}` | Slack/Telegram/Discord |
| `TaskIsolationRequest` | `'task'` | `task-{slugified}` (max 50 chars) | CLI or manual task |

`IsolationHints` carries the same data loosely typed, flowing from adapters through to the resolver.

---

## The 7-Step Resolution Order (`packages/isolation/src/resolver.ts`)

`IsolationResolver.resolve()` executes these steps in strict order. Each can short-circuit.

### Step 1: Existing Environment Reference
If `request.existingEnvId` is set, checks DB row + filesystem path via `worktreeExists()`. If both valid → `resolved`. If DB exists but filesystem gone → `stale_cleaned` (caller retries).

### Step 2: No Codebase
If `request.codebase` is `null` → `{ status: 'none', cwd: '/workspace' }`.

### Step 3: Workflow Reuse
`store.findActiveByWorkflow(codebaseId, workflowType, workflowId)` — finds existing env with same workflow identity. If filesystem valid → reuse it. If filesystem gone → mark destroyed, fall through.

### Step 4: Linked Issue Sharing
When `hints.linkedIssues` is non-empty, iterates issue numbers and tries `findActiveByWorkflow(codebaseId, 'issue', issueNum)`. First live match → reuse.

### Step 5: PR Branch Adoption
When `hints.prBranch` is set, calls `findWorktreeByBranch(canonicalPath, prBranch)` to scan `git worktree list --porcelain`. If found and path exists → creates DB row with `metadata: { adopted: true, adopted_from: 'skill' }`.

### Step 6: Limit Check + Auto-cleanup
Compares `store.countActiveByCodebase()` against `maxWorktrees` (default 25). If at limit → tries `cleanup.makeRoom()` (removes merged branches). If still at limit → `blocked` with formatted user message.

### Step 7: Create New Environment
1. Constructs concrete `IsolationRequest` from `workflowType` + hints
2. Calls `provider.create(isolationRequest)`
3. On known error → `blocked` with classified message
4. On unknown error → re-throws (crash)
5. On success → `store.create()` to register
6. If `store.create()` fails → destroys orphaned worktree before re-throwing

---

## Worktree Creation Flow (`packages/isolation/src/providers/worktree.ts`)

`WorktreeProvider.create(request)` at line 56:

**1. Generate names + check adoption**
- `generateBranchName(request)` → branch name based on request type
- `getWorktreePath(request, branchName)` → filesystem path
- `findExisting()` → checks if path already exists or PR branch already has a worktree

**2. Sync workspace**
- Calls `syncWorkspace(repoPath, baseBranch)` from `@archon/git/repo.ts`
- Runs `git fetch origin <branch>` (60s timeout)
- Auto-detects default branch: `symbolic-ref` → `origin/main` → `master`

**3. Create worktree**
- For PRs (same-repo): `git fetch origin prBranch` → `git worktree add path -b prBranch origin/prBranch`
- For PRs (fork): fetch `refs/pull/{N}/head` → create at SHA → checkout branch
- For all others: `git worktree add path -b branchName origin/{baseBranch}`
- Before creation: `cleanOrphanDirectoryIfExists()` removes stale non-worktree directories

**4. Copy configured files**
- Default: always copies `.archon/` directory
- User config: additional paths from `.archon/config.yaml` `worktree.copyFiles`
- Supports `"source -> destination"` arrow syntax
- Path traversal blocked (security check via `isPathWithinRoot()`)

---

## Worktree Path Layout

`getWorktreeBase()` in `packages/git/src/worktree.ts:29`:

- **Project-scoped** (repo under `~/.archon/workspaces/owner/repo/`):
  - Base: `~/.archon/workspaces/owner/repo/worktrees/`
  - Path: `<base>/<branchName>`

- **Legacy global** (repo elsewhere):
  - Base: `~/.archon/worktrees/`
  - Path: `<base>/owner/repo/<branchName>`

---

## Worktree Cleanup Flow

### `removeEnvironment()` (`packages/core/src/services/cleanup-service.ts:134`)

1. Fetch DB row. If `status === 'destroyed'` → return (idempotent)
2. Get `canonicalRepoPath` from codebase record
3. Check `worktreeExists()` for the path
4. If exists and `force` is false → check `hasUncommittedChanges()` (fail-safe: returns `true` on unexpected errors). If changes exist → skip removal
5. Call `provider.destroy(path, options)`

### `WorktreeProvider.destroy()` (`providers/worktree.ts:105`)

Returns `DestroyResult` tracking partial failures:

1. If path already gone → `worktreeRemoved: true`
2. If path exists → `git worktree remove [--force] path`
3. If directory persists after git removal (untracked files) → `rm -rf`
4. If `branchName` provided → `git branch -D branchName`
5. If `deleteRemoteBranch: true` → `git push origin --delete branchName`

---

## Error Classification (`packages/isolation/src/errors.ts`)

`classifyIsolationError(err)` maps error messages to user-friendly messages:

| Pattern | User Message |
|---------|-------------|
| `permission denied` / `eacces` | "Permission denied while creating workspace." |
| `timeout` | "Timed out creating workspace." |
| `no space left` / `enospc` | "No disk space available." |
| `not a git repository` | "Target path is not a valid git repository." |
| `branch not found` | "Branch not found." |

`isKnownIsolationError(err)` decides: known → produce user message and block. Unknown → re-throw as crash.

`IsolationBlockedError` signals ALL message handling must stop — the user was already notified.

---

## The Adoption Pattern

Two entry points for adopting worktrees created by external skills:

**Path-based adoption** (inside `WorktreeProvider.create()`):
- Before any git operations, checks if the expected worktree path already exists
- Also checks `findWorktreeByBranch()` for PR branch matches
- Returns adopted environment with `metadata: { adopted: true }`

**DB-level adoption** (in `IsolationResolver.tryBranchAdoption()`):
- Uses `findWorktreeByBranch()` to scan git's worktree list
- Creates DB row without calling `provider.create()` at all
- Returns `{ method: { type: 'branch_adoption', branch } }`

---

## Port Allocation (`packages/core/src/utils/port-allocation.ts`)

`getPort()`:
1. If `PORT` env var set → use it
2. If CWD is a worktree → MD5(cwd), `readUInt16BE(0) % 900 + 100` → port = `3090 + offset` (range: 3190-4089)
3. If not a worktree → `3090`

Same worktree always gets the same port (deterministic hash).

---

## Stale Environment Detection

`isEnvironmentStale(env, staleDays)` in cleanup-service:
1. Check `getLastCommitDate()` (`git log -1 --format=%ci`)
2. If recent commit exists and within threshold → not stale
3. Otherwise check `env.created_at` against threshold
4. Default threshold: 14 days (`STALE_THRESHOLD_DAYS`)

---

## Scheduled Cleanup

`runScheduledCleanup()` runs on startup + every 6 hours:

For each active environment:
1. Filesystem gone → `removeEnvironment()`
2. Branch merged into main → remove (if no uncommitted changes, no other conversations reference it)
3. Stale (14+ days, non-Telegram) → remove (same checks)

After environment cleanup: `sessionDb.deleteOldSessions(30)` (session retention).

---

## `makeRoom()` Strategy

When at worktree limit: only removes **merged branches** (not stale ones). For each environment:
- Check `isBranchMerged(repoPath, branchName, mainBranch)`
- Skip if uncommitted changes or conversations reference it
- Remove with `deleteRemoteBranch: true`

If merged cleanup frees space → proceed with creation. If not → block with formatted limit message showing breakdown of merged/stale/active counts.

---

## Key Files

| Component | File |
|-----------|------|
| Branded types | `packages/git/src/types.ts` |
| `execFileAsync` wrapper | `packages/git/src/exec.ts` |
| Low-level worktree ops | `packages/git/src/worktree.ts` |
| Branch ops | `packages/git/src/branch.ts` |
| Repo ops (sync, clone) | `packages/git/src/repo.ts` |
| Isolation request types | `packages/isolation/src/types.ts` |
| `IIsolationStore` interface | `packages/isolation/src/store.ts` |
| Factory / singleton | `packages/isolation/src/factory.ts` |
| 7-step resolver | `packages/isolation/src/resolver.ts` |
| `WorktreeProvider` | `packages/isolation/src/providers/worktree.ts` |
| File copy utilities | `packages/isolation/src/worktree-copy.ts` |
| Error classification | `packages/isolation/src/errors.ts` |
| Cleanup service | `packages/core/src/services/cleanup-service.ts` |
| Port allocation | `packages/core/src/utils/port-allocation.ts` |
