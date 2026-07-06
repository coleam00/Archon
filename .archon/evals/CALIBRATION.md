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
collapses that wobble and makes the baseline robust. Cheaper blunt alternative: widen
`golden` `regression_tolerance` 0.5 → 0.7.

## Caveat for future case authors

The shipped `seed`/`golden` `reference:` fields currently hint the expected verdict
("expect mid scores", "should score low on verification"), so a standard run partly tests
reading-comprehension. Use BLIND references (ideal-only, no defect naming) to test
*independent* detection.
