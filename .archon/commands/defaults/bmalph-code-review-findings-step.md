---
description: Run a finding-only bmalph code review pass for the current loop round
argument-hint: (none - reads current round from workflow state)
---

# bmalph Code Review Findings Step

This command is a review-only node.
Do not fix code.
Do not edit implementation files.

Read `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/state.json` to determine the current review round.
Use that round number when naming files and findings.

## Story Context

Use the story selected by the `bmalph-implementation` node:

- Story name: $bmalph-implementation.output.story_name.
- Story key: $bmalph-implementation.output.story_key.
- Story file: $bmalph-implementation.output.story_file.
- Sprint status: $bmalph-implementation.output.sprint_status.

## Required Reads

Read these files before acting:

- `_bmad/bmm/workflows/4-implementation/bmad-code-review/SKILL.md`.
- `.ralph/@fix_plan.md`.
- `.ralph/status.json` if present.
- Relevant `.ralph/logs/` files.
- `_bmad-output/project-context.md` if present.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` if present.
- The active story file if known.
- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/decision-log.md`.
- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/findings/open-findings.md`.
- The current git diff.

## Task

Run BMAD code-review as a finding-only pass over the bmalph/Ralph implementation result.
For round 1, review the Ralph implementation and TEA or QA automation output.
For later rounds, verify whether earlier fixes resolved prior concerns and whether new concerns were introduced.
Write findings to `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/findings/round-{round}-code-review.md`.
If there are no findings, write that explicitly.

Each finding must include:

- Source gate: CR.
- Severity.
- What is wrong.
- Evidence.
- Why this is a defect.
- Required fix direction.
- Status: OPEN.

Do not append to the decision log in this command.
The collect-findings command owns decision-log finding entries.
