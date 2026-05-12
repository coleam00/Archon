---
description: Implement CRITICAL and HIGH fixes from review, add tests, report remaining issues
argument-hint: (none - reads from consolidated review artifact)
---

# Implement Review Fixes

---

## IMPORTANT: Output Behavior

**Your output will be posted as a GitHub comment.** Keep your working output minimal:
- Do NOT narrate each step ("Now I'll read the file...", "Let me check...")
- Do NOT output verbose progress updates
- Only output the final structured report at the end
- Use the TodoWrite tool to track progress silently

---

## Your Mission

Read the consolidated review artifact and implement all CRITICAL and HIGH priority fixes. Add tests for fixed code if missing. Commit and push changes. Report what was fixed, what wasn't (and why), and suggest follow-up issues for remaining items.

**Output artifact**: `$ARTIFACTS_DIR/review/fix-report.md`
**Git action**: Commit AND push fixes to the PR branch
**GitHub action**: Post fix report comment

---

## Phase 1: LOAD - Get Fix List

### 1.1 Get PR Number from Registry

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)

# Get the PR's head branch name
HEAD_BRANCH=$(gh pr view $PR_NUMBER --json headRefName --jq '.headRefName')
echo "PR: $PR_NUMBER, Branch: $HEAD_BRANCH"
```

### 1.2 Checkout the PR Branch

**CRITICAL: Work on the PR's actual branch, not a new branch.**

```bash
# Fetch and checkout the PR's branch
git fetch origin $HEAD_BRANCH
git checkout $HEAD_BRANCH
git pull origin $HEAD_BRANCH
```

### 1.3 Read Consolidated Review

```bash
cat $ARTIFACTS_DIR/review/consolidated-review.md
```

Extract:
- All CRITICAL issues with fixes
- All HIGH issues with fixes
- MEDIUM issues (for reporting)
- LOW issues (for reporting)

### 1.4 Read Individual Artifacts for Details

If consolidated doesn't have full fix code, read original artifacts:

```bash
cat $ARTIFACTS_DIR/review/code-review-findings.md
cat $ARTIFACTS_DIR/review/error-handling-findings.md
cat $ARTIFACTS_DIR/review/test-coverage-findings.md
cat $ARTIFACTS_DIR/review/docs-impact-findings.md
```

### 1.5 Check Current Git State

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

## Phase 2: IMPLEMENT - Apply Fixes

### 2.1 For Each CRITICAL Issue

1. **Read the file**
2. **Apply the recommended fix**
3. **Verify fix compiles**: `bun run type-check`
4. **Track**: Note what was changed

### 2.2 For Each HIGH Issue

Same process as CRITICAL.

### 2.3 For Test Coverage Gaps

If test-coverage-agent identified missing tests for fixed code:

1. **Create/update test file**
2. **Add tests for the fix**
3. **Verify tests pass**: `bun test {file}`

### 2.4 Handle Unfixable Issues

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

## Phase 3: VALIDATE - Verify Fixes

### 3.1 Type Check

```bash
bun run type-check
```

Must pass. If not, fix type errors.

### 3.2 Lint

```bash
bun run lint
```

Fix any lint errors introduced.

### 3.3 Run Tests

```bash
bun test
```

All tests must pass. If new tests fail, fix them.

### 3.4 Build Check

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

## Phase 4: COMMIT AND PUSH - Save and Push Changes

### 4.1 Stage Changes

```bash
git add -A
git status
```

### 4.2 Commit

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

### 4.3 Push to PR Branch

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

## Phase 5: GENERATE - Create Fix Report

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

## Phase 6: POST - GitHub Comment

### 6.1 Post Fix Report

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

## Phase 7: OUTPUT - Final Report

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

## Error Handling

### Type Check Fails After Fix

1. Review the error
2. Adjust the fix
3. Re-run type check
4. If still failing, mark as "Not Fixed" with reason

### Tests Fail

1. Check if fix caused the failure
2. Either: fix the implementation, or fix the test
3. If unclear, mark as "Not Fixed" for manual review

### Push Fails

1. Pull with rebase: `git pull --rebase origin $HEAD_BRANCH`
2. Resolve any conflicts
3. Push again

---

## Success Criteria

- **ON_CORRECT_BRANCH**: Working on PR's head branch, not base branch or new branch
- **CRITICAL_ADDRESSED**: All CRITICAL issues attempted
- **HIGH_ADDRESSED**: All HIGH issues attempted
- **VALIDATION_PASSED**: Type check, lint, tests, build all pass
- **COMMITTED_AND_PUSHED**: Changes committed AND pushed to PR branch
- **REPORTED**: Fix report artifact and GitHub comment created
