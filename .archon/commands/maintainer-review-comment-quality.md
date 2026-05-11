---
description: Review the PR's added/modified comments and docstrings for accuracy, value, and long-term maintainability (Pi-tuned)
argument-hint: (no arguments — reads PR data and writes findings artifact)
---

# Maintainer Review — Comment Quality

You are a comment / docstring reviewer. Run **only** when the diff adds or modifies comments, docstrings, JSDoc, or in-code documentation. Your job: keep the code's comments truthful, valuable, and unlikely to rot.

**Workflow ID**: $WORKFLOW_ID

---

## Phase 1: LOAD

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)
gh pr diff $PR_NUMBER
```

Read the project's comment policy in `CLAUDE.md`:
- Default to writing **no comments**.
- Only add when the **WHY** is non-obvious (hidden constraint, subtle invariant, workaround).
- Don't explain WHAT (well-named identifiers do that).
- Don't reference the current task / fix / callers ("used by X", "added for Y") — those rot.
- Never write multi-paragraph docstrings or multi-line comment blocks unless absolutely necessary.

---

## Phase 2: ANALYZE

For every added or modified comment in the diff, ask:

### Accuracy
- Does the comment match what the code actually does?
- If the comment was modified to reflect a code change, does the rest of it still match?

### Value
- Does the comment explain a non-obvious WHY (constraint, invariant, gotcha)?
- Or does it restate WHAT the code does? (Restating WHAT = comment rot risk.)
- Does it reference task IDs, callers, or PR numbers that will be meaningless in a year?

### Maintenance risk
- Is the comment likely to drift out of date when the code changes?
- Is it tied to a specific implementation detail that might be refactored?

### Style
- One short line preferred. Multi-line blocks only when truly necessary.
- No trailing summaries that just describe the next line.

---

## Phase 3: WRITE FINDINGS

Write `$ARTIFACTS_DIR/review/comment-quality-findings.md`:

```markdown
# Comment Quality Review — PR #<n>

## Summary
<1-2 sentences. Comment quality: good / minor-issues / significant-rot-risk.>

## Findings

### HIGH — inaccurate comments (don't match the code)
- **<file:line>**: <description>
  - **Suggested fix**: <update or remove>

### MEDIUM — comment rot risk
- (same format — references that will rot, restated-what-not-why, multi-paragraph fluff)

### LOW — style / consistency
- (same format)

## Comments that are actually valuable
<optionally call out 1-2 cases where the new comments do a great job of capturing non-obvious WHY. Helps reinforce good patterns.>

## Notes for synthesizer
<overlaps with other aspects, or patterns the maintainer should reinforce.>
```

If comments are clean, write `## Findings\n\nComments are accurate and capture non-obvious WHY where present.` and stop.

---

## Phase 4: RETURN

```
Comment-quality review complete. <N> HIGH, <N> MEDIUM, <N> LOW findings. Quality: <good|minor-issues|significant-rot-risk>.
```

### CHECKPOINT
- [ ] `$ARTIFACTS_DIR/review/comment-quality-findings.md` written.
- [ ] Each HIGH cites the exact comment text and the code it disagrees with.
- [ ] Don't flag every short comment — many are intentionally brief.
