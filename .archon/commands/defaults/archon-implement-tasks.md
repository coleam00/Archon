---
description: Execute plan tasks with type-checking after each change
argument-hint: (no arguments - reads from workflow artifacts)
---

# Implement Tasks

**Workflow ID**: $WORKFLOW_ID

---

## Your Mission

Execute each task from the plan, validating after every change.

**Core Philosophy**:
- Type-check after EVERY file change
- Fix issues immediately before moving on
- Document any deviations from the plan

**This step assumes setup is complete** - branch exists, PR is created, plan is confirmed.

---

## Phase 1: LOAD - Read Context

### 1.1 Load Plan Context

```bash
cat $ARTIFACTS_DIR/plan-context.md
```

Extract:
- Files to change (CREATE/UPDATE list)
- Validation commands (especially type-check)
- Patterns to mirror

### 1.2 Load Plan Confirmation

```bash
cat $ARTIFACTS_DIR/plan-confirmation.md
```

Check:
- Status is CONFIRMED or PROCEED WITH CAUTION
- Note any warnings to handle during implementation

### 1.3 Load Original Plan

The plan source path is in `plan-context.md`. Read the full plan for detailed task instructions:

```bash
cat {plan-source-path}
```

### 1.4 Identify Package Manager

```bash
test -f bun.lockb && echo "bun" || \
test -f pnpm-lock.yaml && echo "pnpm" || \
test -f yarn.lock && echo "yarn" || \
test -f package-lock.json && echo "npm" || \
echo "unknown"
```

Store the runner for validation commands.

**PHASE_1_CHECKPOINT:**

- [ ] Plan context loaded
- [ ] Confirmation status verified
- [ ] Original plan loaded
- [ ] Package manager identified

---

## Phase 2: EXECUTE - Implement Each Task

**For each task in the plan's "Tasks" or "Step-by-Step Tasks" section:**

### 2.1 Read Task Context

Before implementing each task:

1. **Read the MIRROR file** referenced in the task
2. **Understand the pattern** to follow
3. **Note any GOTCHA warnings**
4. **Check IMPORTS** needed

### 2.2 Implement the Task

Make the change as specified:

- **CREATE**: Write new file following the pattern
- **UPDATE**: Modify existing file as described
- **Follow patterns exactly** - match style, naming, structure

### 2.3 Type-Check Immediately

**After EVERY file change:**

```bash
{runner} run type-check
```

**If type-check fails:**

1. Read the error message carefully
2. Fix the type issue
3. Re-run type-check
4. Only proceed when passing

**Do NOT accumulate errors** - fix each one before moving to the next task.

### 2.4 Track Progress

Log each task as completed:

```
Task 1: CREATE src/features/x/models.ts ✅
Task 2: CREATE src/features/x/service.ts ✅
Task 3: UPDATE src/routes/index.ts ✅
```

### 2.5 Handle Deviations

If you must deviate from the plan:

1. **Document WHAT** changed
2. **Document WHY** it changed
3. **Continue** with the deviation noted

Common reasons for deviation:
- Pattern file has changed since plan was created
- Missing import discovered
- Type incompatibility requires different approach
- Better solution discovered during implementation

**PHASE_2_CHECKPOINT (per task):**

- [ ] Task implemented
- [ ] Type-check passes
- [ ] Progress logged
- [ ] Deviations documented (if any)

---

## Phase 3: TESTS - Write Required Tests

### 3.1 Test Requirements

Every new function/feature needs at least one test:

- **New file created** → Create corresponding test file
- **New function added** → Add test for that function
- **Behavior changed** → Update existing tests

### 3.2 Follow Test Patterns

Find existing test files to mirror:

```bash
find . -name "*.test.ts" -type f | head -5
```

Read a relevant test file to understand the project's test patterns.

### 3.3 Write Tests

For each new/changed file, write tests that cover:

1. **Happy path** - Normal expected behavior
2. **Edge cases** - Boundary conditions from the plan
3. **Error cases** - What happens with bad input

### 3.4 Run Tests

```bash
{runner} test
```

**If tests fail:**

1. Determine: bug in implementation or bug in test?
2. Fix the actual issue (usually implementation)
3. Re-run tests
4. Repeat until green

**PHASE_3_CHECKPOINT:**

- [ ] Tests written for new code
- [ ] All tests pass

---

## Phase 4: ARTIFACT - Write Implementation Progress

### 4.1 Write Progress Artifact

Write to `$ARTIFACTS_DIR/implementation.md`:

```markdown
# Implementation Progress

**Generated**: {YYYY-MM-DD HH:MM}
**Workflow ID**: $WORKFLOW_ID
**Status**: {COMPLETE | IN_PROGRESS | BLOCKED}

---

## Tasks Completed

| # | Task | File | Status | Notes |
|---|------|------|--------|-------|
| 1 | {description} | `src/x.ts` | ✅ | |
| 2 | {description} | `src/y.ts` | ✅ | |
| 3 | {description} | `src/z.ts` | ✅ | Minor deviation - see below |

**Progress**: {X} of {Y} tasks completed

---

## Files Changed

| File | Action | Lines |
|------|--------|-------|
| `src/new-file.ts` | CREATE | +{N} |
| `src/existing.ts` | UPDATE | +{N}/-{M} |

---

## Tests Written

| Test File | Test Cases |
|-----------|------------|
| `src/x.test.ts` | `should do X`, `should handle Y` |
| `src/y.test.ts` | `creates correctly`, `validates input` |

---

## Deviations from Plan

{If none:}
No deviations. Implementation matched the plan exactly.

{If any:}
### Deviation 1: {brief title}

**Task**: {which task}
**Expected**: {what plan said}
**Actual**: {what was done}
**Reason**: {why the change was necessary}

---

## Type-Check Status

- [x] Passes after all changes

---

## Test Status

- [x] All tests pass
- Tests added: {N}
- Tests modified: {M}

---

## Issues Encountered

{If none:}
No issues encountered.

{If any:}
### Issue 1: {title}

**Problem**: {description}
**Resolution**: {how it was fixed}

---

## Next Step

Continue to `archon-validate` for full validation suite.
```

**PHASE_4_CHECKPOINT:**

- [ ] Implementation artifact written
- [ ] All tasks documented
- [ ] Deviations noted
- [ ] Test status recorded

---

## Phase 5: OUTPUT - Report Progress

```markdown
## Implementation Complete

**Workflow ID**: `$WORKFLOW_ID`
**Status**: ✅ All tasks executed

### Progress Summary

| Metric | Count |
|--------|-------|
| Tasks completed | {X}/{Y} |
| Files created | {N} |
| Files updated | {M} |
| Tests written | {K} |

### Type-Check

✅ Passes

### Tests

✅ All pass ({N} tests)

{If deviations:}
### Deviations

{count} deviation(s) from plan documented in artifact.

### Artifact

Progress written to: `$ARTIFACTS_DIR/implementation.md`

### Next Step

Proceed to `archon-validate` for full validation (lint, build, integration tests).
```

---

## Error Handling

### Type-Check Fails

Do NOT proceed to next task. Fix the issue:

1. Read the error carefully
2. Identify the file and line
3. Fix the type issue
4. Re-run type-check
5. Only continue when green

### Test Fails

1. Read the failure output
2. Identify: implementation bug or test bug?
3. Fix the root cause
4. Re-run tests

### Pattern File Changed

If a pattern file has changed since the plan was created:

1. Read the current version
2. Adapt the implementation to match current patterns
3. Document as a deviation
4. Continue

### Task Unclear

If a task description is ambiguous:

1. Check the plan's context sections for clarity
2. Look at the MIRROR file for guidance
3. Make a reasonable decision
4. Document the interpretation as a deviation

---

## Success Criteria

- **TASKS_COMPLETE**: All tasks from plan executed
- **TYPES_PASS**: Type-check passes after all changes
- **TESTS_WRITTEN**: New code has tests
- **TESTS_PASS**: All tests green
- **DEVIATIONS_DOCUMENTED**: Any plan deviations noted
- **ARTIFACT_WRITTEN**: Implementation progress artifact created
