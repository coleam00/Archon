# `@archon/provider-contract`

This leaf package owns the shapes at the provider boundary: the typed failure a provider reports, the terminal result of a turn, token usage, and the capability set. It depends only on zod, so an out-of-repo provider can depend on it too. `@archon/providers`, `@archon/workflows` and `@archon/server` import these schemas instead of restating them.

A provider that knows why a turn failed sets `failure: { class, retryAfterMs?, resetAt?, evidence }` on its `result` chunk. The engine decides retry from `class`. `evidence` is for the operator and the logs; nothing branches on it.

`schema/provider-contract.schema.json` is generated from `src/` by `src/scripts/generate-schema.ts`. Run `bun run generate:provider-contract-schema` from the repository root after changing a schema; `bun run validate` fails while the file is stale.

`@archon/provider-contract/conformance` checks a provider against the contract from fixtures the provider owns. The first check is failure classes: each fixture drives the provider into one failure and names the class it must report.
