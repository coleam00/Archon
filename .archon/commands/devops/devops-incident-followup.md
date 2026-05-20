---
description: Convert incident notes into remediation and runbook updates
argument-hint: <incident summary or link>
---

# DevOps Incident Follow-Up

**Input**: $ARGUMENTS

---

## Mission

Convert an incident into actionable remediation, runbook updates, and product follow-up.

## Process

1. Read incident notes from input.
2. Identify root cause, contributing factors, detection gaps, and prevention tasks.
3. Write `$ARTIFACTS_DIR/devops/incident-followup.md`.

## Artifact Format

```markdown
# Incident Follow-Up

## Summary

## Customer Impact

## Root Cause

## Detection And Response Gaps

## Remediation Tasks

## Runbook Updates

## Product Follow-Up
```

## Output

Return the artifact path and recommended issues to create.
