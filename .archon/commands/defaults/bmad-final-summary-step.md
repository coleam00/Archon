---
description: Summarize the BMAD dev-story with TEA fix loop run
argument-hint: (none - reads workflow artifacts)
---

# BMAD Final Summary Step

Summarize the BMAD dev-story with TEA fix loop run.

## Story Context

Use the story selected by the `dev-story` node:

- Story name: $dev-story.output.story_name.
- Story key: $dev-story.output.story_key.
- Story file: $dev-story.output.story_file.
- Sprint status: $dev-story.output.sprint_status.

Read:

- `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/state.json`.
- `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/decision-log.md`.
- `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/findings/open-findings.md`.
- All files under `$ARTIFACTS_DIR/bmad-dev-story-with-tea-fix-loop/reports/`.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`.

Report:

- Final workflow status.
- Story worked on.
- Number of review rounds.
- Findings found.
- Fixes applied.
- Validation evidence.
- Remaining risk, if any.

Keep the report concise and include the decision-log path.
