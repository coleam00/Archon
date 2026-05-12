---
description: Auto-fix all review findings unless clear YAGNI violations, post fix report
argument-hint: (none - reads all review artifacts from $ARTIFACTS_DIR/review/)
---

# Auto-Fix Review Findings

---

## IMPORTANT: Output Behavior

**Your output will be posted as a GitHub comment.** Keep working output minimal:
- Do NOT narrate each step
- Do NOT output verbose progress updates
- Only output the final structured report at the end
- Use the TodoWrite tool to track progress silently

---

## Your Mission

Read all review artifacts produced in this workflow run and fix everything surfaced — unless a finding is a clear YAGNI violation or speculative over-engineering beyond the scope of the original fix. Validate, commit, push, write an artifact, and post a GitHub comment explaining what was fixed and why anything was skipped.

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

**Always re-checkout to ensure you are on the right branch.**

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

Discover whatever review artifacts exist — there may be one or many depending on which review agents ran:

```bash
ls $ARTIFACTS_DIR/review/
```

Read each `.md` file that looks like a findings artifact (e.g. `code-review-findings.md`, `error-handling-findings.md`, `test-coverage-findings.md`, `docs-impact-findings.md`, `consolidated-review.md`). Skip non-findings files like `scope.md` and `fix-report.md`.

```bash
for f in $ARTIFACTS_DIR/review/*.md; do
  echo "=== $f ==="; cat "$f"; echo
done
```

### 1.4 Extract Findings

From all loaded artifacts, compile a unified list of all findings with their severity, location, and suggested fix.

**PHASE_1_CHECKPOINT:**
- [ ] PR number and branch identified
- [ ] On correct PR branch
- [ ] All review artifacts read
- [ ] All findings extracted

---

## Phase 2: TRIAGE — Decide What to Fix

For each finding, decide: **FIX** or **SKIP**.

### Fix if:
- It is a real bug, type error, silent failure, or clear code quality issue
- The fix is concrete and low-risk

### Skip (YAGNI / out-of-scope) if the finding recommends:
- Adding something not required to fix the original issue (new config options, new abstractions, speculative fallbacks, "what if" edge cases)
- Refactoring or restructuring code that isn't broken
- Adding validation for inputs that cannot actually be invalid in this context
- Extracting utilities or helpers for code that currently has only one caller
- Architectural changes that touch code well outside the PR's scope

Use judgment — don't be overly restrictive. If it's a legitimate bug the reviewer found, fix it even if it's adjacent to the PR. If it's clearly speculative ("this might be useful someday"), skip it.

For each skipped finding, write down **the specific reason** — this goes in the report.

**PHASE_2_CHECKPOINT:**
- [ ] Every finding marked FIX or SKIP
- [ ] Skip reasons documented

---

## Phase 3: IMPLEMENT — Apply Fixes

### 3.1 For Each Finding Marked FIX

1. Read the relevant file(s)
2. Apply the fix following the suggested approach from the review artifact
3. Run type-check after each fix: `bun run type-check`
4. Note exactly what was changed

### 3.2 Handle Unfixable Findings

If a fix cannot be applied (code changed since review, fix is ambiguous, fix would break other things), mark it as **BLOCKED** and document why. Do not force a broken fix.

### 3.3 Add Tests for Fixed Code

If the review flagged missing test coverage for something you just fixed, add a targeted test. Run it:

```bash
bun test {file}
```

**PHASE_3_CHECKPOINT:**
- [ ] All FIX findings attempted
- [ ] Tests added where flagged
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
git commit -m "fix: address review findings

$(echo "Fixed:"; echo "- {brief list}")
$(echo ""; echo "Skipped (YAGNI/out-of-scope):"; echo "- {brief list if any}")"
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

---

## Summary

{2-3 sentences covering what was found, what was fixed, what was skipped and why}

---

## Fixes Applied

| Severity | Finding | Location | What Was Done |
|----------|---------|----------|---------------|
| CRITICAL | {title} | `file:line` | {description} |
| HIGH     | {title} | `file:line` | {description} |

---

## Skipped Findings

| Severity | Finding | Location | Reason Skipped |
|----------|---------|----------|----------------|
| HIGH     | {title} | `file:line` | YAGNI: {specific reason} |
| MEDIUM   | {title} | `file:line` | Out of scope: {reason} |

---

## Tests Added

| File | Test Cases |
|------|------------|
| `{file}.test.ts` | `{test description}` |

*(none)* if no tests were added

---

## Blocked (Could Not Fix)

| Severity | Finding | Reason |
|----------|---------|--------|
| {sev}    | {title} | {why it could not be applied} |

*(none)* if nothing was blocked

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
## ⚡ Auto-Fix Report

**Status**: {COMPLETE | PARTIAL}
**Pushed**: ✅ Changes pushed to `{HEAD_BRANCH}`

---

### Fixes Applied

| Severity | Finding | Location |
|----------|---------|----------|
| 🔴 CRITICAL | {title} | `file:line` |
| 🟠 HIGH | {title} | `file:line` |

*(none)* if nothing was fixed

---

### Skipped

| Severity | Finding | Reason |
|----------|---------|--------|
| 🟠 HIGH | {title} | {reason — YAGNI, out of scope, blocked} |

*(none)* if nothing was skipped

---

### Tests Added

{List or "(none)"}

---

### Validation

✅ Type check | ✅ Lint | ✅ Tests ({n} passed)

---

*Auto-fix by Archon · fixes pushed to `{HEAD_BRANCH}`*
EOF
)"
```

**PHASE_7_CHECKPOINT:**
- [ ] GitHub comment posted

---

## Phase 8: OUTPUT — Final Summary

Output only this:

```
## ⚡ Auto-Fix Complete

**PR**: #{number}
**Branch**: {HEAD_BRANCH}
**Status**: COMPLETE | PARTIAL

Fixed: {n}
Skipped: {n} (YAGNI/out-of-scope)
Blocked: {n}

Validation: ✅ All checks pass
Pushed: ✅

Fix report: $ARTIFACTS_DIR/review/fix-report.md
```

---

## Error Handling

### Type check fails after a fix
1. Review the error
2. Adjust or revert the fix
3. If still failing after a reasonable attempt, mark BLOCKED

### Tests fail
1. Check whether the fix caused it or it was pre-existing
2. Fix the test if the fix is correct
3. If unclear, mark BLOCKED — do not ship broken tests

### Push fails
1. `git pull --rebase origin $HEAD_BRANCH`
2. Resolve conflicts if any
3. Push again

### No review artifacts found
```
❌ No review artifacts found in $ARTIFACTS_DIR/review/
Cannot proceed without findings.
```

---

## Success Criteria

- **ON_CORRECT_BRANCH**: Working on PR's head branch
- **ALL_FINDINGS_ADDRESSED**: Every finding is either fixed, skipped (with reason), or blocked (with reason)
- **VALIDATION_PASSED**: Type check, lint, and tests all pass
- **COMMITTED_AND_PUSHED**: Changes committed and pushed to PR branch
- **REPORTED**: Fix report artifact written and GitHub comment posted
