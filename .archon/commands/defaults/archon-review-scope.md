---
description: Establish the scope for the parallel reviewer cascade after open-pr. Captures the diff, files, ACs, and writes the scope artifact reviewers will read.
argument-hint: (none - reads PR + task context from $ARTIFACTS_DIR)
---

You are the SCOPE reviewer. Read `$ARTIFACTS_DIR/review/scope.md` and
look at the PR diff with `git diff origin/main`.

Evaluate whether the work stayed within scope:
- **Files in scope**: for each changed file, is it relevant to what the
  ticket asked for? Flag unrelated touches and drive-by edits — when
  someone asked to update a modal, we should not be changing an auth
  route.
- **AC coverage**: does the diff address each acceptance criterion?
  Flag unimplemented or partial ACs. Flag work that goes BEYOND the
  ACs — extra features the ticket didn't ask for.

You are NOT judging code quality, security, error handling, or
documentation — other reviewers cover those.

Write `$ARTIFACTS_DIR/review/scope-findings.md` following the same
format the other reviewers use:

```markdown
# Scope Review Findings: PR #{number}

**Reviewer**: scope-review
**Date**: {ISO timestamp}
**Files Reviewed**: {count}

## Summary
{2-3 sentence overview}
**Verdict**: APPROVE | REQUEST_CHANGES | NEEDS_DISCUSSION

## Findings

### Finding 1: {Descriptive Title}
**Severity**: CRITICAL | HIGH | MEDIUM | LOW
**Category**: scope-creep | unrelated-change | missing-ac | ac-overreach
**Location**: `{file}:{line}` (or `(plan-level)` for AC concerns)
**Issue**: {description}
**Evidence**: `{file path or snippet}`
**Why This Matters**: {impact}

## Statistics
Total findings: {n}
- CRITICAL: {n}
- HIGH: {n}
- MEDIUM: {n}
- LOW: {n}
```

Severity guidance:
- CRITICAL: a critical AC is unimplemented, or files were touched that
  risk breaking unrelated systems.
- HIGH: an AC is partial, or scope creep is large enough to warrant
  a separate ticket.
- MEDIUM: small unrelated change snuck in, or AC met loosely.
- LOW: minor commentary, no real action needed.

After writing, post to PR:
  gh pr comment "$(cat $ARTIFACTS_DIR/.pr-number)" \
    --body-file "$ARTIFACTS_DIR/review/scope-findings.md"

Return STRICT JSON only:
  {"verdict":"...","critical_count":N,"high_count":N,"medium_count":N,"low_count":N}

