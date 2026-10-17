# Community Chat Adapters

This directory holds the Discord adapter, a bundled community integration kept for
existing installs. Bundled community integrations are a transition state
([`direction.md §community-plugins`](../../../../../.archon/direction.md#community-plugins)):
they get focused compatibility, correctness and security fixes, and no new adapter is
added here.

## Adding a chat platform

A new chat platform ships as a chat plugin from its own repository and attaches through
`ChatPlugin` from `@archon/chat-contract`, with no change to Archon:

- [`@archon/chat-contract`](../../../../chat-contract/README.md) owns the wire, the
  descriptor and the conformance suite.
- [Publish a plugin: chat plugins](../../../../docs-web/src/content/docs/guides/publishing-plugins.md#chat-plugins)
  covers the manifest, release assets and `archon plugin add`.
- [`@archon/chat-slack`](../../../../chat-slack/src/plugin.ts) is the maintained Slack chat
  plugin and a complete example.
