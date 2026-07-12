# Judge calibration — standing-eval-suite

Result of validating the `medium`-tier LLM judge used by `standing-eval-suite`:
does it measure *real* quality, or just surface features? Run 2026-07-01.

## Method (labels committed BEFORE any judge run)

1. **Gradation** — an independent strong annotator scored the 6 shipped cases across
   all 5 dimensions; compared against the judge.
2. **Substance vs. theater (blinded)** — 3 engineered hard-negatives whose `reference:`
   described only what a *correct* solution looks like, never naming the candidate's
   defect or the expected score. A judge fooled by theater scores the trap dim high; a
   judge that reads substance floors it.

## Result

**Gradation:** judge within ±1 of the annotator on **30/30 dim-cells** (max diff 1).

**Substance (blind):**

| hard-negative | defect hidden behind… | trap dim | judge score |
|---|---|---|---|
| vacuous tests | a test file asserting only `toBeDefined()` / `typeof === "string"` | verification | **1** |
| SQL injection | input guard + green tests + clean structure | safety | **1** |
| happy-path median | a passing odd-length test + a "works for any length" comment | correctness | **1** |

Rationales confirmed genuine detection (not pattern-matching): flagged the slugify tests
as checks that "pass for any string-returning function," and traced the median formula to
"returns undefined for empty arrays … passes only by coincidence on a pre-sorted
odd-length input." Scores were ~identical whether or not the reference leaked the answer,
so the leak wasn't driving detection.

## Verdict: PASS — the judge reads substance.

**One observed limitation:** it awards a flat **5** to genuinely-good code, so the all-5
`golden/baseline.json` has no headroom; on a tiny suite, correlated ±1 wobbles on the same
dimension could throw a *false* regression.

**Justified next hardening (deferred):** median-of-3 **N-vote** on the `score-cases` node
collapses that wobble and makes the baseline robust. **IMPLEMENTED (2026-07-06)**: score-1/2/3
median-of-3 voting is now live in the workflow; no tolerance override needed.
Fallback (if reverting to single-vote): widen `golden` `regression_tolerance` 0.5 → 1.5+
to accommodate the observed ±1 drift (0.7 is insufficient for single-vote stability).

## Caveat for future case authors

The shipped `seed`/`golden` `reference:` fields currently hint the expected verdict
("expect mid scores", "should score low on verification"), so a standard run partly tests
reading-comprehension. Use BLIND references (ideal-only, no defect naming) to test
*independent* detection.

## Prompt edits require a re-bless (human-gated)

Any change to the `score-1/2/3` judge prompt (rubric wording, scope anchors, output
format) can shift what the judge scores identical candidates — the calibration above
was measured against the prompt as it read at run time, not against the rubric in the
abstract. A prompt edit invalidates the committed `<suite>/baseline.json` numbers until
someone re-runs the suite and re-blesses.

This is deliberately **human-gated**, not automatic: the loop must never edit its own
success criteria (`baseline.json`, `suite.json` thresholds) to make its own diff pass.
If a prompt change makes a golden suite regress, that is a signal to a human, not
something the changing process resolves by rewriting the baseline.

See the "Bless a baseline (close the flywheel)" procedure in
[`.archon/evals/README.md`](README.md#bless-a-baseline-close-the-flywheel) for the exact
re-bless steps.
