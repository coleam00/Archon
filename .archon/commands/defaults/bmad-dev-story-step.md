---
description: Run BMAD dev-story for the active story, including review-fix passes
argument-hint: (none - reads workflow context and BMAD sprint status)
---

# BMAD Dev Story Step

This command owns BMAD dev-story execution for both initial implementation and review-fix passes.

User request:
$USER_MESSAGE

## Required Reads

Read these files before acting:

- `AGENTS.md` and `CLAUDE.md` if present.
- `_bmad/bmm/config.yaml`.
- `_bmad-output/project-context.md` if present.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`.
- `.agents/skills/bmad-dev-story/SKILL.md`.
- `.agents/skills/bmad-dev-story/checklist.md`.
- `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/state.json`.
- `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/findings/open-findings.md`.
- `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/decision-log.md`.
- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/state.json` if this command is invoked by the bmalph workflow.
- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/findings/open-findings.md` if this command is invoked by the bmalph workflow.
- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/decision-log.md` if this command is invoked by the bmalph workflow.

## Invocation Modes

Detect the active workflow directory first.
Use `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop` when that state file exists.
Otherwise use `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop`.

If `open-findings.md` contains current `Status: OPEN` findings, this invocation is a fix pass.
Use the active story from `state.json`.
Do not select a new story.
Run the installed BMAD dev-story workflow against the active story and the open findings as the fix brief.
Fix every open finding that BMAD dev-story can address safely.
For each fixed finding, append a `### Fix R{round}-F{number}` entry to the decision log.
Each fix entry must include what was fixed, how it was fixed, why this fix was chosen, alternatives considered, files changed, validation run, and status.
Rewrite `open-findings.md` so fixed findings are marked pending re-review.
If a finding cannot be fixed safely, leave it open with the blocker and rationale.
Update `state.json` with `"round": {round + 1}` and `"status": "running"`.

If `open-findings.md` has no current open findings, this invocation is the initial implementation pass.
When invoked by the bmalph workflow after review, do not run bmalph or Ralph.
Use BMAD dev-story only.

## Task

Execute the installed BMAD dev-story workflow.
If the user request names a story, implement that story.
If no story is named, let BMAD dev-story select the first `ready-for-dev` story from sprint status.
Follow BMAD dev-story exactly.
Write failing tests first where the story requires implementation.
Run the story-required validation.
Update only the story-file sections permitted by BMAD dev-story.
Update `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/state.json` with the active story key, active story name, and active story file when known.

Do not run TEA review gates in this command.
Do not perform code review in this command.

Final response must be exactly one JSON object with this shape:

```json
{
  "story_name": "Selected BMAD story title",
  "story_key": "Selected BMAD story key or id",
  "story_file": "Path to selected BMAD story file",
  "sprint_status": "Current BMAD sprint status for the story",
  "implementation_summary": "Concise implementation summary",
  "files_changed": "Concise list or summary of files changed",
  "tests_run": "Tests and validation commands run",
  "validation_summary": "Validation result summary"
}
```
