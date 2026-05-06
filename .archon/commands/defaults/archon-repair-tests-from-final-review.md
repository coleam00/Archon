---
description: After the dev-loop converges with test-side-only blockers, apply the final reviewer's required repairs. Edits test files only (cage-enforced); never production source.
argument-hint: (none - reads dev-review-final.json from $ARTIFACTS_DIR)
---

# Repair Tests From Final Implementation Review

The dev-loop produced production code that the final reviewer judged
correct on the ACs, but the reviewer flagged remaining test-file
defects. Apply each `required_repairs` item from the review verdict,
preserving acceptance-criterion coverage.

## Phase 1: LOAD

Read in this order:
- `$ARTIFACTS_DIR/dev-review-final.json` — the verdict. Every entry
  in `required_repairs[]` has `file`, `issue`, `exact_solution`,
  `acceptance_criterion`, and often `example_code`. These are
  instructions, not suggestions.
- `docs/contracts/<lowercase-issue-key>.md` — the contract that
  defines canonical file paths, exports, signatures, selectors,
  and accessible names. If a repair contradicts the contract, the
  contract wins; halt and report.
- `$ARTIFACTS_DIR/task-context.md` — the ticket and ACs.
- The test files named in `required_repairs[].file`.
- For each repair, read the production source the test targets so
  you understand what selector/export/signature is correct.

**PHASE_1_CHECKPOINT:**
- [ ] Verdict loaded; every `required_repairs[].file` is under a
      test path (tests/, e2e/, *.test.*, *.spec.*, __tests__/)
- [ ] Contract is loaded
- [ ] For every repair, you know the exact production behavior the
      test should be asserting against
- [ ] If any `required_repairs[].file` is NOT a test path, halt
      with an explicit message — your scope is test-only

## Phase 2: REPAIR

Apply each `exact_solution` verbatim. Common repair shapes:

- Selector mismatch: replace `getByRole("button", { name: /X/i })`
  with the production button's actual accessible name (often the
  button's visible text). The contract names visible text and
  aria-labels; use those as the source of truth.
- Type-cast: insert `unknown as` for structurally-disjoint cast
  pairs (TS2352). Mirror the same pattern adjacent lines already
  use.
- Stub-file removal: delete `__stubs__/X.ts` files; switch the
  test's import to the contracted path.
- Test-only fixture changes that do not affect production behavior.

Forbidden:
- Editing any production source file (`src/`, `convex/`, `app/`,
  `pages/`, `components/`, etc.). The cage will deny these writes.
  If a repair seems to require a production change, halt and
  report — that means the verdict was misclassified and the
  dev-loop should run again.
- Removing AC coverage or weakening assertions.
- Adding tests that the contract does not justify.

**PHASE_2_CHECKPOINT:**
- [ ] Every `required_repairs[]` entry was addressed
- [ ] No production source file was edited (cage will enforce)
- [ ] Test contract coverage preserved

## Phase 3: REPORT

List the files you edited and which repair each edit addressed.

## Success Criteria

- **REPAIRS_APPLIED**: Every `required_repairs[]` from
  `dev-review-final.json` is implemented.
- **NO_PRODUCTION_EDITS**: Only test paths were modified.
- **AC_COVERAGE_PRESERVED**: All ACs are still tested.

