# Simplify Review — Avoidable Machinery

Find one thing: **machinery the change does not need to preserve its required outcome.** Simplicity is fewer states, representations, concepts, and synchronization points — not fewer lines. Your findings are always **Suggestions** and never block a merge. Read-only: never modify files, commit, or post anywhere.

Read `$ARTIFACTS_DIR/review/scope.md` first. In light mode, verify prior findings from this lens first, then examine only the delta.

## A finding needs all five

1. **Outcome** — the observable behavior the change must deliver.
2. **Invariant** — what must remain true while delivering it.
3. **Machinery** — the avoidable state, lifecycle, abstraction, configuration, wrapper, duplication, or special case, with `file:line`.
4. **Primitive** — the existing or smaller mechanism that carries the outcome: an API already present, data available before it was copied, one owner replacing synchronized representations, direct control flow replacing speculative policy.
5. **Proof** — call sites, tests, or contracts showing the smaller shape suffices. Taste, line count, and "more idiomatic" are not proof.

Ask what forces each moving part: which observable transition requires the lifecycle? what second real use does the wrapper own? which supported variation exists today for the configuration? which concrete failure does the fallback recover, and who observes it? is data copied, flattened, rebuilt, or cached where one owner could carry it — and does a signal threaded through types, schemas, or layers have an owner that already knows the answer? DRY applies to shared structure and data models, not every repeated line: explicit repetition can be simpler than a premature abstraction.

## Falsify before reporting

Read every in-scope caller that depends on the machinery; find the input the replacement cannot represent; check concurrency, ordering, persistence, and error semantics. If the smaller approach changes observable behavior, it is not a simplification finding.

## Carve-outs

Duplication across a genuine build or ownership boundary; an abstraction that owns and enforces a real invariant; essential domain complexity; a compatibility path tied to a concrete supported state; code outside the change unless the change newly makes it redundant. Do not move complexity into a helper and call it gone.

## Output

Write `$ARTIFACTS_DIR/review/simplify.md`: each finding with the five parts, what disappears, and the real tradeoff (or "none found"); then the examined-and-already-simple list naming the primitive or invariant that justifies the current shape. In light mode, a verdict per prior finding. One proven structural simplification beats a catalog of cosmetic edits; no findings is a valid result.

Verify every cited `file:line` is real, then reply with one line: findings count (all Suggestions).
