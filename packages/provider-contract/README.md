# `@archon/provider-contract`

This leaf package owns the shapes at the provider boundary: the events a provider streams during a turn, the typed failure it reports, the terminal result of a turn, the `settled` signal, token usage, and the capability set. It depends only on zod, so an out-of-repo provider can depend on it too. `@archon/providers`, `@archon/workflows`, `@archon/core` and `@archon/server` import these schemas instead of restating them.

A provider that knows why a turn failed sets `failure: { class, retryAfterMs?, resetAt?, evidence }` on its `result` chunk, and still sets `isError`. The class comes from the SDK's structured signals (error codes, HTTP status fields, typed exceptions), never from matching text; a setup error the provider detects (a missing binary, an unreadable config file, an unknown model) is `misconfigured`, and a failure the provider cannot classify is `unknown`. The engine decides retry from `class`. `evidence` is for the operator and the logs; nothing branches on it. A provider does not retry on its own: the engine owns the retry policy.

During a turn a provider streams `ProviderEvent`s (`src/events.ts`): message and thought text, tool calls and their updates, warnings, MCP server status, compaction, subtasks, hooks and state updates. Names follow the Agent Client Protocol where it has the concept, and each field documents whether it comes from ACP or is an Archon addition. `providerChunkSchema` is the whole stream: these events, then `result`, then `settled`.

- Text events carry a whole block, not a token delta. A provider coalesces deltas and sends the block at a block, tool or turn boundary.
- A provider gives every tool call its own `toolCallId` and closes it with exactly one `tool_call_update` before the next `result`. An interrupted call closes as `cancelled`.
- Tool output is capped at `TOOL_OUTPUT_MAX_CHARS` code points, the unit JSON Schema's `maxLength` counts. The provider truncates with `truncateToolOutput`, which sets `outputTruncated` when it cuts.
- A warning carries a provider-namespaced `code`, such as `claude.node_config_ignored`. Readers branch on the code, never on the message.

Every turn, successful or failed, ends with one `{ type: 'settled' }` chunk after its final `result`. A `result` can arrive while work the turn started is still running, so the engine finishes a node on `settled`, not on `result`.

`schema/provider-contract.schema.json` is generated from `src/` by `src/scripts/generate-schema.ts`. Run `bun run generate:provider-contract-schema` from the repository root after changing a schema; `bun run validate` fails while the file is stale.

`@archon/provider-contract/conformance` checks a provider against the contract from fixtures the provider owns. Failure cases drive the provider into one failure each and name the class it must report and the vendor text its evidence must keep. Turn cases, together with the failure cases, check that every turn settles exactly once, last, after its result. A provider with tools also supplies a `toolTurn`: a turn with two tool calls, one of them interrupted. Its stream must parse as provider chunks, close every tool call once before the next result, never update a call it did not start, and leave every subtask in a terminal status at `settled`.
