---
description: Review a PR or implementation against design and UX expectations
argument-hint: <PR number, branch, or implementation summary>
---

# Design UI Review

**Input**: $ARGUMENTS

---

## Mission

Review the implementation for design consistency, accessibility, and user-flow quality.

## Process

1. Read `$ARTIFACTS_DIR/design/design-brief.md` and `$ARTIFACTS_DIR/development/implementation-report.md` if present.
2. Inspect changed UI files and any screenshots or validation artifacts.
3. Compare implementation against existing UI patterns.
4. Write `$ARTIFACTS_DIR/design/ux-review.md`.

## Artifact Format

```markdown
# UX Review

## Verdict

Pass / Pass with follow-ups / Blocked

## Findings

| Severity | Area | Finding | Required Action |
|----------|------|---------|-----------------|

## Accessibility Notes

## Visual Consistency Notes

## User Flow Notes

## Approval Recommendation
```

## Output

Return the verdict and artifact path.
