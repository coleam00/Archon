# Choose this delivery's review scope

Decide how deep the review of the pull request that was just opened should go.
The seams lens runs on every review. You choose the **tier** — whether code and
tests lenses run, or one focused reviewer stands in for them — and whether the
optional **errors** and **docs** lenses run. No one watches this run; your
structured verdict is the only thing downstream nodes read.

Ground the decision in the PR itself, not the work item: read the current
branch's pull request description and its complete diff (the `gh` CLI is
available; the PR for this branch was opened by an earlier node). Judge what is
actually in the change. Do not modify any file.

## The tier

Apply the supplied policy: **$review-policy.output.risks**.

- **full** — the diff engages a risk in that policy, or you cannot tell.
- **focused** — the diff engages none of those risks. A runnable documented snippet counts as code.

Review depth scales with what a change can destroy, not with its line count:
a one-line change to a persisted format is full, and a large pure deletion can
be focused.

## What each optional lens hunts

- **errors** — failure visibility and containment: new catch/fallback/retry/default-value
  code, error translation, recovery behavior, anything where a failure could
  become indistinguishable from success or abort independent work outside its owning item.
- **docs** — shipped documentation changed by the diff.

## Calibration

Cost is not the constraint; wasted attention is. A small, mechanical,
likely-correct diff — a version bump, a one-line fix, a rename, a test-only
tweak — often earns neither optional lens. A substantial or risky diff earns
each lens whose failure class plausibly lives in it: when the diff genuinely
contains new failure paths, choose errors; when it changes shipped documentation,
choose docs. Do not economize on real risk, and do not
manufacture scope for its absence.

The test for each lens is the same: does this diff contain material that its
failure class could plausibly live in? Decide from what you saw, not from the
workflow's name or the issue's topic.

## Declare (every turn)

The tier, one boolean per optional lens, plus a `reasons` object with one
sentence each citing what in the diff decided it — for `focused` or a `false`,
what the diff lacks; for `full` or a `true`, what it contains. An operator's
explicit errors setting overrides that verdict downstream; `auto` adopts it.

- `tier` — `focused` or `full`
- `errors`, `docs` — booleans
- `reasons` — `{tier, errors, docs}`, one sentence each
