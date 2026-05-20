---
description: Generate a rollback plan for risky releases
argument-hint: <release candidate or PR>
---

# DevOps Rollback Plan

**Input**: $ARGUMENTS

---

## Mission

Create a concrete rollback plan for a risky release.

## Process

1. Read deployment, security, QA, and implementation artifacts.
2. Identify rollback commands, data migration constraints, monitoring signals, and ownership.
3. Write `$ARTIFACTS_DIR/devops/rollback-plan.md`.

## Artifact Format

```markdown
# Rollback Plan

## Rollback Trigger

## Fast Rollback Path

## Data Considerations

## Verification After Rollback

## Owner

## Communication Plan
```

## Output

Return the rollback plan path.
