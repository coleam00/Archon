---
description: Execute an Archon implementation plan file
argument-hint: <path-to-plan.md>
---

# Execute: Implement an Archon Plan

## Objective

Read and execute every task in the plan file: **$ARGUMENTS**

Implement all tasks faithfully, following Archon monorepo conventions, and report results.

---

## Step 1: Read the Entire Plan

Read the plan file at `$ARGUMENTS` from start to finish before writing a single line of code.
Understand:

- All tasks and their dependencies
- Affected packages and files
- Architecture notes and prohibited patterns
- The validation steps at the end

Do NOT start implementing until you have the full picture.

---

## Step 2: Verify Current State

Check the working tree is clean before starting:

```bash
git status
```

If there are uncommitted changes unrelated to this plan, flag them before proceeding.

Check the current branch:

```bash
git branch --show-current
```

---

## Step 3: Execute Tasks in Dependency Order

Work through each task in the plan sequentially (respecting `Depends on:` ordering).

### For each task:

1. **Read** the target file(s) before modifying — never edit blindly.
2. **Implement** the change using the Edit or Write tools.
3. **Verify** the change compiles after touching TypeScript files:
   ```bash
   bun run type-check 2>&1 | tail -20
   ```
   Fix type errors immediately — do not accumulate them.

### Archon conventions to follow:

**Imports:**
```typescript
// Type-only imports
import type { IPlatformAdapter, Conversation } from '@archon/core';
// Value imports — named, not namespace
import { handleMessage, pool } from '@archon/core';
// Submodule namespace imports (acceptable)
import * as git from '@archon/git';
```

**Functions:**
```typescript
// All functions need explicit return types
async function createSession(id: string): Promise<Session> { ... }
// No implicit any
```

**Logging:**
```typescript
import { createLogger } from '@archon/paths';
// Lazy logger pattern (test mocks work correctly)
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('my-module');
  return cachedLog;
}
// Event naming: {domain}.{action}_{state}
log.info({ id }, 'session.create_started');
```

**Error handling:**
```typescript
// Never swallow errors silently
try {
  await riskyOperation();
} catch (error) {
  const err = error as Error;
  log.error({ err, context }, 'operation.failed');
  throw err; // re-throw or classify for user
}
```

**Git operations:**
- Always use `execFileAsync` (not `exec`) when calling git directly
- Never run `git clean -fd` — use `git checkout .` instead
- Use branded types: `toRepoPath()`, `toBranchName()`, `toWorktreePath()`

**Package boundaries:**
- `@archon/workflows` must NOT import from `@archon/core`
- `@archon/git` must NOT import from `@archon/core` or `@archon/workflows`
- `@archon/paths` has zero `@archon/*` dependencies

**Testing (if adding tests):**
- Check which test batch the new file belongs to in the package's `package.json`
- `mock.module()` is permanent in Bun — place new test files to avoid polluting other files
- Use `spyOn()` for modules other test files also use directly (not `mock.module()`)

---

## Step 4: Run Incremental Validation

After completing all tasks in a package, run validation for that package:

```bash
# Type checking across all packages
bun run type-check

# Lint (zero warnings policy)
bun run lint

# Format check
bun run format:check

# Tests (per-package isolation — do NOT run from repo root directly)
bun run test
```

Fix any failures before proceeding to the next package group.

---

## Step 5: Run Full Validation

After all tasks are complete, run the full validation suite:

```bash
bun run validate
```

This runs: `type-check && lint --max-warnings 0 && format:check && test`

All four must pass. If any fail, fix them before reporting completion.

---

## Step 6: Output Report

Provide a structured completion report:

```
## Execution Report: {Plan Name}

### Tasks Completed
- [x] Task 1: {description} — {files changed}
- [x] Task 2: {description} — {files changed}
...

### Files Created
- `packages/{pkg}/src/{file}.ts` — {purpose}

### Files Modified
- `packages/{pkg}/src/{file}.ts` — {what changed}

### Validation Results
- type-check: PASS / FAIL
- lint: PASS / FAIL (N warnings)
- format:check: PASS / FAIL
- tests: PASS / FAIL (N passed, N failed)
- Full `bun run validate`: PASS / FAIL

### Manual Verification
{Any curl commands or UI steps to manually verify the feature works.}

### Notes
{Any deviations from the plan, unexpected findings, or follow-up work needed.}
```
