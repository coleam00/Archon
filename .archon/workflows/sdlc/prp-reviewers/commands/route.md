# Pick the review lenses

Decide which reviewers this round runs. This is a quick decision: read only what is named here, run nothing, and answer.

- The diff summary: `git diff --stat origin/<base>...HEAD` for the pull request's base (the pull request record: $INPUTS.scope).
- The plan or work order: $INPUTS.work_order (when it names a file such as `$ARTIFACTS_DIR/plan.md`, read that file's summary and steps, not the whole repository).
- The operator's lens request (empty means none): $INPUTS.scopes

Lenses:

- `seams` — missing types, counterpart drift, bypassed boundaries. On by default: it runs unless the change clearly touches no type, contract, payload, state, wire format, persistence, concurrency, isolation, security, or other boundary. When unsure, it runs.
- `code` — general correctness and repository fit. It runs on every change that touches code or behavior; a documentation-only change may skip it.
- `tests` — regression protection, when the change establishes or alters behavior a test should protect.
- `errors` — swallowed failures and fallbacks, when the change adds or changes catches, fallbacks, retries, error translation, or recovery.
- `docs` — stale or missing documentation, when the diff changes shipped documentation or a user-facing command, configuration, or behavior.

Lenses the operator names are added; an explicit restriction ("only tests") replaces your selection; `all` selects every lens.

Declare one boolean per lens (`seams`, `code`, `tests`, `errors`, `docs`) and `risk`: the risk call in one sentence.
