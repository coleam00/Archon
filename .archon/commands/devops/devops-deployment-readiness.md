---
description: Review deployment readiness, operational risk, and production prerequisites
argument-hint: <release candidate, PR, or implementation report>
---

# DevOps Deployment Readiness

**Input**: $ARGUMENTS

---

## Mission

Determine whether the change is ready to deploy safely.

## Process

1. Read product, development, QA, security, and docs artifacts if present.
2. Inspect migrations, configuration, env vars, infrastructure, CI, release scripts, and rollback paths.
3. Write `$ARTIFACTS_DIR/devops/deployment-plan.md`.

## Artifact Format

```markdown
# Deployment Readiness

## Verdict

Ready / Ready with caveats / Blocked

## Deployment Steps

## Required Config Or Secrets

## Migration Notes

## Monitoring And Alerts

## Rollback Readiness

## Blockers
```

## Output

Return the verdict and artifact path.
