# Pick the review lenses

Decide which reviewers this round runs. This is a quick decision: read only what is
named here, run nothing (no tests, builds or checks), and do not modify any file. No
one watches this run; your structured answer is all the next nodes read.

- `$ARTIFACTS_DIR/review/scope.md`, which the scope node wrote: it names the target,
  its base and the exact commands that produce the diff under review. Run its
  `--stat` form and read the hunks you need; never a bare `git diff --stat`, which
  shows only uncommitted changes and is empty for a committed change.
- The work order (may be empty for a standalone review): $INPUTS.work_order. When it
  names a file such as `$ARTIFACTS_DIR/plan.md`, read that file's summary and steps,
  not the whole repository.
- Whether this round continues an earlier review: `$mode.output.continuation`. On a
  continuation, scope.md's diff is the correction delta since the previous round's
  reviewed commit. The lens booleans in **$mode.output** that are `true` review it
  whatever you answer: the code lens, and every lens that raised a blocker the
  previous round left open, which verifies its findings were fixed and that the fix
  caused nothing new in its area. For every other lens, select it only when the delta reaches new
  ground in that lens's area that the earlier rounds never saw: a new type,
  contract or boundary for `seams`; new behavior a test should protect for `tests`;
  a new catch, fallback or retry for `errors`; a new user-facing command,
  configuration key, flag or behavior for `docs`; a new page or interaction for
  `ux`. The defaults below, seams on among them, describe a first round.

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
- `ux` — whether the change works well for the person using it, when the diff adds
  or changes something a person sees or does in a browser. Off for every other
  change.

A small, mechanical change — a version bump, a one-line fix, a rename, a test-only
tweak — rarely earns errors or docs. Depth follows what a change can break, not its
size: do not economize on real risk, and do not invent it.

Every round selects at least one lens: when your judgment leaves none, select `code`.
Declare one boolean per lens (`seams`, `code`, `tests`, `errors`, `docs`, `ux`) and
`reason`: one or two sentences citing what in the diff decided it. If you cannot read
the diff, select every lens and say so in `reason`; never answer that no lens runs
because a command failed.
