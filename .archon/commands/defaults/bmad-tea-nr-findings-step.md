---
description: Run a finding-only TEA NFR evidence review pass for the current loop round
argument-hint: (none - reads current round from workflow state)
---

# BMAD TEA NFR Evidence Findings Step

This command is a review-only node.
Do not fix code.
Do not edit implementation files.

Read `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/state.json` to determine the current review round.
Use that round number when naming files and findings.

## Story Context

Use the story selected by the `dev-story` node:

- Story name: $dev-story.output.story_name.
- Story key: $dev-story.output.story_key.
- Story file: $dev-story.output.story_file.
- Sprint status: $dev-story.output.sprint_status.

## Required Reads

Read these files before acting:

- `.agents/skills/bmad-testarch-nfr/SKILL.md`.
- The active story file.
- `_bmad-output/project-context.md` if present.
- Relevant implementation artifacts.
- Relevant test artifacts.
- `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/decision-log.md`.
- `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/findings/open-findings.md`.

## Task

Run TEA NFR Evidence Audit for the active story.
For later rounds, verify whether earlier fixes resolved prior NFR concerns and whether new concerns were introduced.
If the story has no applicable NFR, reliability, performance, security, scalability, or critical-path implications, write a not-applicable report and pass this gate.
Write findings to `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/findings/round-{round}-nfr.md`.

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
