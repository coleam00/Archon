---
description: Summarize GSD phase execution results after sequential plan execution
argument-hint: <phase number>
---

# GSD Execution Summary

**Input**: $ARGUMENTS
**Artifacts directory**: $ARTIFACTS_DIR

## Mission

Summarize phase execution after `archon-gsd-execute-phase` has completed its plan loop.

## Required process

1. Read `$ARTIFACTS_DIR/phase.txt`.
2. Read `$ARTIFACTS_DIR/phase-plans.md`.
3. Read relevant `.planning/phases/**/SUMMARY.md` files.
4. Inspect git status and recent commits.
5. Write `$ARTIFACTS_DIR/execution-summary.md`.

## Required output file

`$ARTIFACTS_DIR/execution-summary.md` must include:

- Phase executed
- Plans completed
- Summary files created
- Key changes
- Validation commands run
- Deviations from plan
- Blockers or follow-up items
- Next suggested workflow: `archon-gsd-verify-work`

## Final response

Return the path to `$ARTIFACTS_DIR/execution-summary.md` and a concise execution summary.
