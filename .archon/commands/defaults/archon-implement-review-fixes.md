---
description: review에서 나온 CRITICAL/HIGH 수정사항을 구현하고 test 추가 및 남은 issue 보고
argument-hint: (none - reads from consolidated review artifact)
---

# 리뷰 수정사항 구현

---

## 중요: 출력 방식

**Your output will be posted as a GitHub comment.** Keep your working output minimal:
- Do NOT narrate each step ("Now I'll read the file...", "Let me check...")
- Do NOT output verbose progress updates
- Only output the final structured report at the end
- Use the TodoWrite tool to track progress silently

---

## 미션

Read the consolidated review artifact and implement all CRITICAL and HIGH priority fixes. Add tests for fixed code if missing. Commit and push changes. Report what was fixed, what wasn't (and why), and suggest follow-up issues for remaining items.

**Output artifact**: `$ARTIFACTS_DIR/review/fix-report.md`
**Git action**: Commit AND push fixes to the PR branch
**GitHub action**: Post fix report comment

---

## 1단계: 로드 — 수정 목록 가져오기

### 1.1 registry에서 PR 번호 가져오기

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)

# Get the PR's head branch name
HEAD_BRANCH=$(gh pr view $PR_NUMBER --json headRefName --jq '.headRefName')
echo "PR: $PR_NUMBER, Branch: $HEAD_BRANCH"
```

### 1.2 checkout the PR Branch

**CRITICAL: Work on the PR's actual branch, not a new branch.**

```bash
# Fetch and checkout the PR's branch
git fetch origin $HEAD_BRANCH
git checkout $HEAD_BRANCH
git pull origin $HEAD_BRANCH
```

### 1.3 consolidated review 읽기

```bash
cat $ARTIFACTS_DIR/review/consolidated-review.md
```

Extract:
- All CRITICAL issues with fixes
- All HIGH issues with fixes
- MEDIUM issues (for reporting)
- LOW issues (for reporting)

### 1.4 세부 개별 artifact 읽기

If consolidated doesn't have full fix code, read original artifacts:

```bash
cat $ARTIFACTS_DIR/review/code-review-findings.md
cat $ARTIFACTS_DIR/review/error-handling-findings.md
cat $ARTIFACTS_DIR/review/test-coverage-findings.md
cat $ARTIFACTS_DIR/review/docs-impact-findings.md
```

### 1.5 현재 git 상태 확인

```bash
git status --porcelain
git branch --show-current
```

Verify you are on the correct PR branch (should be `$HEAD_BRANCH`).

**PHASE_1_CHECKPOINT:**
- [ ] PR number identified
- [ ] On the correct PR branch (NOT base branch, NOT a new branch)
- [ ] Consolidated review loaded
- [ ] CRITICAL/HIGH issues extracted

---

## 2단계: 구현 — 수정 적용

### 2.1 각 CRITICAL issue 처리

1. **Read the file**
2. **Apply the recommended fix**
3. **Verify fix compiles**: `bun run type-check`
4. **Track**: Note what was changed

### 2.2 각 HIGH issue 처리

Same process as CRITICAL.

### 2.3 test coverage gap 처리

If test-coverage-agent identified missing tests for fixed code:

1. **Create/update test file**
2. **Add tests for the fix**
3. **Verify tests pass**: `bun test {file}`

### 2.4 수정 불가 issue 처리

If a fix cannot be applied:
- **Conflict**: Code has changed since review
- **Complex**: Requires architectural changes
- **Unclear**: Recommendation is ambiguous
- **Risk**: Fix might break other things

Document the reason clearly.

**PHASE_2_CHECKPOINT:**
- [ ] All CRITICAL fixes attempted
- [ ] All HIGH fixes attempted
- [ ] Tests added for fixes
- [ ] Unfixable issues documented

---

## 3단계: 검증 — 수정 검증

### 3.1 type check

```bash
bun run type-check
```

Must pass. If not, fix type errors.

### 3.2 lint

```bash
bun run lint
```

Fix any lint errors introduced.

### 3.3 test 실행

```bash
bun test
```

All tests must pass. If new tests fail, fix them.

### 3.4 build 확인

```bash
bun run build
```

Must succeed.

**PHASE_3_CHECKPOINT:**
- [ ] Type check passes
- [ ] Lint passes
- [ ] All tests pass
- [ ] Build succeeds

---

## 4단계: 커밋 및 Push — 변경 저장 및 push

### 4.1 stage 변경사항

```bash
git add -A
git status
```

### 4.2 commit

```bash
git commit -m "fix: Address review findings (CRITICAL/HIGH)

Fixes applied:
- {brief list of fixes}

Tests added:
- {list of new tests if any}

Skipped (see review artifacts):
- {brief list of unfixable if any}

Review artifacts: $ARTIFACTS_DIR/review/"
```

### 4.3 PR branch에 push

**Push the fixes to the PR branch so they appear in the PR.**

```bash
git push origin $HEAD_BRANCH
```

If push fails due to divergence:
```bash
git pull --rebase origin $HEAD_BRANCH
git push origin $HEAD_BRANCH
```

**PHASE_4_CHECKPOINT:**
- [ ] Changes committed
- [ ] Changes pushed to PR branch
- [ ] PR now shows the fixes

---

## 5단계: 생성 — fix report 작성

Write to `$ARTIFACTS_DIR/review/fix-report.md`:

```markdown
# Fix Report: PR #{number}

**Date**: {ISO timestamp}
**Status**: {COMPLETE | PARTIAL}
**Branch**: {HEAD_BRANCH}

---

## Summary

{2-3 sentence overview of fixes applied}

---

## Fixes Applied

### CRITICAL Fixes ({n}/{total})

| Issue | Location | Status | Details |
|-------|----------|--------|---------|
| {title} | `file:line` | ✅ FIXED | {what was done} |
| {title} | `file:line` | ❌ SKIPPED | {why} |

---

### HIGH Fixes ({n}/{total})

| Issue | Location | Status | Details |
|-------|----------|--------|---------|
| {title} | `file:line` | ✅ FIXED | {what was done} |

---

## Tests Added

| Test File | Test Cases | For Issue |
|-----------|------------|-----------|
| `src/x.test.ts` | `it('should...')` | {issue title} |

---

## Not Fixed (Requires Manual Action)

### {Issue Title}

**Severity**: {CRITICAL/HIGH}
**Location**: `{file}:{line}`
**Reason Not Fixed**: {reason}

**Suggested Action**:
{What the user should do}

---

## MEDIUM Issues (User Decision Required)

| Issue | Location | Options |
|-------|----------|---------|
| {title} | `file:line` | Fix now / Create issue / Skip |

---

## LOW Issues (For Consideration)

| Issue | Location | Suggestion |
|-------|----------|------------|
| {title} | `file:line` | {brief suggestion} |

---

## Suggested Follow-up Issues

| Issue Title | Priority | Related Finding |
|-------------|----------|-----------------|
| "{title}" | P{1/2/3} | {which finding} |

---

## Validation Results

| Check | Status |
|-------|--------|
| Type check | ✅ |
| Lint | ✅ |
| Tests | ✅ ({n} passed) |
| Build | ✅ |

---

## Git Status

- **Branch**: {HEAD_BRANCH}
- **Commit**: {commit-hash}
- **Pushed**: ✅ Yes
```

**PHASE_5_CHECKPOINT:**
- [ ] Fix report created
- [ ] All fixes documented

---

## 6단계: 게시 — GitHub comment

### 6.1 fix report 게시

```bash
gh pr comment {number} --body "$(cat <<'EOF'
# ⚡ Auto-Fix Report

**Status**: {COMPLETE | PARTIAL}
**Pushed**: ✅ Changes pushed to PR

---

## Fixes Applied

| Severity | Fixed | Skipped |
|----------|-------|---------|
| 🔴 CRITICAL | {n} | {n} |
| 🟠 HIGH | {n} | {n} |

### What Was Fixed

{For each fix:}
- ✅ **{title}** (`{file}:{line}`) - {brief description}

### Tests Added

{If any:}
- `{test-file}`: {n} new test cases

---

## ❌ Not Fixed (Manual Action Required)

{If any:}
- **{title}** (`{file}`) - {reason}

---

## 🟡 MEDIUM Issues (Your Decision)

{If any:}
| Issue | Options |
|-------|---------|
| {title} | Fix now / Create issue / Skip |

---

## 📋 Suggested Follow-up Issues

{If any items should become issues:}
1. **{Issue Title}** (P{1/2/3}) - {brief description}

---

## Validation

✅ Type check | ✅ Lint | ✅ Tests | ✅ Build

---

*Auto-fixed by Archon comprehensive-pr-review workflow*
*Fixes pushed to branch `{HEAD_BRANCH}`*
EOF
)"
```

**PHASE_6_CHECKPOINT:**
- [ ] GitHub comment posted

---

## 7단계: 출력 — 최종 보고

Output only this summary (keep it brief):

```markdown
## ✅ Fix Implementation Complete

**PR**: #{number}
**Branch**: {HEAD_BRANCH}
**Status**: {COMPLETE | PARTIAL}

| Severity | Fixed |
|----------|-------|
| CRITICAL | {n}/{total} |
| HIGH | {n}/{total} |

**Validation**: ✅ All checks pass
**Pushed**: ✅ Changes pushed to PR

See fix report: `$ARTIFACTS_DIR/review/fix-report.md`
```

---

## 오류 처리

### 수정 후 type check 실패

1. Review the error
2. Adjust the fix
3. Re-run type check
4. If still failing, mark as "Not Fixed" with reason

### Test 실패

1. Check if fix caused the failure
2. Either: fix the implementation, or fix the test
3. If unclear, mark as "Not Fixed" for manual review

### Push 실패

1. Pull with rebase: `git pull --rebase origin $HEAD_BRANCH`
2. Resolve any conflicts
3. Push again

---

## 성공 기준

- **ON_CORRECT_BRANCH**: Working on PR's head branch, not base branch or new branch
- **CRITICAL_ADDRESSED**: All CRITICAL issues attempted
- **HIGH_ADDRESSED**: All HIGH issues attempted
- **VALIDATION_PASSED**: Type check, lint, tests, build all pass
- **COMMITTED_AND_PUSHED**: Changes committed AND pushed to PR branch
- **REPORTED**: Fix report artifact and GitHub comment created
