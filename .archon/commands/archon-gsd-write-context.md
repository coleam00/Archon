---
description: Write a GSD phase CONTEXT.md from gray areas and human decisions
argument-hint: <phase number and approved decisions>
---

# Write GSD Phase Context

**Input**: $ARGUMENTS
**Artifacts directory**: $ARTIFACTS_DIR

## Mission

Create a phase CONTEXT.md that downstream research and planning agents can obey without re-asking the same questions.

## Required process

1. Read `$ARTIFACTS_DIR/phase.txt`.
2. Read `$ARTIFACTS_DIR/planning-context.md`.
3. Read `$ARTIFACTS_DIR/codebase-scout.md`.
4. Read `$ARTIFACTS_DIR/gray-areas.md`.
5. Treat the approval response from the workflow as the user's latest decisions.
6. Write the context into a phase directory under `.planning/phases/`.
7. Write the final context path to `$ARTIFACTS_DIR/context-path.txt`.

## Phase directory rule

Use an existing phase directory if one clearly matches the target phase. If none exists, create `.planning/phases/{phase}-phase/` where `{phase}` is the phase value from `$ARTIFACTS_DIR/phase.txt`.

## Required CONTEXT.md structure

Include:

- Phase goal
- Decisions
- Deferred ideas
- Claude's discretion
- Codebase patterns to preserve
- Constraints and risks
- Research needs
- Planning instructions

Use stable decision IDs such as `D-01`, `D-02`, and `D-03`.

## Final response

Return the context file path and summarize locked decisions, deferred ideas, and discretion areas.
