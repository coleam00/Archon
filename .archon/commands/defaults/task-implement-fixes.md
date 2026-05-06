---
description: Implement EVERY actual issue from review findings — no severity filtering, no skips
argument-hint: (none — reads from $ARTIFACTS_DIR/review)
---

# Implement Review Fixes

This command shadows the bundled `archon-implement-review-fixes` because the
bundled version is opinionated against fixing MEDIUM/LOW findings and treats
"hard to fix" as a reason to skip. Our pipeline policy is different: every
actual issue in the review gets fixed.

---

## Your task

Read every reviewer finding for this PR. Implement code changes that
address every item that is an **actual issue** — a bug, a missing
behavior, a code-quality problem, a documentation gap. Severity does
NOT determine whether to fix; severity only determines order.

The only category you are allowed to leave unfixed is **questions**:
findings that ask "do you want X or Y?", "is this intentional?", "would
you prefer A over B?". Questions belong to a human. Mark them as
deferred in the report. Everything else gets fixed.

When you have implemented all fixes, commit and push. Then write the
report and post the GitHub comment.

---

## Inputs

- `docs/contracts/<lowercase-issue-key>.md` — **canonical**. Derive
  the path: lowercase the `issue_key` from
  `$ARTIFACTS_DIR/trigger-payload.json`. The contract names every
  file, export, signature, query, and invariant the work must align
  with. Fixes that pull the implementation away from the contract
  are wrong; fixes that bring it closer to the contract are right.
- `$ARTIFACTS_DIR/.pr-number` — the PR number to fix and post on.
- `$ARTIFACTS_DIR/review/consolidated-review.md` — the synthesizer's
  consolidated finding list with severities and locations.
- `$ARTIFACTS_DIR/review/*-findings.md` — per-reviewer detailed findings
  (code-review, error-handling, scope, comment-quality, docs-impact). Use
  these when consolidated lacks fix-level detail.
- The current PR branch checkout.

---

## Workflow

### 1. Setup

```bash
PR_NUMBER=$(cat "$ARTIFACTS_DIR/.pr-number")
HEAD_BRANCH=$(gh pr view "$PR_NUMBER" --json headRefName --jq '.headRefName')
git fetch origin "$HEAD_BRANCH"
git checkout "$HEAD_BRANCH"
git pull origin "$HEAD_BRANCH"
```

### 2. Read the findings

```bash
cat "$ARTIFACTS_DIR/review/consolidated-review.md"
```

Read each `*-findings.md` for full fix-level detail when needed.

### 3. Categorize each finding

For every finding in the consolidated review, classify it as:

- **Issue**: anything that is wrong with the code as written — a bug,
  a missing case, a typo in a docstring, a misnamed variable, a missing
  guard, a stale comment, a documentation hole, a duplicated block.
  **All of these get fixed.**
- **Question**: a finding phrased as "do you want…", "should we…",
  "is this intentional?", "would you prefer…". **Defer these to the
  user — note them in the report.**

If a finding is genuinely ambiguous between issue and question, treat
it as an issue and fix it; over-fixing is cheaper than under-fixing.

### 4. Implement fixes (every issue, in order)

Process by severity (CRITICAL → HIGH → MEDIUM → LOW), but **fix every
issue at every severity**. For each:

1. Read the file at the location indicated.
2. Apply the recommended fix, or — if the recommendation is wrong or
   unclear — apply a fix that addresses the underlying issue.
3. Track what you changed (you'll need this for the report).

If a fix conflicts with another fix's outcome, resolve by addressing
the deeper issue first, then re-evaluating.

### 5. Validate locally

DO NOT run tests, lint, or typecheck — those are deterministic gates
that run elsewhere in the pipeline. Just check that the files you
edited compile / parse cleanly enough to be committable.

### 6. Commit and push

```bash
git add -A
git commit -m "fix: address review findings

Fixes applied:
- <one line per fix>

Deferred (questions for human review):
- <one line per question, if any>"
git push origin "$HEAD_BRANCH"
```

If push fails due to divergence:
```bash
git pull --rebase origin "$HEAD_BRANCH"
git push origin "$HEAD_BRANCH"
```

### 7. Write the fix report

Write to `$ARTIFACTS_DIR/review/fix-report.md`:

```markdown
# Fix Report: PR #<number>

**Date**: <ISO timestamp>
**Branch**: <HEAD_BRANCH>
**Commit**: <commit-hash>

---

## Fixes applied (<n>)

| Severity | Issue | Location | What changed |
|----------|-------|----------|--------------|
| CRITICAL | ... | `file:line` | ... |
| HIGH     | ... | `file:line` | ... |
| MEDIUM   | ... | `file:line` | ... |
| LOW      | ... | `file:line` | ... |

---

## Deferred (questions for human review) (<n>)

| Severity | Question | Location |
|----------|----------|----------|
| MEDIUM | "Do you want X or Y?" | `file:line` |

If this section is empty, the entire review was actionable and every
finding was addressed.
```

### 8. Post the GitHub comment

```bash
gh pr comment "$PR_NUMBER" --body-file "$ARTIFACTS_DIR/review/fix-report.md"
```

---

## What NOT to do

- **Do not skip a finding because the fix is "complex" or "risky".**
  If you can identify the issue, you can write a fix for it. If the
  fix you write turns out to be wrong, the next reviewer pass will
  catch it.
- **Do not skip a finding because the recommendation is unclear.**
  Use the underlying issue as the spec, not the recommendation text.
- **Do not skip a finding because it's MEDIUM or LOW.** Severity does
  not change whether to fix; it only changes order.
- **Do not run tests, lint, or typecheck yourself.** Validation runs
  in a separate node downstream.
- **Do not narrate progress.** The TodoWrite tool tracks state silently;
  your visible output is the final commit + the report.
