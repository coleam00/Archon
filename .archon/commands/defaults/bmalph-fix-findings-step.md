---
description: Fix open bmalph, BMAD, and TEA findings for the current loop round and log decisions
argument-hint: (none - reads open findings and current round from workflow state)
---

# bmalph Fix Findings Step

This command owns only fixing findings recorded by the current review round.

Read `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/state.json` to determine the current round.
Read `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/findings/open-findings.md` before editing implementation files.
Read `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/decision-log.md` before editing implementation files.
Read `.ralph/@fix_plan.md`, `.ralph/status.json` if present, relevant `.ralph/logs/`, the active story if known, relevant source files, and relevant test files.

## Story Context

Use the story selected by the `bmalph-implementation` node:

- Story name: $bmalph-implementation.output.story_name.
- Story key: $bmalph-implementation.output.story_key.
- Story file: $bmalph-implementation.output.story_file.
- Sprint status: $bmalph-implementation.output.sprint_status.

## Task

Fix every open finding for the current round that can be fixed safely.
Do not add unrelated changes.
Do not silently ignore any open finding.
If a finding cannot be fixed safely, leave it open and document the blocker.
If the fix requires another Ralph implementation pass, run `bmalph run --no-dashboard` only after recording the intended fix direction in the decision log.
If the fix is narrow and local, apply it directly in this command and validate it.

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
