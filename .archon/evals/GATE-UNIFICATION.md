# Gate unification — CodeRabbit + standing-eval-suite (design outline, no code)

Two quality gates exist today and answer different questions. This is a short design
sketch for presenting them as one verdict to a human, without merging what they measure.

## Why not just merge the two gates

- **CodeRabbit** reviews a **diff** (per-PR): any changed file, any pattern it can grep —
  type safety, robustness, path traversal, docs, tests, API design. Scope is unbounded and
  changes with every PR.
- **standing-eval-suite**'s judge scores a **curated, versioned case set** against a fixed
  5-dimension rubric (`correctness`, `completeness`, `maintainability`, `safety`,
  `verification`) — a stable measurement of candidate quality *over time*, independent of
  which PR is open today.

Folding CodeRabbit's unbounded pattern space into the 5-dimension rubric causes dimension
explosion and prompt bloat, and folding the rubric's temporal baseline into a per-PR tool
throws away the "measured over time, not per-change" property that is the suite's whole
point (see `EVAL_SUITE_VS_CODERABBIT.md` at repo root for the case-by-case comparison that
motivated this doc). The two INPUTS stay separate.

## Separate inputs, unified output

```
┌─────────────────┐        ┌──────────────────────┐
│   CodeRabbit     │        │  standing-eval-suite  │
│  (diff-scoped,   │        │  (curated cases,      │
│   any pattern)   │        │   5-dim rubric,       │
│                  │        │   over time)           │
└────────┬─────────┘        └──────────┬────────────┘
         │ PR review comments/status    │ scorecard.json
         │                              │ { gate: PASS|FAIL, ... }
         └──────────────┬───────────────┘
                         ▼
              ┌─────────────────────┐
              │  unified verdict     │
              │  (one artifact/line  │
              │   a human reads)     │
              └─────────────────────┘
```

The unified output is a thin **presentation** layer, not a new scoring engine:

- Each gate keeps its own pass/fail semantics and its own artifact (CodeRabbit's PR
  review state; `scorecard.json`'s `gate` field).
- A unification step reads both and renders one line/section: `CodeRabbit: <n> findings
  (<severity breakdown>) · Standing eval: <PASS|FAIL> (<blocking reasons if FAIL>)`.
- Neither gate can override or silence the other. A human (or a reviewing agent) still
  sees both verdicts and their respective reasoning — this is presentation, not
  aggregation into a single boolean.
- No shared threshold, no shared weight, no cross-gate math. If that's ever needed, it is
  a new, explicitly-designed decision, not a byproduct of unification.

## Sketch: future feedback loop (not built)

Today `/evolve` turns a real escaped bug into a `regressions/` case by hand (see
`.archon/evals/README.md`). A natural extension, once the unified verdict above exists:

1. A CodeRabbit finding that recurs across multiple PRs on the **same underlying
   defect shape** (not a one-off style nit) is a candidate for promotion into a labelled
   `regressions/` case — the same flywheel `/evolve` already runs for judge-side misses,
   just sourced from CodeRabbit instead of a production incident.
2. Promotion stays **human-gated**, same as a re-bless: a recurring CodeRabbit pattern
   suggests a candidate case; a human decides whether it belongs in the rubric's scope
   (see "Why not just merge the two gates" above — most CodeRabbit findings are
   infra-scoped and correctly stay out of the judge's candidate-quality rubric).
3. No code exists for this yet. This section is a placeholder for a later PRP, not a
   commitment to build it.

## Non-goals

- Do not make the judge catch everything CodeRabbit catches, or vice versa.
- Do not compute a single blended score across the two gates.
- Do not let either gate's pass/fail decision be edited by the other.
