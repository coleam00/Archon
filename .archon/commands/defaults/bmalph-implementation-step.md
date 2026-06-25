---
description: Run bmalph transition and Ralph implementation for the active fix plan scope
argument-hint: (none - reads workflow context and bmalph/Ralph state)
---

# bmalph Implementation Step

This command owns only the bmalph transition and Ralph implementation step.

User request:
$USER_MESSAGE

## Required Reads

Read these files before acting:

- `AGENTS.md` and `CLAUDE.md` if present.
- `brain/Vision.md` and `brain/Gotchas.md` if present.
- `bmalph/config.json`.
- `_bmad/config.yaml`.
- `_bmad-output/project-context.md` if present.
- `_bmad-output/planning-artifacts/`.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` if present.
- `.ralph/RALPH-REFERENCE.md`.
- `.ralph/PROMPT.md`.
- `.ralph/@AGENT.md`.
- `.ralph/@fix_plan.md` if present.
- `.agents/skills/bmad-bmalph/SKILL.md`.

## Task

Run the installed bmalph implementation flow from the project root.
Start with `bmalph doctor`.
Fix or report any blocker before implementation.

If `.ralph/@fix_plan.md` does not exist, run `bmalph implement`.
If `.ralph/@fix_plan.md` already exists, preserve existing progress.
Use `bmalph implement --force` only when the user request or changed BMAD artifacts clearly require regenerating Ralph inputs.

Inspect `.ralph/@fix_plan.md` and identify the target story or fix-plan item.
If the user request names a story, prioritize that story or the matching fix-plan item.
If no story is named, use the next unchecked item in `.ralph/@fix_plan.md`.

Run Ralph through bmalph with `bmalph run --no-dashboard`.
Monitor `.ralph/status.json`, `.ralph/logs/`, and `.ralph/@fix_plan.md`.
Stop this step when the targeted item is completed, Ralph exits, or a circuit-breaker/blocker stops progress.

Ralph must keep the repo contracts from `AGENTS.md`, `CLAUDE.md`, `brain/Vision.md`, and `brain/Gotchas.md`.
For bug fixes, reproduce behavior as close to the end-user path as practical before editing.
Use targeted tests first, then broader validation.
Do not weaken tests to pass.
Do not make unrelated changes.

Update `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/state.json` with the active story key, active story name, active story file, `.ralph/@fix_plan.md`, and `.ralph/status.json` when known.

Do not run TEA review gates in this command.
Do not perform code review in this command.

Final response must be exactly one JSON object with this shape:

```json
{
  "story_name": "Selected bmalph/Ralph story or fix-plan item title",
  "story_key": "Selected story key, fix-plan item id, or stable identifier",
  "story_file": "Path to selected BMAD story file or .ralph/@fix_plan.md",
  "sprint_status": "Current bmalph/Ralph status for the item",
  "implementation_summary": "Concise bmalph/Ralph implementation summary",
  "files_changed": "Concise list or summary of files changed",
  "tests_run": "Tests and validation commands run",
  "validation_summary": "Validation result summary"
}
```
