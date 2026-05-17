---
description: PIV loop — fix the issues surfaced by the code review, one at a time, then re-validate.
argument-hint: (no arguments — reads the code review from workflow artifacts)
---

# PIV Code Review Fix

**Workflow ID**: $WORKFLOW_ID

A code review found a set of issues. Fix them one by one, verify each, then re-run validation.

---

## Phase 1: LOAD

- Read `$ARTIFACTS_DIR/code-review.md` in full — every issue listed there.
- Read `$ARTIFACTS_DIR/plan.md` for the intended behavior.
- Read `CLAUDE.md` for conventions.

If the review's recommendation is already READY with no issues, skip to Phase 4 and report
that no fixes were needed.

### PHASE_1_CHECKPOINT
- [ ] Code review loaded; all issues enumerated
- [ ] Intended behavior understood from the plan

## Phase 2: FIX

Work through the issues **in severity order** — critical, then high, then medium, then low.
For each issue:

1. **Explain** what is wrong (briefly).
2. **Read** the affected file(s) for full context.
3. **Apply** the fix, following codebase conventions.
4. **Verify** — create or run a relevant test, or run the specific check that exercises the
   fix. Confirm the issue is actually resolved.

Do not batch unrelated fixes into one undifferentiated change. Keep each fix focused.

### PHASE_2_CHECKPOINT
- [ ] Every critical and high issue fixed and verified
- [ ] Medium and low issues fixed, or consciously deferred with a noted reason

## Phase 3: RE-VALIDATE

Re-run the project's full validation suite (tests, type-check, lint, build) — the same
commands `$ARTIFACTS_DIR/validation.md` used. Confirm zero regressions.

Update `$ARTIFACTS_DIR/validation.md` with the post-fix results.

Write `$ARTIFACTS_DIR/code-review-fix.md`:

```markdown
# Code Review Fixes

## Fixes Applied
- [issue] → [fix] → [how it was verified]

## Deferred
- [issue] — Reason: [why it was not fixed]

## Post-Fix Validation: PASS / FAIL
```

### PHASE_3_CHECKPOINT
- [ ] All fixes applied and individually verified
- [ ] Full validation re-run; results recorded
- [ ] `$ARTIFACTS_DIR/code-review-fix.md` written

## Phase 4: COMMIT

Commit the review fixes. Do NOT push. Skip this phase cleanly if no fixes were needed.

```bash
git add -A
git status --short
git commit -m "fix: address code review findings"
```

### PHASE_4_CHECKPOINT
- [ ] Review fixes committed to the worktree branch (or skipped — no fixes needed)

## Phase 5: REPORT

Summarize: which issues were fixed, which were deferred and why, the commit made, and the
post-fix validation status.
