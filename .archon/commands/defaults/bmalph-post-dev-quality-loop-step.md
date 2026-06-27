---
description: Run the custom post-dev quality loop after bmalph implementation
argument-hint: (none - reads workflow state and post-dev-quality-loop skill)
---

# bmalph Post-Dev Quality Loop Step

This command owns the handoff from bmalph implementation into the custom `post-dev-quality-loop` skill.
Do not run `bmalph` again in this command.
Do not run the final `bmad-testarch-test-review` in this command.

User request:
$USER_MESSAGE

## Story Context

Use the story selected by the `bmalph-implementation` node:

- Story name: $bmalph-implementation.output.story_name.
- Story key: $bmalph-implementation.output.story_key.
- Story file: $bmalph-implementation.output.story_file.
- Sprint status: $bmalph-implementation.output.sprint_status.
- Implementation summary: $bmalph-implementation.output.implementation_summary.
- Files changed: $bmalph-implementation.output.files_changed.
- Tests run: $bmalph-implementation.output.tests_run.
- Validation summary: $bmalph-implementation.output.validation_summary.

## Required Reads

Read these files before acting:

- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/state.json`.
- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/post-dev-quality-loop-skill.txt`.
- The skill file path named inside `post-dev-quality-loop-skill.txt`.
- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/decision-log.md`.
- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/findings/open-findings.md`.
- `AGENTS.md` and `CLAUDE.md` if present.
- `.ralph/@fix_plan.md`.
- `.ralph/status.json` if present.
- Relevant `.ralph/logs/` files.
- `_bmad/config.yaml`.
- `_bmad/tea/config.yaml`.
- `_bmad-output/project-context.md` if present.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` if present.
- The active story file if known.
- `.agents/skills/bmad-code-review/SKILL.md`.
- `.agents/skills/bmad-dev-story/SKILL.md`.
- `.agents/skills/bmad-testarch-automate/SKILL.md`.
- Current git diff.

## Task

Execute the custom `post-dev-quality-loop` skill exactly as the post-development quality owner.
This node replaces the old explicit review, dev, and review sequence in the bmalph workflow.

The required order is:

1. Audit implementation decisions.
2. Run `bmad-code-review` against both the code and decision audit.
3. If code review fails, run `bmad-dev-story` to fix the review findings.
4. Run `bmad-testarch-automate` after remediation when the fix changes behavior, exposes a coverage gap, or invalidates prior test evidence.
5. Update the decision audit for changed decisions or new automation evidence.
6. Run `bmad-code-review` again.
7. Repeat until `bmad-code-review` passes or a concrete blocker prevents meaningful progress.

Do not start this command with `bmad-dev-story`.
This workflow is invoked after bmalph/Ralph implementation is already complete.

## Artifact Writes

Write the decision audit and quality-loop result to:

- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/reports/post-dev-quality-loop.md`.

Append decision audit entries, remediation decisions, and review outcomes to:

- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/decision-log.md`.

If the loop is blocked, update `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/state.json` with `"status": "failed"` and write the blocker to:

- `$ARTIFACTS_DIR/bmalph-dev-story-with-tea-fix-loop/reports/post-dev-quality-loop-blocked.md`.

If the loop reaches a passing `bmad-code-review`, leave workflow `state.json` in `"status": "running"`.
The final `bmad-testarch-test-review` node owns the final pass/fail gate.

## Output

Return exactly one JSON object with this shape:

```json
{
  "current_state": "review-passed",
  "decision_audit_file": "path to post-dev-quality-loop.md",
  "skills_run": "ordered list of BMAD skills run",
  "review_findings": "code review findings addressed or still open",
  "automation_summary": "test automation added, updated, or explicitly not needed",
  "next_bmad_skill": "bmad-testarch-test-review"
}
```

Use `current_state: "blocked"` and set `next_bmad_skill` to the exact blocked rerun point if the loop cannot continue.
