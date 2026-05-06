---
description: Evaluate the latest deterministic test report and write actionable repair instructions for the next dev attempt. Always reads the canonical latest pointers; no attempt-number bookkeeping.
argument-hint: (none - reads latest test state from $ARTIFACTS_DIR)
---

# Validate Deterministic Test Results

Do not edit repository files. Evaluate the latest deterministic test
artifact and write actionable feedback for the next implementation
attempt.

Read:
- `$ARTIFACTS_DIR/task-context.md`
- `$ARTIFACTS_DIR/parent-attachments.md`
- `$ARTIFACTS_DIR/feedback.json` — the canonical latest deterministic
  test report. The test runner script always writes the most recent
  report here.
- `$ARTIFACTS_DIR/dev-review-latest.json` if it exists — prior
  implementation review with required repairs.
- `$ARTIFACTS_DIR/instructions.md` if it exists — your prior validation
  instructions from the previous attempt. Read it to avoid repeating
  failed advice.

Do not read tests, fixtures, Playwright artifacts, screenshots, or
error-context files. Use only the raw report's gate summaries/logs, the
implementation review, and your prior instructions.

Before writing new guidance, compare the latest failure against your
prior `instructions.md` if one exists. If a prior instruction already
recommended a repair and the latest raw report still fails after that
repair was attempted, do not repeat that same repair as the solution.
Mark it as failed prior advice and identify a different production
surface or explain why the repair was never actually applied.

Write `$ARTIFACTS_DIR/instructions.md` (overwriting any prior version)
as Markdown. `feedback.json` must remain the raw deterministic report
from the test node; do not overwrite it. The instructions artifact is
the specification for the next implementation step and must contain
everything needed without reading tests.

Use this exact structure:

```markdown
# Validation Instructions

**Canonical raw feedback**: `$ARTIFACTS_DIR/feedback.json`
**Status**: PASS | FAIL

## Problem

One or two sentences describing the remaining product behavior gap. If
the raw report passed, state that no validation repair is required.

## Acceptance Criteria Impacted

- **Criterion**: {quote or paraphrase the relevant AC from task-context.md}
  **Status**: missing | partial | uncertain
  **Why**: {why the raw report suggests this AC is not satisfied}

## Evidence

- **Gate**: lint | typecheck | vitest | playwright
  **Raw artifact**: {path to raw report or gate log from feedback.json}
  **Product signal**: {product-level interpretation of the failure}
  **Allowed detail**: {only production-relevant file paths, symbols, or error categories}

## Production Repair Plan

1. **Target files**: `production/file/path.ts` or `unknown`
   **Change**: {specific production behavior to implement or repair}
   **Reason**: {how this maps to the impacted AC}

## Prior Advice Check

- **Prior instruction**: present | none
  **Recommended repair**: {what your prior instructions advised, or 'no prior advice'}
  **Was attempted**: yes | no | uncertain
  **Latest result**: fixed | still failing | changed failure
  **Decision**: keep | revise | reject
  **Why**: {why the latest advice must not repeat failed guidance}

## Validation To Rerun

- **Command**: `bash /home/user/Archon/.archon/scripts/task-run-validation.sh`
- **Success condition**: All blocking gates pass for this Jira ticket

## Edge Cases And Risks

- {edge case or risk the next dev agent should consider}

## Out Of Scope Signals

- {raw signal that appears test-specific, unrelated, or unsupported by the ticket}

## Summary

Short product-level summary for quick scanning.
```

Artifact quality bar:
- Include a clear problem statement.
- Include raw evidence references by artifact/log path so the handoff is
  auditable.
- Include production file paths or symbols when the report provides them;
  use `unknown` when the raw report does not support a production target.
- Include a step-by-step production repair plan.
- Include a prior advice check that explicitly rejects any prior repair
  that was already attempted and still failed.
- Include the validation command and success condition.
- Include edge cases and risks the next dev agent or human should consider.
- Keep `feedback.json` as raw test output and put interpreted guidance
  only in `instructions.md`.
- Do not include selectors, fixture values, test names, assertion wording,
  screenshots, stack trace line numbers, or test file paths in repair
  guidance.

Set the returned `passed` field true when every blocking gate in the
deterministic report passed EXCEPT playwright. Playwright is
TEMPORARILY EXCLUDED from the pass/fail decision while the app's
frontend is incomplete; treat any playwright result (passed, failed, or
skipped) as non-decisive. The lint, typecheck, and vitest gates remain
authoritative as before. Return JSON matching the output schema, with
`instructions_file` set to `$ARTIFACTS_DIR/instructions.md` and
`raw_report` set to `$ARTIFACTS_DIR/feedback.json`.
