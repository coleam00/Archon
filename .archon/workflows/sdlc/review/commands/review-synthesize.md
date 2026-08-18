# Synthesize the Review

Aggregate the lens reports into one evidence-based verdict and the review report humans read. Synthesis connects and prioritizes reviewer evidence — it does not perform another review, invent findings, or raise severity without evidence. Read-only on the repository: never modify project files, commit, or post anywhere.

## Read

1. `$ARTIFACTS_DIR/review/scope.md` — the target, mode, and the **head SHA under review**.
2. Every lens report present in `$ARTIFACTS_DIR/review/` (`code.md`, `seams.md`, `tests.md`, `errors.md`, `comments.md`, `types.md`, `docs.md`, `simplify.md`). A missing file means that lens was skipped by design this round — record it as skipped, never as clean.

## Aggregate

- Merge duplicate findings across lenses into one **causal** finding; attribute every contributing lens; preserve genuine disagreement rather than averaging it away.
- **Adversarially verify before accepting**: for each Critical or Important finding, check its cited `file:line` evidence yourself (read the file, run the smallest falsifying command when practical). A finding whose evidence does not hold is recorded as rejected with the reason — not silently dropped.
- Assign stable IDs (`R1`, `R2`, …). In light mode, keep the prior report's IDs for the same causal finding, allocate new IDs after the prior maximum, and carry every prior finding forward with its verdict: still open, fixed at `<sha>`, or disproved — **never make an earlier finding disappear**.
- Severity: Critical and Important block; **Suggestions never block, including every simplify finding.**

## Verdict

`ready: true` exactly when there are **no open Critical or Important findings**. "Nothing left to say" is not the bar — open Suggestions do not hold `ready` back, and a round that ran fewer lenses says so rather than implying a fuller clearance.

## Write the report

Write `$ARTIFACTS_DIR/review/report.md`:

1. **Verdict** — ready or not, and the one-sentence reason.
2. **Reviewed head SHA** — from scope.md, stated exactly (this is the next round's cursor).
3. **Findings** — by severity, each with ID, claim, `file:line` evidence, and the smallest correction; then rejected findings with the disproving evidence; then Suggestions.
4. **Prior findings** (light mode) — the full carried-forward table with per-finding verdicts.
5. **Lens roster** — which lenses ran, were skipped by choice, or found nothing.

## Verify before finishing

Confirm the report exists, every lens file present is accounted for in the roster, the head SHA appears verbatim, and every finding you accepted has evidence you actually checked. Then declare:

- `ready` — the verdict as defined above.
- `findings_summary` — 2-4 sentences: counts by severity, the dominant theme if one exists, and what blocks readiness (or that nothing does).
