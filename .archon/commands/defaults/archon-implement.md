---
description: 엄격한 validation loop와 함께 implementation plan 실행
argument-hint: <path/to/plan.md or GitHub issue URL>
---

# Plan 구현

**Plan**: $ARGUMENTS

---

## 미션

Execute the plan end-to-end with rigorous self-validation. You are autonomous.

**Core Philosophy**: Validation loops catch mistakes early. Run checks after every change. Fix issues immediately. The goal is a working implementation, not just code that exists.

**Golden Rule**: If a validation fails, fix it before moving on. Never accumulate broken state.

---

## 0단계: 감지 — project 환경

### 0.1 package manager 식별

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

### 0.2 validation script 식별

Check `package.json` (or equivalent) for available scripts:
- Type checking: `type-check`, `typecheck`, `tsc`
- Linting: `lint`, `lint:fix`
- Testing: `test`, `test:unit`, `test:integration`
- Building: `build`, `compile`

**Use the plan's "Validation Commands" section** - it should specify exact commands for this project.

---

## 1단계: 로드 — plan 읽기

### 1.1 plan file 로드

```bash
cat $ARGUMENTS
```

If `$ARGUMENTS` is a GitHub issue URL or number (e.g., `#123`), fetch the issue body which contains the plan.

### 1.2 핵심 section 추출

Locate and understand:

- **Summary** - What we're building
- **Patterns to Mirror** - Code to copy from
- **Files to Change** - CREATE/UPDATE list
- **Step-by-Step Tasks** - Implementation order
- **Validation Commands** - How to verify (USE THESE, not hardcoded commands)
- **Acceptance Criteria** - Definition of done

### 1.3 plan 존재 확인

**If plan not found:**

```
오류: $ARGUMENTS에서 plan을 찾지 못했습니다

유효한 plan path 또는 plan이 포함된 GitHub issue를 제공하세요.
```

**PHASE_1_CHECKPOINT:**

- [ ] Plan file loaded
- [ ] Key sections identified
- [ ] Tasks list extracted

---

## 2단계: 준비 — git 상태

### 2.1 확인 현재 상태

```bash
# What branch are we on?
git branch --show-current

# Are we in a worktree?
git rev-parse --show-toplevel
git worktree list

# Is working directory clean?
git status --porcelain
```

### 2.2 branch 결정

```text
┌─ IN WORKTREE?
│  └─ YES → Use current branch AS-IS. Do NOT switch branches. Do NOT create
│           new branches. The isolation system has already set up the correct
│           branch; any deviation operates on the wrong code.
│           Log: "Using worktree at {path} on branch {branch}"
│
├─ ON $BASE_BRANCH? (main, master, or configured base branch)
│  └─ Q: Working directory clean?
│     ├─ YES → Create branch: git checkout -b feature/{plan-slug}
│     │        (only applies outside a worktree — e.g., manual CLI usage)
│     └─ NO  → STOP: "Stash or commit changes first"
│
├─ ON OTHER BRANCH?
│  └─ Use it AS-IS. Do NOT switch to another branch (e.g., one shown by
│     `git branch` but not currently checked out).
│     Log: "Using existing branch {name}"
│
└─ DIRTY STATE?
   └─ STOP: "Stash or commit changes first"
```

### 2.3 remote와 sync

```bash
git fetch origin
git pull --rebase origin $BASE_BRANCH 2>/dev/null || true
```

**PHASE_2_CHECKPOINT:**

- [ ] On correct branch (not $BASE_BRANCH with uncommitted work)
- [ ] Working directory ready
- [ ] Up to date with remote

---

## 3단계: 실행 — task 구현

**For each task in the plan's Step-by-Step Tasks section:**

### 3.1 context 읽기

1. Read the **MIRROR** file reference from the task
2. Understand the pattern to follow
3. Read any **IMPORTS** specified

### 3.2 구현

1. Make the change exactly as specified
2. Follow the pattern from MIRROR reference
3. Handle any **GOTCHA** warnings

### 3.3 즉시 검증

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

### 3.4 progress 추적

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

## 4단계: 검증 — 전체 검증

### 4.1 static analysis

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

### 4.2 unit test

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

### 4.3 build 확인

**Run the build command from the plan's Validation Commands section.**

Common patterns:
- JS/TS: `{runner} run build`
- Python: N/A (interpreted) or `uv build`
- Rust: `cargo build --release`
- Go: `go build ./...`

**Must complete without errors.**

### 4.4 integration test(해당 시)

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

### 4.5 edge case test

Run any edge case tests specified in the plan.

**PHASE_4_CHECKPOINT:**

- [ ] Type-check passes (command from plan)
- [ ] Lint passes (0 errors)
- [ ] Tests pass (all green)
- [ ] Build succeeds
- [ ] Integration tests pass (if applicable)

---

## 5단계: 보고 — implementation report 작성

### 5.1 report directory 생성

```bash
mkdir -p $ARTIFACTS_DIR/../reports
```

### 5.2 report 생성

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

### 5.3 plan archive

```bash
mkdir -p $ARTIFACTS_DIR/../plans/completed
cp $ARGUMENTS $ARTIFACTS_DIR/../plans/completed/ 2>/dev/null || true
```

**PHASE_5_CHECKPOINT:**

- [ ] Report created at `$ARTIFACTS_DIR/../reports/`
- [ ] Plan copied to completed folder (if local file)

---

## 6단계: 출력 — 사용자에게 보고

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

## 실패 처리

### type check Fails

1. Read error message carefully
2. Fix the type issue
3. Re-run the type-check command
4. Don't proceed until passing

### Test 실패

1. Identify which test failed
2. Determine: implementation bug or test bug?
3. Fix the root cause (usually implementation)
4. Re-run tests
5. Repeat until green

### Lint 실패

1. Run the lint fix command for auto-fixable issues
2. Manually fix remaining issues
3. Re-run lint
4. Proceed when clean

### Build 실패

1. Usually a type or import issue
2. Check the error output
3. Fix and re-run

### Integration test 실패

1. Check if server started correctly
2. Verify endpoint exists
3. Check request format
4. Fix implementation and retry

---

## 성공 기준

- **TASKS_COMPLETE**: All plan tasks executed
- **TYPES_PASS**: Type-check command exits 0
- **LINT_PASS**: Lint command exits 0 (warnings OK)
- **TESTS_PASS**: Test command all green
- **BUILD_PASS**: Build command succeeds
- **REPORT_CREATED**: Implementation report exists
