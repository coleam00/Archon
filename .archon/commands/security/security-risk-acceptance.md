---
description: Document accepted security risk with owner, expiration, and controls
argument-hint: <risk acceptance context>
---

# Security Risk Acceptance

**Input**: $ARGUMENTS

---

## Mission

Document accepted risk when a medium or high security risk is not fixed before release.

## Process

1. Read `$ARTIFACTS_DIR/security/security-review.md`.
2. Capture the approving owner, expiration date, reason, and compensating controls from workflow input or approval response.
3. Write `$ARTIFACTS_DIR/security/risk-acceptance.md`.

## Artifact Format

```markdown
# Security Risk Acceptance

## Risk

## Risk Level

## Owner

## Expiration Or Review Date

## Reason For Acceptance

## Compensating Controls

## Required Follow-Up

## Approval Evidence
```

## Output

Return the artifact path and any missing approval evidence.
