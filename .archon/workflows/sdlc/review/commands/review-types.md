# Type Review — Unenforced Invariants

Find one defect: **a meaningful invariant exists, but a changed type permits a reachable invalid state that downstream code must detect, guess around, or silently mishandle.** Do not rate type aesthetics — a plain data shape is correct when its valid states are plain. Read-only: never modify files, commit, or post anywhere.

Read `$ARTIFACTS_DIR/review/scope.md` first. In light mode, verify prior findings from this lens first, then examine only the delta.

## A finding needs all four

1. **Invariant** — a rule required by actual behavior, callers, tests, or schema (never an imagined one).
2. **Reachable construction** — a constructor, parser, mutation, or public call that creates the invalid state, with `file:line`. A cast-only or test-only path does not count.
3. **Consequence** — a concrete consumer that fails, branches defensively, or accepts a contract-violating result, with `file:line`.
4. **Proportional correction** — the smallest enforcement: a discriminated union for genuinely different variants, validation at one ingress boundary, a distinct phase type when consumers need proof a transition happened, a required field when absence is not supported. The correction must cost less than the defensive code it removes — never propose a class hierarchy, wrapper, or builder by default.

Repeated guards saying an earlier phase "should already have" enforced something are the strongest signal: a runtime assertion standing in for a type nobody wrote. Also worth a look: casts, assertions, and `any` that hide a proof the compiler lacks; local types hand-duplicating an authoritative schema they can drift from (the correction is derivation from the schema, not a third copy); and matches that let a new variant compile without deliberate handling — check whether the language could already enforce exhaustiveness there without a permissive default.

## Falsify before reporting

Search for an earlier boundary that already rejects the state; check whether the type is deliberately an unvalidated transport shape; check serialization and compatibility before narrowing a public shape. If the invalid state is supported behavior, the type is not wrong.

## Not yours

Encapsulation preferences; mutability without a violated invariant; cross-language transport shapes (the seams lens owns those); numerical scores or best-practice sermons.

## Severity

- **Critical** — the invalid state reaches a supported path with data-corrupting or contract-breaking effect.
- **Important** — a reachable invalid state forces defensive guessing or silent mishandling downstream.
- **Suggestion** — proportional hardening with clear value, non-blocking.

## Output

Write `$ARTIFACTS_DIR/review/types.md`: each finding with the four parts, then the examined-and-enforced list citing the boundary that makes each suspected state unreachable. In light mode, a verdict per prior finding. No findings is a valid result.

Verify every cited `file:line` is real, then reply with one line: findings count by severity.
