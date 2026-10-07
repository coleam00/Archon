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
pending (including authored decisions and pause identity), and terminal status
with authored outcome and cost. Engine events and database rows stay on the host.
The host routes events only to the plugin owning the run's conversation.

Run actions are approve, reject, respond and cancel. An optional response carries
node/pause identity and feedback; respond requires an explicit decision.
`RunActionResult` carries the approval/rejection presentation facts and whether
resume succeeded, cooperative cancellation (including already-finished), or
a stopped live owner with cleanup warnings, cascade failures and a blocked parent.
Unexpected host operation failures should become RPC errors, not a successful
action result.

The descriptor declares retention, streaming defaults and their environment key,
an optional allowlist environment key, optional footer and run-event support, and
`workflowCommand.prefix`. Hosts format workflow commands as `prefix + command`;
the prefix's trailing space is significant.

## Conformance and schema

`runChatConformance(connect)` is exported from `@archon/chat-contract/conformance`
and returns a list of violations. The factory returns a `ChatConformanceFixture`:
a connected host, plugin-owned drivers for inbound messages and actions, a
malformed inbound driver that bypasses local validation, a next-render failure
driver, and a promise that resolves once the plugin stops. Drivers must exercise
the real transport and platform implementation; they must not fabricate results.
The runner installs fixture host handlers for sender ids `allowed` and `denied`.
It checks start success or typed failure, long sends, both sender outcomes,
invalid-params without delivery, render-error containment, optional footer and
stdin closure. Each check has a bounded grace period (5 seconds by default).

Generate the language-independent schema with
`bun run generate:chat-contract-schema` from the root; verify it with
`bun run check:chat-contract-schema`. The published document's `$defs` includes
each wire payload and the JSON-RPC envelope. Package tests run with
`bun run --cwd packages/chat-contract test`.

This package delivers slice 1 of #3646. Installation, process supervision,
host authorization pipelines, event mapping and Slack migration are later slices.
