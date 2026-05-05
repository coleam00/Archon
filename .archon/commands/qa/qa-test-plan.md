---
description: Generate a QA test plan from PRD, design, security, and implementation artifacts
argument-hint: <feature, PRD, or PR>
---

# QA Test Plan

**Input**: $ARGUMENTS

---

## Mission

Create a focused QA plan that covers functional behavior, regressions, risk areas, and release blockers.

## Process

1. Read product, design, development, and security artifacts if present.
2. Identify test scenarios, regression areas, environments, data needs, and automation opportunities.
3. Write `$ARTIFACTS_DIR/qa/test-plan.md`.

## Artifact Format

```markdown
# QA Test Plan

## Scope

## Out Of Scope

## Test Scenarios

| Scenario | Priority | Method | Expected Result |
|----------|----------|--------|-----------------|

## Regression Areas

## Test Data And Environment

## Automation Candidates

## Release Blockers
```

## Output

Return the test plan path and release blockers.
