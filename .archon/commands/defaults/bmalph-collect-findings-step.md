---
description: Consolidate final test-review findings and update the bmalph TEA gate
argument-hint: (none - reads current round from workflow state)
---

# bmalph Collect Findings Step

This command consolidates review findings for the current round.
Do not fix anything in this command.

Read `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/state.json` to determine `round` and `maxRounds`.
Use the current round when reading finding files and assigning finding IDs.

## Story Context

Use the story selected by the `bmalph-implementation` node:

- Story name: $bmalph-implementation.output.story_name.
- Story key: $bmalph-implementation.output.story_key.
- Story file: $bmalph-implementation.output.story_file.
- Sprint status: $bmalph-implementation.output.sprint_status.

## Inputs

Read any current-round finding files that exist under `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/findings/`:

- `round-{round}-code-review.md`.
- `round-{round}-test-review.md`.
- `round-{round}-nfr.md`.
- `round-{round}-trace.md`.

In the current bmalph flow, `post-dev-quality-loop` owns the code review and remediation loop.
The expected final finding file is `round-{round}-test-review.md` from `bmad-testarch-test-review`.
Do not fail just because the code-review, nfr, or trace finding files are absent.

Also read:

- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/decision-log.md`.
- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/findings/open-findings.md`.

## Task

Merge every current-round `Status: OPEN` finding into `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/findings/open-findings.md`.
Assign IDs in the form `R{round}-F{number}`.
Append a matching `### Finding R{round}-F{number}` entry to `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/decision-log.md` for every open finding.

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
Write `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/reports/final-failed.md` with the unresolved findings and decision-log path.
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
