---
description: Groom an incoming Bug ticket. Validate it's a real bug, write reproduction steps, extrapolate acceptance criteria, identify likely-affected files, and assign severity. Output is structured JSON the rest of the bug pipeline reads.
argument-hint: (none - reads task-context.md and parent-attachments.md from $ARTIFACTS_DIR)
---

# Groom Bug Ticket

You are reviewing a Bug ticket as it enters the pipeline. The ticket
was filed by a human (or auto-filed from telemetry). Your job is to
turn the raw report into a structured spec the rest of the pipeline
can act on. Do not write code. Do not edit files. Read.

## Inputs

- `$ARTIFACTS_DIR/task-context.md` — the ticket as filed (summary +
  description). For a bug, the description usually has:
    - what the user did / observed
    - what they expected
    - sometimes a stack trace, error message, or screenshot reference
  Sometimes it has none of that and is just "X doesn't work."
- `$ARTIFACTS_DIR/parent-attachments.md` — TechSpec / DesignDoc from
  the parent Epic if present. Use to ground "what was this feature
  supposed to do?"
- `$ARTIFACTS_DIR/parent-epic-context.md` if present.
- The current codebase (the worktree was checked out at workflow
  start). Use `Glob`/`Grep` to locate the affected surface — but
  only as evidence to inform your verdict, not to write a fix.

## Mission

Produce `$ARTIFACTS_DIR/groomed-bug.json` with a verdict on the
ticket, an extrapolated acceptance-criteria list, and the metadata
the test-strategy phase will need.

## Phase 1: VALIDATE — Is this actually a bug?

Classify the ticket into exactly one of:

- `genuine_bug` — the described behavior contradicts the spec or
  the obvious user expectation. The codebase has a defect.
- `working_as_designed` — the described behavior matches the spec,
  even if the user finds it surprising. (Example: "the form clears
  when I navigate away" but the spec says drafts are session-only.)
- `feature_request_disguised_as_bug` — the user is asking for new
  behavior the spec never promised. (Example: "I want autosave."
  Autosave was never in scope.)
- `environment_or_user_error` — the symptom is caused by user
  setup, network, browser extension, etc. — not the application.
- `cannot_reproduce` — the description is too vague or contradicted
  by the current codebase, and you cannot identify a defect.

Each classification except `genuine_bug` halts the pipeline. The
human triager promoted the ticket; if you say it's not a bug, the
workflow comments on Jira with your reasoning and stops.

If you are uncertain, mark it `genuine_bug` with a low
`confidence` (see schema). The downstream test-strategy phase will
catch a misclassification when it tries and fails to write a
failing test.

## Phase 2: REPRODUCE — Describe the failure precisely

Write a `reproduction` object that names:
- `steps` — ordered list of user actions that trigger the bug
- `expected` — one-sentence expected behavior
- `actual` — one-sentence actual behavior
- `error_signal` — exact error message, stack trace symbol, or
  null if the bug is silent (wrong behavior with no error)

If the report is too vague to reproduce, **mark the bug
`cannot_reproduce`** rather than guessing. A wrong reproduction
sends the test-strategy phase chasing the wrong defect.

## Phase 3: LOCATE — Identify the affected surface

Use `Glob` and `Grep` (not Read — keep the agent's context light).
Identify:
- `affected_files[]` — the production source files most likely to
  contain the defect, with a one-line reason for each. Use `unknown`
  if the report doesn't give enough surface to locate.
- `nearby_tests[]` — existing test files whose scope overlaps the
  affected surface. The test-strategy phase will read these to
  decide whether to update an existing test or write a new one.

You may be wrong about `affected_files`. Mark each entry with a
`confidence: "high" | "medium" | "low"`. The test-strategy phase
treats this as a starting hypothesis, not a constraint.

## Phase 4: EXTRAPOLATE — Acceptance criteria for "fixed"

Write `acceptance_criteria[]` — each item describes a
**verifiable** condition that must be true after the fix lands.
Each AC must be:
- a positive statement of behavior (not "the bug is gone")
- testable with a single deterministic test (not "the user is
  happy")
- scoped to the production behavior, not the test design

Example bad: `AC1: The crash no longer happens.`
Example good: `AC1: When the user clicks "Save Draft" with an
empty body field, the system shows a toast "Draft is empty" and
does not call the saveDraft mutation.`

Always include at minimum:
1. A "regression" AC — a positive statement of the corrected
   behavior at the exact reproduction path.
2. Any related ACs the report implies (other paths through the
   same code surface that would have the same bug).

## Phase 5: SEVERITY — Triage hint for the human

Set `severity` to one of:
- `critical` — data loss, security, payment failure, or core
  user flow is unusable for everyone
- `high` — core flow is broken for some users, or a feature is
  unusable
- `medium` — non-core feature is broken or has wrong behavior
- `low` — cosmetic, edge case, or rare path

This is advisory; the human PM may override it. It informs prompt
prioritization later in the pipeline.

## Output Schema

Write `$ARTIFACTS_DIR/groomed-bug.json` as valid JSON with this
exact shape:

```json
{
  "verdict": "genuine_bug | working_as_designed | feature_request_disguised_as_bug | environment_or_user_error | cannot_reproduce",
  "confidence": "high | medium | low",
  "reasoning": "one paragraph explaining the verdict",
  "reproduction": {
    "steps": ["step 1", "step 2"],
    "expected": "one sentence",
    "actual": "one sentence",
    "error_signal": "exact error or null"
  },
  "affected_files": [
    { "path": "src/...", "reason": "why this is suspect", "confidence": "high|medium|low" }
  ],
  "nearby_tests": [
    { "path": "tests/...", "reason": "what this test currently covers" }
  ],
  "acceptance_criteria": [
    "AC1: positive statement of corrected behavior",
    "AC2: ..."
  ],
  "severity": "critical | high | medium | low",
  "severity_reasoning": "one sentence explaining the severity assessment"
}
```

## Success criteria

- **VERDICT_REACHED**: `verdict` is set. If not `genuine_bug`, the
  workflow halts with your reasoning posted to Jira.
- **REPRODUCTION_OR_HALT**: For `genuine_bug`, `reproduction.steps`
  has at least one entry and `expected`/`actual` are filled. If
  you cannot describe how to reproduce it, set `verdict` to
  `cannot_reproduce`.
- **AT_LEAST_ONE_AC**: For `genuine_bug`, `acceptance_criteria`
  has at least one entry. Each AC is verifiable.
- **NO_EDITS**: No source files were modified.
