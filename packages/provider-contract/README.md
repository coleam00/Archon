# `@archon/provider-contract`

This leaf package owns the shapes at the provider boundary: the typed failure a provider reports, the terminal result of a turn, the `settled` signal, token usage, and the capability set. It depends only on zod, so an out-of-repo provider can depend on it too. `@archon/providers`, `@archon/workflows`, `@archon/core` and `@archon/server` import these schemas instead of restating them.

A provider that knows why a turn failed sets `failure: { class, retryAfterMs?, resetAt?, evidence }` on its `result` chunk, and still sets `isError`. The class comes from the SDK's structured signals (error codes, HTTP status fields, typed exceptions), never from matching text; a failure the provider cannot classify is `unknown`. The engine decides retry from `class`. `evidence` is for the operator and the logs; nothing branches on it. A provider does not retry on its own: the engine owns the retry policy.

Every turn, successful or failed, ends with one `{ type: 'settled' }` chunk after its final `result`. A `result` can arrive while work the turn started is still running, so the engine finishes a node on `settled`, not on `result`.

`schema/provider-contract.schema.json` is generated from `src/` by `src/scripts/generate-schema.ts`. Run `bun run generate:provider-contract-schema` from the repository root after changing a schema; `bun run validate` fails while the file is stale.

`@archon/provider-contract/conformance` checks a provider against the contract from fixtures the provider owns. Failure cases drive the provider into one failure each and name the class it must report and the vendor text its evidence must keep. Turn cases, together with the failure cases, check that every turn settles exactly once, last, after its result.
