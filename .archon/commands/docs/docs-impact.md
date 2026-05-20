---
description: Identify documentation impact from a PRD, PR, or release candidate
argument-hint: <feature, PRD, or PR>
---

# Documentation Impact

**Input**: $ARGUMENTS

---

## Mission

Determine what documentation must change before launch.

## Process

1. Read product, design, implementation, QA, and security artifacts if present.
2. Inspect changed user-facing behavior, APIs, CLI flags, env vars, workflows, and screenshots.
3. Write `$ARTIFACTS_DIR/docs/docs-impact.md`.

## Artifact Format

```markdown
# Documentation Impact

## Verdict

No docs needed / Docs needed / Blocking docs gap

## Required Updates

| Doc Area | Change Needed | Owner | Blocking |
|----------|---------------|-------|----------|

## User-Facing Release Notes

## Internal Enablement Notes

## Open Questions
```

## Output

Return the verdict and artifact path.
