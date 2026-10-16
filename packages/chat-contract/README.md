# @archon/chat-contract

The `archon-chat/1` contract for long-lived, out-of-process chat plugins. It depends
on `@archon/provider-contract` for the symmetric NDJSON JSON-RPC peer and token
usage schema. It has no engine, database, platform SDK or server dependency.

`serveChat(plugin, io?)` serves a `ChatPlugin`, using stdin/stdout by default.
`connectChat(io, expectedDescriptor)` initializes a host connection and checks
the live descriptor against the installed descriptor. Register `onInbound` and
`onRunAction` before calling `start()`. Close the connection to close plugin stdin;
`serveChat` drains in-flight requests and rendering before returning. Plugins own
shutdown of their platform connection after `serveChat` returns.

## Wire

| Direction | Method | Result |
| --- | --- | --- |
| Host to plugin | `initialize` (`{}`) | `ChatPluginDescriptor` |
| Host to plugin | `chat/start` (`{}`) | `{}` or RPC error `-32000` with `{retryable}` |
| Plugin to host | `chat/inbound` | Accepted or rejected (`not_allowed`) |
| Plugin to host | `chat/run_action` | Done, rejected, forbidden or refused |
| Host to plugin | `chat/send` | `{}` |
| Host to plugin | `chat/result_footer` | `{}`; requires `resultFooter` capability |
| Host to plugin | `chat/run_event` notification | Requires `runEvents` capability |
| Host to plugin | `chat/attention_notice` | `{conversationId?}`; requires `attentionNotices` capability |

All payloads have exported Zod schemas and inferred TypeScript types. Malformed
request arguments get JSON-RPC `-32602`. Malformed reply payloads reject the
affected call with `PluginProtocolError`; the connection remains usable. An
invalid initialization reply prevents connection setup and closes the peer.
Malformed JSON-RPC messages or run-event notifications fail the connection;
`closed` exposes that failure.
Rendering exceptions are contained and reported to stderr without event contents,
so a rendering failure does not disconnect chat. Start implementations can throw
`ChatStartError(message, retryable)`; unclassified start errors are non-retryable.

Plugins authenticate platform traffic and assert only `sender.platformUserId`
and an optional display name. The host owns allowlists, identity resolution and
authorization, stamps the platform from the installed descriptor, and dispatches
accepted messages without awaiting the full assistant turn. `ChatActor` contains
only `user` and `unidentified`; it is a host type, never a plugin-supplied actor.
Plugin message persistence is always owned by core.

`ChatRunEvent` is a presentation projection: workflow start, node state, approval
pending (including authored decisions, pause identity and the persisted authored
outcome), and terminal status with authored outcome and cost. Engine events and database rows stay on the host.
The host routes events only to the plugin owning the run's conversation.

`ChatAttentionNotice` goes to an install-level route the operator configured, not to
a run's own conversation. `destination` is the route's opaque value. A `gate` notice
carries the gate type, message and decisions; an `attention` notice carries the
attention wait's form (`message`, `approval`, `select` or `multi_select`) and its
options; a `terminal` notice closes a run the route was told about, with the
`conversationId` the plugin returned for that run's earlier notice. A plugin that can
thread a follow-up returns `conversationId`; otherwise it returns `{}`.

Run actions are approve, reject, respond, answer, resume and cancel. An optional
response carries node/pause identity and feedback; respond requires an explicit
decision. Answer carries a typed answer to an attention wait: the required
`nodeId` and `pauseId` of the occurrence it answers, the chosen option ids and
optional text. The host refuses an answer to an occurrence that is no longer open.
Resume continues a paused or failed run, such as an attention wait without a
`pauseId`. `RunActionResult` carries the approval/rejection presentation facts and
whether resume succeeded, an answer or resume and whether it resumed, cooperative
cancellation (including already-finished), or a stopped live owner with cleanup
warnings, cascade failures and a blocked parent.
Unexpected host operation failures should become RPC errors, not a successful
action result.

The descriptor declares retention, streaming defaults and their environment key,
an optional allowlist environment key, optional footer, run-event and attention-notice
support, and
`workflowCommand.prefix`. Hosts format workflow commands as `prefix + command`;
the prefix's trailing space is significant.

## Compatibility

Within `CHAT_PLUGIN_PROTOCOL` (`archon-chat/<n>`), changes are additive: every
message valid for the baseline shape stays valid for the current receiver.
Plugins parse host messages without rejecting unknown fields, so behavior a plugin
must honor is introduced behind a descriptor capability, as `resultFooter`,
`runEvents` and `attentionNotices` are. Removing or narrowing a field, making one
required, adding an enum value the receiver parses, or changing a field's meaning
bumps the protocol.

`connectChat` and `inspectChat` read the protocol a plugin advertises before
parsing its descriptor. A plugin on another protocol fails with
`PluginProtocolMismatchError` from `@archon/provider-contract/plugin`, whose
message and `hostProtocol`/`pluginProtocol` fields name both versions; the host
does not restart it.

`src/fixtures/archon-chat-1-baseline.schema.json` is the baseline the promise
starts from. `compat.test.ts` sends baseline-shaped host messages to the current
plugin and current host messages to a plugin pinned to the baseline. A protocol
bump replaces the snapshot; a test fails while its protocol differs from
`CHAT_PLUGIN_PROTOCOL`.

## Conformance and schema

`runChatConformance(connect)` is exported from `@archon/chat-contract/conformance`
and returns a list of violations. The factory returns a `ChatConformanceFixture`:
a connected host, plugin-owned drivers for inbound messages and actions, a
malformed inbound driver that bypasses local validation, a next-render failure
driver, and a promise that resolves once the plugin stops. Drivers must exercise
the real transport and platform implementation; they must not fabricate results.
The runner installs fixture host handlers for sender ids `allowed` and `denied`.
`PluginRemoteError` is exported from the conformance subpath for process-fixture
drivers that carry a remote error through a separate control channel.
It checks start success or typed failure, long sends, both sender outcomes,
invalid-params without delivery, render-error containment, optional footer, an
optional attention notice and its terminal follow-up, and stdin closure. Each check has a bounded grace period (5 seconds by default).

Generate the language-independent schema with
`bun run generate:chat-contract-schema` from the root; verify it with
`bun run check:chat-contract-schema`. The published document's `$defs` includes
each wire payload and the JSON-RPC envelope. Package tests run with
`bun run --cwd packages/chat-contract test`.
