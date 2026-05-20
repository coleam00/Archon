---
description: Summarize implementation results for downstream review
argument-hint: <implementation context>
---

# Development Implementation Report

**Input**: $ARGUMENTS

---

## Mission

Create an implementation report that downstream QA, security, docs, DevOps, and services workflows can consume.

## Process

1. Inspect git diff and commits.
2. Read validation output and PR metadata if available.
3. Write `$ARTIFACTS_DIR/development/implementation-report.md`.

## Artifact Format

```markdown
# Implementation Report

## Summary

## Changed Files

## Behavior Changes

## Validation Evidence

## Known Limitations

## Security-Relevant Changes

## QA Notes

## Docs Impact

## Rollback Notes
```

## Output

Return the report path and any downstream blockers.
