---
description: Convert GSD VERIFICATION.md gaps into executable gap-closure PLAN.md files
argument-hint: <phase number>
---

# Create GSD Gap Closure Plans

**Input**: $ARGUMENTS
**Artifacts directory**: $ARTIFACTS_DIR

## Mission

Convert verification gaps into executable gap-closure plans. Do not execute the plans.

## Required process

1. Read `$ARTIFACTS_DIR/phase.txt`.
2. Read the verification report path from upstream workflow context if present.
3. Read the latest relevant `*-VERIFICATION.md` file.
4. Parse structured gaps from frontmatter and report body.
5. Create one or more new `*-PLAN.md` files in the phase directory with `gap_closure: true`.
6. Write `$ARTIFACTS_DIR/gap-plans.md` summarizing the created plans.

## Required gap plan rules

- Each plan must address specific failed truths.
- Include exact files, actions, verification commands, and done criteria.
- Keep plans small and executable.
- Preserve normal PLAN frontmatter fields.
- Add `gap_closure: true`.

## Final response

Return the gap plans created and the next suggested workflow: `archon-gsd-execute-phase --gaps-only`.
