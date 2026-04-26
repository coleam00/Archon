---
description: investigation artifact 기반 수정 구현 — 코드 변경, 검증, commit 수행(PR 없음)
argument-hint: <issue-number|artifact-path>
---

# Issue 수정

**Input**: $ARGUMENTS

---

## 미션

Execute the implementation plan from `/investigate-issue`:

1. Load and validate the artifact
2. Ensure git state is correct
3. Discover and install dependencies in the worktree
4. Implement the changes exactly as specified
5. Run validation
6. Commit changes
7. Write implementation report

**Golden Rule**: Follow the artifact. If something seems wrong, validate it first - don't silently deviate.

---

## 1단계: 로드 — artifact 가져오기

### 1.1 investigation artifact 찾기

Look for the investigation artifact from the previous step:

```bash
# Check for artifact in workflow runs directory
ls $ARTIFACTS_DIR/investigation.md
```

**If input is a specific path**, use that path directly.

### 1.2 artifact 로드 및 파싱

```bash
cat {artifact-path}
```

**Extract from artifact:**
- Issue number and title
- Type (BUG/ENHANCEMENT/etc)
- Files to modify (with line numbers)
- Implementation steps
- Validation commands
- Test cases to add

### 1.3 artifact 존재 확인

**If artifact not found:**
```
❌ Investigation artifact not found at $ARTIFACTS_DIR/investigation.md

Run `/investigate-issue {number}` first to create the implementation plan.
```

**PHASE_1_CHECKPOINT:**
- [ ] Artifact found and loaded
- [ ] Key sections parsed (files, steps, validation)
- [ ] Issue number extracted (if applicable)

---

## 2단계: 검증 — sanity check

### 2.1 plan 정확성 확인

For each file mentioned in the artifact:
- Read the actual current code
- Compare to what artifact expects
- Check if the "current code" snippets match reality

**If significant drift detected:**
```
⚠️ Code has changed since investigation:

File: src/x.ts:45
- Artifact expected: {snippet}
- Actual code: {different snippet}

Options:
1. Re-run /investigate-issue to get fresh analysis
2. Proceed carefully with manual adjustments
```

### 2.2 접근 방식 타당성 확인

Ask yourself:
- Does the proposed fix actually address the root cause?
- Are there obvious problems with the approach?
- Has something changed that invalidates the plan?

**If plan seems wrong:**
- STOP
- Explain what's wrong
- Suggest re-investigation

**PHASE_2_CHECKPOINT:**
- [ ] Artifact matches current codebase state
- [ ] Approach still makes sense
- [ ] No blocking issues identified

---

## 3단계: GIT — CHECK - 확인 Correct 상태

### 3.1 현재 git 상태 확인

```bash
# What branch are we on?
git branch --show-current

# Are we in a worktree?
git rev-parse --show-toplevel
git worktree list

# Is working directory clean?
git status --porcelain

# Are we up to date with remote?
git fetch origin
git status
```

### 3.2 decision tree

```text
┌─ IN WORKTREE?
│  └─ YES → Use current branch AS-IS. Do NOT switch branches. Do NOT create
│           new branches. The isolation system has already set up the correct
│           branch; any deviation operates on the wrong code.
│           Log: "Using worktree at {path} on branch {branch}"
│
├─ ON $BASE_BRANCH? (main, master, or configured base branch)
│  └─ Q: Working directory clean?
│     ├─ YES → Create branch: fix/issue-{number}-{slug}
│     │        git checkout -b fix/issue-{number}-{slug}
│     │        (only applies outside a worktree — e.g., manual CLI usage)
│     └─ NO  → STOP: "Uncommitted changes on $BASE_BRANCH.
│              Please commit or stash before proceeding."
│
├─ ON OTHER BRANCH?
│  └─ Use it AS-IS (assume it was set up for this work).
│     Do NOT switch to another branch (e.g., one shown by `git branch` but
│     not currently checked out).
│     If branch name doesn't contain issue number:
│       Warn: "Branch '{name}' may not be for issue #{number}"
│
└─ DIRTY STATE?
   └─ STOP: "Uncommitted changes. Please commit or stash first."
```

### 3.3 최신 상태 확인

```bash
# If branch tracks remote
git pull --rebase origin $BASE_BRANCH 2>/dev/null || git pull origin $BASE_BRANCH
```

**PHASE_3_CHECKPOINT:**
- [ ] Git state is clean and correct
- [ ] On appropriate branch (created or existing)
- [ ] Up to date with base branch

---

## 4단계: 의존성 — 탐색 및 설치

### 4.1 install command 감지

Inspect the worktree for lock/config files and choose the install command:

- `package.json` + `bun.lock` → `bun install`
- `package.json` + `package-lock.json` → `npm install`
- `package.json` + `yarn.lock` → `yarn install`
- `package.json` + `pnpm-lock.yaml` → `pnpm install`
- `requirements.txt` → `pip install -r requirements.txt`
- `pyproject.toml` + `poetry.lock` → `poetry install`
- `Cargo.toml` → `cargo build`
- `go.mod` → `go mod download`

### 4.2 install 실행

Run the chosen install command from the worktree root before any validation or tests.

### 4.3 실패 처리

If install fails, STOP and report the error. Do not proceed to validation with missing dependencies.

**PHASE_4_CHECKPOINT:**
- [ ] Install command discovered
- [ ] Dependencies installed successfully

---

## 5단계: 구현 — 변경 수행

### 5.1 각 step 실행

For each step in the artifact's Implementation Plan:

1. **Read the target file** - understand current state
2. **Make the change** - exactly as specified
3. **Verify types compile** - `bun run type-check`

### 5.2 implementation 규칙

**DO:**
- Follow artifact steps in order
- Match existing code style exactly
- Copy patterns from "Patterns to Follow" section
- Add tests as specified

**DON'T:**
- Refactor unrelated code
- Add "improvements" not in the plan
- Change formatting of untouched lines
- Deviate from the artifact without noting it

### 5.3 각 file type 처리

**For UPDATE files:**
- Read current content
- Find the exact lines mentioned
- Make the specified change
- Preserve surrounding code

**For CREATE files:**
- Use patterns from artifact
- Follow existing file structure conventions
- Include all specified content

**For test files:**
- Add test cases as specified
- Follow existing test patterns
- Ensure tests actually test the fix

### 5.4 deviation 추적

If you must deviate from the artifact:
- Note what changed and why
- Include in implementation report

**PHASE_5_CHECKPOINT:**
- [ ] All steps from artifact executed
- [ ] Types compile after each change
- [ ] Tests added as specified
- [ ] Any deviations documented

---

## 6단계: 확인 — validation 실행

### 6.1 artifact validation command 실행

Execute each command from the artifact's Validation section:

```bash
bun run type-check
bun test {pattern-from-artifact}
bun run lint
```

### 6.2 결과 확인

**All must pass before proceeding.**

If failures:
1. Analyze what's wrong
2. Fix the issue
3. Re-run validation
4. Note any fixes in implementation report

### 6.3 수동 검증(지정된 경우)

Execute any manual verification steps from the artifact.

**PHASE_6_CHECKPOINT:**
- [ ] Type check passes
- [ ] Tests pass
- [ ] Lint passes
- [ ] Manual verification complete (if applicable)

---

## 7단계: 커밋 — 변경 저장

### 7.1 stage 변경사항

```bash
git add -A
git status  # Review what's being committed
```

### 7.2 commit message 작성

**Format:**
```
Fix: {brief description} (#{issue-number})

{Problem statement from artifact - 1-2 sentences}

Changes:
- {Change 1 from artifact}
- {Change 2 from artifact}
- Added test for {case}

Fixes #{issue-number}
```

**Commit:**
```bash
git commit -m "$(cat <<'EOF'
Fix: {title} (#{number})

{problem statement}

Changes:
- {change 1}
- {change 2}

Fixes #{number}
EOF
)"
```

**PHASE_7_CHECKPOINT:**
- [ ] All changes committed
- [ ] Commit message references issue

---

## 8단계: 작성 — implementation report

### 8.1 implementation artifact 작성

Write to `$ARTIFACTS_DIR/implementation.md`:

```markdown
# Implementation Report

**Issue**: #{number}
**Generated**: {YYYY-MM-DD HH:MM}
**Workflow ID**: $WORKFLOW_ID

---

## Tasks Completed

| # | Task | File | Status |
|---|------|------|--------|
| 1 | {task} | `src/x.ts` | ✅ |
| 2 | {task} | `src/x.test.ts` | ✅ |

---

## Files Changed

| File | Action | Lines |
|------|--------|-------|
| `src/x.ts` | UPDATE | +{N}/-{M} |
| `src/x.test.ts` | CREATE | +{N} |

---

## Deviations from Investigation

{If none: "Implementation matched the investigation exactly."}

{If any:}
### Deviation 1: {title}

**Expected**: {from investigation}
**Actual**: {what was done}
**Reason**: {why}

---

## Validation Results

| Check | Result |
|-------|--------|
| Type check | ✅ |
| Tests | ✅ ({N} passed) |
| Lint | ✅ |
```

**PHASE_8_CHECKPOINT:**
- [ ] Implementation artifact written

---

## 9단계: 출력 — 사용자에게 보고

Skip archiving - artifacts remain in place for review workflow to access.

---

```markdown
## Implementation Complete

**Issue**: #{number} - {title}
**Branch**: `{branch-name}`

### Changes Made

| File | Change |
|------|--------|
| `src/x.ts` | {description} |
| `src/x.test.ts` | Added test |

### Validation

| Check | Result |
|-------|--------|
| Type check | ✅ Pass |
| Tests | ✅ Pass |
| Lint | ✅ Pass |

### Artifacts

- 📄 Investigation: `$ARTIFACTS_DIR/investigation.md`
- 📄 Implementation: `$ARTIFACTS_DIR/implementation.md`

### Next Step

Proceeding to PR creation...
```

---

## Edge Case 처리

### Artifact가 오래됨
- Warn user about drift
- Suggest re-running `/investigate-issue`
- Can proceed with caution if changes are minor

### 구현 후 test 실패
- Debug the failure
- Fix the code (not the test, unless test is wrong)
- Re-run validation
- Note the additional fix in implementation report

### Rebase 중 merge conflict
- Resolve conflicts
- Re-run full validation
- Note conflict resolution in implementation report

### 이미 변경사항이 있는 branch에 있음
- Use the existing branch
- Warn if branch name doesn't match issue
- Don't create a new branch

### Worktree 안에 있음
- Use it as-is
- Assume it was created for this purpose
- Log that worktree is being used

---

## 성공 기준

- **PLAN_EXECUTED**: All investigation steps completed
- **VALIDATION_PASSED**: All checks green
- **CHANGES_COMMITTED**: All changes committed to branch
- **IMPLEMENTATION_ARTIFACT**: Written to $ARTIFACTS_DIR/
- **READY_FOR_PR**: Workflow continues to PR creation
