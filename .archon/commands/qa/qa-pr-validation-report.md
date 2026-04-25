---
description: Produce a QA validation report for a PR or release candidate
argument-hint: <PR number, branch, or release candidate>
---

# QA PR Validation Report

**Input**: $ARGUMENTS

---

## Mission

Validate the change and produce a release-ready QA verdict.

## Process

1. Read `$ARTIFACTS_DIR/qa/test-plan.md` if present.
2. Inspect available validation output, test logs, screenshots, and PR metadata.
3. Write `$ARTIFACTS_DIR/qa/validation-report.md`.

## Artifact Format

```markdown
# QA Validation Report

## Verdict

Pass / Pass with risks / Fail

## Evidence

## Tested Scenarios

## Defects

| Severity | Scenario | Evidence | Required Action |
|----------|----------|----------|-----------------|

## Untested Areas

## Release Recommendation
```

## Output

Return the verdict and artifact path.
