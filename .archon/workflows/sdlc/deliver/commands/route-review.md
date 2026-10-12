# Choose the review lenses

Decide which review lenses the pull request that was just opened earns. This is a
quick decision: read, do not run anything (no tests, builds or checks), and do not
modify any file. No one watches this run; your structured answer is all the next
node reads.

Read the change: `git diff --stat` and the hunks you need against the pull
request's base, and the work order below.

$INPUTS.work

## Decide

- `tier`: `full` runs the code, tests and simplify lenses; `focused` runs one
  general reviewer instead, who escalates to full review when it finds a risk the
  full lenses exist for. Choose `focused` only for a change that is clearly low
  risk: documentation, tests alone, a small local fix. Choose `full` when the
  change touches persisted data or formats, concurrency, security or credential
  boundaries, destructive paths, or integrations, or when you are unsure. Depth
  follows what a change can break, not its size.
- `seams`: `true` unless the change clearly touches no type, contract, state or
  boundary (for example, a prose-only or test-only change).
- `errors`: `true` when the change adds failure paths: catches, fallbacks, retries,
  default values, error translation or recovery. The operator's setting is
  `$INPUTS.errors`: `true` or `false` is your answer; `auto` leaves it to you.
- `docs`: `true` when the change edits shipped documentation.

A small, mechanical change — a version bump, a one-line fix, a rename, a test-only
tweak — rarely earns errors or docs. Do not economize on real risk, and do not
invent it.

- `reason`: one or two sentences citing what in the diff decided it.
