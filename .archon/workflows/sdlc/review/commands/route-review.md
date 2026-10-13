# Pick the review lenses

Decide which reviewers this round runs. This is a quick decision: read only what is
named here, run nothing (no tests, builds or checks), and do not modify any file. No
one watches this run; your structured answer is all the next nodes read.

- The diff summary against the change's base: `git diff --stat` and the hunks you
  need. The requested scope (empty means the current branch's pull request or the
  working diff): $INPUTS.scope
- The work order (may be empty for a standalone review): $INPUTS.work_order. When it
  names a file such as `$ARTIFACTS_DIR/plan.md`, read that file's summary and steps,
  not the whole repository.

Lenses:

- `seams` — missing types, counterpart drift, bypassed boundaries. On by default: it
  runs unless the change clearly touches no type, contract, payload, state, wire
  format, persistence, concurrency, isolation, security, or other boundary. When
  unsure, it runs.
- `code` — general correctness and repository fit. It runs on every change that
  touches code or behavior; a documentation-only change may skip it.
- `tests` — regression protection, when the change establishes or alters behavior a
  test should protect.
- `errors` — swallowed failures and fallbacks, when the change adds or changes
  catches, fallbacks, retries, default values, error translation, or recovery. The
  operator's setting is `$INPUTS.errors`: `true` or `false` is your answer; `auto`
  leaves it to you.
- `docs` — stale or missing documentation, when the diff changes shipped
  documentation or a user-facing command, configuration, or behavior.

A small, mechanical change — a version bump, a one-line fix, a rename, a test-only
tweak — rarely earns errors or docs. Depth follows what a change can break, not its
size: do not economize on real risk, and do not invent it.

Declare one boolean per lens (`seams`, `code`, `tests`, `errors`, `docs`) and
`reason`: one or two sentences citing what in the diff decided it.
