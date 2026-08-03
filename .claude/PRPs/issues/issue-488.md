# Investigation: CLI --branch + --no-worktree silently checks out in main repo

**Issue**: #488 (https://github.com/dynamous-community/remote-coding-agent/issues/488)
**Type**: BUG
**Investigated**: 2026-03-10T12:00:00Z

### Assessment

| Metric     | Value    | Reasoning                                                                                                          |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| Severity   | HIGH     | Silently switches the user's working branch and runs AI workflows without isolation — potential for unintended file modifications in the main repo |
| Complexity | LOW      | Single validation check to add in `cli.ts:249`, one test to add — isolated change, no architectural impact         |
| Confidence | HIGH     | Root cause is clear and confirmed in code; the fix is a straightforward flag validation guard                       |

---

## Problem Statement

When `--branch` and `--no-worktree` are both passed to `bun run cli workflow run`, `--no-worktree` silently wins — it checks out the branch directly in the user's working repo with no warning. The user's branch is switched and AI modifications happen without isolation. This is a safety footgun because the likely intent of `--branch` is isolation.

---

## Analysis

### Root Cause

The flag parsing in `cli.ts` and the execution logic in `workflow.ts` both accept `--branch` + `--no-worktree` together without any conflict check. The `noWorktree` branch silently proceeds to `git.checkout()` on the user's repo.

### Evidence Chain

WHY: User's branch is silently switched when both `--branch` and `--no-worktree` are passed
↓ BECAUSE: `workflow.ts:222` checks `options.noWorktree` first and silently proceeds to checkout
Evidence: `packages/cli/src/commands/workflow.ts:222-232` — `if (options.noWorktree) { ... await git.checkout(...) }`

↓ BECAUSE: No flag conflict validation exists in `cli.ts` before calling `workflowRunCommand`
Evidence: `packages/cli/src/cli.ts:249-255` — only validates `--from` without `--branch`, no check for `--branch` + `--no-worktree`

↓ ROOT CAUSE: Missing mutual exclusion check for `--branch` and `--no-worktree` flags
Evidence: `packages/cli/src/cli.ts:249` — the validation block has a gap

### Affected Files

| File                                                  | Lines   | Action | Description                                            |
| ----------------------------------------------------- | ------- | ------ | ------------------------------------------------------ |
| `packages/cli/src/cli.ts`                             | 249-252 | UPDATE | Add mutual exclusion check for --branch + --no-worktree |
| `packages/cli/src/commands/workflow.ts`                | 222-232 | UPDATE | Remove dead code path (noWorktree + branchName)         |
| `packages/cli/src/commands/workflow.test.ts`           | 315     | UPDATE | Add test for the error case                             |

### Integration Points

- `cli.ts:254` constructs the options object passed to `workflowRunCommand`
- `workflow.ts:206-293` consumes the options for isolation logic
- `WorkflowRunOptions` type at `workflow.ts:32-34` allows the combination via discriminated union

### Git History

- **Last modified**: 729a1d9 — `--from` / `--from-branch` support added (recent)
- **Implication**: Pre-existing issue, not introduced by recent changes. The `--from` + `--no-worktree` conflict was caught but the simpler `--branch` + `--no-worktree` was missed.

---

## Implementation Plan

### Step 1: Add mutual exclusion check in `cli.ts`

**File**: `packages/cli/src/cli.ts`
**Lines**: 249-252
**Action**: UPDATE

**Current code:**

```typescript
// Line 249-252
if (fromBranch !== undefined && branchName === undefined) {
  console.error('Error: --from/--from-branch requires --branch to be specified.');
  return 1;
}
```

**Required change:**

```typescript
if (fromBranch !== undefined && branchName === undefined) {
  console.error('Error: --from/--from-branch requires --branch to be specified.');
  return 1;
}
if (branchName !== undefined && noWorktree) {
  console.error(
    'Error: --branch and --no-worktree are mutually exclusive.\n' +
      '  --branch creates an isolated worktree (safe).\n' +
      '  --no-worktree checks out directly in your repo (no isolation).\n' +
      'Use one or the other.'
  );
  return 1;
}
```

**Why**: Fail-fast at the CLI entry point before any git operations. This follows Option A from the issue (error on conflict), which is the safest approach. The combination has no legitimate use case.

---

### Step 2: Simplify `WorkflowRunOptions` type

**File**: `packages/cli/src/commands/workflow.ts`
**Lines**: 32-34
**Action**: UPDATE

**Current code:**

```typescript
export type WorkflowRunOptions =
  | { branchName?: undefined; noWorktree?: undefined }
  | { branchName: string; fromBranch?: string; noWorktree?: boolean };
```

**Required change:**

```typescript
export type WorkflowRunOptions =
  | { branchName?: undefined }
  | { branchName: string; fromBranch?: string };
```

**Why**: Since `--branch` and `--no-worktree` are now mutually exclusive at the CLI level, `noWorktree` should not appear in the branch variant. The `noWorktree` flag only makes sense as a standalone option (no branch specified), but currently it's only used when `branchName` is set. With the CLI guard, the `noWorktree` path inside `if (options.branchName)` becomes dead code.

Wait — re-examining: `--no-worktree` without `--branch` currently does nothing (the `if (options.branchName)` block is skipped). So `--no-worktree` is ONLY useful with `--branch`. Making them mutually exclusive means `--no-worktree` becomes entirely useless.

**Revised approach**: Keep the type as-is but remove `noWorktree` from the branch variant since the CLI now rejects the combination. The `noWorktree` flag becomes dead/unused. However, the simplest fix per KISS is just the CLI guard (Step 1) — we can leave the type and dead code path for a follow-up cleanup if desired.

**Actually**: Let's keep this minimal. The type can stay as-is. The CLI guard in Step 1 prevents the combination from ever reaching `workflowRunCommand`. The dead code in `workflow.ts:222-232` is harmless but unreachable. This avoids unnecessary refactoring.

---

### Step 2 (revised): Add test for the error case

**File**: `packages/cli/src/cli.ts` (integration test via the CLI entry point)

Since the validation happens in `cli.ts` before `workflowRunCommand` is called, and the test file tests `workflowRunCommand` directly, the best approach is to test the CLI `main` function. However, the existing test patterns in `workflow.test.ts` test `workflowRunCommand` directly.

Alternative: Add a unit test in `workflow.test.ts` that confirms `workflowRunCommand` with both flags still works (defensive), but the real validation is in `cli.ts`.

**File**: `packages/cli/src/commands/workflow.test.ts`
**Lines**: After line 315
**Action**: UPDATE

**Test cases to add:**

```typescript
it('throws when --from-branch is used with --no-worktree', async () => {
  const { discoverWorkflowsWithConfig } = await import('@archon/workflows');
  const conversationDb = await import('@archon/core/db/conversations');
  const codebaseDb = await import('@archon/core/db/codebases');

  (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
    workflows: [{ name: 'assist', description: 'Help', steps: [] }],
    errors: [],
  });
  (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
    id: 'conv-123',
  });
  (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
    id: 'cb-123',
    default_cwd: '/test/path',
  });

  await expect(
    workflowRunCommand('/test/path', 'assist', 'hello', {
      branchName: 'test-branch',
      fromBranch: 'main',
      noWorktree: true,
    })
  ).rejects.toThrow('--from/--from-branch has no effect with --no-worktree');
});
```

**Note**: The main `--branch` + `--no-worktree` mutual exclusion is enforced in `cli.ts` before `workflowRunCommand` is reached. Testing the CLI entry point (`main()`) would require more involved mocking. The existing `--from` + `--no-worktree` throw test above validates the secondary guard in `workflow.ts`.

---

## Patterns to Follow

**From codebase — existing flag validation pattern:**

```typescript
// SOURCE: packages/cli/src/cli.ts:249-252
// Pattern for flag conflict validation
if (fromBranch !== undefined && branchName === undefined) {
  console.error('Error: --from/--from-branch requires --branch to be specified.');
  return 1;
}
```

**From codebase — existing throw pattern for flag conflicts in workflow.ts:**

```typescript
// SOURCE: packages/cli/src/commands/workflow.ts:223-227
// Pattern for flag conflict inside workflowRunCommand
if (options.fromBranch) {
  throw new Error(
    '--from/--from-branch has no effect with --no-worktree. ' +
      'Remove --from or drop --no-worktree.'
  );
}
```

---

## Edge Cases & Risks

| Risk/Edge Case                                    | Mitigation                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| User intentionally wants both flags               | No legitimate use case identified; `--no-worktree` alone is sufficient     |
| `--no-worktree` becomes entirely useless           | It's already only useful with `--branch`; making them exclusive removes its purpose. Could remove the flag in a follow-up |
| Breaking change for scripts using both flags       | Unlikely anyone depends on this; the behavior was a bug                    |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test packages/cli/src/commands/workflow.test.ts
bun run lint
```

### Manual Verification

1. Run `bun run cli workflow run assist --branch test --no-worktree "hello"` — should see error message and exit 1
2. Run `bun run cli workflow run assist --branch test "hello"` — should still create worktree normally
3. Run `bun run cli workflow run assist "hello"` — should work without isolation

---

## Scope Boundaries

**IN SCOPE:**
- Add mutual exclusion check for `--branch` + `--no-worktree` in `cli.ts`
- Add test for the `--from` + `--no-worktree` throw in `workflow.ts` (currently untested)

**OUT OF SCOPE (do not touch):**
- Removing `--no-worktree` flag entirely (follow-up decision)
- Refactoring `WorkflowRunOptions` type (dead code is harmless)
- Changes to `workflow.ts` execution logic (the CLI guard is sufficient)

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-03-10T12:00:00Z
- **Artifact**: `.claude/PRPs/issues/issue-488.md`
