---
description: "Execute an implementation plan with rigorous validation loops"
argument-hint: "<path/to/plan.md>"
agent: "agent"
tools:
  - codebase
  - editFiles
  - createFile
  - createDirectory
  - readFile
  - runInTerminal
  - problems
  - runTests
  - textSearch
  - fileSearch
  - usages
  - listDirectory
---

# Implement Plan

**Plan**: ${input:planPath:Path to plan file (e.g. .agents/plans/feature-name.plan.md)}

## Your Mission

Execute the plan end-to-end with rigorous self-validation. You are autonomous.

**Core Philosophy**: Validation loops catch mistakes early. Run checks after every change. Fix issues immediately. The goal is a working implementation, not just code that exists.

**Golden Rule**: If a validation fails, fix it before moving on. Never accumulate broken state.

---

## Phase 0: DETECT - Project Environment

### 0.1 Identify Package Manager

Check for these files to determine the project's toolchain:

| File Found | Package Manager | Runner |
|------------|-----------------|--------|
| `bun.lockb` | bun | `bun` / `bun run` |
| `pnpm-lock.yaml` | pnpm | `pnpm` / `pnpm run` |
| `yarn.lock` | yarn | `yarn` / `yarn run` |
| `package-lock.json` | npm | `npm run` |
| `pyproject.toml` | uv/pip | `uv run` / `python` |
| `Cargo.toml` | cargo | `cargo` |
| `go.mod` | go | `go` |

Store the detected runner — use it for all subsequent commands.

### 0.2 Detect Base Branch

Determine the base branch for branching and syncing:

```bash
# Auto-detect from remote
git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'
```

If that fails:

```bash
git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}'
```

**Last resort**: `main`

Store as `{base-branch}` — use this for ALL branch operations. Never hardcode `main` or `master`.

### 0.3 Identify Validation Scripts

Check `package.json` (or equivalent) for available scripts:

- Type checking: `type-check`, `typecheck`, `tsc`, `build`
- Linting: `lint`, `lint:fix`
- Testing: `test`, `test:unit`, `test:integration`
- Building: `build`, `compile`

**Use the plan's "Validation" section** — it should specify exact commands for this project.

---

## Phase 1: LOAD - Read the Plan

### 1.1 Load Plan File

Read the plan file and extract all key sections.

### 1.2 Extract Key Sections

Locate and understand:

- **Summary** — What we're building
- **Mandatory Reading** — Files to read BEFORE starting (P0/P1/P2 priority)
- **Patterns to Mirror** — Code to copy from
- **Files to Change** — CREATE/UPDATE list
- **NOT Building** — Explicit scope limits
- **Tasks** — Implementation order with MIRROR references
- **Validation** — Commands to run (USE THESE, not hardcoded commands)
- **Acceptance Criteria** — Definition of done

### 1.3 Read Mandatory Files

**Before implementing ANY task**, read every file in the Mandatory Reading table, starting with P0 (highest priority). These contain the patterns and types you must follow.

**If plan not found:**

```
Error: Plan not found at the specified path.
Create a plan first: /plan "feature description"
```

---

## Phase 2: PREPARE - Git State

### 2.1 Check Current State

```bash
git branch --show-current
git status --porcelain
git worktree list
```

### 2.2 Branch Decision

| Current State | Action |
|---------------|--------|
| In worktree | Use it (log: "Using worktree") |
| On {base-branch}, clean | Create branch: `git checkout -b feature/{plan-slug}` |
| On {base-branch}, dirty | STOP: "Stash or commit changes first" |
| On feature branch | Use it (log: "Using existing branch") |

### 2.3 Sync with Remote

```bash
git fetch origin
git pull --rebase origin {base-branch} 2>/dev/null || true
```

---

## Phase 3: EXECUTE - Implement Tasks

**For each task in the plan's Tasks section:**

### 3.1 Read Context

1. Read the **MIRROR** file reference from the task
2. Understand the pattern to follow
3. Read any **IMPORTS** specified
4. Note any **GOTCHA** warnings

### 3.2 Implement

1. Make the change exactly as specified
2. Follow the pattern from MIRROR reference
3. Handle any GOTCHA warnings from the task

### 3.3 Validate Immediately

**After EVERY file change**, run the type-check command from the plan's Validation section.

Common patterns (use what the plan specifies):

| Toolchain | Command |
|-----------|---------|
| JS/TS | `{runner} run build` or `{runner} run type-check` |
| Python | `mypy .` or `pyright` |
| Rust | `cargo check` |
| Go | `go build ./...` |

**If types fail:**

1. Read the error
2. Fix the issue
3. Re-run type-check
4. Only proceed when passing

### 3.4 Track Progress

```
Task 1: CREATE src/features/x/models.ts ✅
Task 2: CREATE src/features/x/service.ts ✅
Task 3: UPDATE src/routes/index.ts ✅
```

**If you deviate from the plan**, document what changed and why.

---

## Phase 4: VALIDATE - Full Verification

### 4.1 Static Analysis

Run type-check and lint commands from the plan's Validation section.

**Must pass with zero errors.**

If lint errors:

1. Run the lint fix command (e.g., `{runner} run lint --fix`, `ruff check --fix .`)
2. Re-check
3. Manual fix remaining issues

### 4.2 Write Tests

**You MUST write or update tests for new code.** This is not optional.

- Every new function/feature needs at least one test
- Edge cases identified in the plan need tests
- Update existing tests if behavior changed
- Follow the test patterns from the plan's "Patterns to Mirror" section

### 4.3 Run Tests

Run the test command from the plan's Validation section.

**If tests fail:**

1. Read failure output
2. Determine: bug in implementation or bug in test?
3. Fix the actual issue (usually implementation)
4. Re-run tests
5. Repeat until green

### 4.4 Build Check

Run the build command from the plan's Validation section.

**Must complete without errors.**

### 4.5 Integration Testing (if applicable)

If the plan involves API/server changes, run any integration test commands from the plan.

### 4.6 Edge Case Testing

Run any edge case tests specified in the plan's Testing Strategy section.

---

## Phase 5: REPORT - Create Implementation Report

### 5.1 Create Report

**Output path**: `.agents/reports/{plan-name}-report.md`

```bash
mkdir -p .agents/reports
```

```markdown
# Implementation Report

**Plan**: `{plan-path}`
**Branch**: `{branch-name}`
**Date**: {YYYY-MM-DD}
**Status**: {COMPLETE | PARTIAL}

## Summary

{Brief description of what was implemented}

## Assessment vs Reality

| Metric | Plan Predicted | Actual | Notes |
|--------|----------------|--------|-------|
| Complexity | {from plan} | {actual} | {why it matched or differed} |
| Tasks | {count from plan} | {actual count} | {any additions/removals} |

## Tasks Completed

| # | Task | File | Status |
|---|------|------|--------|
| 1 | {description} | `src/x.ts` | ✅ |
| 2 | {description} | `src/y.ts` | ✅ |

## Validation Results

| Check | Result | Details |
|-------|--------|---------|
| Type check | ✅ | No errors |
| Lint | ✅ | 0 errors |
| Tests | ✅ | {N} passed, 0 failed |
| Build | ✅ | Compiled successfully |

## Files Changed

| File | Action | Lines |
|------|--------|-------|
| `src/x.ts` | CREATE | +{N} |
| `src/y.ts` | UPDATE | +{N}/-{M} |

## Deviations from Plan

{List any deviations with rationale, or "None"}

## Issues Encountered

{List any issues and how they were resolved, or "None"}

## Tests Written

| Test File | Test Cases |
|-----------|------------|
| `src/x.test.ts` | {list of test functions} |
```

### 5.2 Update Source PRD (if applicable)

If the plan was generated from a PRD (check for `Source PRD:` reference in the plan):

1. Read the PRD file
2. Find the relevant phase row in the Implementation Phases table
3. Update the phase Status from `in-progress` to `complete`
4. Save the PRD

### 5.3 Archive Plan

```bash
mkdir -p .agents/plans/completed
mv {plan-path} .agents/plans/completed/
```

---

## Phase 6: OUTPUT - Report to User

```markdown
## Implementation Complete

**Plan**: `{plan-path}`
**Branch**: `{branch-name}`
**Status**: ✅ Complete

### Validation

| Check | Result |
|-------|--------|
| Type check | ✅ |
| Lint | ✅ |
| Tests | ✅ ({N} passed) |
| Build | ✅ |

### Files Changed

- {N} files created
- {M} files updated
- {K} tests written

### Deviations

{Summary or "Implementation matched the plan."}

### Artifacts

- Report: `.agents/reports/{name}-report.md`
- Plan archived: `.agents/plans/completed/`

{If from PRD:}
### PRD Progress

**PRD**: `{prd-file-path}`
**Phase Completed**: #{number} - {phase name}

| # | Phase | Status |
|---|-------|--------|
{Updated phases table showing progress}

**Next Phase**: {next pending phase, or "All phases complete!"}

To continue: `/plan {prd-path}`

### Next Steps

1. Review the report
2. Create PR: `gh pr create`
3. Merge when approved
{If more PRD phases: "4. Continue with next phase: `/plan {prd-path}`"}
```

---

## Handling Failures

| Failure | Action |
|---------|--------|
| Type check fails | Read error, fix type issue, re-run |
| Tests fail | Determine root cause (impl vs test), fix, re-run |
| Lint fails | Run lint fix command, then manual fixes, re-run |
| Build fails | Usually type or import issue — check output, fix, re-run |
| Integration test fails | Check server started, verify endpoint exists, fix and retry |

---

## Success Criteria

- **TASKS_COMPLETE**: All plan tasks executed
- **TYPES_PASS**: Type-check exits 0
- **LINT_PASS**: Lint exits 0
- **TESTS_PASS**: All tests green
- **BUILD_PASS**: Build succeeds
- **REPORT_CREATED**: Implementation report exists
- **PLAN_ARCHIVED**: Plan moved to completed folder
- **PRD_UPDATED**: Source PRD phase marked complete (if applicable)
