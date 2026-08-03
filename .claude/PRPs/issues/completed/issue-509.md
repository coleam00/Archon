# Investigation: 23 test pollution failures from unrestored mocks

**Issue**: #509 (https://github.com/dynamous-community/remote-coding-agent/issues/509)
**Type**: BUG
**Investigated**: 2026-02-26T12:00:00Z

### Assessment

| Metric     | Value    | Reasoning                                                                                          |
| ---------- | -------- | -------------------------------------------------------------------------------------------------- |
| Severity   | HIGH     | 23 tests fail in full suite making CI unreliable; masks real regressions                           |
| Complexity | MEDIUM   | 3 polluter files to fix, patterns are well-understood, but `mock.module` requires different strategy than `spyOn` |
| Confidence | HIGH     | Root cause fully traced with code evidence; issue is well-documented and reproducible               |

---

## Problem Statement

23 tests pass in isolation but fail in the full `bun test` suite. Three test files set up `spyOn()` or `mock.module()` calls that never restore original implementations, polluting global state for subsequent test files in Bun's single-process test runner.

---

## Analysis

### Root Cause

All 23 failures share one anti-pattern: **process-global mocks without cleanup**.

- `spyOn()` replaces properties on the live module namespace object. Without `.mockRestore()`, the spy persists for all subsequent test files.
- `mock.module()` replaces the module in Bun's registry permanently. Bun has no per-call undo — only the global `mock.restore()` resets all module mocks.

### Evidence Chain

WHY: 19 git tests fail with mock return values instead of real fs results
↓ BECAUSE: `worktreeExists`, `getCanonicalRepoPath`, `findWorktreeByBranch` are spied on the `@archon/git` namespace
Evidence: `packages/isolation/src/resolver.test.ts:89-95` — three `spyOn()` calls in `beforeEach`

↓ BECAUSE: No `afterEach` exists to call `.mockRestore()` on these spies
Evidence: `packages/isolation/src/resolver.test.ts` — zero occurrences of `afterEach`, `mockRestore`, or `restore`

↓ ROOT CAUSE: `resolver.test.ts` mutates the shared `@archon/git` module object via `spyOn` and never restores it.

WHY: 3 `ensureRepoReady` tests fail in adapter.test.ts
↓ BECAUSE: `mock.module('@archon/git', ...)` at file scope replaces the entire module permanently
Evidence: `packages/adapters/src/forge/github/adapter.test.ts:82-90` — `mock.module('@archon/git', () => ({...}))` with only 7 of 20+ real exports

↓ ROOT CAUSE: No `afterAll(() => mock.restore())` to reset module-level mocks.

WHY: 1 `checkExistingConfig` test fails expecting `null` but gets truthy
↓ BECAUSE: `fs.existsSync` is globally replaced by `mock.module('fs', ...)` to always return `true`
Evidence: `packages/core/src/orchestrator/orchestrator.test.ts:170-174` — `mock.module('fs', () => ({ existsSync: mock(() => true) }))`

↓ ROOT CAUSE: No `afterAll(() => mock.restore())` to reset the `fs` module mock.

### Affected Files

| File | Lines | Action | Description |
| ---- | ----- | ------ | ----------- |
| `packages/isolation/src/resolver.test.ts` | 85-95 | UPDATE | Add `afterEach` with `mockRestore()` for all 3 spies |
| `packages/adapters/src/forge/github/adapter.test.ts` | 82-90 | UPDATE | Add `afterAll(() => mock.restore())` to clean up module mocks |
| `packages/core/src/orchestrator/orchestrator.test.ts` | 170-174 | UPDATE | Add `afterAll(() => mock.restore())` to clean up module mocks |

### Integration Points

- `packages/git/src/git.test.ts` — victim: 19 tests rely on real `@archon/git` functions
- `packages/cli/src/commands/setup.test.ts` — victim: 1 test relies on real `fs.existsSync`
- `packages/adapters/src/forge/github/adapter.test.ts` — both polluter (mock.module) and victim (ensureRepoReady tests)

### Git History

- **Group 1 introduced**: `a9ed888` (Feb 25) — extract @archon/isolation (#492)
- **Group 2 introduced**: `3b52102` (Feb 25) — extract @archon/adapters (#499)
- **Group 3 introduced**: `4204e1f` (Feb 18) — Archon orchestrator (#452)
- **Implication**: Latent bugs — the missing cleanup existed before extraction, but file ordering changes made them visible

---

## Implementation Plan

### Step 1: Add `afterEach` cleanup to `resolver.test.ts`

**File**: `packages/isolation/src/resolver.test.ts`
**Lines**: After line 95 (end of `beforeEach` block)
**Action**: UPDATE

**Current code:**
```typescript
// Line 89-95
beforeEach(() => {
  worktreeExistsSpy = spyOn(git, 'worktreeExists').mockResolvedValue(true);
  getCanonicalSpy = spyOn(git, 'getCanonicalRepoPath').mockResolvedValue(
    '/repos/myrepo' as git.RepoPath
  );
  findWorktreeByBranchSpy = spyOn(git, 'findWorktreeByBranch').mockResolvedValue(null);
});

// ← No afterEach
```

**Required change:**
```typescript
beforeEach(() => {
  worktreeExistsSpy = spyOn(git, 'worktreeExists').mockResolvedValue(true);
  getCanonicalSpy = spyOn(git, 'getCanonicalRepoPath').mockResolvedValue(
    '/repos/myrepo' as git.RepoPath
  );
  findWorktreeByBranchSpy = spyOn(git, 'findWorktreeByBranch').mockResolvedValue(null);
});

afterEach(() => {
  worktreeExistsSpy.mockRestore();
  getCanonicalSpy.mockRestore();
  findWorktreeByBranchSpy.mockRestore();
});
```

**Why**: Restores the three spied functions on the `@archon/git` namespace object after each test, preventing pollution of `packages/git/src/git.test.ts`.

**Pattern**: Mirrors `packages/git/src/git.test.ts:357-366` which uses the same `spyOn`/`afterEach`/`mockRestore` pattern.

---

### Step 2: Add `afterAll` with `mock.restore()` to `adapter.test.ts`

**File**: `packages/adapters/src/forge/github/adapter.test.ts`
**Action**: UPDATE

**Required change:** Add `afterAll` import and call inside the top-level `describe`:

1. Update the import line to include `afterAll`:
```typescript
import { describe, it, expect, beforeEach, afterEach, afterAll, mock, spyOn } from 'bun:test';
```

2. Add `afterAll` inside the top-level `describe('GitHubAdapter', ...)` block:
```typescript
afterAll(() => {
  mock.restore();
});
```

**Why**: `mock.module` is permanent in Bun — only `mock.restore()` (the global form) resets all module-level mocks. This prevents `@archon/git`, `child_process`, `@archon/paths`, and `@archon/core/db/*` mocks from leaking.

**Pattern**: Mirrors `packages/workflows/src/executor.test.ts:205-209` which uses the same `afterAll(() => mock.restore())` pattern with an explicit comment about preventing cross-file leaks.

---

### Step 3: Add `afterAll` with `mock.restore()` to `orchestrator.test.ts`

**File**: `packages/core/src/orchestrator/orchestrator.test.ts`
**Action**: UPDATE

**Required change:** Add `afterAll` import and call inside the top-level `describe`:

1. Update the import line to include `afterAll`:
```typescript
import { mock, describe, test, expect, beforeEach, afterAll } from 'bun:test';
```

2. Add `afterAll` inside the top-level `describe` block:
```typescript
afterAll(() => {
  mock.restore();
});
```

**Why**: Resets the `fs` module mock (and 14 other module mocks) after orchestrator tests complete, preventing `existsSync` from returning `true` in `setup.test.ts`.

**Pattern**: Same as Step 2 — mirrors `executor.test.ts:205-209`.

---

### Step 4: Add `afterAll` with `mock.restore()` to `resolver.test.ts`

**File**: `packages/isolation/src/resolver.test.ts`
**Action**: UPDATE

**Required change:** In addition to the `afterEach` from Step 1, add `afterAll` to clean up the `mock.module('@archon/paths')` call at line 5:

1. Update the import to include `afterAll`:
```typescript
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
```

2. Add `afterAll` inside the `describe('IsolationResolver', ...)` block:
```typescript
afterAll(() => {
  mock.restore();
});
```

**Why**: The `mock.module('@archon/paths')` at line 5 is also a permanent replacement. While the `afterEach` from Step 1 handles the `spyOn` pollution, `mock.restore()` in `afterAll` ensures the module-level mock is also cleaned up.

---

### Step 5: Verify the fix

**Automated:**
```bash
# Full suite should now pass
bun test

# Individual files should still pass
bun test packages/git/src/git.test.ts
bun test packages/adapters/src/forge/github/adapter.test.ts
bun test packages/cli/src/commands/setup.test.ts
bun test packages/isolation/src/resolver.test.ts
bun test packages/core/src/orchestrator/orchestrator.test.ts
```

**Manual:**
```bash
# Confirm no new failures introduced
bun run validate
```

---

## Patterns to Follow

**From codebase — mirror these exactly:**

```typescript
// SOURCE: packages/workflows/src/executor.test.ts:195-209
// Pattern for afterEach spy restore + afterAll module mock restore
afterEach(async () => {
  commitAllChangesSpy.mockRestore();
  getDefaultBranchSpy.mockRestore();
  // ...cleanup...
});

afterAll(() => {
  // Clear module mocks and pending timers to prevent leaks to other test files
  mock.restore();
});
```

```typescript
// SOURCE: packages/git/src/git.test.ts:357-366
// Pattern for spyOn with afterEach restore
describe('listWorktrees', () => {
  let execSpy: Mock<typeof git.execFileAsync>;

  beforeEach(() => {
    execSpy = spyOn(git, 'execFileAsync');
  });

  afterEach(() => {
    execSpy.mockRestore();
  });
});
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
| -------------- | ---------- |
| `mock.restore()` in `afterAll` might restore mocks too aggressively, breaking tests within the same file that depend on module mocks | `afterAll` runs after ALL tests in the describe block, so intra-file tests are unaffected |
| Multiple files call `mock.restore()` — order matters | Each file's `afterAll` runs after its own tests; the global restore is idempotent |
| `mock.restore()` also restores `spyOn` — could the `afterEach` + `afterAll` double-restore cause issues? | No — restoring an already-restored spy is a no-op in Bun |
| Future test files might add new `mock.module` calls without cleanup | Could add a linting rule or CLAUDE.md guideline, but out of scope for this fix |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test
bun run lint
# Or all at once:
bun run validate
```

### Manual Verification

1. Run `bun test` and confirm 0 failures (all 23 previously-failing tests now pass)
2. Run individual test files to confirm they still pass in isolation
3. Confirm no new test failures introduced

---

## Scope Boundaries

**IN SCOPE:**
- Adding `afterEach` with `mockRestore()` to `resolver.test.ts` for spy cleanup
- Adding `afterAll` with `mock.restore()` to 3 polluter files for module mock cleanup
- Updating imports to include `afterEach`/`afterAll` as needed

**OUT OF SCOPE (do not touch):**
- Refactoring tests to use dependency injection instead of `mock.module`
- Adding a global test setup that calls `mock.restore()` after every file
- Fixing mock patterns in other test files that aren't currently causing failures
- Adding ESLint rules for mock cleanup enforcement

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-02-26T12:00:00Z
- **Artifact**: `.claude/PRPs/issues/issue-509.md`
