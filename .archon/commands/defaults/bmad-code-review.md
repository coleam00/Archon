---
description: Run a finding-only BMAD code review pass for the current loop round
argument-hint: (none - reads current round from workflow state)
---

# BMAD Code Review Findings Step

This command is a review-only node.
Do not fix code.
Do not edit implementation files.

Read `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/state.json` to determine the current review round.
Use that round number when naming files and findings.

## Story Context

Use the story requested by the workflow caller:

- Story argument: $ARGUMENTS.
- Resolve the active story from `_bmad-output/implementation-artifacts/sprint-status.yaml` and `_bmad-output/implementation-artifacts/`.
- Prefer an exact story key, story filename, or story title match from `$ARGUMENTS`.

## Required Reads

Read these files before acting:

- `.agents/skills/bmad-code-review/SKILL.md`.
- `.agents/skills/bmad-code-review/steps/step-01-gather-context.md`.
- `.agents/skills/bmad-code-review/steps/step-02-review.md`.
- `.agents/skills/bmad-code-review/steps/step-03-triage.md`.
- `.agents/skills/bmad-code-review/steps/step-04-present.md`.
- `_bmad-output/project-context.md` if present.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`.
- The active story file.
- `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/decision-log.md`.
- `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/findings/open-findings.md`.
- The current git diff.

## Non-Interactive Route Contract

Use BMAD code-review as the review method and preserve its native story handoff behavior as much as possible.
This Archon node only removes interactive pauses that would block the DAG.
When BMAD step-04 asks how to handle `patch` findings, choose the non-interactive equivalent of leaving findings as action items for `bmad-dev-story`.
Do not apply patches in this node.
Do let BMAD code-review write findings to the story file and update story or sprint status according to its own rules.
Do not offer next steps after the route decision; return the required JSON instead.

Blocking findings for this route are:

- `decision_needed` findings.
- `patch` findings.
- Any failed, timed out, empty, or unparseable required review layer.

Non-blocking findings for this route are:

- `defer` findings, because BMAD classifies them as pre-existing and not actionable for this change.
- `dismiss` findings, because BMAD classifies them as noise, false positives, or handled elsewhere.

`findings_count` means the number of blocking open code-review findings left for `bmad-dev-story`.
Return `gate: "FAIL"` when `findings_count` is greater than zero.
Return `gate: "PASS"` only when `findings_count` is zero and the BMAD review completed enough to trust the result.

## Task

Run BMAD code-review as a finding-only pass.
For round 1, review the dev-story and TEA automation output.
For later rounds, verify whether earlier fixes resolved prior concerns and whether new concerns were introduced.
Write findings to `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/findings/round-{round}-code-review.md`.
If there are no findings, write that explicitly.
Document non-blocking `defer` and `dismiss` findings in the round report, but do not write them as `Status: OPEN` route-loop findings.

Each blocking finding must include:

- Source gate: CR.
- Severity.
- What is wrong.
- Evidence.
- Why this is a defect.
- Required fix direction.
- Status: OPEN.

This workflow routes directly from code review back to dev-story, so this command owns route-loop finding consolidation in addition to BMAD's native story handoff.
When code review finds open issues, rewrite `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/findings/open-findings.md` with the current code-review findings.
Assign finding IDs in the form `R{round}-F{number}`.
Append a matching `### Finding R{round}-F{number}` entry to `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/decision-log.md` for every open code-review finding.
Each decision-log finding entry must include source gate, severity, what is wrong, evidence, why this is a defect, required fix direction, and `Status: OPEN`.

When code review finds no open issues, rewrite `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/findings/open-findings.md` so there are no current open code-review findings.
If no other open findings are present, write `No open findings yet.` under the heading.
Do not select a new story.
Do not fix code.

Final response must be exactly one JSON object with this shape:

```json
{
  "gate": "PASS",
  "round": 1,
  "findings_count": 0,
  "open_findings_file": "path",
  "decision_log_file": "path",
  "code_review_report": "path"
}
```
