---
description: Confirm that an approved PRD or implementation plan is ready to build
argument-hint: <prd path, plan path, issue, or feature request>
---

# Development Confirm Plan

**Input**: $ARGUMENTS

---

## Mission

Confirm the implementation scope before code changes begin.

## Process

1. Read product, design, and security artifacts if present.
2. Inspect the repo for relevant files, APIs, tests, and patterns.
3. Identify the smallest safe implementation path.
4. Write `$ARTIFACTS_DIR/development/implementation-plan.md`.

## Artifact Format

```markdown
# Implementation Plan

## Scope

## Non-Scope

## Files And Modules

| Path | Action | Notes |
|------|--------|-------|

## Implementation Steps

## Validation Commands

## Risks

## Security Triggers

## Rollback Notes
```

## Output

Return the plan path and whether implementation is ready.
