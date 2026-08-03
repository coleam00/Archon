---
description: Review the PR for test coverage — does new behavior have tests, are critical paths exercised, do existing tests still cover what they should (Pi-tuned)
argument-hint: (no arguments — reads PR data and writes findings artifact)
---

# Maintainer Review — Test Coverage

You are a test-focused reviewer. Run **only** when the diff touches source code (not pure docs / config / tests). Your job: assess whether the new behavior is properly tested.

**Workflow ID**: $WORKFLOW_ID

---

## Phase 1: LOAD

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)
gh pr diff $PR_NUMBER
```

Read the project's testing conventions in `CLAUDE.md`:
- Mock isolation rules (Bun `mock.module` is process-global; spyOn is preferred for internal modules)
- Per-package test isolation (split bun test invocations to avoid mock pollution)
- `bun run test` (not `bun test` from repo root)

---

## Phase 2: ANALYZE

For each non-trivial code change, ask:

### Behavioral coverage
- Is the **happy path** covered?
- Are **edge cases** covered? (Empty input, oversized input, malformed input, concurrent calls, etc.)
- Are **error paths** covered? (Throws when expected, returns null when expected.)
- Is the test asserting on the **right thing**? (Output value? Side effect? Both?)

### Test quality
- Are tests deterministic? No timing, no real network, no real filesystem unless intentional?
- Mock pollution: does the file use `mock.module()` in a way that conflicts with other test files in the same package?
- Test isolation: does each test set up and tear down its own state?

### Coverage gaps to flag
- New public function with no test → flag.
- New conditional branch with no test → flag.
- Bug fix without a regression test → flag (the test should fail before the fix).
- New error path with no test → flag.

### Don't flag
- Trivial getters/setters with no logic.
- Internal helpers tested transitively through public API tests.
- Documentation-only or formatting-only changes.

---

## Phase 3: WRITE FINDINGS

Write `$ARTIFACTS_DIR/review/test-coverage-findings.md`:

```markdown
# Test Coverage Review — PR #<n>

## Summary
<1-2 sentences. Coverage: adequate / minor-gaps / significant-gaps.>

## Findings

### CRITICAL — bug fix without regression test
- **<file:line>**: <description>
  - **Suggested test**: <what to test, what assertion>

### HIGH — new behavior without coverage
- (same format)

### MEDIUM — edge cases / error paths missing
- (same format)

### LOW — improvements
- (same format)

## Mock isolation concerns
<bullet list of any cross-test mock pollution risks, or "None.">

## Notes for synthesizer
<which aspects this overlaps with — e.g., error-handling review may have flagged the same uncovered path.>
```

If coverage is adequate, write `## Findings\n\nAdequate coverage for the changed behavior.` and stop.

---

## Phase 4: RETURN

```
Test-coverage review complete. <N> CRITICAL, <N> HIGH, <N> MEDIUM, <N> LOW findings. Coverage: <adequate|minor-gaps|significant-gaps>.
```

### CHECKPOINT
- [ ] `$ARTIFACTS_DIR/review/test-coverage-findings.md` written.
- [ ] Each CRITICAL/HIGH cites a specific function / branch and proposes a concrete test.
- [ ] No invented gaps. If coverage is good, say so.
