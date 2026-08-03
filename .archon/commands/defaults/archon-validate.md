---
description: Run full validation suite - type-check, lint, tests, build
argument-hint: (no arguments - reads from workflow artifacts)
---

# Validate Implementation

**Workflow ID**: $WORKFLOW_ID

---

## Your Mission

Run the complete validation suite and fix any failures.

This is a focused step: run checks, fix issues, repeat until green.

---

## Phase 1: LOAD - Get Validation Commands

### 1.1 Load Plan Context

```bash
cat $ARTIFACTS_DIR/plan-context.md
```

Extract the "Validation Commands" section.

### 1.2 Identify Package Manager

```bash
test -f bun.lockb && echo "bun" || \
test -f pnpm-lock.yaml && echo "pnpm" || \
test -f yarn.lock && echo "yarn" || \
test -f package-lock.json && echo "npm" || \
echo "unknown"
```

### 1.3 Determine Available Commands

Check `package.json` for available scripts:

```bash
cat package.json | grep -A 20 '"scripts"'
```

**PHASE_1_CHECKPOINT:**

- [ ] Validation commands identified
- [ ] Package manager known

---

## Phase 2: VALIDATE - Run All Checks

Run each check in order. Fix any failures before proceeding.

### 2.1 Type Check

```bash
{runner} run type-check
```

**If fails:**
1. Read error output
2. Fix the type issues
3. Re-run until passing

**Record result**: ✅ Pass / ❌ Fail (fixed)

### 2.2 Lint Check

```bash
{runner} run lint
```

**If fails:**

1. Try auto-fix first:
   ```bash
   {runner} run lint:fix
   ```

2. Re-run lint check

3. If still failing, manually fix remaining issues

**Record result**: ✅ Pass / ❌ Fail (fixed)

### 2.3 Format Check

```bash
{runner} run format:check
```

**If fails:**

1. Auto-fix:
   ```bash
   {runner} run format
   ```

2. Verify fixed:
   ```bash
   {runner} run format:check
   ```

**Record result**: ✅ Pass / ❌ Fail (fixed)

### 2.4 Test Suite

```bash
{runner} test
```

**If fails:**

1. Identify which test(s) failed
2. Determine: implementation bug or test bug?
3. Fix the root cause
4. Re-run tests

**Record result**: ✅ Pass ({N} tests) / ❌ Fail (fixed)

### 2.5 Build Check

```bash
{runner} run build
```

**If fails:**

1. Usually a type or import issue
2. Fix and re-run

**Record result**: ✅ Pass / ❌ Fail (fixed)

**PHASE_2_CHECKPOINT:**

- [ ] Type check passes
- [ ] Lint passes
- [ ] Format passes
- [ ] Tests pass
- [ ] Build passes

---

## Phase 3: ARTIFACT - Write Validation Results

### 3.1 Write Validation Artifact

Write to `$ARTIFACTS_DIR/validation.md`:

```markdown
# Validation Results

**Generated**: {YYYY-MM-DD HH:MM}
**Workflow ID**: $WORKFLOW_ID
**Status**: {ALL_PASS | FIXED | BLOCKED}

---

## Summary

| Check | Result | Details |
|-------|--------|---------|
| Type check | ✅ | No errors |
| Lint | ✅ | 0 errors, {N} warnings |
| Format | ✅ | All files formatted |
| Tests | ✅ | {N} passed, 0 failed |
| Build | ✅ | Compiled successfully |

---

## Type Check

**Command**: `{runner} run type-check`
**Result**: ✅ Pass

{If issues were fixed:}
### Issues Fixed

- `src/file.ts:42` - Added missing return type
- `src/other.ts:15` - Fixed generic constraint

---

## Lint

**Command**: `{runner} run lint`
**Result**: ✅ Pass

{If issues were fixed:}
### Issues Fixed

- {N} auto-fixed by `lint:fix`
- {M} manually fixed

### Remaining Warnings

{List any warnings that weren't fixed, with justification}

---

## Format

**Command**: `{runner} run format:check`
**Result**: ✅ Pass

{If files were formatted:}
### Files Formatted

- `src/file.ts`
- `src/other.ts`

---

## Tests

**Command**: `{runner} test`
**Result**: ✅ Pass

| Metric | Count |
|--------|-------|
| Total tests | {N} |
| Passed | {N} |
| Failed | 0 |
| Skipped | {M} |

{If tests were fixed:}
### Tests Fixed

- `src/x.test.ts` - Fixed assertion to match new behavior

---

## Build

**Command**: `{runner} run build`
**Result**: ✅ Pass

Build output: `dist/` (or as configured)

---

## Files Modified During Validation

{If any files were changed to fix issues:}

| File | Changes |
|------|---------|
| `src/file.ts` | Fixed type error |
| `src/other.ts` | Lint auto-fix |

---

## Next Step

Continue to `archon-finalize-pr` to update PR and mark ready for review.
```

**PHASE_3_CHECKPOINT:**

- [ ] Validation artifact written
- [ ] All results documented

---

## Phase 4: OUTPUT - Report Results

### If All Pass:

```markdown
## Validation Complete ✅

**Workflow ID**: `$WORKFLOW_ID`

### Results

| Check | Status |
|-------|--------|
| Type check | ✅ |
| Lint | ✅ |
| Format | ✅ |
| Tests | ✅ ({N} passed) |
| Build | ✅ |

{If issues were fixed:}
### Issues Fixed

- {N} type errors fixed
- {M} lint issues fixed
- {K} format issues fixed

### Artifact

Results written to: `$ARTIFACTS_DIR/validation.md`

### Next Step

Proceed to `archon-finalize-pr` to update PR and mark ready for review.
```

### If Blocked (unfixable issue):

```markdown
## Validation Blocked ❌

**Workflow ID**: `$WORKFLOW_ID`

### Failed Check

**{check-name}**: {error description}

### Attempts to Fix

1. {what was tried}
2. {what was tried}

### Required Action

This issue requires manual intervention:

{description of what needs to be done}

### Artifact

Partial results written to: `$ARTIFACTS_DIR/validation.md`
```

---

## Success Criteria

- **TYPE_CHECK_PASS**: `{runner} run type-check` exits 0
- **LINT_PASS**: `{runner} run lint` exits 0
- **FORMAT_PASS**: `{runner} run format:check` exits 0
- **TESTS_PASS**: `{runner} test` all green
- **BUILD_PASS**: `{runner} run build` exits 0
- **ARTIFACT_WRITTEN**: Validation results documented
