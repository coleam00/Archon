---
description: Run bmalph QA automation or TEA test automation for the active Ralph item
argument-hint: (none - reads workflow context and active Ralph item)
---

# bmalph TEA Test Automation Step

This command owns only the TEA test automation step.

User request:
$USER_MESSAGE

## Story Context

Use the story selected by the `bmalph-implementation` node:

- Story name: $bmalph-implementation.output.story_name.
- Story key: $bmalph-implementation.output.story_key.
- Story file: $bmalph-implementation.output.story_file.
- Sprint status: $bmalph-implementation.output.sprint_status.

## Required Reads

Read these files before acting:

- `_bmad/config.yaml` for bmalph project metadata.
- `_bmad/tea/config.yaml`.
- `_bmad-output/project-context.md` if present.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` if present.
- `.ralph/@fix_plan.md`.
- `.ralph/status.json` if present.
- Relevant `.ralph/logs/` files.
- The active story file from `_bmad-output/implementation-artifacts/` if known.
- `.claude/skills/bmad-tea/SKILL.md`.
- `.claude/skills/bmad-testarch-automate/SKILL.md`.
- `.claude/skills/bmad-testarch-automate/checklist.md`.

## Task

Execute the installed TEA Test Automation workflow for the active story or fix-plan item.
Use `_bmad/tea/config.yaml` as the TEA config source.
If `_bmad/tea/config.yaml` is missing, stop and report that the TEA installer-generated config is missing.
Do not fall back to `_bmad/config.yaml` for TEA execution.
Expand test coverage where the story, fix plan, Ralph changes, and Dev Notes demand it.
Do not perform code review.
Do not mark review findings.

End with a concise summary of tests added or changed and validation run.
