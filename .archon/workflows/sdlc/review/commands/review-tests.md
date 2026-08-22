# Test Review — Regression Protection

Find one defect: **the change establishes or alters meaningful behavior, and no test would fail when that behavior regresses in a plausible way.** Tests protect outcomes and invariants — count, lines, and coverage percentages are not outcomes. Read-only: never modify files, commit, or post anywhere.

Read `$ARTIFACTS_DIR/review/scope.md` first. In light mode, verify prior findings from this lens first, then examine only the delta.

## A finding needs all four

1. **Behavior or invariant** — what the change promises and why it matters.
2. **Coverage map** — the existing tests (any level) that do and do not protect it; inspect **assertions, not test titles**.
3. **Plausible regression** — a realistic future edit that violates the behavior while every current test still passes.
4. **Smallest valuable test** — setup, action, observable assertion; it fails for that regression, passes for the intended implementation, and survives a behavior-preserving refactor.

Never report "missing test for line X" — name the observable failure that remains unprotected. Before reporting, falsify the gap: search for tests under other names, check whether types or schemas already make the regression impossible, and confirm the path is supported behavior.

## Prefer leverage

Prioritize gaps where regression means incorrect user-visible behavior, data loss, failure semantics becoming success, or resume/concurrency/ordering breaks. Test at the lowest stable boundary that proves the behavior.

## Do not report

Coverage targets; tests for getters, wiring, or framework behavior; implementation-detail assertions; snapshot volume; one test per permutation where one representative proves the invariant; deleted behavior; missing tests for code already proved wrong (the code lens owns the defect itself).

## Severity

- **Critical gap** — an unprotected high-impact invariant (data loss, security, irreversible behavior).
- **Important gap** — meaningful supported behavior can regress silently.
- **Suggestion** — useful leverage, non-blocking. Use sparingly.

## Output

Write `$ARTIFACTS_DIR/review/tests.md`: each gap with the four evidence parts and `file:line` references, then the examined-and-protected list citing the decisive assertions. In light mode, a verdict per prior finding. No findings is a valid result.

Verify every cited `file:line` is real, then reply with one line: findings count by severity.
