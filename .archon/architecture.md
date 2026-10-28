# Archon architecture

A map of the code as it is, where it is going, and the boundaries that hold while it moves. Product scope and the reasons behind the target live in [`direction.md`](direction.md); this file covers code structure only. Links point at the owning source. When this file and the code disagree, the code wins and this file is the bug.

## Current state

### Packages

| Package | Owns | May import (`@archon/*`) | Tests may also import |
|---|---|---|---|
| `paths` | Archon home and workspace paths, env loading, logger, test utilities | none | |
| `provider-contract` | `IAgentProvider`, provider chunks and failure classes, registration rules, the provider plugin wire | none | |
| `chat-contract` | `ChatPlugin`, the chat plugin wire | `provider-contract` | |
| `plugin-manifest` | Plugin manifest schema for the `provider`, `chat`, `forge` and `workflow-pack` kinds, install receipts | `chat-contract`, `paths`, `provider-contract` | |
| `git` | Git operations | `paths` | |
| `forge` | Forge seam: discovery, dispatch and conformance for forge plugins | `paths` | |
| `providers` | Claude and Codex, Pi (maintained, though it sits under `community/`), the bundled community providers OpenCode and Copilot, the provider registry | `paths`, `provider-contract` | |
| `workflows` | The engine: loading, validation, DAG execution, durable pauses, attention queue, store contract, file store | `git`, `paths`, `plugin-manifest`, `provider-contract` | `providers` |
| `isolation` | Worktree provider, in-place and container backends, isolation resolver | `git`, `paths`, `provider-contract`, `workflows` | |
| `core` | Database, conversations, chat orchestrator, workflow operations and hosts, credentials | `chat-contract`, `git`, `isolation`, `paths`, `plugin-manifest`, `provider-contract`, `providers`, `workflows` | |
| `adapters` | Bundled chat adapters (Telegram; Discord under `community/`), the GitHub forge adapter (Gitea and GitLab under `community/`), platform policies, the Standard Webhooks source | `core`, `forge`, `git`, `isolation`, `paths`, `providers`, `workflows` | |
| `chat-slack` | The maintained Slack chat plugin | `chat-contract` | |
| `server` | HTTP API, the Web adapter, webhooks, SSE, the chat plugin host, serving the console | `adapters`, `chat-contract`, `core`, `git`, `paths`, `provider-contract`, `providers`, `workflows` | |
| `cli` | The `archon` command and the CLI adapter | `adapters`, `chat-contract`, `core`, `forge`, `git`, `isolation`, `paths`, `plugin-manifest`, `provider-contract`, `providers`, `workflows` | |
| `web` | The console; reads the API through generated types | none | |
| `docs-web` | The docs site | `plugin-manifest` | |

The import columns are each package's declared `@archon/*` dependencies, and `check:package-edges` fails when a `package.json` disagrees with them. The allowed edges live in `PACKAGE_LAYERING` ([`scripts/check-package-edges.ts`](../scripts/check-package-edges.ts)); its test keeps this table equal to it.

### Main flows

- **Chat message.** A bundled adapter, the Web adapter ([`server/src/adapters/web.ts`](../packages/server/src/adapters/web.ts)) or a chat plugin process run by the server's chat host ([`server/src/chat-host/`](../packages/server/src/chat-host/), receipts loaded by [`core/src/platforms/chat-plugins.ts`](../packages/core/src/platforms/chat-plugins.ts)) normalizes the message and calls `handleMessage` ([`core/src/orchestrator/orchestrator-agent.ts`](../packages/core/src/orchestrator/orchestrator-agent.ts)). The chat agent acts through typed tools ([`orchestrator/chat-tools.ts`](../packages/core/src/orchestrator/chat-tools.ts)). `invoke_workflow` queues a launch that the orchestrator dispatches after the turn, resolving the workspace through `validateAndResolveIsolation` ([`orchestrator/dispatch/isolation-resolver.ts`](../packages/core/src/orchestrator/dispatch/isolation-resolver.ts)) and `IsolationResolver` ([`isolation/src/resolver.ts`](../packages/isolation/src/resolver.ts)).
- **Workflow run.** `workflowRunCommand` ([`cli/src/commands/workflow-run-owned.ts`](../packages/cli/src/commands/workflow-run-owned.ts)) or the orchestrator prepares the workspace and submits the run to a `WorkflowHost` ([`core/src/workflows/host-store.ts`](../packages/core/src/workflows/host-store.ts)), backed by SQL ([`sql-host.ts`](../packages/core/src/workflows/sql-host.ts)) or files ([`file-host.ts`](../packages/core/src/workflows/file-host.ts), [`@archon/workflows/file-store`](../packages/workflows/src/file-store/index.ts)). Its engine, `InProcessWorkflowEngine` ([`workflows/src/in-process-engine.ts`](../packages/workflows/src/in-process-engine.ts), port in [`engine-port.ts`](../packages/workflows/src/engine-port.ts)), calls `executeWorkflow` ([`workflows/src/executor.ts`](../packages/workflows/src/executor.ts)), which hands the graph to `executeDagWorkflow` ([`workflows/src/dag-executor.ts`](../packages/workflows/src/dag-executor.ts)). The engine reaches providers and persistence only through `WorkflowDeps` ([`workflows/src/deps.ts`](../packages/workflows/src/deps.ts)): the provider registry and an `IWorkflowStore` ([`workflows/src/store.ts`](../packages/workflows/src/store.ts)).
- **Pause and continue.** A gate, wait, provider usage limit or rate limit that outlasted its retries pauses the run durably and the run appears in the attention queue ([`workflows/src/attention-queue.ts`](../packages/workflows/src/attention-queue.ts)). Approve, reject, answer and abandon go through workflow operations ([`core/src/operations/workflow-operations.ts`](../packages/core/src/operations/workflow-operations.ts)) from any surface, and the continuation host ([`core/src/workflows/continuation-host.ts`](../packages/core/src/workflows/continuation-host.ts)) resumes the run through the shared [`core/src/workflows/continuation-resume.ts`](../packages/core/src/workflows/continuation-resume.ts) path. Provider-limit waits resume when their deadline is due: the reported reset, or a rate limit's backoff.
- **Webhooks and triggers.** The server verifies a forge delivery ([`server/src/routes/webhooks.ts`](../packages/server/src/routes/webhooks.ts)) and passes it to the forge adapter's `receiveWebhook` (for GitHub, [`adapters/src/forge/github/adapter.ts`](../packages/adapters/src/forge/github/adapter.ts)). Webhook sources ([`server/src/services/webhook-source-plugins.ts`](../packages/server/src/services/webhook-source-plugins.ts)), schedules and `archon trigger` start workflows without a chat message ([workflow triggers guide](../packages/docs-web/src/content/docs/guides/workflow-triggers.md)).

### Extension points

| Seam | Contract | How it attaches |
|---|---|---|
| AI provider | `IAgentProvider` ([`provider-contract`](../packages/provider-contract/README.md)) | Provider plugin, or maintained in `providers` |
| Chat platform | `ChatPlugin` ([`chat-contract`](../packages/chat-contract/README.md)) | Chat plugin, loaded by `loadChatPlugins` |
| Forge | [`@archon/forge`](../packages/forge/src/index.ts) | Forge plugin executable |
| Workflow pack | Workflow YAML plus scripts and commands | `archon plugin add` |
| Workspace isolation | `IIsolationProvider` ([`isolation/src/types.ts`](../packages/isolation/src/types.ts)) | Built in: worktrees for repo projects |
| Execution isolation | `IIsolationBackend` ([`isolation/src/types.ts`](../packages/isolation/src/types.ts)) | Built in: in-place and container |
| Persistence | `IWorkflowStore` ([`workflows/src/store.ts`](../packages/workflows/src/store.ts)) | SQL (SQLite or PostgreSQL) or file store |

Details: [publishing plugins](../packages/docs-web/src/content/docs/guides/publishing-plugins.md), [building a community provider](../packages/docs-web/src/content/docs/contributing/adding-a-community-provider.mdx), [database](../packages/docs-web/src/content/docs/reference/database.md), [isolation](direction.md#isolation).

### Module layout

- **DAG execution.** [`workflows/src/dag-executor.ts`](../packages/workflows/src/dag-executor.ts) keeps the `executeDagWorkflow` entry. The layer walker, node dispatch and shared execution code live in [`workflows/src/dag/`](../packages/workflows/src/dag/), with one folder per node type under [`dag/nodes/`](../packages/workflows/src/dag/nodes/). Each module's tests sit beside it.
- **Chat turn.** [`core/src/orchestrator/orchestrator-agent.ts`](../packages/core/src/orchestrator/orchestrator-agent.ts) keeps the `handleMessage` entry. Request preparation, conversation context, project commands, typed chat tools, workflow dispatch and the AI turn itself live in sibling modules under [`core/src/orchestrator/`](../packages/core/src/orchestrator/). Each module's tests sit beside it, sharing mocks from [`core/src/test/orchestrator-agent-harness.ts`](../packages/core/src/test/orchestrator-agent-harness.ts).
- **HTTP API.** [`server/src/routes/api.ts`](../packages/server/src/routes/api.ts) is an ordered list of per-area registrars, each in an `api.<area>.ts` module beside it.

## Target state

Each item is a direction, not a fact about today's code. The why is in [`direction.md §standalone-core`](direction.md#aspirational-architecture-a-standalone-core).

- **The engine is an SDK.** A public SDK package defines, validates, runs, resumes and queries workflows without the server, the console, adapters, provider implementations or a database. The CLI and console become its first users.
- **Core plus CLI is a complete local install**, with the file store as default persistence and a database as an optional adapter.
- **Integrations are plugins.** Providers, chat platforms and forges attach through their contracts with no provider- or platform-specific branches in engine control flow. The bundled community integrations (Telegram, Discord, Gitea, GitLab, OpenCode and Copilot) move out once their plugin path is proven.
- **Isolation beyond worktrees is plugins.** Containers, VMs and remote execution attach behind `IIsolationBackend`.
- **Lifecycle has pluggable hosts.** Continuations, schedules and triggers are core surfaces that the server, the CLI, an OS timer or a third party can drive.
- **One owner per plugin's config.** Chat and forge plugins follow the single config owner providers already have.
- **Large modules split along their seams** when work touches them, the way the modules under [Module layout](#module-layout) did, following existing patterns rather than a new architecture.

## Boundaries

Rules that hold now and during the move. Each names what enforces it, or says it isn't enforced.

| Rule | Enforced by |
|---|---|
| A package imports only `@archon/*` packages it declares | `check:package-edges` ([`scripts/check-package-edges.ts`](../scripts/check-package-edges.ts)) |
| Which packages may depend on which (the package table above) | `check:package-edges` (`PACKAGE_LAYERING`) |
| `workflows` never imports `core`, `server`, adapters or provider implementations; it gets them through `WorkflowDeps` | `check:package-edges`: the `workflows` row allows none of them at runtime |
| Workflow-facing code in `core` and `cli` reaches persistence only through the workflow host contract | `bun run lint` ([`scripts/check-workflow-persistence.ts`](../scripts/check-workflow-persistence.ts)) |
| Engine schemas use plain `zod`, not `@hono/zod-openapi` | `check:package-edges` |
| CLI startup doesn't load core, the engine or provider SDKs before a command needs them | `check:cli-import-boundary` ([`scripts/check-cli-import-boundary.ts`](../scripts/check-cli-import-boundary.ts)) |
| Provider SDK dependencies live only in `providers`; copied SDK types conform to the SDK | `bun run lint` ([`scripts/check-sdk-type-drift.ts`](../scripts/check-sdk-type-drift.ts)) for the copies. **The location rule is not enforced.** |
| No provider- or platform-specific branches in engine control flow | **Not enforced.** Review only. |
| The console uses only generated API types | `check:api-types`, plus `web` declaring no `@archon` dependency |
| Schema changes are additive, and SQLite and PostgreSQL agree | `check:schema-upgrades`, `check:sqlite-vintages`, the schema parity tests in [`core/src/db/adapters/sqlite.test.ts`](../packages/core/src/db/adapters/sqlite.test.ts) |
| Each provider's capabilities are declared once, in its `capabilities.ts`, and the docs derive from them | `check:capability-matrix` |
| Workflow packs don't hardcode a project's context paths, and the engine doesn't assume a pack's conventions | **Not enforced.** Review only. |
