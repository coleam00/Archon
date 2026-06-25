---
description: Fix open BMAD and TEA findings for the current loop round and log decisions
argument-hint: (none - reads open findings and current round from workflow state)
---

# BMAD Fix Findings Step

This command owns only fixing findings recorded by the current review round.

Read `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/state.json` to determine the current round.
Read `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/findings/open-findings.md` before editing implementation files.
Read `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/decision-log.md` before editing implementation files.
Read the active story, relevant source files, relevant test files, and `.agents/skills/bmad-dev-story/SKILL.md`.

## Story Context

Use the story selected by the `dev-story` node:

- Story name: $dev-story.output.story_name.
- Story key: $dev-story.output.story_key.
- Story file: $dev-story.output.story_file.
- Sprint status: $dev-story.output.sprint_status.

## Task

Fix every open finding for the current round that can be fixed safely.
Do not add unrelated changes.
Do not silently ignore any open finding.
If a finding cannot be fixed safely, leave it open and document the blocker.

For each finding, append a `### Fix R{round}-F{number}` entry to the decision log.
Each fix entry must include:

- What was fixed.
- How it was fixed.
- Why this fix was chosen.
- Alternatives considered.
- Files changed.
- Validation run and result.
- Status.

Run the relevant validation commands.
Rewrite `findings/open-findings.md` so it says the fixed findings are pending re-review.
If any finding remains blocked, leave only those blocked findings in `open-findings.md` with rationale.
Update `state.json` with `"round": {round + 1}` and `"status": "running"`.

End with a concise fix summary.
