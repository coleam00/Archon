---
description: Consolidate current-round findings and update the BMAD TEA review gate
argument-hint: (none - reads current round from workflow state)
---

# BMAD Collect Findings Step

This command consolidates review findings for the current round.
Do not fix anything in this command.

Read `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/state.json` to determine `round` and `maxRounds`.
Use the current round when reading finding files and assigning finding IDs.

## Story Context

Use the story selected by the `dev-story` node:

- Story name: $dev-story.output.story_name.
- Story key: $dev-story.output.story_key.
- Story file: $dev-story.output.story_file.
- Sprint status: $dev-story.output.sprint_status.

## Inputs

Read all current-round finding files under `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/findings/`:

- `round-{round}-code-review.md`.
- `round-{round}-test-review.md`.
- `round-{round}-nfr.md`.
- `round-{round}-trace.md`.

Also read:

- `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/decision-log.md`.
- `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/findings/open-findings.md`.

## Task

Merge every current-round `Status: OPEN` finding into `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/findings/open-findings.md`.
Assign IDs in the form `R{round}-F{number}`.
Append a matching `### Finding R{round}-F{number}` entry to `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/decision-log.md` for every open finding.

Each decision-log finding entry must include:

- Source gate.
- Severity.
- What is wrong.
- Evidence.
- Why this is a defect.
- Required fix direction.
- Status: OPEN.

If there are no open findings, update `state.json` with `"status": "complete"` and the current `round`.
Return JSON with `gate` set to `PASS`.

If there are open findings and the current round is lower than `maxRounds`, update `state.json` with `"status": "running"` and the current `round`.
Return JSON with `gate` set to `FAIL`.

If there are open findings and the current round equals `maxRounds`, update `state.json` with `"status": "failed"` and the current `round`.
Write `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/reports/final-failed.md` with the unresolved findings and decision-log path.
Return JSON with `gate` set to `FAIL`.

Final response must be exactly one JSON object with this shape:

```json
{
  "gate": "PASS",
  "round": 1,
  "findings_count": 0,
  "open_findings_file": "path",
  "decision_log_file": "path"
}
```
