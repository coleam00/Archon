---
description: Synthesize all validation findings into a final PR verdict report
argument-hint: (none - reads from artifacts)
---

# PR Validation Report

Synthesize all code review and E2E testing findings into a comprehensive verdict.

---

## Phase 1: Gather All Artifacts

Read every artifact produced by earlier workflow nodes:

```bash
echo "=== Available artifacts ==="
ls -la $ARTIFACTS_DIR/
echo ""
echo "=== Code review (main) ==="
cat $ARTIFACTS_DIR/code-review-main.md 2>/dev/null || echo "NOT AVAILABLE"
echo ""
echo "=== Code review (feature) ==="
cat $ARTIFACTS_DIR/code-review-feature.md 2>/dev/null || echo "NOT AVAILABLE"
echo ""
echo "=== E2E test (main) ==="
cat $ARTIFACTS_DIR/e2e-main.md 2>/dev/null || echo "NOT AVAILABLE (code-review-only PR)"
echo ""
echo "=== E2E test (feature) ==="
cat $ARTIFACTS_DIR/e2e-feature.md 2>/dev/null || echo "NOT AVAILABLE (code-review-only PR)"
```

Also read the PR details:

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number | tr -d '\n')
gh pr view "$PR_NUMBER" --json title,body,url,headRefName,baseRefName,additions,deletions,changedFiles
```

List all screenshots taken:

```bash
ls $ARTIFACTS_DIR/e2e-*.png 2>/dev/null || echo "No screenshots"
```

If screenshots exist, read a few key ones to include visual context in the report.

---

## Phase 2: Synthesize Findings

### 2.1 Cross-Reference Code Review with E2E Results

For each bug/gap identified:
- **Code review (main)**: Did the code analysis find the bug?
- **E2E test (main)**: Was the bug visible in the UI?
- **Code review (feature)**: Does the code fix look correct?
- **E2E test (feature)**: Is the bug actually fixed in the UI?

### 2.2 Identify Discrepancies

Look for cases where:
- Code review says it's fixed but E2E shows it's not
- E2E shows it's fixed but the code fix is fragile/incomplete
- New issues were found during E2E that code review missed
- Code review found issues that E2E couldn't test

### 2.3 Determine Final Verdict

| Criteria | Required for APPROVE |
|----------|---------------------|
| Bug confirmed on main | Yes (or justified why not) |
| Fix addresses root cause | Yes |
| E2E confirms fix works | Yes (if E2E testable) |
| No regressions | Yes |
| Code quality acceptable | Yes |
| CLAUDE.md compliant | Yes |

---

## Phase 3: Write Final Report

Write to `$ARTIFACTS_DIR/validation-report.md`:

```markdown
# PR Validation Report: #{number}

**Title**: {PR title}
**URL**: {PR URL}
**Branch**: {head} → {base}
**Files**: {count} changed (+{additions} -{deletions})
**Validation Date**: {ISO timestamp}

---

## Verdict: {APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION}

{2-3 sentence executive summary. Be direct: is this PR ready to merge?}

---

## Bug Confirmation

| Claim | Confirmed on Main? | Fixed on Feature? | Evidence |
|-------|--------------------|--------------------|----------|
| {claim 1} | YES/NO | YES/NO | {screenshot refs or code refs} |
| {claim 2} | YES/NO | YES/NO | {screenshot refs or code refs} |

---

## Code Review Summary

### Main Branch (Pre-Fix)
{Brief summary from code-review-main.md — was the bug evident in code?}

### Feature Branch (Post-Fix)
{Brief summary from code-review-feature.md — is the fix correct and optimal?}

**Fix Quality Score**: {n}/5

---

## E2E Testing Summary

{If E2E testing was performed:}

### Main Branch (Bug Reproduction)
{Brief summary from e2e-main.md — was the bug visible in the UI?}

### Feature Branch (Fix Verification)
{Brief summary from e2e-feature.md — is the fix verified in the UI?}

**Fix Confidence**: HIGH / MEDIUM / LOW

{If code-review-only:}

_E2E testing was skipped — this PR's changes are not UI-visible. Validation based on code review only._

---

## Screenshots

{List key screenshots with descriptions:}

| Screenshot | Description |
|------------|-------------|
| `e2e-main-01-initial.png` | {what it shows} |
| `e2e-feature-01-initial.png` | {what it shows — compare with main} |

---

## Issues Found

### Must Fix Before Merge
{CRITICAL or HIGH issues from any review stage. If none, say "None."}

### Should Fix (Non-Blocking)
{MEDIUM issues — recommended but not blocking. If none, say "None."}

### Minor / Suggestions
{LOW issues — nice to have. If none, say "None."}

---

## Regressions
{Any new issues introduced by the fix, or "None found."}

---

## What's Done Well
{Positive observations — good patterns, clean code, thorough fix}

---

## Recommendation

**{APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION}**

{Final paragraph: clear recommendation with reasoning. If REQUEST_CHANGES, list the specific changes needed. If NEEDS_DISCUSSION, describe what needs to be discussed.}
```

### 3.1 Post Summary to PR (optional)

If the verdict is clear, post a condensed summary to the PR as a comment:

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number | tr -d '\n')

# Create a concise PR comment
gh pr comment "$PR_NUMBER" --body "$(cat <<'COMMENT'
## Archon PR Validation Report

**Verdict**: {APPROVE / REQUEST_CHANGES}

### Summary
{2-3 sentence summary}

### Bug Confirmation
| Claim | Main | Feature |
|-------|------|---------|
| {claim} | {status} | {status} |

### Issues
{List any must-fix issues, or "No blocking issues found."}

---
_Validated by archon-validate-pr workflow_
COMMENT
)"
```

---

## Success Criteria

- **ALL_ARTIFACTS_READ**: Every available artifact loaded and analyzed
- **CROSS_REFERENCED**: Code review and E2E results reconciled
- **VERDICT_DETERMINED**: Clear APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION
- **REPORT_WRITTEN**: `$ARTIFACTS_DIR/validation-report.md` created
- **PR_COMMENTED**: Summary posted to the PR
