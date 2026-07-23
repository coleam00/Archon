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

Read all review artifacts and fix everything surfaced **that falls within this PR's diff**. Within that boundary you lean aggressively towards fixing — LLMs are fast at generating code, so use that to add tests for the PR's own code, fix docs, improve error handling, and address all in-scope findings.

**Scope is a hard boundary, not a judgment call (see Phase 1.3).** You may only edit files this PR already changed (`git diff $BASE_BRANCH...HEAD`), plus a **new** test/doc file that pairs 1:1 with one of those files. A finding about any **other** file — even a real, valid one — is **not yours to fix in this PR**: record it under "Suggested Follow-up Issues" instead. Aggressive *inside* the diff; never *outside* it. This is enforced by a hard gate in Phase 5 before commit.

**Philosophy**: Within the PR's diff scope, fix it — real bugs, missing tests for the PR's own changed code, docs, error handling, naming. You skip a finding for exactly two reasons: (a) it targets a file **outside the diff scope** → record a follow-up issue (this is the most common skip and it is correct), or (b) it would introduce a **genuinely new feature / architectural change**. The bar for editing outside the diff is absolute: you don't.

**Output artifact**: `$ARTIFACTS_DIR/review/fix-report.md`
**Git action**: Commit AND push fixes to the PR branch
**GitHub action**: Post fix report as a comment on the PR

---

## Phase 1: LOAD — Get Context

### 1.1 Get PR Number and Branch

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)
HEAD_BRANCH=$(gh pr view $PR_NUMBER --json headRefName --jq '.headRefName')
BASE_BRANCH=$(gh pr view $PR_NUMBER --json baseRefName --jq '.baseRefName')
echo "PR: $PR_NUMBER, Head: $HEAD_BRANCH, Base: $BASE_BRANCH"
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

### 1.3 Compute the PR Diff Scope (allow-list)

This PR's scope is the set of files it already changed. Compute it now — every fix you make must stay inside it. This is the guard that prevents the self-fix step from editing unrelated files.

```bash
git fetch origin $BASE_BRANCH
# The allow-list: files this PR touched, measured from the merge-base.
git diff origin/$BASE_BRANCH...HEAD --name-only | sort -u > /tmp/scope-allowlist.txt
echo "In-scope files (this is the ONLY set you may edit):"; cat /tmp/scope-allowlist.txt
```

**The rule (enforced by the hard gate in Phase 5):**

- You MAY edit any file in the allow-list.
- You MAY create a **new** test or doc file that pairs 1:1 with an in-scope source file (e.g. `foo.test.ts` for an in-scope `foo.ts`, or that file's doc page).
- You MAY NOT touch any other file. A finding about an out-of-scope file is real but **not yours to fix here** — record it under "Suggested Follow-up Issues," do not edit it.

### 1.4 Read All Review Artifacts

```bash
ls $ARTIFACTS_DIR/review/
```

Read each `.md` file that contains findings (e.g. `code-review-findings.md`, `error-handling-findings.md`, `test-coverage-findings.md`, `comment-quality-findings.md`, `docs-impact-findings.md`, `consolidated-review.md`). Skip `scope.md` and `fix-report.md`.

```bash
for f in $ARTIFACTS_DIR/review/*.md; do
  echo "=== $f ==="; cat "$f"; echo
done
```

### 1.5 Extract All Findings

Compile a unified list of ALL findings with severity, location, and suggested fix. Tag each finding **in-scope** or **out-of-scope** by checking its file against the allow-list from 1.3.

**PHASE_1_CHECKPOINT:**

- [ ] PR number, head, and base branch identified
- [ ] On correct PR branch
- [ ] Scope allow-list computed (1.3)
- [ ] All review artifacts read
- [ ] All findings extracted and tagged in-scope / out-of-scope

---

## Phase 2: TRIAGE — Decide What to Fix

For each finding, decide: **FIX** or **SKIP**.

**Gate every finding on scope first.** If the finding's file is **not** in the 1.3 allow-list (and the fix isn't a new test/doc paired 1:1 with an in-scope source file), it is **SKIP → follow-up issue**, full stop — no matter how real or easy it is. Only findings that pass this scope gate proceed to the FIX/SKIP judgment below.

### FIX (for in-scope findings, lean towards fixing):

- Real bugs, type errors, silent failures, code quality issues
- Missing tests for the **PR's own changed code** (an in-scope file)
- Missing or outdated documentation **for an in-scope file**
- Error handling gaps
- Comment quality issues
- Import organization
- Naming improvements
- Any finding where the fix is concrete and the file is in the scope allow-list (1.3)

### SKIP if:

- **The finding targets a file NOT in the scope allow-list (1.3)** → record it as a follow-up issue. This is the most common skip, and it is correct — do not edit out-of-scope files.
- The fix introduces a **genuinely new feature** not related to the PR
- The fix requires **architectural changes** that affect untouched subsystems
- The finding is factually wrong or based on a misunderstanding

**Key principle**: In-scope (a file the PR already changed, or a new test/doc paired to one) → fair game to fix aggressively. Out-of-scope → a follow-up issue, never an edit. "The reviewer mentioned it" does **not** make an out-of-scope file fixable here.

For each skipped finding, write down **the specific reason** (for out-of-scope skips: name the file and that it's not in the allow-list).

**PHASE_2_CHECKPOINT:**

- [ ] Every finding marked FIX or SKIP
- [ ] Every out-of-scope finding routed to a follow-up issue, not an edit
- [ ] Skip reasons documented

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

### 5.1 Enforce scope (hard gate), then stage and commit

**Scope gate — run this BEFORE staging.** Every file you changed must be in the allow-list (1.3), or a new test/doc paired 1:1 with an in-scope source file. Anything else is a scope leak and must not be committed:

```bash
git diff --name-only | sort -u > /tmp/changed.txt
# Files you changed that are NOT in the allow-list:
comm -23 /tmp/changed.txt /tmp/scope-allowlist.txt
```

For each path that prints: if it is **not** a new test/doc paired 1:1 with an in-scope source file, it is **out of scope** — revert it (`git checkout -- <path>` for an edit, or `rm <path>` for a stray new file) and move the finding to "Suggested Follow-up Issues." Re-run the check until it prints only justified paired new files (ideally nothing).

Then stage **only** the in-scope files you changed — never `git add -A`, `git add .`, or `git add -u`:

```bash
git add {specific in-scope files}
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

- [ ] Scope gate passed — no out-of-scope files staged
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
- **SCOPE_RESPECTED**: Every change is inside the 1.3 allow-list (or a new test/doc paired 1:1 with an in-scope source file); out-of-scope findings are routed to follow-up issues, never edited
- **ALL_FINDINGS_ADDRESSED**: Every finding is fixed (in-scope), skipped (with reason), or blocked (with reason)
- **AGGRESSIVE_WITHIN_SCOPE**: In-scope findings fixed thoroughly; out-of-scope skips are expected and correct, not a failure
- **TESTS_ADDED**: Missing test coverage for the PR's own code addressed
- **DOCS_UPDATED**: Documentation gaps for in-scope files filled
- **VALIDATION_PASSED**: Type check, lint, and tests all pass
- **COMMITTED_AND_PUSHED**: Changes committed and pushed to PR branch
- **REPORTED**: Fix report artifact written and GitHub comment posted
