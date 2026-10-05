# `@archon/provider-contract`

This leaf package owns the shapes at the provider boundary: the events a provider streams during a turn, the typed failure it reports, the terminal result of a turn, the `settled` signal, token usage, capabilities, agent requests, execution contexts, native tools, provider registration and the effort ladder. It depends only on zod, so an out-of-repo provider can depend on it too. `@archon/providers`, `@archon/workflows`, `@archon/core` and `@archon/server` import these schemas instead of restating them.

A provider that knows why a turn failed sets `failure: { class, retryAfterMs?, resetAt?, evidence }` on its `result` chunk, and still sets `isError`. The class comes from the SDK's structured signals (error codes, HTTP status fields, typed exceptions), never from matching text; a setup error the provider detects (a missing binary, an unreadable config file, an unknown model) is `misconfigured`, and a failure the provider cannot classify is `unknown`. The engine decides retry from `class`. `evidence` is for the operator and the logs; nothing branches on it. A provider does not retry on its own: the engine owns the retry policy.

During a turn a provider streams `ProviderEvent`s (`src/events.ts`): message and thought text, tool calls and their updates, warnings, MCP server status, compaction, subtasks, hooks and state updates. Names follow the Agent Client Protocol where it has the concept, and each field documents whether it comes from ACP or is an Archon addition. `providerChunkSchema` is the whole stream: these events, then `result`, then `settled`.

- Text events carry a whole block, not a token delta. A provider coalesces deltas and sends the block at a block, tool or turn boundary.
- A provider gives every tool call its own `toolCallId` and closes it with exactly one `tool_call_update` before the next `result`. An interrupted call closes as `cancelled`.
- Tool output is capped at `TOOL_OUTPUT_MAX_CHARS` code points, the unit JSON Schema's `maxLength` counts. The provider truncates with `truncateToolOutput`, which sets `outputTruncated` when it cuts.
- A warning carries a provider-namespaced `code`, such as `claude.node_config_ignored`. Readers branch on the code, never on the message.

The engine records every event a workflow node receives exactly as the provider yielded it, inside an envelope with the node attempt and an emission sequence number, in the run's JSONL log and in its database, and serves the same object from `GET /api/workflows/runs/{runId}/provider-events`. What a provider puts in an event is what operators and API readers see, so the cap and the codes above are the only shaping it gets.

Every normally completed turn, successful or failed, ends with one `{ type: 'settled' }` chunk after its final `result`. A `result` can arrive while work the turn started is still running, so the engine finishes a node on `settled`, not on `result`. Lost observation with live work and cancellation never settle. Workflow nodes suspend the idle watchdog only while a provider declaring `backgroundWork: reported` reports live subtasks; never-ending tasks stay running and cancellable. Any other provider's silent turn still times out. Final result text, structured output and session ID own the node output; cost and tokens sum across results. A shell process launched with `cmd &` inside a foreground command is invisible to every provider.

A provider that declares `sessionResume` names the session each turn ran in with the result's `sessionId`; a provider that cannot resume leaves it out rather than inventing one. A session id can resume the conversation, so the engine stores the full id only on the node record, which is where a user finds it to continue a node outside Archon. Streams and logs carry `sessionPreview(id)`, its first `SESSION_PREVIEW_LENGTH` characters; a provider logs that preview, never the full id.

`schema/provider-contract.schema.json` is generated from `src/` by `src/scripts/generate-schema.ts`. Run `bun run generate:provider-contract-schema` from the repository root after changing a schema; `bun run validate` fails while the file is stale.

`@archon/provider-contract/conformance` checks a provider against the contract from fixtures the provider owns. Failure cases drive the provider into one failure each and name the class it must report and the vendor text its evidence must keep. Turn cases, together with the failure cases, check that every turn settles exactly once, last, after its result. A provider with tools also supplies a `toolTurn`: a turn with two tool calls, one of them interrupted. Its stream must parse as provider chunks, close every tool call once before the next result, never update a call it did not start, and leave every subtask in a terminal status at `settled`, as reported by its runtime. Providers never invent terminal subtask statuses. A provider declaring `backgroundWork: reported` supplies `backgroundCases` with runtime status evidence sampled as chunks arrive; the checker rejects early settlement, invented closes, and missing background fixtures. `none` means verified absence of background work; `unobserved` makes no claim about work the adapter cannot see. When the suite's `capabilities` declare `sessionResume`, every result of a turn case, the tool turn, the fork turn and each background case must carry a non-empty `sessionId`; failure cases are not checked. When they declare `sessionFork`, the suite needs a `forkTurn`: a turn that forks an existing `source` session. Every result of it must report `resumed: true` and name a session other than `source`.

`@archon/provider-contract/plugin` serves and connects a provider over a pair of UTF-8 byte streams (`ReadableStream<Uint8Array>` and `WritableStream<Uint8Array>`). This is the contract slice for [#3642](https://github.com/coleam00/Archon/issues/3642); process spawning, installation and registry integration follow separately.

```ts
import { connectProvider, serveProvider } from '@archon/provider-contract/plugin';

const serving = serveProvider({ descriptor, create: () => provider }, providerIO);
const client = await connectProvider(hostIO);
try {
  for await (const chunk of client.sendQuery('Task', '/absolute/project/path')) {
    // Consume the same ProviderChunk the in-process provider emits.
  }
} finally {
  await client.close();
  await serving;
}
```

`serveProvider` defaults to stdin/stdout when no stream pair is supplied. Stdout must contain only protocol traffic; diagnostics belong on stderr. The connection uses ACP v1 `initialize`, `session/new`, `session/prompt` and `session/cancel`, with the descriptor advertised in `agentCapabilities._meta.archon`. The transport-local session handle is separate from the native session id carried in `result.sessionId`. Each `_archon/chunk` notification carries `{ sessionId, chunk }`; the client validates the chunk using `providerChunkSchema` and preserves its fields and order. It finishes on `settled`, or when a cancelled stream ends. It never invents results, settlement or terminal subtask states. An uncancelled end before settlement fails.

Descriptors declare protocol `1`, provider identity/version, capabilities, a static credential catalog and a config JSON Schema. Native tool handlers and dynamic credential catalogs cannot cross this wire and are refused. Credential checks and credential-model resolution use `_archon/check_credential` and `_archon/resolve_credential_model`. Unknown notifications are ignored; unsupported requests receive JSON-RPC `-32601`. This is an Archon extension, not a plain ACP agent adapter.

Session requests carry the data fields of `SendQueryOptions`. `abortSignal` becomes `session/cancel`; `onAdmission` stays with the host; `nativeTools` cannot be transported. `env` belongs to the process carrier, not the wire: `serveProvider` gives the underlying provider its own process environment. A stream pair does not apply the client's `env` bag to the serving process. The process carrier owns termination when a provider does not respond to cancellation. Closing a connection aborts its provider work.

The generated JSON Schema includes the descriptor, serializable request, lifecycle payloads, extension payloads and JSON-RPC envelopes. Messages are newline-terminated JSON, capped at `PROVIDER_PLUGIN_MAX_MESSAGE_BYTES` (16 MiB per line, excluding the newline). Malformed UTF-8, JSON, envelopes and chunk payloads fail with `ProviderPluginProtocolError`, including the provider id and incoming line number. The tests check emitted lifecycle payloads against the unmodified ACP v1 schema definitions from `@agentclientprotocol/sdk@1.7.0`, kept as a test fixture with its Apache 2.0 license.
