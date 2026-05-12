---
description: Run Archon's full validation suite with per-level reporting
---

# Validate: Comprehensive Archon Validation

## Objective

Run all four validation levels for the Archon monorepo and report pass/fail with actionable
diagnostics. All four must pass before a PR can be created.

---

## Level 1: Type Checking

```bash
bun run type-check
```

Runs `tsc --noEmit` across all 8 packages via `bun --filter '*' type-check`.

**What to look for:**
- Missing return types (explicit return types required on all functions)
- Incorrect interface implementations (`IPlatformAdapter`, `IAgentProvider`, etc.)
- Import type errors (use `import type` for type-only imports)
- Package boundary violations (e.g., `@archon/workflows` importing from `@archon/core`)

---

## Level 2: ESLint Linting

```bash
bun run lint
```

Zero-tolerance policy: `--max-warnings 0`. Any warning is a failure.

**What to look for:**
- `no-explicit-any` violations — fix the type, don't suppress
- Missing explicit return types
- Unused variables or imports
- Import order issues

To auto-fix safe lint issues:
```bash
bun run lint:fix
```

---

## Level 3: Prettier Format Check

```bash
bun run format:check
```

**What to look for:**
- Inconsistent indentation (2 spaces)
- Missing/extra semicolons
- Quote style (single quotes)
- Trailing whitespace, line endings

To auto-fix formatting:
```bash
bun run format
```

---

## Level 4: Tests

```bash
bun run test
```

This runs `bun --filter '*' test` for per-package isolation. **Never run `bun test` from the
repo root** — it causes ~135 mock pollution failures due to Bun's global `mock.module()` cache.

**Package test isolation notes:**
- `@archon/core` — 7 separate `bun test` batches (mock.module pollution prevention)
- `@archon/workflows` — 5 batches
- `@archon/adapters` — 3 batches
- `@archon/isolation` — 3 batches

**What to look for:**
- Failing unit tests (fix root cause, not the test assertion)
- Flaky tests (timing/network dependencies — add proper mocking)
- Missing test coverage for new code

To run a single test file during debugging:
```bash
bun test packages/core/src/handlers/command-handler.test.ts
```

To run tests for a single package:
```bash
bun --filter @archon/workflows test
```

---

## Level 5: Full Validation (CI Gate)

```bash
bun run validate
```

Equivalent to: `bun run type-check && bun run lint --max-warnings 0 && bun run format:check && bun run test`

This is the exact command CI runs. If this passes locally, CI will pass.

---

## Output Report

After running all levels, provide this report:

```
## Validation Report

| Level | Command | Result | Details |
|-------|---------|--------|---------|
| 1 | bun run type-check | PASS / FAIL | N errors |
| 2 | bun run lint | PASS / FAIL | N warnings |
| 3 | bun run format:check | PASS / FAIL | N files |
| 4 | bun run test | PASS / FAIL | N passed, N failed |
| 5 | bun run validate | PASS / FAIL | — |

### Failures (if any)

#### Type Errors
{List specific errors with file:line references}

#### Lint Warnings/Errors
{List specific violations with file:line references}

#### Format Issues
{List files with formatting problems}

#### Test Failures
{List failing test names and error messages}

### Recommended Fixes
{Prioritized list of what to fix, in order}
```

**Tip:** Fix in this order — types first (lint often clears up after type fixes), then lint,
then format (always auto-fixable), then tests last.
