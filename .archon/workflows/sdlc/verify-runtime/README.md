# Runtime verification

`archon-verify-runtime` runs an agent against a live, testable target — a
running app, a CLI, any executable project surface — and checks a
project-declared set of runtime assertions with real observed evidence. It
answers one question: does this candidate actually behave as declared when
exercised, not just when read.

## The scenario contract

A project supplies one JSON file (the `scenario` input, a path relative to
the checkout) and nothing else. Commands live in this pack — see
`commands/verify-runtime.md`; the file below is pure project-owned data:

```json
{
  "assertions": [
    { "id": "kebab-case-id", "description": "What must be true, stated so an agent knows how to check it" }
  ],
  "environment": {
    "setup": "optional shell command; fresh state before each attempt",
    "start": "optional shell command; must not return until the target is ready",
    "teardown": "optional shell command; best-effort cleanup after each attempt",
    "candidate_command": "optional shell command naming what is running; defaults to 'git rev-parse HEAD'"
  }
}
```

`environment` and every field inside it is optional. A scenario with no
`environment` block at all means "the target is already reachable" — the
plain, non-factory case (`fixtures/scenarios/sample.json`): no web app,
container, or bespoke lifecycle required.

## What is checked, deterministically

`check-evidence.py` is the only place a verdict is decided, and it never
reads a self-reported pass count. For a report to be trustworthy it must, for
every declared assertion id (no more, no fewer, no duplicates): report a real
observation (not a restated claim or a stock phrase like "as expected"), and
point at a real, non-empty, on-disk evidence file. The agent's own reported
candidate identity must match what `check-evidence.py` independently obtains
by re-running `candidate_command` itself. Only once every one of those holds
does the verdict come from the assertions' own `ok` fields — never before.

## Outcomes

`gate-verified`'s `verdict` is exactly one of:

- `verified` — every assertion passed with real evidence.
- `failed` — the report was entirely trustworthy; a specific assertion did
  not hold. Never retried.
- `inconclusive` — either the declared environment never came up
  (`unavailable`), or the report itself could not be trusted after the retry
  budget was spent (`unavailable`/`malformed` in `check-evidence.py`'s
  terms — see that script's own docstring for the full four-way breakdown).
  `outcome_field: verified` maps only `verified` to a succeeded run; both
  `failed` and `inconclusive` are a failed run outcome, distinguished from
  each other by `verdict` in the returned node's output.

## Bounded retry, never on a real failure

The retry loop (`verify-loop`) retries exactly one class of problem: a
malformed report — missing coverage, an unobserved claim, absent evidence, or
a candidate mismatch. It never retries an assertion that genuinely failed,
and it never retries because the target was unavailable (that is a single
attempt, reported inconclusive, since blindly repeating an unreachable target
rarely helps without an operator looking at it). Each retry gets a fresh
`fresh_context: true` agent turn and re-runs the scenario's own
setup/start/teardown, so a stale process from the previous attempt does not
survive into the next one.

## What this workflow does not enforce

**Holdout / confidential scenarios.** This workflow's own agent is meant to
read whatever scenario file it is pointed at — that is its job as the
grader. The confidentiality property a holdout scenario actually needs is
that a *different* agent (the one building the candidate) never reads it.
This workflow has no way to enforce that, and does not claim to: no per-node
reader ACL exists in the engine today (a worktree bounds which files a run
*sees*, not what a specific agent inside it may read — see
`.archon/direction.md`'s Isolation section), and `sandbox.filesystem.denyRead`
on the *builder's* own node is the closest real mechanism, owned entirely by
whoever configures that node, not by this workflow. If a caller needs that
boundary enforced, it needs its own answer for it — this workflow will
faithfully read and honestly report on a confidential scenario, exactly as it
would an ordinary one, with no extra secrecy implied by the fact that the
scenario file happens to live in a directory called `holdout`.

**Cleanup on cancellation.** `teardown-run` runs after `verify` inside the
retry loop, gated by `trigger_rule: all_done` so it fires on both a passing
and a failing attempt. It does **not** fire if the run itself is cancelled or
the process is killed mid-attempt — the engine does not guarantee a
best-effort node runs when a run is torn down externally, and this workflow
does not invent a lifecycle manager to promise otherwise. For a first slice,
treat any target this workflow starts as **externally managed**: a project
whose `start` command leaves a long-lived process behind should own its own
supervision (a disposable container, a process manager, a scheduled reaper)
rather than relying on this workflow's `teardown` to be the only thing that
ever stops it. A future slice that wants a stronger guarantee needs an
explicit owner for that guarantee — most likely the isolation backend
(`.archon/direction.md`'s `#2206` container-execution gap) rather than this
workflow reaching outside its own node.

## Integrating from a caller (for example a factory or a merge queue)

Invoke this workflow with `workflow:` (a governed sub-run, not `include:`) so
each verification attempt gets its own run record, artifacts, and audit
trail:

```yaml
- id: verify-candidate
  workflow: archon-verify-runtime
  with:
    scenario: scenarios/e2e.json
    candidate: "$pr.output.head"
  depends_on: [pr]
```

Read the result from `$verify-candidate.output.verdict` /
`.verified` / `.summary` — never infer success from the child run's mere
completion, and never reinterpret `inconclusive` as `failed` or vice versa
downstream; they are different operator actions (retry/investigate vs. fix).

For **mutation verification** (rerunning this same check against a mutated
candidate to prove a fault is actually caught), call this workflow once per
mutant the same way — a separate `workflow:` node or a data-driven `fan_out:`
over the mutant list, each a real governed sub-run with its own record. That
composition is intentionally out of scope for this PR (see the completion
report for why) and is not built here.

Keep this workflow's own `scenario` commands from ever invoking this pack's
`validate`, `review`, or `deliver` workflows: `validate` must never depend
(even transitively) on `verify-runtime`, or a caller that gates `deliver` on
both would create the exact recursive gate the shared task list calls out.
