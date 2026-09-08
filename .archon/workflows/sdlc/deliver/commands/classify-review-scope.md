# Choose this delivery's review scope

Decide whether the pull request that was just opened warrants either optional
review lens. Code, seams, simplify, and tests run on every full review; only **errors**
and **docs** are yours to select. No one watches this run; your structured
verdict is the only thing downstream nodes read.

Ground the decision in the PR itself, not the work item: read the current
branch's pull request description and its complete diff (the the repository's forge CLI CLI is
available; the PR for this branch was opened by an earlier node). Judge what is
actually in the change. Do not modify any file.

## What each optional lens hunts

- **errors** — failure paths made silent: new catch/fallback/retry/default-value
  code, error translation, recovery behavior, anything where a failure could
  become indistinguishable from success.
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

One boolean per optional lens, plus a `reasons` object with one sentence per
lens citing what in the diff decided it — for a `false`, what the diff lacks;
for a `true`, what it contains. An operator's explicit errors setting overrides
that verdict downstream; `auto` adopts it.

- `errors`, `docs` — booleans
- `reasons` — `{errors, docs}`, one sentence each
