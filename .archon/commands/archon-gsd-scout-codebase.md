---
description: Scout the codebase for patterns relevant to a GSD phase discussion
argument-hint: <phase number and optional focus>
---

# GSD Codebase Scout

**Input**: $ARGUMENTS
**Artifacts directory**: $ARTIFACTS_DIR

## Mission

Find reusable codebase patterns and existing assets that should shape phase discussion and planning.

## Required process

1. Read `$ARTIFACTS_DIR/planning-context.md`.
2. Identify the target phase and likely implementation area.
3. Search the repository for analogous features, routes, commands, data models, tests, and conventions.
4. Prefer concrete file paths and concise evidence over broad summaries.
5. Write `$ARTIFACTS_DIR/codebase-scout.md`.

## Required output file

`$ARTIFACTS_DIR/codebase-scout.md` must include:

- Target phase
- Relevant existing patterns
- Candidate files/directories to reuse or mirror
- Testing and validation conventions
- Risks or unknowns for the discussion phase
- Recommended gray-area topics

## Final response

Return the path to `$ARTIFACTS_DIR/codebase-scout.md` and the most important patterns found.
