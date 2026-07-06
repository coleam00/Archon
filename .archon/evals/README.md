# Standing eval suites (`.archon/evals/`)

Datasets for the `standing-eval-suite` workflow (the labelled-regression companion to
`agentic-eval-gate`). A suite is a folder; select one with `EVAL_SUITE` (default `seed`).

```
.archon/evals/<suite>/
  suite.json       # rubric dimensions + weights + thresholds (JSON — bun reads it dep-free)
  cases/*.yaml     # one labelled case each (YAML — the AI judge reads these natively)
  baseline.json    # OPTIONAL, COMMITTED: blessed mean_by_dim from an accepted run
  labels.json      # OPTIONAL: detection labels for failure-derived DEFECT cases (see below)
```

## Run it

```bash
# default suite = seed; runs against your LIVE checkout (no worktree)
bun run cli workflow run standing-eval-suite

# pick another suite
EVAL_SUITE=my-suite bun run cli workflow run standing-eval-suite
```

Outputs: a per-run `scorecard.json` in the run's artifacts dir, plus one trend line
appended to `.archon/state/eval-history.jsonl` (gitignored).

## Case schema (`cases/*.yaml`)

```yaml
id: kebab-unique-id           # must be unique within the suite
tags: [area, note]
task: |                       # the spec / "done means"
candidate: |                  # the work under test (v1: inline; the thing being scored)
reference: |                  # what a correct/strong solution looks like
```

The judge scores 5 fixed dimensions 1-5 (`correctness`, `completeness`, `maintainability`,
`safety`, `verification`). Weights and thresholds live in `suite.json`.

## N-vote judging (A4)

Every run casts **3 independent fresh-context judge votes** (`score-1/2/3`, identical
prompts); the `aggregate` node takes the per-case-per-dimension **median**. This
de-flakes the ±1 single-vote wobble that made tiny-suite baselines throw false
regressions. The aggregate also enforces **queue identity**: every queued case must be
scored exactly once in every vote — a judge that drops, duplicates, or invents a case
fails the gate loudly. Scorecards record `votes: N`.

## Gate logic (deterministic, in the `aggregate` node)

PASS only if ALL hold:
- weighted `overall` ≥ `thresholds.overall_min`
- every dimension mean ≥ `thresholds.dim_floor`
- no case whose worst dimension < `thresholds.case_min`
- (if `baseline.json` present) no dimension regressed by more than `thresholds.regression_tolerance`
- (if `labels.json` present) **no detection miss** (see next section)

## Failure-derived regression cases (`labels.json` — the A3 flywheel)

The `regressions` suite holds cases whose `candidate:` is a REAL defect that escaped a
gate once. For those the gate INVERTS — success means the judge **catches** the defect:

- `labels.json` maps case id → `{ "trap_dim": "<dimension>", "max_score": 2, "source": "<bug + date>" }`
- a labelled case passes when its **median** score on `trap_dim` is `<= max_score`;
  anything higher is a `detection_miss` → gate FAIL (the verifier has a blind spot)
- labelled cases are **excluded** from the mean/threshold math (their intentionally-low
  scores would poison the means); a suite of only labelled cases gates on detection alone

**Blindness rules (mandatory):** the case YAML's `reference:` describes ONLY what a
correct solution looks like — never name the defect, the trap dimension, or an expected
score. Labels live in `labels.json`, which judges are prompt-mandated (and tool-restricted)
never to read. Tuning `max_score` upward to make a miss pass is gaming your own gate —
a detection miss is a real finding about the judge; fix the rubric or accept the RED.

**Adding a case** (done automatically by `/evolve`, or by hand):
1. `cases/<kebab-slug>.yaml` — `task` (what was asked), `candidate` (the defective
   artifact as it escaped), `reference` (ideal-only, blind)
2. an entry in `labels.json` with `trap_dim`, `max_score`, and a one-line `source`
3. run `EVAL_SUITE=regressions bun run cli workflow run standing-eval-suite` — the new
   case must be CAUGHT (no detection miss) before you trust it as a guard

## Bless a baseline (close the flywheel)

After an accepted run, copy its scorecard's `mean_by_dim` into `<suite>/baseline.json`:

```json
{ "mean_by_dim": { "correctness": 4.3, "completeness": 4.0, "maintainability": 4.0, "safety": 3.7, "verification": 4.0 } }
```

Commit `baseline.json`. Every later run is then checked for regressions against it. When a
bug escapes the one-shot gate in real use, add a `cases/*.yaml` reproducing it — the suite
guards it permanently.

> Roadmap (v2): per-case fan-out via a `loop:` node for large suites, regenerating candidates
> by invoking a target workflow per case (needs worktree isolation), and N-vote judging.
