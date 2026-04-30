---
description: Identify phase gray areas and decision prompts before GSD planning
argument-hint: <phase number and optional focus>
---

# Identify GSD Phase Gray Areas

**Input**: $ARGUMENTS
**Artifacts directory**: $ARTIFACTS_DIR

## Mission

Identify the implementation decisions that must be resolved before planning can produce executable, unambiguous phase plans.

## Required process

1. Read `$ARTIFACTS_DIR/planning-context.md`.
2. Read `$ARTIFACTS_DIR/codebase-scout.md`.
3. Compare the roadmap phase goal, requirements, existing decisions, and codebase patterns.
4. Avoid re-asking questions already answered in existing CONTEXT.md or STATE.md.
5. Write `$ARTIFACTS_DIR/gray-areas.md`.

## Required output file

`$ARTIFACTS_DIR/gray-areas.md` must include:

- Phase summary
- Already locked decisions
- Remaining gray areas
- Recommended decision options for each gray area
- Suggested defaults where Claude can decide
- Scope creep candidates that should be deferred

## Final response

Return the path to `$ARTIFACTS_DIR/gray-areas.md` and list the decisions needing human input.
