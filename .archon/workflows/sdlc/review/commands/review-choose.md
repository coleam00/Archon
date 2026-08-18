# Choose Review Lenses

Decide which optional review lenses this change deserves. Code correctness and seam analysis always run — you choose only the additions.

Read `$ARTIFACTS_DIR/review/scope.md`, then look at the actual diff it describes.

## The lenses

| Lens | Run when the diff… |
|---|---|
| `tests` | changes production behavior (not only tests, docs, or config) — the behavior needs regression protection |
| `errors` | touches failure paths: catch/except blocks, fallbacks, retries, defaults on error, optional operations, error translation |
| `comments` | adds or edits comments, docstrings, TODOs, or embedded examples — or changes code that existing nearby prose describes |
| `types` | introduces or modifies types, schemas, constructors, state transitions, or public contracts |
| `docs` | changes anything a user, operator, or contributor follows documentation for: commands, config, APIs, workflows, defaults |
| `simplify` | adds new state, abstractions, wrappers, configuration, or duplicated structure worth challenging |

## Bias

When uncertain, run the lens — more review, never less. A skipped lens on a diff that needed it costs far more than a lens that comes back clean. Skip only when the diff clearly gives the lens nothing to examine.

Provide `reasoning` covering each decision in a line. Output nothing else.
