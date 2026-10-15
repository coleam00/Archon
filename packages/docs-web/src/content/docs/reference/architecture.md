---
title: Architecture
description: How Archon's code is organized, and where the maintained architecture map lives.
category: reference
audience: [developer]
status: current
sidebar:
  order: 1
---

Archon is a Bun and TypeScript monorepo. A small set of packages carries the engine and its contracts; the server, CLI, console and integrations compose around them.

- **Contracts.** `provider-contract`, `chat-contract` and `plugin-manifest` define how providers, chat platforms, forges and workflow packs attach. `forge` owns the forge seam.
- **Engine.** `workflows` loads, validates and runs workflow graphs, records events through a store contract, and pauses runs durably. It reaches providers and persistence only through injected dependencies.
- **Isolation.** `isolation` provides git worktrees for repo projects, and in-place and container execution backends.
- **Host.** `core` owns the database, conversations, the chat orchestrator and workflow operations. `server` serves the API, webhooks and the console; `cli` is the `archon` command.
- **Integrations.** `providers` holds the maintained Claude, Codex and Pi providers and the deprecated bundled OpenCode and Copilot providers. `adapters` and `chat-slack` hold the bundled chat and forge integrations. New integrations ship as [plugins](/guides/publishing-plugins/).

The maintained map, with each package's dependencies, the main flows, extension points and the checks that enforce each boundary, is [`.archon/architecture.md`](https://github.com/coleam00/Archon/blob/dev/.archon/architecture.md) in the repository. It is kept beside the code, and CI checks its package table against the declared dependencies.

## Related

- [Build a community provider](/contributing/adding-a-community-provider/), including how native SDK events map to the provider contract
- [Provider capabilities](/reference/provider-capabilities/)
- [Forge operations](/reference/forge/)
- [Database](/reference/database/)
- [Isolation](/book/isolation/)
