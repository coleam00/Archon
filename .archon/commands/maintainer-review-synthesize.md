---
description: Synthesize findings from all review aspects into a single maintainer-ready review report (Pi-tuned)
argument-hint: (no arguments — reads review/*.md artifacts and writes synthesis)
---

# Maintainer Review — Synthesize

You are the synthesizer. Read all available review-aspect findings, deduplicate overlap, prioritize, and produce a single maintainer-ready review summary plus a draft GitHub comment.

**Workflow ID**: $WORKFLOW_ID

---

## Phase 1: LOAD

### PR number
```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)
```

### Read every available review findings file
```bash
ls $ARTIFACTS_DIR/review/
```

Then read each one:
- `code-review-findings.md` (always present if review branch ran)
- `error-handling-findings.md` (present if classifier said yes)
- `test-coverage-findings.md` (present if classifier said yes)
- `comment-quality-findings.md` (present if classifier said yes)
- `docs-impact-findings.md` (present if classifier said yes)

Some files may be missing — that's expected. Don't error.

### Read the gate decision (for context)
```bash
cat $ARTIFACTS_DIR/gate-decision.md
```

The gate may have noted things ("template was empty — nudge in synthesis"). Carry those notes forward.

---

## Phase 2: AGGREGATE + DEDUPLICATE

Issues often surface in multiple aspects (e.g. a missing test for an error path shows up in error-handling AND test-coverage). Don't list the same finding twice. Pick the most actionable wording and merge.

Group findings by **severity** across all aspects, not by aspect:

- **CRITICAL** (across aspects): merge / blocking / data-loss / silent-failure issues.
- **HIGH**: real bugs, missing test for a fix, missing docs for a new public surface, CLAUDE.md violation.
- **MEDIUM**: edge cases, comment rot risks, minor docs polish.
- **LOW / NITPICK**: style, naming, optional improvements.

Within each tier, order by file path so the maintainer can scan top-to-bottom.

---

## Phase 3: WRITE THE SYNTHESIS

Write `$ARTIFACTS_DIR/review/synthesis.md`:

```markdown
# Maintainer Review — PR #<n>

## Verdict
<one of: ready-to-merge | minor-fixes-needed | blocking-issues>

## Summary
<2-3 sentence overview. What the PR does, what's good, what's blocking.>

## Findings

### CRITICAL (N)
- **<file:line>**: <description>
  - From: <which aspect(s) flagged this>
  - **Suggested fix**: <concrete change>

### HIGH (N)
- (same format)

### MEDIUM (N)
- (same format)

### LOW / NITPICK (N)
- (consolidated)

## CLAUDE.md compliance
<bullet list of any violations carried forward from code-review.>

## Gate-decision notes
<any non-review notes the gate flagged for synthesis — e.g. "template was empty, nudge contributor".>

## Aspects run
- code-review: <yes/no, summary line>
- error-handling: <yes/no, summary line>
- test-coverage: <yes/no, summary line>
- comment-quality: <yes/no, summary line>
- docs-impact: <yes/no, summary line>

## Aspects skipped
<list with reason — e.g. "test-coverage skipped: no source code changes detected by review-classify".>
```

---

## Phase 4: WRITE THE DRAFT PR COMMENT

Write `$ARTIFACTS_DIR/review/review-comment.md` — this is the markdown body that would be posted to the PR. The maintainer can copy-paste it or hand-edit before posting.

Format:

```markdown
## Review Summary

**Verdict**: <ready-to-merge | minor-fixes-needed | blocking-issues>

<2-3 sentence overview written for the PR author, not for the maintainer.>

### Blocking issues
- (list CRITICAL findings, file:line, fix suggestion)

### Suggested fixes
- (list HIGH findings)

### Minor / nice-to-have
- (list MEDIUM + LOW combined)

### Compliments
<optional: 1-2 things the PR did particularly well — patterns, tests, docs. Keep brief and genuine.>

---
*Reviewed via maintainer-review-pr workflow (Pi/Minimax). Aspects run: <list>.*
```

Tone for the PR comment:
- Address the contributor directly ("you", "your change").
- Be **specific** — file:line + concrete fix.
- No corporate-speak, no excessive praise, no AI-attribution-by-name (the footer line is enough).

---

## Phase 5: RETURN

Return a single-line summary:

```
Synthesized: <verdict>. <N> CRITICAL / <N> HIGH / <N> MEDIUM / <N> LOW findings across <K> aspects. Comment drafted at $ARTIFACTS_DIR/review/review-comment.md.
```

### CHECKPOINT
- [ ] `$ARTIFACTS_DIR/review/synthesis.md` written.
- [ ] `$ARTIFACTS_DIR/review/review-comment.md` written.
- [ ] Findings deduplicated across aspects.
- [ ] Severity ordering correct.
- [ ] Skipped aspects listed with reason.
