---
description: Review generated tests against the contract and acceptance criteria. Writes the canonical latest review verdict; if a prior review exists, also verifies its required repairs were applied.
argument-hint: (none - reads contract, task spec, and tests from $ARTIFACTS_DIR + worktree)
---

# Review Generated Tests

**Inputs**:
- `$ARTIFACTS_DIR/contract.md` — canonical interface contract
- `$ARTIFACTS_DIR/task-context.md` — ticket spec + AC
- `$ARTIFACTS_DIR/test-review-latest.json` — prior review verdict, if it exists
- Generated test files under `tests/` and `e2e/`

---

## Your Mission

Review the tests generated for this task. Your job is to verify
three things at once:

1. **Tests cover the acceptance criteria.** Every AC in
   `task-context.md` is exercised by at least one test that would
   fail before the implementation exists.
2. **Tests align with the contract.** Imports come from the file
   paths the contract names; signatures match what the contract
   specifies; mocks for Convex queries match the contract's
   `queries_used` list and shapes.
3. **The contract itself is sufficient.** Does the contract provide
   enough detail for the tests to be meaningful? If the contract
   is vague, ambiguous, or missing fields the tests need, flag it
   as `state: contract_inadequate` and the workflow will regenerate
   the contract before continuing.

If `$ARTIFACTS_DIR/test-review-latest.json` exists, this is a
re-review after a repair pass. Verify every `required_repairs[]`,
`selector_conflicts[]`, `unflushed_timer_tests[]`, `weak_tests[]`,
and `lint_typecheck_risks[]` entry from the prior verdict was
actually addressed. If repairs introduced new issues, flag them.

Expected red state: tests will fail with "module not found" or
similar errors when the implementation hasn't been written yet.
That is correct. Do NOT flag those as test bugs. Flag stub files
(e.g. `__stubs__/X.ts` placeholder shims) as a smell — the contract
replaced the need for them.

Do not edit files. Produce a durable artifact for downstream repair
and validation nodes.

The artifact you write is the specification for the next step. Be
precise enough that a repair agent can act without hidden context.

## Phase 1: LOAD - Gather Review Inputs

Read in this order:
- `$ARTIFACTS_DIR/contract.md` — first and canonical. Internalize
  every `files:`, `exports:`, `signatures:`, `queries_used:`,
  `invariants:`, and `tested_by:` entry.
- `$ARTIFACTS_DIR/task-context.md`
- `$ARTIFACTS_DIR/parent-epic-context.md` if present
- `$ARTIFACTS_DIR/parent-attachments.md` if present
- `$ARTIFACTS_DIR/test-review-latest.json` if it exists — your prior
  verdict. Treat each prior `required_repairs[]` entry as a
  must-verify-fixed item.
- Generated test files under `tests/` and `e2e/`
- Test configuration and package scripts changed by this workflow

**PHASE_1_CHECKPOINT:**
- [ ] Contract entries are loaded — you know what interfaces tests
      must align with
- [ ] Acceptance criteria are loaded
- [ ] Prior verdict (if any) is loaded and each prior repair item
      mapped to its target file/test
- [ ] Generated test files are identified
- [ ] Relevant test config changes are identified

## Phase 1.5: SELECTOR SANITY CHECK — Catch Unsatisfiable Tests

Before evaluating quality, verify that the tests are **mechanically
satisfiable**. This catches a class of failure where multiple tests
use selectors that cannot all match correctly at the same time —
the dev agent will burn its full attempt budget chasing an
impossible target because it cannot read or modify tests.

### What to look for

For each `tests/**/*.test.{ts,tsx}` and `e2e/**/*.spec.{ts,tsx}`:

**(a) `getBy*` (singular) selectors must match exactly one element.**
Scan every `getByRole(...)`, `getByText(...)`, `getByLabelText(...)`,
`getByTitle(...)`, etc. Trace what the rendered output (per the
contract) will produce. Flag any selector whose pattern could
match more than one element. Common traps:

- Substring-matching regexes like `/copy link/i` when the rendered
  DOM contains both a "Copy link" button AND a "Just copy link"
  button — both match. Use anchored regexes (`/^Copy link$/i`) when
  the visible text or aria-label conflicts with another element's
  accessible name.
- `getByText(/error/i)` when multiple elements contain the word "error".
- `getByRole("button", { name: ... })` patterns that could match
  more than one button on the page (especially when buttons share
  a common verb like "Copy", "Save", "Open").

**(b) Selector conflicts across tests must form a satisfiable system.**
Two tests can each use `getBy*` selectors that match different
elements — but if those selectors create logically incompatible
constraints on element accessible names, neither implementation
can satisfy both. Specifically:

- If test A wants `getByRole("button", { name: /copy link/i })` and
  test B wants `getByRole("button", { name: /just copy link/i })`,
  any element accessible name containing "just copy link" will
  also match test A's regex (because "copy link" is a substring
  of "just copy link"). No aria-label combination can satisfy
  both. **This is a contradiction. Flag it.**
- More generally: list each `getBy*` query's regex/pattern, then
  check whether any pair of patterns has a substring/superset
  relationship that would force ambiguity.

**(c) Fake-timer tests must use `act()` and/or `waitFor()`.**
If a test uses `vi.useFakeTimers()` and calls
`vi.advanceTimersByTime(...)`, the React state updates triggered
by setTimeout callbacks are not flushed synchronously. The
assertion immediately after the timer-advance call will see stale
DOM. Tests must either:
- Wrap the timer-advance in `await act(async () => { ... })`, OR
- Wrap the post-timer assertion in `await waitFor(() => ...)`.
Flag any test that advances fake timers and then asserts without
a flushing wrapper.

**(d) `__stubs__/X.ts` files are a smell.**
The contract names the file paths the dev agent will create. Test
imports should target those paths directly with a narrow
task-labeled `@ts-expect-error`. If a stub file exists, flag it
as a `required_repair`: the test should import from the
contracted path and accept module-not-found as the red state.

### What to write into the review

Add a `selector_conflicts: []` array to the review JSON. Each
entry must name:
- The conflicting selectors (file:line for each).
- The element shapes that would make them ambiguous.
- The recommended fix (anchor the regex, change the visible
  text/aria-label, switch to a different selector type).

Add an `unflushed_timer_tests: []` array for tests that advance
fake timers without `act()`/`waitFor()`.

A failed Phase 1.5 sanity check is **always** a `required_repair`
because tests with these issues will burn the dev-loop budget on
an impossible target. Set `passed: false` if any selector conflict
or unflushed-timer issue exists.

**PHASE_1.5_CHECKPOINT:**
- [ ] Every `getBy*` (singular) selector traced against contract output
- [ ] No two selectors have a substring/superset relationship that
      forces ambiguity
- [ ] Every fake-timer-advance is wrapped in `act()` or followed
      by `waitFor()`
- [ ] No `__stubs__/X.ts` files exist; tests import from contracted paths
- [ ] `selector_conflicts` and `unflushed_timer_tests` populated in
      the review JSON if any issues found

## Phase 2: REVIEW - Evaluate Test Quality

Evaluate:
- Does every acceptance criterion have meaningful coverage?
- Would each test fail for the missing product behavior, not because the
  test is malformed?
- Are tests based on product contracts and observable behavior?
- Are Playwright tests limited to browser-visible behavior?
- Are mocks limited to external services?
- Are assertions strong enough to guide implementation?
- Are there obvious TypeScript or ESLint problems in the generated tests?
- Do future implementation imports use narrow task-labeled
  `@ts-expect-error` comments so raw `TS2307` errors cannot reach
  validation?
- Are any tests likely to push the implementation agent toward
  test-harness gaming, fake IDs, selectors, or fixture-specific behavior?
- **If a prior review exists:** was each prior `required_repairs[]`
  entry actually addressed? Did the repair introduce a new issue?

**PHASE_2_CHECKPOINT:**
- [ ] AC coverage gaps are listed
- [ ] Weak or misleading tests are listed
- [ ] Mechanical test-quality risks are listed
- [ ] Test-gaming risks are listed
- [ ] Prior repair items (if any) verified as fixed or surfaced as
      still-broken

## Phase 3: WRITE - Save Review Artifact

Write `$ARTIFACTS_DIR/test-review-latest.json` (overwriting any
prior version) as valid JSON with this shape:

```json
{
  "passed": true,
  "summary": "short review summary",
  "coverage_gaps": [],
  "weak_tests": [],
  "lint_typecheck_risks": [],
  "gaming_risks": [],
  "selector_conflicts": [],
  "unflushed_timer_tests": [],
  "required_repairs": []
}
```

Set `"passed": false` if any required repair remains, including any
`selector_conflicts` or `unflushed_timer_tests` entries from
Phase 1.5 — those will burn the dev-loop budget if not fixed first.

Each item in `required_repairs` must include:
- `file`
- `issue`
- `required_change`
- `acceptance_criterion`

## Success Criteria

- **ARTIFACT_WRITTEN**: `$ARTIFACTS_DIR/test-review-latest.json` exists
  and is valid JSON.
- **AC_REVIEWED**: Every acceptance criterion was checked.
- **PRIOR_REPAIRS_VERIFIED**: If a prior verdict existed, every prior
  `required_repairs[]` was checked as fixed or re-flagged as still
  broken.
- **ACTIONABLE**: Every required repair names a file and change.
- **NO_EDITS**: No repository files were modified by this review.
