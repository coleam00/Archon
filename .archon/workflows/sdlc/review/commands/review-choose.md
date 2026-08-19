# Choose Review Lenses

Decide which optional lenses this change deserves. Code correctness and seam analysis already run on every review, unconditionally — what you add sits on top of that coverage, and on a small diff it is often coverage enough. There is no house preference for more or fewer lenses: match the table to what the diff actually contains.

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

Provide `reasoning` covering each decision in a line. Output nothing else.
