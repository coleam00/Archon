---
description: Check GSD phase plans for coverage, dependencies, scope, and decision fidelity
argument-hint: <phase number>
---

# Check GSD Phase Plans

**Input**: $ARGUMENTS
**Artifacts directory**: $ARTIFACTS_DIR

## Mission

Verify that the phase plans will achieve the roadmap goal before execution starts.

## Required process

1. Read `$ARTIFACTS_DIR/phase.txt` if it exists.
2. Read relevant `.planning/` artifacts.
3. Read all target phase `*-PLAN.md` files.
4. Evaluate every dimension below.
5. Write `$ARTIFACTS_DIR/plan-check.md`.

## Verification dimensions

- Requirement coverage
- Task completeness
- Dependency correctness
- Key links planned
- Scope sanity
- Must-have derivation
- Context compliance
- Project convention compliance

## Issue severity

Use:

- `blocker` when execution should not proceed.
- `warning` when execution may proceed but quality or maintainability is degraded.
- `info` for suggestions.

## Required output file

`$ARTIFACTS_DIR/plan-check.md` must include:

- Overall status: `passed` or `issues_found`
- Counts by severity
- Coverage table
- Plan summary table
- Structured issue list
- Specific fix hints

## Final response

If there are no blockers, explicitly output `<promise>PLANS_ACCEPTED</promise>`. Otherwise summarize blockers and do not output that promise.
