---
description: Create executable GSD-style phase PLAN.md files with waves and must-haves
argument-hint: <phase number and optional focus>
---

# Create GSD Phase Plans

**Input**: $ARGUMENTS
**Artifacts directory**: $ARTIFACTS_DIR

## Mission

Create executable phase plans that can be implemented by a fresh agent without interpretation.

## Required process

1. Read `$ARTIFACTS_DIR/phase.txt`.
2. Read `$ARTIFACTS_DIR/phase-planning-context.md`.
3. Read `$ARTIFACTS_DIR/phase-research.md`.
4. Read the relevant phase CONTEXT.md if present.
5. Inspect codebase files needed to name exact file paths and validation commands.
6. Write one or more `*-PLAN.md` files under the appropriate `.planning/phases/` directory.

## Planning rules

- Respect locked decisions exactly.
- Exclude deferred ideas.
- Use Claude discretion only where CONTEXT.md allows it.
- Never reduce scope with terms like `v1`, `placeholder`, `static for now`, or `future enhancement` unless the roadmap explicitly says so.
- Prefer vertical slices.
- Keep each plan to 2-3 implementation tasks where possible.
- Assign dependency waves.
- Same-wave plans must not edit the same files.
- Include concrete file paths.
- Include runnable verification commands.
- Include user-observable must-haves.

## Required PLAN frontmatter

Each PLAN.md must include frontmatter fields:

- `phase`
- `plan`
- `type`
- `wave`
- `depends_on`
- `files_modified`
- `autonomous`
- `must_haves`

## Required PLAN body

Each PLAN.md must include:

- Objective
- Context files
- Tasks
- Verification
- Success criteria
- Expected summary output

## Required task structure

For each automated task include:

- Files
- Action
- Verify
- Done

## Final response

Return the phase directory, list of created plans, wave structure, and next command: `archon-gsd-execute-phase`.
