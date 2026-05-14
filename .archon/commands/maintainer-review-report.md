---
description: Produce the final summary of a maintainer-review-pr run for the workflow log
argument-hint: (no arguments — reads upstream artifacts)
---

# Maintainer Review — Final Report

You are the final reporter. The workflow has finished the deep review. Your job: produce a one-screen summary that tells the maintainer what just happened and what's pending.

**Workflow ID**: $WORKFLOW_ID

---

## Phase 1: LOAD ARTIFACTS

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number 2>/dev/null)
ls $ARTIFACTS_DIR/
ls $ARTIFACTS_DIR/review/ 2>/dev/null
```

`$ARTIFACTS_DIR/review/synthesis.md` should exist and contain the synthesized verdict + findings.

---

## Phase 2: WRITE THE FINAL REPORT

Write `$ARTIFACTS_DIR/final-report.md`:

```markdown
# Maintainer Review — PR #<n> — Final

## Outcome

- Synthesized verdict: <ready-to-merge | minor-fixes-needed | blocking-issues>
- Findings: <N CRITICAL / N HIGH / N MEDIUM / N LOW>
- Aspects run: <list>
- **Draft comment**: $ARTIFACTS_DIR/review/review-comment.md (already posted to PR; copy-paste if you want to edit and re-post)
- **Full synthesis**: $ARTIFACTS_DIR/review/synthesis.md

## Next steps for the maintainer
<2-3 short bullets. e.g.:
- "Open PR #<n> and confirm the posted review reads well."
- "If blocking-issues: wait for contributor reply; check back in N days."
- "If ready-to-merge: merge when CI is green.">
```

---

## Phase 3: RETURN

Return a single-line outcome:

```
PR #<n> — verdict=<synthesized verdict>, action=posted-review-comment.
```

### CHECKPOINT
- [ ] `$ARTIFACTS_DIR/final-report.md` written.
- [ ] Numbers in the report match `$ARTIFACTS_DIR/review/synthesis.md` (don't invent finding counts).
- [ ] Lists concrete next steps for the maintainer.
