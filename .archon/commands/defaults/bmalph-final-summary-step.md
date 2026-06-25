---
description: Summarize the bmalph implementation with TEA fix loop run
argument-hint: (none - reads workflow artifacts)
---

# bmalph Final Summary Step

Summarize the bmalph implementation with TEA fix loop run.

## Story Context

Use the story selected by the `bmalph-implementation` node:

- Story name: $bmalph-implementation.output.story_name.
- Story key: $bmalph-implementation.output.story_key.
- Story file: $bmalph-implementation.output.story_file.
- Sprint status: $bmalph-implementation.output.sprint_status.

Read:

- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/state.json`.
- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/decision-log.md`.
- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/findings/open-findings.md`.
- All files under `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/reports/`.
- `.ralph/@fix_plan.md` if present.
- `.ralph/status.json` if present.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` if present.

Report:

- Final workflow status.
- Story worked on.
- Number of review rounds.
- Findings found.
- Fixes applied.
- Validation evidence.
- Remaining risk, if any.

Keep the report concise and include the decision-log path.
