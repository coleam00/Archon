---
description: Compare a requested scope change against the approved PRD
argument-hint: <scope change request>
---

# Product Scope Change Review

**Input**: $ARGUMENTS

---

## Mission

Decide whether a proposed scope change should be accepted, deferred, or rejected.

## Process

1. Read `$ARTIFACTS_DIR/product/prd.md` if available.
2. Compare the requested change to goals, non-goals, success metrics, risks, and delivery timeline.
3. Identify affected functions: design, development, QA, security, docs, DevOps, services.
4. Write `$ARTIFACTS_DIR/product/scope-change-review.md`.

## Artifact Format

```markdown
# Scope Change Review

## Requested Change

## Decision Recommendation

Accept / Defer / Reject

## Rationale

## Impact

- Product:
- Design:
- Development:
- QA:
- Security:
- Docs:
- DevOps:
- Services:

## Required Approvals

## Follow-Up Actions
```

## Output

Return the recommendation and artifact path.
