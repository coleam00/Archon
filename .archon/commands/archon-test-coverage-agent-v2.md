---
description: V2 — Review test coverage, emit structured findings.json
argument-hint: (none — reads from $ARTIFACTS_DIR/review/scope.md)
---

## CRITICAL — Tool-use enforcement

You MUST use the Write tool to persist BOTH findings files. Do NOT describe
findings as a chat response — invoke Write. The pipeline blocks if either
file is missing.

This command MUST end with BOTH files Written:
- `$ARTIFACTS_DIR/review/test-coverage-findings.md`
- `$ARTIFACTS_DIR/review/test-coverage-findings.json`

Even if you found zero issues, Write the JSON with empty findings array.

---

# Test-Coverage Review Agent (v2)

Edit tool is denied (no source modifications); Write and Bash are allowed.
A recurring finding across prior audits was "headline fix shipped with
zero tests for it." Be aggressive about flagging this.

## Phase 1: LOAD

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)
cat $ARTIFACTS_DIR/review/scope.md
gh pr diff $PR_NUMBER
# List all test files in the repo to know naming conventions
find . -path ./node_modules -prune -o \( -name "*.test.ts" -o -name "*.spec.ts" -o -name "*.test.tsx" \) -print | head -20
```

## Phase 2: ANALYZE

For each non-test source file in the diff, check:
- **Headline-fix coverage** — the change that motivated the PR. Is there a NEW test that fails before the fix and passes after? If not → CRITICAL.
- **Branch coverage** — does the test exercise each branch the diff added? (e.g., the degraded envelope path AND the healthy path)
- **Test theatre** — tests that assert structure rather than behaviour. Red flag patterns:
  - Comments like `// This is a structural test — the code has clearTimeout in finally`
  - `expect(fetch).toHaveBeenCalledTimes(1)` with no assertion about timeout actually firing
  - Tests that mock the function under test and only assert the mock was called
  - `grep -q` shell tests that check spelling rather than behaviour
- **Mocks that always succeed** — tests that mock the upstream service to return only happy-path JSON; never simulate malformed responses, missing keys, 200-with-text-body, or error envelopes
- **No regression test for fixed bug** — the bug should not be re-introducable without the test screaming
- **Visibility-leaked-for-tests** — `private` widened to `protected` purely to enable subclass-mocking; mark this as a code-quality-via-tests finding

## Phase 3: EMIT

Write both markdown and JSON. JSON schema:

```json
{
  "agent": "test-coverage",
  "pr_number": <int>,
  "verdict": "APPROVE" | "REQUEST_CHANGES" | "NEEDS_DISCUSSION",
  "findings": [
    {
      "id": "test-coverage-1",
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      "category": "headline-untested" | "branch-untested" | "test-theatre" | "happy-path-only-mock" | "visibility-leak" | "regression-untested",
      "title": "...",
      "file": "<source file that needs the test>",
      "line": <int>,
      "evidence": "<the untested branch / the fake test code>",
      "why_it_matters": "...",
      "recommended_fix": "<which test file to add to, what to assert>",
      "confirmation_check": "<bash command, e.g. `bun test path/to/test.ts -t 'name of new test'`>",
      "in_scope": true | false
    }
  ],
  "stats": { "critical": <int>, "high": <int>, "medium": <int>, "low": <int> }
}
```

**Severity rubric for test-coverage**:
- **CRITICAL** — the headline fix has zero tests; a future revert would not break any test
- **HIGH** — a branch the diff added has no test (e.g., degraded envelope path uncovered)
- **MEDIUM** — test theatre (asserts structure not behaviour); happy-path-only mocks
- **LOW** — could add a snapshot or extra assertion

## Phase 4: VALIDATE

```bash
jq -e '.agent == "test-coverage" and (.findings | type == "array")' $ARTIFACTS_DIR/review/test-coverage-findings.json
```

## Success Criteria

- The PR's headline behaviour change has at least one test, and that finding is recorded if absent
- Every finding cites a specific source line and recommends a specific test location
- `confirmation_check` is runnable (a `bun test` invocation that exists after the fix)
