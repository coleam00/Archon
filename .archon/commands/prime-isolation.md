---
description: Prime agent with Archon isolation system and git operations context
---

# Prime Isolation: Worktree Isolation and Git Ops Orientation

## Objective

Orient on the isolation system (`packages/isolation/`) and low-level git operations
(`packages/git/`) before working on worktree lifecycle, branch management, or error handling.

## Process

### 1. Understand the Package Structures

!`ls packages/isolation/src/`
!`ls packages/git/src/`

### 2. Understand Branded Git Types

Read `packages/git/src/types.ts` in full — branded types (`RepoPath`, `BranchName`,
`WorktreePath`) that prevent mix-ups between plain strings and typed git paths.

### 3. Understand Low-Level Git Operations

Read `packages/git/src/worktree.ts` first 60 lines — `createWorktree`, `removeWorktree`,
`listWorktrees`, `worktreeExists`, `toWorktreePath` (hashing strategy for unique paths).

Read `packages/git/src/exec.ts` — `execFileAsync` and `mkdirAsync` wrappers. Note:
always use `execFileAsync` (not `exec`) for git commands to avoid shell injection.

Read `packages/git/src/branch.ts` first 40 lines — `checkout`, `getDefaultBranch`,
`isBranchMerged`, `findWorktreeByBranch`.

### 4. Understand the Isolation Resolver

Read `packages/isolation/src/resolver.ts` first 130 lines — `IsolationResolver` class with
the 7-step resolution order:
1. Existing environment reference (from conversation)
2. No codebase → skip isolation
3. Workflow reuse (same codebase + workflow identity)
4. Linked issue sharing (cross-conversation)
5. PR branch adoption (skill symbiosis)
6. Limit check with auto-cleanup (default: 25 worktrees per codebase)
7. Create new worktree

### 5. Understand Error Classification

Read `packages/isolation/src/errors.ts` in full — `classifyIsolationError()` maps raw git
errors (permission denied, no space left, timeout, not a git repo) to user-friendly messages.
`IsolationBlockedError` for limit-exceeded cases. `isKnownIsolationError` for detection.

### 6. Understand the Worktree Provider

Read `packages/isolation/src/providers/worktree.ts` first 60 lines — `WorktreeProvider`
implements `IIsolationProvider`: `createEnvironment`, `removeEnvironment`, `environmentExists`.

### 7. Understand the Factory

Read `packages/isolation/src/factory.ts` — `getIsolationProvider()` and `configureIsolation()`
entry points used by the command handler and orchestrator.

### 8. Understand the Store Interface

Read `packages/isolation/src/store.ts` — `IIsolationStore` interface (database abstraction
for isolation_environments table).

### 9. Check Recent Isolation/Git Activity

!`git log -8 --oneline -- packages/isolation/ packages/git/`

## Output

Summarize (under 250 words):

### Resolution Order
- The 7 steps in `IsolationResolver.resolve()` and what each returns
- `IsolationResolution` discriminated union statuses: `resolved`, `none`, `stale_cleaned`

### Worktree Lifecycle
- Creation: `toWorktreePath` (hash-based unique path) → `createWorktree` → DB record
- Reuse: matched by `(codebase_id, workflow_type, workflow_id)`
- Removal: `removeWorktree` respects uncommitted changes (trusts git's natural guardrail)
- NEVER run `git clean -fd` — use `git checkout .` instead

### Error Handling Pattern
```typescript
try {
  // isolation creation
} catch (error) {
  const userMessage = classifyIsolationError(error as Error);
  await platform.sendMessage(conversationId, userMessage);
}
```

### Branded Types Usage
- Always use `toRepoPath()`, `toBranchName()`, `toWorktreePath()` — never cast plain strings
- Prevents mixing repo paths and worktree paths at compile time

### Key Limits
- Default max 25 worktrees per codebase
- Default stale threshold: 14 days
- Auto-cleanup before creating new if at limit

### Recent Changes
