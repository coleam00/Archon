---
description: Execute an implementation plan with rigorous validation loops
argument-hint: <path/to/plan.md or GitHub issue URL>
---

# Implement Plan

**Plan**: $ARGUMENTS

---

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

**Store the detected runner** - use it for all subsequent commands.

### 0.2 Identify Validation Scripts

Check `package.json` (or equivalent) for available scripts:
- Type checking: `type-check`, `typecheck`, `tsc`
- Linting: `lint`, `lint:fix`
- Testing: `test`, `test:unit`, `test:integration`
- Building: `build`, `compile`

**Use the plan's "Validation Commands" section** - it should specify exact commands for this project.

---

## Phase 1: LOAD - Read the Plan

### 1.1 Load Plan File

```bash
cat $ARGUMENTS
```

If `$ARGUMENTS` is a GitHub issue URL or number (e.g., `#123`), fetch the issue body which contains the plan.

### 1.2 Extract Key Sections

Locate and understand:

- **Summary** - What we're building
- **Patterns to Mirror** - Code to copy from
- **Files to Change** - CREATE/UPDATE list
- **Step-by-Step Tasks** - Implementation order
- **Validation Commands** - How to verify (USE THESE, not hardcoded commands)
- **Acceptance Criteria** - Definition of done

### 1.3 Validate Plan Exists

**If plan not found:**

```
Error: Plan not found at $ARGUMENTS

Provide a valid plan path or GitHub issue containing the plan.
```

**PHASE_1_CHECKPOINT:**

- [ ] Plan file loaded
- [ ] Key sections identified
- [ ] Tasks list extracted

---

## Phase 2: PREPARE - Git State

### 2.1 Check Current State

```bash
git branch --show-current
git status --porcelain
git worktree list
```

### 2.2 Branch Decision

| Current State     | Action                                               |
| ----------------- | ---------------------------------------------------- |
| In worktree       | Use it (log: "Using worktree")                       |
| On base branch, clean    | Create branch: `git checkout -b feature/{plan-slug}` |
| On base branch, dirty    | STOP: "Stash or commit changes first"                |
| On feature branch | Use it (log: "Using existing branch")                |

### 2.3 Sync with Remote

```bash
git fetch origin
git pull --rebase origin $BASE_BRANCH 2>/dev/null || true
```

**PHASE_2_CHECKPOINT:**

- [ ] On correct branch (not base branch with uncommitted work)
- [ ] Working directory ready
- [ ] Up to date with remote

---

## Phase 3: EXECUTE - Implement Tasks

**For each task in the plan's Step-by-Step Tasks section:**

### 3.1 Read Context

1. Read the **MIRROR** file reference from the task
2. Understand the pattern to follow
3. Read any **IMPORTS** specified

### 3.2 Implement

1. Make the change exactly as specified
2. Follow the pattern from MIRROR reference
3. Handle any **GOTCHA** warnings

### 3.3 Validate Immediately

**After EVERY file change, run the type-check command from the plan's Validation Commands section.**

Common patterns:
- `{runner} run type-check` (JS/TS projects)
- `mypy .` (Python)
- `cargo check` (Rust)
- `go build ./...` (Go)

**If types fail:**

1. Read the error
2. Fix the issue
3. Re-run type-check
4. Only proceed when passing

### 3.4 Track Progress

Log each task as you complete it:

```
Task 1: CREATE src/features/x/models.ts ✅
Task 2: CREATE src/features/x/service.ts ✅
Task 3: UPDATE src/routes/index.ts ✅
```

**Deviation Handling:**
If you must deviate from the plan:

- Note WHAT changed
- Note WHY it changed
- Continue with the deviation documented

**PHASE_3_CHECKPOINT:**

- [ ] All tasks executed in order
- [ ] Each task passed type-check
- [ ] Deviations documented

---

## Phase 4: VALIDATE - Full Verification

### 4.1 Static Analysis

**Run the type-check and lint commands from the plan's Validation Commands section.**

Common patterns:
- JS/TS: `{runner} run type-check && {runner} run lint`
- Python: `ruff check . && mypy .`
- Rust: `cargo check && cargo clippy`
- Go: `go vet ./...`

**Must pass with zero errors.**

If lint errors:

1. Run the lint fix command (e.g., `{runner} run lint:fix`, `ruff check --fix .`)
2. Re-check
3. Manual fix remaining issues

### 4.2 Unit Tests

**You MUST write or update tests for new code.** This is not optional.

**Test requirements:**

1. Every new function/feature needs at least one test
2. Edge cases identified in the plan need tests
3. Update existing tests if behavior changed

**Write tests**, then run the test command from the plan.

Common patterns:
- JS/TS: `{runner} test` or `{runner} run test`
- Python: `pytest` or `uv run pytest`
- Rust: `cargo test`
- Go: `go test ./...`

**If tests fail:**

1. Read failure output
2. Determine: bug in implementation or bug in test?
3. Fix the actual issue
4. Re-run tests
5. Repeat until green

### 4.3 Build Check

**Run the build command from the plan's Validation Commands section.**

Common patterns:
- JS/TS: `{runner} run build`
- Python: N/A (interpreted) or `uv build`
- Rust: `cargo build --release`
- Go: `go build ./...`

**Must complete without errors.**

### 4.4 Integration Testing (if applicable)

**If the plan involves API/server changes, use the integration test commands from the plan.**

Example pattern:
```bash
# Start server in background (command varies by project)
{runner} run dev &
SERVER_PID=$!
sleep 3

# Test endpoints (adjust URL/port per project config)
curl -s http://localhost:{port}/health | jq

# Stop server
kill $SERVER_PID
```

### 4.5 Edge Case Testing

Run any edge case tests specified in the plan.

**PHASE_4_CHECKPOINT:**

- [ ] Type-check passes (command from plan)
- [ ] Lint passes (0 errors)
- [ ] Tests pass (all green)
- [ ] Build succeeds
- [ ] Integration tests pass (if applicable)

---

## Phase 5: REPORT - Create Implementation Report

### 5.1 Create Report Directory

```bash
mkdir -p $ARTIFACTS_DIR/../reports
```

### 5.2 Generate Report

**Path**: `$ARTIFACTS_DIR/../reports/{plan-name}-report.md`

```markdown
# Implementation Report

**Plan**: `$ARGUMENTS`
**Source Issue**: #{number} (if applicable)
**Branch**: `{branch-name}`
**Date**: {YYYY-MM-DD}
**Status**: {COMPLETE | PARTIAL}

---

## Summary

{Brief description of what was implemented}

---

## Assessment vs Reality

Compare the original plan's assessment with what actually happened:

| Metric     | Predicted   | Actual   | Reasoning                                                                      |
| ---------- | ----------- | -------- | ------------------------------------------------------------------------------ |
| Complexity | {from plan} | {actual} | {Why it matched or differed - e.g., "discovered additional integration point"} |
| Confidence | {from plan} | {actual} | {e.g., "root cause was correct" or "had to pivot because X"}                   |

**If implementation deviated from the plan, explain why:**

- {What changed and why - based on what you discovered during implementation}

---

## Tasks Completed

| #   | Task               | File       | Status |
| --- | ------------------ | ---------- | ------ |
| 1   | {task description} | `src/x.ts` | ✅     |
| 2   | {task description} | `src/y.ts` | ✅     |

---

## Validation Results

| Check       | Result | Details               |
| ----------- | ------ | --------------------- |
| Type check  | ✅     | No errors             |
| Lint        | ✅     | 0 errors, N warnings  |
| Unit tests  | ✅     | X passed, 0 failed    |
| Build       | ✅     | Compiled successfully |
| Integration | ✅/⏭️  | {result or "N/A"}     |

---

## Files Changed

| File       | Action | Lines     |
| ---------- | ------ | --------- |
| `src/x.ts` | CREATE | +{N}      |
| `src/y.ts` | UPDATE | +{N}/-{M} |

---

## Deviations from Plan

{List any deviations with rationale, or "None"}

---

## Issues Encountered

{List any issues and how they were resolved, or "None"}

---

## Tests Written

| Test File       | Test Cases               |
| --------------- | ------------------------ |
| `src/x.test.ts` | {list of test functions} |

---

## Next Steps

- [ ] Review implementation
- [ ] Create PR (next step in workflow)
- [ ] Merge when approved
```

### 5.3 Archive Plan

```bash
mkdir -p $ARTIFACTS_DIR/../plans/completed
cp $ARGUMENTS $ARTIFACTS_DIR/../plans/completed/ 2>/dev/null || true
```

**PHASE_5_CHECKPOINT:**

- [ ] Report created at `$ARTIFACTS_DIR/../reports/`
- [ ] Plan copied to completed folder (if local file)

---

## Phase 6: OUTPUT - Report to User

```markdown
## Implementation Complete

**Plan**: `$ARGUMENTS`
**Source Issue**: #{number} (if applicable)
**Branch**: `{branch-name}`
**Status**: ✅ Complete

### Validation Summary

| Check      | Result          |
| ---------- | --------------- |
| Type check | ✅              |
| Lint       | ✅              |
| Tests      | ✅ ({N} passed) |
| Build      | ✅              |

### Files Changed

- {N} files created
- {M} files updated
- {K} tests written

### Deviations

{If none: "Implementation matched the plan."}
{If any: Brief summary of what changed and why}

### Artifacts

- Report: `$ARTIFACTS_DIR/../reports/{name}-report.md`

### Next Steps

1. Review the report (especially if deviations noted)
2. Create PR (next workflow step)
3. Merge when approved
```

---

## Handling Failures

### Type Check Fails

1. Read error message carefully
2. Fix the type issue
3. Re-run the type-check command
4. Don't proceed until passing

### Tests Fail

1. Identify which test failed
2. Determine: implementation bug or test bug?
3. Fix the root cause (usually implementation)
4. Re-run tests
5. Repeat until green

### Lint Fails

1. Run the lint fix command for auto-fixable issues
2. Manually fix remaining issues
3. Re-run lint
4. Proceed when clean

### Build Fails

1. Usually a type or import issue
2. Check the error output
3. Fix and re-run

### Integration Test Fails

1. Check if server started correctly
2. Verify endpoint exists
3. Check request format
4. Fix implementation and retry

---

## Success Criteria

- **TASKS_COMPLETE**: All plan tasks executed
- **TYPES_PASS**: Type-check command exits 0
- **LINT_PASS**: Lint command exits 0 (warnings OK)
- **TESTS_PASS**: Test command all green
- **BUILD_PASS**: Build command succeeds
- **REPORT_CREATED**: Implementation report exists
