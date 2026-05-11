---
description: Aggressively fix all review findings - lean towards fixing unless clearly a new concern
argument-hint: (none - reads all review artifacts from $ARTIFACTS_DIR/review/)
---

# Self-Fix All Review Findings

---

## IMPORTANT: Output Behavior

**Your output will be posted as a GitHub comment.** Keep working output minimal:
- Do NOT narrate each step
- Do NOT output verbose progress updates
- Only output the final structured report at the end

---

## Your Mission

Read all review artifacts and fix EVERYTHING surfaced. Unlike conservative auto-fix, you lean aggressively towards fixing. LLMs are fast at generating code — use that advantage to add tests, fix docs, improve error handling, and address all findings.

**Philosophy**: Fix it unless it's clearly a NEW unrelated concern that deserves its own issue. Adding tests for existing code? Fix it. Updating docs? Fix it. Adding missing error handling? Fix it. The bar for skipping is HIGH — only skip when the fix would introduce a genuinely new feature or concern outside the PR's scope.

**Output artifact**: `$ARTIFACTS_DIR/review/fix-report.md`
**Git action**: Commit AND push fixes to the PR branch
**GitHub action**: Post fix report as a comment on the PR

---

## Phase 1: LOAD — Get Context

### 1.1 Get PR Number and Branch

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)
HEAD_BRANCH=$(gh pr view $PR_NUMBER --json headRefName --jq '.headRefName')
echo "PR: $PR_NUMBER, Branch: $HEAD_BRANCH"
```

### 1.2 Checkout PR Branch

```bash
git fetch origin $HEAD_BRANCH
git checkout $HEAD_BRANCH
git pull origin $HEAD_BRANCH
```

Verify:

```bash
git branch --show-current
git status --porcelain
```

### 1.3 Read All Review Artifacts

```bash
ls $ARTIFACTS_DIR/review/
```

Read each `.md` file that contains findings (e.g. `code-review-findings.md`, `error-handling-findings.md`, `test-coverage-findings.md`, `comment-quality-findings.md`, `docs-impact-findings.md`, `consolidated-review.md`). Skip `scope.md` and `fix-report.md`.

```bash
for f in $ARTIFACTS_DIR/review/*.md; do
  echo "=== $f ==="; cat "$f"; echo
done
```

### 1.4 Extract All Findings

Compile a unified list of ALL findings with severity, location, and suggested fix.

**PHASE_1_CHECKPOINT:**

- [ ] PR number and branch identified
- [ ] On correct PR branch
- [ ] All review artifacts read
- [ ] All findings extracted

---

## Phase 2: TRIAGE — Decide What to Fix

For each finding, decide: **FIX** or **SKIP**.

### FIX (default — lean towards fixing):

- Real bugs, type errors, silent failures, code quality issues
- Missing tests for changed or existing code touched by the PR
- Missing or outdated documentation
- Error handling gaps
- Comment quality issues
- Import organization
- Naming improvements
- Any finding where the fix is concrete and the code is within the PR's touched area

### SKIP only if:

- The fix introduces a **genuinely new feature** not related to the PR
- The fix requires **architectural changes** that affect untouched subsystems
- The fix is about code **completely unrelated** to the PR's changes
- The finding is factually wrong or based on a misunderstanding

**Key principle**: If the review agent found it while reviewing THIS PR, it's fair game to fix. Tests, docs, simplification, error handling — all fixable. The only skip reason is "this is a new concern that deserves its own issue."

For each skipped finding, write down **the specific reason**.

**PHASE_2_CHECKPOINT:**

- [ ] Every finding marked FIX or SKIP
- [ ] Skip reasons documented (should be very few)

---

## Phase 3: IMPLEMENT — Apply Fixes

### 3.1 For Each Finding Marked FIX

1. Read the relevant file(s)
2. Apply the fix following the suggested approach
3. Run type-check after each fix: `bun run type-check`
4. Note exactly what was changed

### 3.2 Add Tests

For ANY finding about missing tests:

1. Create or update the test file
2. Write meaningful tests (not just stubs)
3. Run them: `bun test {file}`

### 3.3 Fix Documentation

For ANY finding about docs:

1. Update the relevant documentation
2. Ensure accuracy with the current code

### 3.4 Handle Blocked Fixes

If a fix cannot be applied (code changed since review, fix would break other things), mark as **BLOCKED** with reason. Do not force a broken fix.

**PHASE_3_CHECKPOINT:**

- [ ] All FIX findings attempted
- [ ] Tests added where flagged
- [ ] Docs updated where flagged
- [ ] BLOCKED findings documented

---

## Phase 4: VALIDATE — Full Check

```bash
bun run type-check
bun run lint
bun test
```

All must pass. If something fails after a fix:

1. Review the error
2. Adjust the fix or revert it and mark BLOCKED
3. Re-run until clean

**PHASE_4_CHECKPOINT:**

- [ ] Type check passes
- [ ] Lint passes
- [ ] Tests pass

---

## Phase 5: COMMIT AND PUSH

### 5.1 Stage and Commit

Only stage files you actually changed:

```bash
git add {specific files}
git status
git commit -m "$(cat <<'EOF'
fix: address review findings

Fixed:
- {brief list of fixes}

Tests added:
- {brief list if any}

Skipped:
- {brief list if any, with reasons}
EOF
)"
```

### 5.2 Push

```bash
git push origin $HEAD_BRANCH
```

If push fails due to divergence:

```bash
git pull --rebase origin $HEAD_BRANCH
git push origin $HEAD_BRANCH
```

**PHASE_5_CHECKPOINT:**

- [ ] Changes committed
- [ ] Pushed to PR branch

---

## Phase 6: GENERATE — Write Fix Report

Write to `$ARTIFACTS_DIR/review/fix-report.md`:

```markdown
# Fix Report: PR #{number}

**Date**: {ISO timestamp}
**Status**: COMPLETE | PARTIAL
**Branch**: {HEAD_BRANCH}
**Commit**: {commit hash}
**Philosophy**: Aggressive fix — lean towards fixing everything

---

## Summary

{2-3 sentences: what was found, what was fixed, what was skipped and why}

---

## Fixes Applied

| Severity | Finding | Location | What Was Done |
|----------|---------|----------|---------------|
| CRITICAL | {title} | `file:line` | {description} |
| HIGH     | {title} | `file:line` | {description} |
| MEDIUM   | {title} | `file:line` | {description} |
| LOW      | {title} | `file:line` | {description} |

---

## Tests Added

| File | Test Cases |
|------|------------|
| `{file}.test.ts` | `{test description}` |

*(none)* if no tests were added

---

## Docs Updated

| File | Changes |
|------|---------|
| `{file}` | {what was updated} |

*(none)* if no docs were updated

---

## Skipped Findings

| Severity | Finding | Location | Reason Skipped |
|----------|---------|----------|----------------|
| {sev}    | {title} | `file:line` | New concern: {specific reason} |

*(none)* if nothing was skipped — ideal outcome

---

## Blocked (Could Not Fix)

| Severity | Finding | Reason |
|----------|---------|--------|
| {sev}    | {title} | {why it could not be applied} |

*(none)* if nothing was blocked

---

## Suggested Follow-up Issues

{For any skipped or blocked findings that warrant their own issue:}

| Issue Title | Priority | Reason |
|-------------|----------|--------|
| "{title}" | {P1/P2/P3} | {why this deserves a separate issue} |

*(none)* if everything was addressed

---

## Validation

| Check | Status |
|-------|--------|
| Type check | ✅ / ❌ |
| Lint | ✅ / ❌ |
| Tests | ✅ {n} passed / ❌ |
```

**PHASE_6_CHECKPOINT:**

- [ ] Fix report written

---

## Phase 7: POST — GitHub Comment

Post the fix report as a PR comment:

```bash
gh pr comment $PR_NUMBER --body "$(cat <<'EOF'
## ⚡ Self-Fix Report (Aggressive)

**Status**: {COMPLETE | PARTIAL}
**Pushed**: ✅ Changes pushed to `{HEAD_BRANCH}`
**Philosophy**: Fix everything unless clearly a new concern

---

### Fixes Applied ({n} total)

| Severity | Count |
|----------|-------|
| 🔴 CRITICAL | {n} |
| 🟠 HIGH | {n} |
| 🟡 MEDIUM | {n} |
| 🟢 LOW | {n} |

<details>
<summary>View all fixes</summary>

{For each fix:}
- ✅ **{title}** (`{file}:{line}`) — {brief description}

</details>

---

### Tests Added

{List or "(none)"}

---

### Skipped ({n})

{If any:}
| Finding | Reason |
|---------|--------|
| {title} | New concern: {reason} |

*(none — all findings addressed)*

---

### Suggested Follow-up Issues

{If any skipped/blocked items warrant issues:}
1. **{Issue Title}** — {brief description}

*(none)*

---

### Validation

✅ Type check | ✅ Lint | ✅ Tests ({n} passed)

---

*Self-fix by Archon · aggressive mode · fixes pushed to `{HEAD_BRANCH}`*
EOF
)"
```

**PHASE_7_CHECKPOINT:**

- [ ] GitHub comment posted

---

## Phase 8: OUTPUT — Final Summary

```
## ⚡ Self-Fix Complete

**PR**: #{number}
**Branch**: {HEAD_BRANCH}
**Status**: COMPLETE | PARTIAL

Fixed: {n} (across all severities)
Tests added: {n}
Docs updated: {n}
Skipped: {n} (new concerns only)
Blocked: {n}

Validation: ✅ All checks pass
Pushed: ✅

Fix report: $ARTIFACTS_DIR/review/fix-report.md
```

---

## Success Criteria

- **ON_CORRECT_BRANCH**: Working on PR's head branch
- **ALL_FINDINGS_ADDRESSED**: Every finding is fixed, skipped (with reason), or blocked (with reason)
- **AGGRESSIVE_FIXING**: Most findings fixed — skip rate should be very low
- **TESTS_ADDED**: Missing test coverage addressed
- **DOCS_UPDATED**: Documentation gaps filled
- **VALIDATION_PASSED**: Type check, lint, and tests all pass
- **COMMITTED_AND_PUSHED**: Changes committed and pushed to PR branch
- **REPORTED**: Fix report artifact written and GitHub comment posted
