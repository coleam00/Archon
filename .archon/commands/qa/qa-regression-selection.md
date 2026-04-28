---
description: Select regression areas for a change
argument-hint: <PR, feature, or implementation report>
---

# QA Regression Selection

**Input**: $ARGUMENTS

---

## Mission

Select a targeted regression suite based on changed behavior and risk.

## Process

1. Read implementation and security artifacts if present.
2. Inspect changed files and related modules.
3. Write `$ARTIFACTS_DIR/qa/regression-selection.md`.

## Artifact Format

```markdown
# Regression Selection

## Changed Behavior

## Required Regression Areas

## Optional Regression Areas

## Rationale
```

## Output

Return the artifact path.
