---
description: Run a finding-only TEA-style NFR evidence review pass for the current loop round
argument-hint: (none - reads current round from workflow state)
---

# bmalph TEA NFR Evidence Findings Step

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
- `.claude/skills/bmad-testarch-nfr/SKILL.md`.
- `_bmad/tea/config.yaml`.
- `_bmad/config.yaml` for bmalph project metadata.
- `.ralph/@fix_plan.md`.
- `.ralph/status.json` if present.
- Relevant `.ralph/logs/` files.
- The active story file if known.
- `_bmad-output/project-context.md` if present.
- Relevant implementation artifacts.
- Relevant test artifacts.
- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/decision-log.md`.
- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/findings/open-findings.md`.

## Task

Run the installed TEA NFR Evidence Audit workflow for the active story or fix-plan item.
Use `_bmad/tea/config.yaml` as the TEA config source.
If `_bmad/tea/config.yaml` is missing, stop and report that the TEA installer-generated config is missing.
Do not fall back to `_bmad/config.yaml` for TEA execution.
For later rounds, verify whether earlier fixes resolved prior NFR concerns and whether new concerns were introduced.
If the story has no applicable NFR, reliability, performance, security, scalability, or critical-path implications, write a not-applicable report and pass this gate.
Write findings to `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/findings/round-{round}-nfr.md`.

Each finding must include:

- Source gate: NR.
- Severity.
- What is wrong.
- Evidence.
- Why this is a defect.
- Required fix direction.
- Status: OPEN.

Do not append to the decision log in this command.
The collect-findings command owns decision-log finding entries.
