---
description: Run BMAD TEA test automation for the active story
argument-hint: (none - reads workflow context and active story)
---

# BMAD TEA Test Automation Step

This command owns only the TEA test automation step.

User request:
$USER_MESSAGE

## Story Context

Use the story requested by the workflow caller:

- Story argument: $ARGUMENTS.
- Resolve the active story from `_bmad-output/implementation-artifacts/sprint-status.yaml` and `_bmad-output/implementation-artifacts/`.
- Prefer an exact story key, story filename, or story title match from `$ARGUMENTS`.

## Required Reads

Read these files before acting:

- `_bmad/bmm/config.yaml`.
- `_bmad-output/project-context.md` if present.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`.
- The active story file resolved from `$ARGUMENTS`.
- `.agents/skills/bmad-testarch-automate/SKILL.md`.
- `.agents/skills/bmad-testarch-automate/checklist.md` if present.

## Task

Execute TEA Test Automation for the active story.
Expand test coverage where the story and Dev Notes demand it.
Do not perform code review.
Do not mark review findings.

End with a concise summary of tests added or changed and validation run.
