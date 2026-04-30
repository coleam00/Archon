---
description: Create a GSD-style project intake brief from a user idea or source document
argument-hint: <project idea or path to source document>
---

# GSD Project Intake

**Input**: $ARGUMENTS
**Artifacts directory**: $ARTIFACTS_DIR

## Mission

Create a concise project intake brief for a GSD-style planning flow. Do not create `.planning/` files in the repository during this command.

## Required process

1. Read `$ARTIFACTS_DIR/repo-inspection.md`.
2. Interpret `$ARGUMENTS` as either a source document path or raw project idea.
3. If a referenced file exists, read it and extract the project intent.
4. Inspect the repository enough to understand the stack and constraints.
5. Write `$ARTIFACTS_DIR/project-intake.md`.

## Required output file

`$ARTIFACTS_DIR/project-intake.md` must include:

- Project idea
- Target users
- Desired outcomes
- Non-goals and explicit exclusions
- Existing repository constraints
- Key unknowns
- Initial phase candidates
- Risks requiring research

## Final response

Return the path to `$ARTIFACTS_DIR/project-intake.md` and a short summary of the project direction.
