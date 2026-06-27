---
description: Run a finding-only TEA-style test review pass for the current loop round
argument-hint: (none - reads current round from workflow state)
---

# bmalph TEA Test Review Findings Step

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

- `.claude/skills/bmad-tea/SKILL.md`.
- `.claude/skills/bmad-testarch-test-review/SKILL.md`.
- `_bmad/tea/config.yaml`.
- `_bmad/config.yaml` for bmalph project metadata.
- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/reports/post-dev-quality-loop.md`.
- `.ralph/@fix_plan.md`.
- `.ralph/status.json` if present.
- Relevant `.ralph/logs/` files.
- The active story file if known.
- Related tests.
- Validation output from bmalph/Ralph and post-dev-quality-loop if available.
- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/decision-log.md`.
- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/findings/open-findings.md`.

## Task

Run the installed `bmad-testarch-test-review` workflow for the active story or fix-plan item.
This is the final TEA test-review gate after `post-dev-quality-loop` has already passed code review.
Use `_bmad/tea/config.yaml` as the TEA config source.
If `_bmad/tea/config.yaml` is missing, stop and report that the TEA installer-generated config is missing.
Do not fall back to `_bmad/config.yaml` for TEA execution.
Write findings to `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/findings/round-{round}-test-review.md`.
If there are no findings, write that explicitly.

Each finding must include:

- Source gate: RV.
- Severity.
- What is wrong.
- Evidence.
- Why this is a defect.
- Required fix direction.
- Status: OPEN.

Do not append to the decision log in this command.
The collect-findings command owns decision-log finding entries.
