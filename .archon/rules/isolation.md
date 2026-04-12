---
paths:
  - "packages/isolation/**/*.ts"
  - "packages/git/**/*.ts"
---

# Isolation & Git Conventions

## Branded Types (packages/git/src/types.ts)

Always use the branded constructors — they reject empty strings at runtime and prevent passing the wrong string type:

```typescript
import { toRepoPath, toBranchName, toWorktreePath } from '@archon/git';
import type { RepoPath, BranchName, WorktreePath } from '@archon/git';

const repo = toRepoPath('/home/user/owner/repo');    // RepoPath
const branch = toBranchName('feature-auth');          // BranchName
const wt = toWorktreePath('/home/.archon/worktrees/x'); // WorktreePath
```

Git operations return `GitResult<T>` discriminated union: `{ ok: true; value: T }` or `{ ok: false; error: GitError }`. Always check `.ok` before accessing `.value`.

## IsolationResolver — 7-Step Resolution Order

1. **Existing env** — use `existingEnvId` if worktree still exists on disk
2. **No codebase** — skip isolation entirely, return `status: 'none'`
3. **Workflow reuse** — find active env with same `(codebaseId, workflowType, workflowId)`
4. **Linked issue sharing** — PR can reuse the worktree from a linked issue
5. **PR branch adoption** — find existing worktree by branch name (`findWorktreeByBranch`)
6. **Limit check + auto-cleanup** — if at `maxWorktrees` (default 25), try `makeRoom()` first
7. **Create new** — call `provider.create(isolationRequest)` then `store.create()`

If `store.create()` fails after `provider.create()` succeeds, the orphaned worktree is cleaned up best-effort before re-throwing.

## Error Handling Pattern

```typescript
import { classifyIsolationError, isKnownIsolationError } from '@archon/isolation';

try {
  await provider.create(request);
} catch (error) {
  const err = error instanceof Error ? error : new Error(String(error));
  if (!isKnownIsolationError(err)) {
    throw err; // Unknown = programming bug, propagate as crash
  }
  const userMessage = classifyIsolationError(err); // Maps to friendly message
  // ...send userMessage to platform, return blocked resolution
}
```

Known error patterns: `permission denied`, `eacces`, `timeout`, `no space left`, `enospc`, `not a git repository`, `branch not found`.

`IsolationBlockedError` signals ALL message handling should stop — the user has already been notified.

## Git Safety Rules

- **NEVER run `git clean -fd`** — permanently deletes untracked files. Use `git checkout .` instead.
- **Always use `execFileAsync`** (from `@archon/git/exec`), never `exec` or `execSync`
- `hasUncommittedChanges()` returns `true` on unexpected errors (conservative — prevents data loss)
- Worktree paths follow project-scoped layout: `~/.archon/workspaces/{owner}/{repo}/worktrees/{branch}`

## Architecture

- `@archon/git` — zero `@archon/*` dependencies; only branded types and `execFileAsync` wrapper
- `@archon/isolation` — depends only on `@archon/git` + `@archon/paths`
- `IIsolationStore` interface injected into `IsolationResolver` — never call DB directly from git package
- `IIsolationProvider` interface — `WorktreeProvider` is the only implementation
- Stale env cleanup is best-effort: `markDestroyedBestEffort()` logs errors but never throws

## Anti-patterns

- Never call `git` via `exec()` or shell string — always `execFileAsync('git', [...args])`
- Never treat `IsolationBlockedError` as recoverable — it means user was notified, stop processing
- Never use a plain `string` where `RepoPath` / `BranchName` / `WorktreePath` is expected
- Never skip the `isKnownIsolationError()` check — unknown errors must propagate as crashes
