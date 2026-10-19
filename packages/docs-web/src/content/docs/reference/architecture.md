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
- **Integrations.** `providers` holds the maintained Claude, Codex and Pi providers and the deprecated bundled OpenCode and Copilot providers. `adapters` holds the bundled chat and forge integrations; `chat-slack` is the maintained Slack chat plugin, installed with `archon plugin add`. New integrations ship as [plugins](/guides/publishing-plugins/).

The maintained map, with each package's ownership, the main flows, extension points and the checks that enforce each boundary, is [`.archon/architecture.md`](https://github.com/coleam00/Archon/blob/dev/.archon/architecture.md) in the repository. It is kept beside the code, and CI checks declared package dependencies against the linked layering policy.

Existing worktrees are reused by default. Reuse emits a `worktree_adopted` warning and records adoption provenance; it does not grant cleanup ownership. The shared [store recipe](https://github.com/coleam00/Archon/blob/dev/packages/isolation/src/store.ts) owns registration and guarded adoption. The [worktree provider](https://github.com/coleam00/Archon/blob/dev/packages/isolation/src/providers/worktree.ts) creates checkouts. The [isolation resolver](https://github.com/coleam00/Archon/blob/dev/packages/isolation/src/resolver.ts) selects worktrees. The resolver and [launch helper](https://github.com/coleam00/Archon/blob/dev/packages/core/src/workflows/registered-worktree.ts) call the store recipe.

## Related

- [Build a community provider](/contributing/adding-a-community-provider/), including how native SDK events map to the provider contract
- [Provider capabilities](/reference/provider-capabilities/)
- [Forge operations](/reference/forge/)
- [Database](/reference/database/)
- [Worktrees](/guides/worktrees/)
