# Standing eval suites (`.archon/evals/`)

Datasets for the `standing-eval-suite` workflow (the labelled-regression companion to
`agentic-eval-gate`). A suite is a folder; select one with `EVAL_SUITE` (default `seed`).

```
.archon/evals/<suite>/
  suite.json       # rubric dimensions + weights + thresholds (JSON — bun reads it dep-free)
  cases/*.yaml     # one labelled case each (YAML — the AI judge reads these natively)
  baseline.json    # OPTIONAL, COMMITTED: blessed mean_by_dim from an accepted run
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

## Gate logic (deterministic, in the `aggregate` node)

PASS only if ALL hold:
- weighted `overall` ≥ `thresholds.overall_min`
- every dimension mean ≥ `thresholds.dim_floor`
- no case whose worst dimension < `thresholds.case_min`
- (if `baseline.json` present) no dimension regressed by more than `thresholds.regression_tolerance`

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
