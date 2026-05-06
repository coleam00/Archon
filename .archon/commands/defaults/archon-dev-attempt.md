---
description: Implement the task using the latest validation feedback and review verdict. Edits production source only; never tests.
argument-hint: (none - reads task spec, contract, and latest validator/review state from $ARTIFACTS_DIR)
---

# Implement Task

**Input**: `$ARTIFACTS_DIR/task-context.md`

---

## Your Mission

Implement the product behavior required by every acceptance criterion in
`$ARTIFACTS_DIR/task-context.md`, **agreeing with the contract** at
`docs/contracts/<lowercase-issue-key>.md` on every interface decision
(file paths, exports, signatures, queries used, invariants). The
ticket context, parent attachments, and contract are the spec;
validation feedback is only an external symptom report.

Passing validation is not the direct objective. The objective is to
implement the requested product behavior within scope, satisfying the
contract. Use validation only to infer which requirement may still be
incomplete.

## Phase 1: LOAD - Gather Context

Read:
- `docs/contracts/<lowercase-issue-key>.md` — **canonical**. Derive
  the path: lowercase the `issue_key` from
  `$ARTIFACTS_DIR/trigger-payload.json` and read that file. The
  contract names every file, export, signature, query, and
  invariant your work must align with. If a signature appears in
  the contract, do not deviate from it. If you believe the contract
  is wrong, write your work the way the contract says and surface
  your concern in your final report.
- `$ARTIFACTS_DIR/task-context.md` — task summary, description, and
  acceptance criteria. This is the behavioral spec.
- `$ARTIFACTS_DIR/parent-attachments.md` — project tech stack,
  architecture, conventions, TechSpec, DesignDoc, STYLE_GUIDE, etc.
- `$ARTIFACTS_DIR/feedback.json` — raw baseline quality gate output.
  Treat this as diagnostic signal, not as a specification.
- `$ARTIFACTS_DIR/instructions.md` if it exists — validator-authored
  repair instructions from a prior deterministic gate.
- `$ARTIFACTS_DIR/dev-review-latest.json` if it exists — implementation
  quality review feedback from a prior attempt.
- Production source files needed to understand the relevant code path.

Do not read tests, fixtures, Playwright artifacts, screenshots, or
error-context files.

**PHASE_1_CHECKPOINT:**
- [ ] Acceptance criteria are listed in your notes
- [ ] Relevant production source areas are identified
- [ ] Validation feedback has been interpreted only as product symptoms

## Phase 2: PLAN - Map Requirements to Source

Create a concise implementation plan:
- Map each acceptance criterion to the production behavior it requires.
- Map each required behavior to likely source files.
- Identify any validation signal that points to an incomplete product
  behavior.
- Ignore validation details that are test-shaped: selectors, fixture
  values, fake IDs, assertion wording, screenshots, stack trace lines,
  test file paths, and artifact paths.

If the ticket is ambiguous, choose the most direct interpretation that
fits the existing architecture. Do not ask for clarification.

**Do not copy patterns blindly.** Existing production code is evidence,
not authority. Before reusing a nearby pattern, prove it works for this
exact module boundary, runtime, generated-code shape, and calling
context. If a pattern fails in any required context, reject that pattern
and implement the direct product behavior instead.

Never add production code whose purpose is to make a stubbed generated
API, mock, fixture, or validation harness behave differently. If the
issue is context plumbing, fix the real production calling contract and
explain why it works in every context.

**PHASE_2_CHECKPOINT:**
- [ ] Every planned edit is justified by the ticket or existing code
- [ ] No planned edit exists solely to satisfy visible test mechanics
- [ ] No test, fixture, generated, or validation artifact file is in scope
- [ ] Any nearby pattern used as evidence has been checked against this
  exact runtime and calling context
- [ ] No planned edit exists to accommodate a mock, stub, generated-file
  placeholder, or validation harness behavior

## Phase 3: IMPLEMENT - Edit Production Code

Make only the production-code edits needed to satisfy the ticket.

Forbidden:
- Reading, creating, modifying, or deleting files under `tests/`, `test/`,
  `e2e/`, `__tests__/`, or matching `*.test.*` / `*.spec.*`
- Editing test fixtures or test configs: `vitest.config.*`,
  `playwright.config.*`, `jest.config.*`
- Running test commands: `npm test`, `npm run test*`, `vitest`,
  `playwright`, `jest`, `npx` test runners, or direct
  `node ./node_modules/.bin/...` test runners
- Editing generated files, generated directories, or validation artifacts
  such as `test-results/`
- Adding fake IDs, hardcoded fixture behavior, test-only branches,
  selector-driven UI, weakened auth, weakened validation, or special
  routes just because validation output exposed them
- Using subagents or delegation tools to inspect the codebase

**PHASE_3_CHECKPOINT:**
- [ ] Edits are limited to production source files in ticket scope
- [ ] No test-shaped behavior or validation-harness workaround was added
- [ ] Existing architecture and style were followed

## Phase 4: VERIFY - Self-Check Without Tests

Review your changed files manually and with non-test commands only when
appropriate. Do not run test runners.

Your self-check must include:

**Requirement mapping.** Each acceptance criterion and the production
behavior implemented for it.

**Validation interpretation.** Product-level symptoms inferred from
feedback, without mentioning selectors, test files, line numbers,
screenshots, fixture values, or artifact paths.

**Scope check.** Changed files and why each one is in ticket scope.

**Anti-gaming check.** Confirm no fake IDs, test selectors, hardcoded
fixtures, generated-file edits, auth weakening, or test-specific
branches were added.

**Execution trace.** For each function or code path you changed,
explicitly walk through what happens when it is invoked. State each
calling context this code path runs in (e.g. "called from a Convex
action with ActionCtx," "called from a unit test with a mock that
provides only `runQuery`/`runMutation`," "called from the HTTP
handler with full request context"). For each context, state what
your code does step by step and confirm it works in that context.
If the code path runs in multiple contexts, the trace must cover
all of them. Surface any context where your implementation would
fail. If you find one, return to Phase 3 before continuing.

**Pre-commit prediction.** State, in one sentence, what you expect
the deterministic gate (lint, typecheck, vitest, playwright) to
report on the next run. If your prediction is anything other than
"all blocking gates pass for this ticket," do not commit — return
to Phase 3 and address the cause of the predicted failure first.

**Repeat-attempt check.** If `$ARTIFACTS_DIR/instructions.md` or
`$ARTIFACTS_DIR/dev-review-latest.json` exists from a prior attempt,
state in one sentence why the previous attempt's fix did not resolve
the issue and why your fix addresses a different surface. If your
fix operates on the same surface as a prior attempt that failed,
your fix is likely also wrong — return to Phase 3 and look for the
deeper cause.

**PHASE_4_CHECKPOINT:**
- [ ] All acceptance criteria are implemented
- [ ] Feedback-linked source issues for this ticket were addressed
- [ ] No forbidden files or commands were used
- [ ] Execution trace covers every calling context for changed code
- [ ] Pre-commit prediction is "all blocking gates pass"
- [ ] If a prior attempt exists, this fix operates on a different
  surface than the prior failed fix

## Phase 5: COMMIT - Save Work

Commit the implementation on the current branch.

The commit message should summarize the ticket behavior implemented. If
you had to make an assumption because the ticket was ambiguous, mention
the assumption in the commit message.

## Success Criteria

- **AC_COMPLETE**: Every acceptance criterion has corresponding
  production behavior.
- **SCOPE_DISCIPLINED**: Every changed file is justified by the ticket
  or existing architecture.
- **NO_TEST_GAMING**: No visible validation detail was turned into a
  test-specific implementation.
- **NO_TEST_ACCESS**: No test, fixture, config, generated, or validation
  artifact files were read or modified; no test runner was executed.
- **CONTEXT_FIDELITY**: Any reused production pattern was validated
  against this change's actual module boundary, runtime, and calling
  contexts; incompatible patterns were rejected instead of copied.
- **EXECUTION_TRACED**: The self-check walked through each calling
  context for changed code and confirmed correctness in each.
- **COMMITTED**: The production implementation is committed.
