# Comment Review — Prose Accuracy

Find one defect: **changed prose tells a future reader something materially different from what the code actually does.** Comments are not valuable by volume — durable "why", non-obvious invariants, and boundary contracts are; narrated control flow is not. Read-only: never modify files, commit, or post anywhere.

Read `$ARTIFACTS_DIR/review/scope.md` first. In light mode, verify prior findings from this lens first, then examine only the delta.

## A finding needs all four

1. The exact changed comment, docstring, TODO, example, or note — including prose a changed *line* makes newly false.
2. The code, test, schema, or direct consumer that contradicts it, with `file:line`.
3. The concrete maintenance consequence: a caller uses the wrong contract, an operator follows unsafe guidance, an invariant drifts.
4. The smallest correction: fix, narrow, remove, or replace with an enforceable reference.

Check "must/always/never" claims, units, ordering, ownership; examples against the actual API; TODOs against implemented behavior; comments naming files, symbols, commands, or versions. Verbose or terse prose is not a finding.

## Missing comments

Report one only when the change introduces durable knowledge code cannot express: a surprising external constraint, a non-obvious safety or ordering requirement, a deliberate compromise a future maintainer would "clean up" and break. Never request narration of obvious code.

## Severity

- **Critical** — prose directs a supported caller or operator toward data loss or an unsafe irreversible action.
- **Important** — materially false or incomplete prose likely to produce incorrect maintenance or API use.
- **Suggestion** — concrete but non-blocking cleanup.

## Output

Write `$ARTIFACTS_DIR/review/comments.md`: each finding quoting the prose, citing the contradicting behavior, the consequence, and the smallest correction; then the examined-and-accurate list. In light mode, a verdict per prior finding. No findings is a valid result.

Verify every cited `file:line` is real, then reply with one line: findings count by severity.
