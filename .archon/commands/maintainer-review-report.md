---
description: Produce the final summary across all branches of maintainer-review-pr (review / decline / unclear) for the workflow log
argument-hint: (no arguments — reads upstream artifacts)
---

# Maintainer Review — Final Report

You are the final reporter. The workflow has finished one of three branches (review / decline / unclear). Your job: produce a one-screen summary that tells the maintainer what just happened and what's pending.

**Workflow ID**: $WORKFLOW_ID

---

## Phase 1: DETECT WHICH BRANCH RAN

Check what artifacts exist:

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number 2>/dev/null)
ls $ARTIFACTS_DIR/
ls $ARTIFACTS_DIR/review/ 2>/dev/null
cat $ARTIFACTS_DIR/gate-decision.md 2>/dev/null | head -30
```

Three possibilities:

1. **Review branch ran**: `$ARTIFACTS_DIR/review/synthesis.md` exists.
2. **Decline branch ran**: `$ARTIFACTS_DIR/decline-comment.md` exists with non-placeholder content; the post-decline bash node already posted to GitHub.
3. **Unclear branch ran**: gate verdict was `unclear` and the maintainer was prompted to decide manually.

---

## Phase 2: WRITE THE FINAL REPORT

Write `$ARTIFACTS_DIR/final-report.md`:

```markdown
# Maintainer Review — PR #<n> — Final

## Branch taken
<review | decline | needs_split | unclear>

## Gate decision
<one-line summary from gate-decision.md: verdict + direction + scope + template>

## Outcome

### If review branch:
- Synthesized verdict: <ready-to-merge | minor-fixes-needed | blocking-issues>
- Findings: <N CRITICAL / N HIGH / N MEDIUM / N LOW>
- Aspects run: <list>
- **Draft comment**: $ARTIFACTS_DIR/review/review-comment.md (copy-paste or edit before posting to PR)
- **Full synthesis**: $ARTIFACTS_DIR/review/synthesis.md

### If decline branch:
- Decline categories: <list>
- Cited direction clauses: <list>
- Comment posted to PR: yes
- Reply window: <YYYY-MM-DD>
- Awaiting-author label added: yes/no

### If unclear branch:
- Gate could not classify confidently.
- Maintainer prompted manually — outcome recorded in approval-gate response.

## Next steps for the maintainer
<2-3 short bullets. e.g.:
- "Read $ARTIFACTS_DIR/review/review-comment.md and post to PR."
- "Wait for contributor reply by <DATE>; if no reply, close PR."
- "Update direction.md to address the open question this PR raised: <topic>".>
```

---

## Phase 3: RETURN

Return a single-line outcome:

```
PR #<n> — branch=<review|decline|needs_split|unclear>, verdict=<gate verdict>, action=<posted-comment|drafted-review|awaiting-manual-decision>.
```

### CHECKPOINT
- [ ] `$ARTIFACTS_DIR/final-report.md` written.
- [ ] Correctly identifies which branch ran (don't pretend the review branch ran when it didn't).
- [ ] Lists concrete next steps for the maintainer.
