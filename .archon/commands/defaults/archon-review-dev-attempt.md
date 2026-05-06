---
description: Review the latest dev implementation against the contract and validation feedback. Produce a prescriptive, code-shape-level repair specification for the next dev attempt.
argument-hint: (none - reads latest dev state from $ARTIFACTS_DIR)
---

# Review Implementation

Do not edit files. Review the latest implementation and write
`$ARTIFACTS_DIR/dev-review-latest.json` as valid JSON.

## Mission

Be prescriptive. Your artifact must give the next dev agent the exact
production repair strategy, including concrete code-shape examples when
the problem is specific enough to infer a solution.

The goal is not to restate that validation failed. The goal is to explain
what production surface is wrong, why prior fixes (if any) did not work,
which nearby patterns are compatible or incompatible, and what code shape
is likely to pass in every relevant calling context.

If validation is currently passing, your job is still to verify the
implementation matches the contract and acceptance criteria — a green
test run with a contract violation is still a required repair.

## Inputs To Read

Read:
- `docs/contracts/<lowercase-issue-key>.md` — **canonical**. Derive
  path: lowercase the `issue_key` from
  `$ARTIFACTS_DIR/trigger-payload.json`. The contract is the
  single source of truth for files, exports, signatures, queries
  used, and invariants. Implementation that disagrees with the
  contract is a required repair, even if the test runner does not
  catch it. A frequent root cause of late-round failures is a quiet
  contract violation that earlier reviewers missed.
- `$ARTIFACTS_DIR/task-context.md`
- `$ARTIFACTS_DIR/parent-attachments.md`
- `$ARTIFACTS_DIR/feedback.json` — raw deterministic test output (latest)
- `$ARTIFACTS_DIR/instructions.md` — validator-authored repair instructions (latest)
- `$ARTIFACTS_DIR/dev-review-latest.json` — prior implementation review,
  if it exists. If it does, evaluate whether prior `required_repairs`
  were addressed; if a prior repair was attempted and validation still
  fails, explain why that approach didn't work before proposing a new
  one.
- `git diff origin/main`
- Production files changed by the implementation

Do not read tests, fixtures, Playwright artifacts, screenshots, or
error-context files. You may cite raw validation categories and
production file paths/symbols, but do not copy test names, selectors,
fixture values, assertion wording, screenshots, stack trace line numbers,
or test file paths into repair guidance.

## Review Requirements

1. Identify the specific production contract that is broken (if any).
2. If a prior attempt exists and didn't resolve the issue, explain why.
   Name the wrong surface if the dev fixed a wrapper, export, helper, or
   call site while the actual failure was in another context.
3. Examine nearby production patterns only as evidence. For each
   candidate pattern, decide whether it applies to this exact module
   boundary, runtime, generated-code shape, and calling context.
   Explicitly reject patterns that do not apply.
4. Provide an exact implementation strategy. If the correct shape is
   clear, include a concise TypeScript example or pseudocode snippet in
   `example_code` that the next dev agent can adapt directly.
5. Include an execution trace expectation for every relevant calling
   context. For example: Convex action with `ActionCtx`, direct helper
   invocation with mocked `runQuery`/`runMutation`, internal mutation
   with mutation context, HTTP handler, etc.
6. Predict the next deterministic gate result. If you predict anything
   other than all blocking gates passing, mark `passed: false` and make
   the missing repair explicit.

## JSON Shape

Write valid JSON to `$ARTIFACTS_DIR/dev-review-latest.json` with this
exact shape:

```json
{
  "passed": false,
  "summary": "short review summary",
  "why_previous_attempt_failed": "specific reason the prior attempt did not resolve the current failure, or 'no prior attempt' on first review",
  "broken_contract": {
    "file": "production/file/path.ts",
    "symbol": "symbol or function name",
    "issue": "specific production contract mismatch",
    "acceptance_criteria": ["AC identifier or quoted criterion"]
  },
  "pattern_compatibility": {
    "candidate_pattern": "production reference considered, or unknown",
    "applies": false,
    "reason": "why this pattern does or does not apply to the current runtime and calling contexts",
    "rejected_pattern": "pattern to avoid, or none"
  },
  "required_repairs": [
    {
      "file": "production/file/path.ts",
      "issue": "specific remaining issue",
      "acceptance_criterion": "criterion this repairs",
      "exact_solution": "plain-English exact solution, not just a diagnosis",
      "example_code": "concise TypeScript snippet or pseudocode showing the intended shape; escape newlines as \n",
      "execution_contexts": [
        {
          "context": "where this code runs",
          "expected_flow": "step-by-step expected behavior in this context",
          "failure_to_avoid": "context-specific bug the previous attempt hit"
        }
      ],
      "validation_prediction": "all blocking gates pass for this ticket | remaining expected failure"
    }
  ],
  "acceptance_criteria_gaps": [],
  "scope_violations": [],
  "architecture_risks": [],
  "test_gaming_risks": []
}
```

Set `passed` false if any required repair remains. Empty or vague
`required_repairs` is not acceptable when validation is red. A valid
required repair must include `exact_solution`, `example_code`, and at
least one `execution_contexts` item. Do not recommend production code
that exists only to satisfy a mock, generated-file stub, undefined
placeholder, fixture, or validation harness. If a prior repair copied a
pattern and validation still failed, the next repair must explain why
that pattern is incompatible before proposing code.
