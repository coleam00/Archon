---
description: Review customer impact and enablement needs for a change
argument-hint: <feature, release candidate, or PR>
---

# Services Customer Impact

**Input**: $ARGUMENTS

---

## Mission

Assess how a change affects customers, implementations, onboarding, support, and professional services delivery.

## Process

1. Read product, docs, QA, security, and deployment artifacts if present.
2. Identify customer-facing behavior, rollout concerns, enablement needs, and migration risks.
3. Write `$ARTIFACTS_DIR/services/customer-impact.md`.

## Artifact Format

```markdown
# Customer Impact Review

## Impact Summary

## Affected Customer Segments

## Enablement Needs

## Migration Or Setup Notes

## Support Risks

## Customer Communication Notes
```

## Output

Return the artifact path and launch blockers.
