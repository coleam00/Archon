---
description: Generate tests for a Jira task. Reads the canonical contract, task spec, and ACs; writes test files under tests/ and e2e/.
argument-hint: (none - reads contract.md and task-context.md from $ARTIFACTS_DIR)
---

# Generate Task Tests

**Inputs**:
- `$ARTIFACTS_DIR/contract.md` — **canonical**. The technical
  contract names every file, export, signature, query, and
  invariant your tests must align with.
- `$ARTIFACTS_DIR/task-context.md` — the original ticket: title,
  description, acceptance criteria.

---

## Your Mission

Write high-signal tests that cover every acceptance criterion in
`$ARTIFACTS_DIR/task-context.md`, **agreeing with the contract** at
`$ARTIFACTS_DIR/contract.md` on every interface decision.

Every acceptance criterion must be covered by at least one test that
would fail before the implementation exists and pass once the criterion
is implemented. Do not paraphrase a criterion into something easier to
test. If a criterion cannot be tested with the available project shape,
report it explicitly in the final status.

The contract is canonical. If the contract names a file path
(e.g. `src/pages/ClosedCasePage.tsx`), import from that path —
not from a stub, not from a placeholder. The test runner will
report "module not found" for paths the implementation hasn't
written yet; that is the correct red state and is more
informative than a stub that silently passes against a placeholder
return value. **Do not create stub files like `__stubs__/X.ts` to
satisfy missing imports.**

The tests you write must be clean TypeScript and clean ESLint. A test
that fails because the product behavior is missing is good. A test that
fails because of a TypeScript error, ESLint error, unused variable,
missing import (when the contract specifies the path the
implementation will create), invalid fixture type, or malformed
Playwright/Vitest API usage is invalid.

## Phase 1: LOAD - Gather Context

Read in this order:
- `$ARTIFACTS_DIR/contract.md` — **first and most important**. This
  is the canonical interface definition. Note every file path,
  export, signature, query, and invariant. Your tests must align
  with these.
- `$ARTIFACTS_DIR/task-context.md` — task summary, description, and
  acceptance criteria. This is the behavioral specification.
- `$ARTIFACTS_DIR/parent-epic-context.md` if present — parent Epic
  framing, PRD highlights, and architectural assumptions.
- `$ARTIFACTS_DIR/parent-attachments.md` if present — TechSpec,
  DesignDoc, STYLE_GUIDE, schema, API contracts, design tokens, and
  project conventions.
- Existing project configuration and test patterns needed to write
  compatible tests.

**PHASE_1_CHECKPOINT:**
- [ ] Every acceptance criterion is listed in your notes
- [ ] Every contract `files:` entry is in your notes — you know
      which paths to import from
- [ ] Every contract `signatures:` entry is in your notes — you
      know what shape your tests must instantiate / invoke
- [ ] Every contract `queries_used:` entry is in your notes — you
      know which Convex queries to mock and what shape they return
- [ ] Existing test framework and file conventions are identified
- [ ] TypeScript, ESLint, Vitest, and Playwright conventions are known

## Phase 2: PLAN - Map Criteria to Tests

Create a concise test plan:
- Map each acceptance criterion to one or more tests.
- Choose Vitest for pure units, backend mutations/queries/actions,
  component logic, and focused integration seams.
- Choose Playwright only for user-visible behavior or end-to-end flows
  that genuinely require a browser.
- Prefer product contracts and observable behavior over implementation
  details.
- Identify any external services that need realistic mocks. Mock only
  true external services such as AI APIs, OAuth providers, email
  delivery, payment providers, or network-only integrations.

Do not design tests around selectors, fixture values, fake IDs, or
implementation guesses unless those details are explicitly required by
the ticket or existing public UI/API contract.

**PHASE_2_CHECKPOINT:**
- [ ] Every acceptance criterion has planned coverage
- [ ] Each test would fail for missing product behavior, not for bad
  setup
- [ ] Playwright is used only where browser behavior is required
- [ ] Planned mocks do not mock the system under test

## Phase 3: GENERATE - Write Tests and Minimal Infrastructure

Write:
- Vitest tests in `tests/<task-id>/<unit-name>.test.ts`, using a
  lowercase task id. Match an existing co-located convention only if the
  repo already has one.
- Playwright tests in `e2e/<task-id>/<flow-name>.spec.ts`, using a
  lowercase task id.
- Test infrastructure only if needed for the tests to run:
  `vitest.config.ts`, `playwright.config.ts`, tsconfig adjustments, and
  minimal `package.json` changes.
- Missing test devDependencies only when required: `vitest`,
  `@vitest/ui`, `playwright`, `@playwright/test`, or project-appropriate
  helpers. Be minimal.
- Required npm scripts if missing:
  - `"test"`: runs Vitest, for example `vitest run`
  - `"test:e2e"`: runs Playwright, for example `playwright test`
  - `"lint"`: runs ESLint, for example `eslint .`
  - `"typecheck"`: runs TypeScript no-emit, for example `tsc --noEmit`

The generated tests must not introduce TypeScript or ESLint failures.
Avoid unused imports, unused variables, implicit `any`, incorrect async
handling, unreachable code, floating promises, invalid Playwright
locators, and raw imports from modules that cannot be resolved by
TypeScript.

If a test must import future implementation code that does not exist yet,
keep the test suite typecheck-clean by placing a narrow `@ts-expect-error`
directly above that import only. The comment must name the task and explain
that the import is the intentional red-state implementation seam, for
example:

```ts
// @ts-expect-error WOR-123 red-state import: implementation is created by task-implement.
import { futureFunction } from "../../src/future-module";
```

Do not use `@ts-ignore`, broad file-level suppressions, or suppressions for
anything other than a future implementation import. Raw `TS2307` missing
module errors are invalid generated tests and must be repaired before
handoff.

**PHASE_3_CHECKPOINT:**
- [ ] Tests and config changes are limited to test-shaped files
- [ ] Each test has a real assertion tied to an acceptance criterion
- [ ] No test trivially passes without proving product behavior
- [ ] No implementation source file was modified

## Phase 4: VERIFY - Run Test-Authoring Quality Gates

Verify the tests you wrote before finishing.

Required checks:
- Inspect every changed test for TypeScript and ESLint issues.
- Run the project lint command if available after you add or confirm it.
- Run the project typecheck command if available after you add or confirm
  it.
- Run the relevant Vitest and Playwright commands if the project can run
  them locally.

Expected result:
- Lint and typecheck must pass for the tests you added.
- The behavior tests may fail because the implementation is missing.
  That is the desired red state.
- Do not make tests pass by weakening assertions, mocking the system
  under test, or changing implementation source.

If lint/typecheck fails because of your tests, fix the tests before
finishing. If lint/typecheck fails only because of unrelated pre-existing
source errors, report that distinction clearly.

**PHASE_4_CHECKPOINT:**
- [ ] Generated tests have no ESLint errors
- [ ] Generated tests have no TypeScript errors. Future implementation
  imports, if required, use a narrow task-labeled `@ts-expect-error`.
- [ ] Behavior failures are due to missing implementation, not broken
  test code
- [ ] Any unrelated pre-existing failures are identified separately

## Phase 5: REPORT - Summarize Coverage

Output a concise final status:
- Test files written
- Acceptance criteria covered by each file
- Lint/typecheck commands run and their result
- Test commands run and whether failures are expected red-state product
  failures
- Any acceptance criteria that could not be translated into valid tests

## Rules

- No implementation code. Do not edit anything in `src/`, `convex/`,
  `app/`, or other production source directories.
- No fixtures that test trivially. `expect(true).toBe(true)` is not
  acceptable except for explicit greenfield scaffolding smoke tests.
- No mocks of the system under test. Mock external services only.
- No test-harness gaming. Do not encode assumptions solely from likely
  validation mechanics, generated selectors, fake IDs, or fixture names.
- No dirty test quality. Do not leave unused variables, unused imports,
  TypeScript errors, ESLint errors, invalid async handling, or invalid
  Playwright/Vitest API usage.

## Greenfield Tasks

If the task is project scaffolding and there is no product behavior to
target yet:
- Write a Vitest smoke test at `tests/<task-id>/scaffolding.test.ts`
  that imports Vitest and asserts the test environment is wired.
- Write a Playwright smoke test at `e2e/<task-id>/scaffolding.spec.ts`
  that visits the default local app URL and asserts a successful
  response or visible starter UI.
- Keep these smoke tests lint-clean and typecheck-clean.

## Success Criteria

- **AC_COVERAGE**: Every acceptance criterion has meaningful test
  coverage or an explicit untestable note.
- **RED_FOR_RIGHT_REASON**: Tests fail only because product behavior is
  missing, not because the tests are broken.
- **TYPECHECK_CLEAN**: Generated tests do not introduce TypeScript
  errors. Future implementation imports, if required for a red-state test,
  use a narrow task-labeled `@ts-expect-error` so `tsc --noEmit` passes.
- **LINT_CLEAN**: Generated tests do not introduce ESLint errors.
- **NO_IMPLEMENTATION_EDITS**: Production source files are untouched.
- **COMMITTED_READY**: The generated test suite is ready for the
  deterministic implementation workflow.

