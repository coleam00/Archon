# Architecture

> Reference detail extracted from `CLAUDE.md`. This is the canonical source for the
> directory layout, database schema, package split, and configuration. `CLAUDE.md` keeps a
> one-paragraph overview and links here.

## Directory Structure

**Monorepo Layout (Bun Workspaces):**

```
packages/
├── cli/                      # @archon/cli - Command-line interface
│   └── src/
│       ├── adapters/         # CLI adapter (stdout output)
│       ├── commands/         # CLI command implementations
│       └── cli.ts            # CLI entry point
├── providers/                # @archon/providers - AI agent providers (SDK deps live here)
│   └── src/
│       ├── types.ts          # Contract layer (IAgentProvider, SendQueryOptions, MessageChunk — ZERO SDK deps)
│       ├── registry.ts       # Typed provider registry (ProviderRegistration records)
│       ├── errors.ts         # UnknownProviderError
│       ├── claude/           # ClaudeProvider + parseClaudeConfig + MCP/hooks/skills translation
│       ├── codex/            # CodexProvider + parseCodexConfig + binary-resolver
│       ├── community/pi/     # PiProvider (builtIn: false) — @earendil-works/pi-coding-agent, ~20 LLM backends
│       ├── community/opencode/ # OpenCodeProvider (builtIn: false) — @archon/opencode SDK, local embedded runtime
│       └── index.ts          # Package exports
├── core/                     # @archon/core - Shared business logic
│   └── src/
│       ├── config/           # YAML config loading
│       ├── db/               # Database connection, queries
│       ├── handlers/         # Command handler (slash commands)
│       ├── orchestrator/     # AI conversation management
│       ├── services/         # Background services (cleanup)
│       ├── schemas/          # Zod row schemas for core data shapes (conversation, message, user, codebase, session, workflow-event, env-var, workflow-run)
│       ├── state/            # Session state machine
│       ├── types/            # TypeScript types and interfaces
│       ├── utils/            # Shared utilities
│       ├── workflows/        # Store adapter (createWorkflowStore) bridging core DB → IWorkflowStore
│       └── index.ts          # Package exports
├── workflows/                # @archon/workflows - Workflow engine (depends on @archon/git + @archon/paths)
│   └── src/
│       ├── schemas/          # Zod schemas for engine types
│       ├── loader.ts         # YAML parsing + validation (parseWorkflow)
│       ├── workflow-discovery.ts # Workflow filesystem discovery (discoverWorkflows, discoverWorkflowsWithConfig)
│       ├── executor-shared.ts # Shared executor infrastructure (error classification, variable substitution)
│       ├── router.ts         # Prompt building + invocation parsing
│       ├── executor.ts       # Workflow execution orchestrator (executeWorkflow)
│       ├── dag-executor.ts   # DAG-specific execution logic
│       ├── store.ts          # IWorkflowStore interface (database abstraction)
│       ├── deps.ts           # WorkflowDeps injection types (IWorkflowPlatform, imports from @archon/providers/types)
│       ├── event-emitter.ts  # Workflow observability events
│       ├── logger.ts         # JSONL file logger
│       ├── validator.ts      # Resource validation (command files, MCP configs, skill dirs)
│       ├── defaults/         # Bundled default commands and workflows
│       └── utils/            # Variable substitution, tool formatting, execution utilities
├── git/                      # @archon/git - Git operations (no @archon/core dep)
│   └── src/
│       ├── branch.ts         # Branch operations (checkout, merge detection, etc.)
│       ├── exec.ts           # execFileAsync and mkdirAsync wrappers
│       ├── repo.ts           # Repository operations (clone, sync, remote URL)
│       ├── types.ts          # Branded types (RepoPath, BranchName, etc.)
│       ├── worktree.ts       # Worktree operations (create, remove, list)
│       └── index.ts          # Package exports
├── isolation/                # @archon/isolation - Worktree isolation (depends on @archon/git + @archon/paths)
│   └── src/
│       ├── types.ts          # Isolation types and interfaces
│       ├── errors.ts         # Error classifiers (classifyIsolationError, IsolationBlockedError)
│       ├── factory.ts        # Provider factory (getIsolationProvider, configureIsolation)
│       ├── resolver.ts       # IsolationResolver (request → environment resolution)
│       ├── store.ts          # IIsolationStore interface
│       ├── worktree-copy.ts  # File copy utilities for worktrees
│       ├── providers/
│       │   └── worktree.ts   # WorktreeProvider implementation
│       └── index.ts          # Package exports
├── paths/                    # @archon/paths - Path resolution and logger (zero @archon/* deps)
│   └── src/
│       ├── archon-paths.ts   # Archon directory path utilities
│       ├── logger.ts         # Pino logger factory
│       └── index.ts          # Package exports
├── adapters/                 # @archon/adapters - Platform adapters (Slack, Telegram, GitHub, Discord)
│   └── src/
│       ├── chat/             # Chat platform adapters (Slack, Telegram)
│       ├── forge/            # Forge adapters (GitHub)
│       ├── community/        # Community adapters (Discord)
│       ├── utils/            # Shared adapter utilities (message splitting)
│       └── index.ts          # Package exports
├── server/                   # @archon/server - HTTP server + Web adapter
│   └── src/
│       ├── adapters/         # Web platform adapter (SSE streaming)
│       ├── routes/           # API routes (REST + SSE)
│       └── index.ts          # Hono server entry point
└── web/                      # @archon/web - React frontend (Web UI)
    └── src/
        ├── components/       # React components (chat, layout, projects, ui, workflows)
        ├── hooks/            # Custom hooks (useSSE, etc.)
        ├── lib/              # API client, types, utilities
        ├── stores/           # Zustand stores (workflow-store)
        ├── routes/           # Route pages (ChatPage, WorkflowsPage, WorkflowBuilderPage, etc.)
        ├── experiments/      # Isolated in-repo spikes; lint-guarded against
        │   │                 # importing production web modules. Drop-in or
        │   │                 # delete cleanly. See experiments/README.md.
        │   └── console/      # Run-centric console UI mounted at /console
        └── App.tsx           # Router + layout
```

**Import Patterns:**

**IMPORTANT**: Always use typed imports - never use generic `import *` for the main package.

```typescript
// ✅ CORRECT: Use `import type` for type-only imports
import type { IPlatformAdapter, Conversation, MergedConfig } from '@archon/core';

// ✅ CORRECT: Use specific named imports for values
import { handleMessage, ConversationLockManager, pool } from '@archon/core';

// ✅ CORRECT: Namespace imports for submodules with many exports
import * as conversationDb from '@archon/core/db/conversations';
import * as git from '@archon/git';

// ✅ CORRECT: Import workflow engine types/functions from direct subpaths
import type { WorkflowDeps } from '@archon/workflows/deps';
import type { IWorkflowStore } from '@archon/workflows/store';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import { executeWorkflow } from '@archon/workflows/executor';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { findWorkflow } from '@archon/workflows/router';

// ❌ WRONG: Never use generic import for main package
import * as core from '@archon/core';  // Don't do this

// ❌ WRONG: In @archon/web, never import from @archon/workflows (it's a server package)
import type { DagNode } from '@archon/workflows/schemas/dag-node';  // Don't do this from @archon/web
// ✅ CORRECT: Use re-exports from api.ts (derived from generated OpenAPI spec)
import type { DagNode, WorkflowDefinition } from '@/lib/api';
```

## Database Schema

**16 Tables (all prefixed with `remote_agent_`):**
1. **`codebases`** - Repository metadata and commands (JSONB)
2. **`conversations`** - Track platform conversations with titles and soft-delete support; nullable `user_id` records first creator
3. **`sessions`** - Track AI SDK sessions with resume capability
4. **`isolation_environments`** - Git worktree isolation tracking; nullable `created_by_user_id` preserves first creator
5. **`workflow_runs`** - Workflow execution tracking and state; nullable `user_id` for per-run attribution
6. **`workflow_events`** - Step-level workflow event log (step transitions, artifacts, errors)
7. **`messages`** - Conversation message history with tool call metadata (JSONB); nullable `user_id` (NULL for assistant rows)
8. **`codebase_env_vars`** - Per-project env vars injected into project-scoped execution surfaces (Claude, Codex, bash/script nodes, and direct chat when codebase-scoped), managed via Web UI or `env:` in config
9. **`users`** - Archon-internal identity (one row per human/bot); created lazily on first sight by any adapter; `role` (`'admin'`(default)`/'member'`) is the identity seam for future per-resource scoping (visibility stays open today)
10. **`user_identities`** - Per-platform mapping (Slack U-id, Telegram chat id, Discord snowflake, GitHub login, Better Auth web user id) → `users.id`; `UNIQUE(platform, platform_user_id)`
11. **`workflow_node_sessions`** - Per-node provider session IDs persisted across workflow re-runs (opt-in via `persist_session`); keyed by `(workflow_name, node_id, scope_key, provider)`; `scope_key` is typically the conversation UUID
12. **`user_github_tokens`** - Per-user GitHub device-flow tokens encrypted at rest (AES-256-GCM); one row per Archon user (`UNIQUE(user_id)`), cascades on user deletion; numeric `github_user_id` anchors the commit no-reply email
13–16. **`remote_agent_auth_user` / `remote_agent_auth_session` / `remote_agent_auth_account` / `remote_agent_auth_verification`** - Better Auth tables for opt-in web login (**PostgreSQL only**; always created on Postgres via the idempotent schema apply, but populated only when web auth is enabled — `DATABASE_URL` + `BETTER_AUTH_SECRET`). Owned and shaped by Better Auth (text ids, camelCase columns); Archon never queries them directly — a session maps to the canonical `users` row via `user_identities('web', <betterAuthUserId>)`

**Key Patterns:**
- Conversation ID format: Platform-specific (`thread_ts`, `chat_id`, `user/repo#123`)
- One active session per conversation
- Codebase commands stored in filesystem, paths in `codebases.commands` JSONB

**Session Transitions:**
- Sessions are immutable - transitions create new linked sessions
- Each transition has explicit `TransitionTrigger` reason (first-message, plan-to-execute, reset-requested, etc.)
- Audit trail: `parent_session_id` links to previous session, `transition_reason` records why
- Only plan→execute creates new session immediately; other triggers deactivate current session

## Architecture Layers

**Package Split:**
- **@archon/paths**: Path resolution utilities, Pino logger factory, web dist cache path (`getWebDistDir`), CWD env stripper (`stripCwdEnv`, `strip-cwd-env-boot`) (no @archon/* deps; `pino` and `dotenv` are allowed external deps)
- **@archon/git**: Git operations - worktrees, branches, repos, exec wrappers (depends only on @archon/paths)
- **@archon/providers**: AI agent providers (Claude, Codex, Pi community) — owns SDK deps, `IAgentProvider` interface, `sendQuery()` contract, and provider-specific option translation. `@archon/providers/types` is the contract subpath (zero SDK deps, zero runtime side effects) that `@archon/workflows` imports from. Providers receive raw `nodeConfig` + `assistantConfig` and translate to SDK-specific options internally. Core providers live under `claude/` and `codex/`; community providers live under `community/` (currently `community/pi/`, registered with `builtIn: false`).
- **@archon/isolation**: Worktree isolation types, providers, resolver, error classifiers (depends only on @archon/git + @archon/paths)
- **@archon/workflows**: Workflow engine - loader, router, executor, DAG, logger, bundled defaults (depends only on @archon/git + @archon/paths + @archon/providers/types + @hono/zod-openapi + zod; DB/AI/config injected via `WorkflowDeps`)
- **@archon/cli**: Command-line interface for running workflows and starting the web UI server (depends on @archon/server + @archon/adapters for the serve command)
- **@archon/core**: Business logic, database, orchestration (depends on @archon/providers for AI and @hono/zod-openapi for core Zod schemas; provides `createWorkflowStore()` adapter bridging core DB → `IWorkflowStore`)
- **@archon/adapters**: Platform adapters for Slack, Telegram, GitHub, Discord (depends on @archon/core)
- **@archon/server**: OpenAPIHono HTTP server (Zod + OpenAPI spec generation via `@hono/zod-openapi`), Web adapter (SSE), API routes, Web UI static serving (depends on @archon/adapters)
- **@archon/web**: React frontend (Vite + Tailwind v4 + shadcn/ui + Zustand), SSE streaming to server. `WorkflowRunStatus`, `WorkflowDefinition`, and `DagNode` are all derived from `src/lib/api.generated.d.ts` (generated from the OpenAPI spec via `bun generate:types`; never import from `@archon/workflows`)

**1. Platform Adapters**
- Implement `IPlatformAdapter` interface
- Handle platform-specific message formats
- **Web** (`packages/server/src/adapters/web/`): Server-Sent Events (SSE) streaming, conversation ID = user-provided string
- **Slack** (`packages/adapters/src/chat/slack/`): SDK with polling (not webhooks), conversation ID = `thread_ts`
- **Telegram** (`packages/adapters/src/chat/telegram/`): Bot API with polling, conversation ID = `chat_id`
- **GitHub** (`packages/adapters/src/forge/github/`): Webhooks + GitHub CLI, conversation ID = `owner/repo#number`
- **Discord** (`packages/adapters/src/community/chat/discord/`): discord.js WebSocket, conversation ID = channel ID

**Adapter Authorization Pattern:**
- Auth checks happen INSIDE adapters (encapsulation, consistency)
- Auth utilities co-located with each adapter (e.g., `packages/adapters/src/chat/slack/auth.ts`)
- Parse whitelist from env var in constructor (e.g., `TELEGRAM_ALLOWED_USER_IDS`)
- Check authorization in message handler (before calling `onMessage` callback)
- Silent rejection for unauthorized users (no error response)
- Log unauthorized attempts with masked user IDs for privacy
- Adapters expose `onMessage(handler)` callback; errors handled by caller

**2. Command Handler** (`packages/core/src/handlers/`)
- Process slash commands (deterministic, no AI)
- The orchestrator treats only these top-level commands as deterministic: `/help`, `/status`, `/reset`, `/workflow`, `/register-project`, `/update-project`, `/remove-project`, `/commands`, `/init`, `/worktree`
- `/workflow` handles subcommands like `list`, `run`, `status`, `cancel`, `resume`, `abandon`, `approve`, `reject`, `reset-sessions`
- Update database, perform operations, return responses

**3. Orchestrator** (`packages/core/src/orchestrator/`)
- Manage AI conversations
- Load conversation + codebase context from database
- Variable substitution: `$1`, `$2`, `$3`, `$ARGUMENTS`
- Session management: Create new or resume existing
- Stream AI responses to platform
- System prompt gets a "Managing Workflow Runs" section (`buildRunManagementSection` in `prompt-builder.ts`) teaching the chat agent to drive run management (`archon workflow runs/get/status/run --detach/approve/reject/abandon`) directly via bash. It is appended **only for project-scoped chats on providers without the native `manage_run` tool** (Codex/OpenCode/Copilot) — gated in `orchestrator-agent.ts` on `!scopedCaps.nativeTools`. Claude and Pi instead receive the in-process `manage_run` native tool (the prompt section would be redundant for them). This is the CLI-bash delivery path for providers that have neither native tools nor `skills:` (direct chat doesn't consume the `skills:` option — it is workflow-node-only).

**4. AI Agent Providers** (`packages/providers/src/`)
- Implement `IAgentProvider` interface
- **ClaudeProvider**: `@anthropic-ai/claude-agent-sdk`
- **CodexProvider**: `@openai/codex-sdk`
- **PiProvider** (community, `builtIn: false`): `@earendil-works/pi-coding-agent` — one harness for ~20 LLM backends via `<provider>/<model>` refs (e.g. `anthropic/claude-haiku-4-5`, `openrouter/qwen/qwen3-coder`); supports extensions, skills, tool restrictions, thinking level, best-effort structured output. See `packages/docs-web/src/content/docs/getting-started/ai-assistants.md` for setup, capability matrix, and extension config.
- Streaming: `for await (const event of events) { await platform.send(event) }`

## Configuration

**Environment Variables:**

see .env.example
see .archon/config.yaml setup as needed

**Assistant Defaults:**

The system supports configuring default models and options per assistant in `.archon/config.yaml`:

```yaml
assistants:
  claude:
    model: sonnet  # or 'opus', 'haiku', 'claude-*', 'inherit'
    settingSources:  # Controls which CLAUDE.md, skills, commands, and agents the SDK loads
      - project      # Project-level <cwd>/.claude/ (included in default)
      - user         # User-level ~/.claude/ (included in default; omit both to restrict to project-only)
    claudeBinaryPath: /absolute/path/to/claude  # Optional: Claude Code executable.
                                                # Native binary (curl installer at
                                                # ~/.local/bin/claude), npm cli.js, or
                                                # the npm platform-package directory
                                                # (e.g. @anthropic-ai/claude-code-win32-x64)
                                                # which is auto-expanded to claude/claude.exe.
                                                # Required in compiled binaries if
                                                # CLAUDE_BIN_PATH env var is not set.
  codex:
    model: gpt-5.3-codex
    modelReasoningEffort: medium  # 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    webSearchMode: live  # 'disabled' | 'cached' | 'live'
    additionalDirectories:
      - /absolute/path/to/other/repo
    codexBinaryPath: /usr/local/bin/codex  # Optional: custom Codex CLI binary path

# docs:
#   path: docs  # Optional: default is docs/

tiers:
  small:
    provider: claude
    model: haiku
  medium:
    provider: claude
    model: sonnet
  large:
    provider: codex
    model: gpt-5.5
    effort: high
```

**Configuration Priority:**
1. Workflow-level options (in YAML `model`, `modelReasoningEffort`, etc.)
2. Config file defaults (`.archon/config.yaml` `assistants.*`)
3. SDK defaults

**Model Validation:**
- Workflows are validated at load time for provider _identity_ only — `provider:` (workflow-level and per-node) must be a registered provider id, otherwise the YAML is rejected with `Unknown provider '<id>'. Registered: claude, codex, pi`.
- Model strings are classified by `resolveModelSpec()` in `packages/workflows/src/model-validation.ts`: tier keywords (`small`/`medium`/`large`) resolve via built-in defaults plus `tiers:` overrides; `@<name>` refs resolve via the merged alias map from config; anything else remains a literal SDK model string.
- Tier and alias refs can resolve provider, model, and provider-specific options. Literal model strings keep the normal provider chain (`node.provider ?? workflow.provider ?? config.assistant`).
- `tiers:` and `aliases:` are valid on global and repo config (repo overrides global). Reserved names `small`, `medium`, `large` cannot be used as custom alias names. Custom alias keys must start with `@` (e.g. `@fast`).

## Running the App in Worktrees

Agents working in worktrees can run the app for self-testing (make changes → run app → test via curl → fix). Ports are automatically allocated to avoid conflicts:

```bash
# Run in worktree (port auto-allocated based on path)
bun dev &
# [Hono] Worktree detected (/path/to/worktree)
# [Hono] Auto-allocated port: 3637 (base: 3090, offset: +547)

# Test via web API (production path)
# 1) Create a conversation
curl -X POST http://localhost:3637/api/conversations \
  -H "Content-Type: application/json" \
  -d '{}'

# 2) Send a message
curl -X POST http://localhost:3637/api/conversations/<conversationId>/message \
  -H "Content-Type: application/json" \
  -d '{"message":"/status"}'

# 3) Fetch messages (polling)
curl http://localhost:3637/api/conversations/<conversationId>/messages

# Note: SSE streaming is available at /api/stream/<conversationId>
```

**Port Allocation:**
- Worktrees: Automatic unique port (3190-4089 range, hash-based on path)
- Main repo: Default 3090
- Override: `PORT=4000 bun dev` (works in both contexts)
- Same worktree always gets same port (deterministic)

**Important:**
- Use the web API routes for manual validation (avoid running multiple platform adapters)
- Database is shared (same conversations/codebases available)
- Kill the server when done: `pkill -f "bun.*dev"` or use the specific port

## Archon Directory Structure

**User-level (`~/.archon/`):**
```
~/.archon/
├── workspaces/owner/repo/        # Project-centric layout
│   ├── source/                   # Cloned repo or symlink → local path
│   ├── worktrees/                # Git worktrees for this project
│   ├── artifacts/                # Workflow artifacts (NEVER in git)
│   │   ├── runs/{id}/            # Per-run artifacts ($ARTIFACTS_DIR)
│   │   │   └── nodes/            # Typed node-output sidecars (<id>.md + <id>.meta.json) for nodes with output_type
│   │   └── uploads/{convId}/     # Web UI file uploads (ephemeral)
│   └── logs/                     # Workflow execution logs
├── vendor/codex/                  # Codex native binary (binary builds, user-placed)
├── web-dist/<version>/            # Cached web UI dist (archon serve, binary only)
├── update-check.json              # Update check cache (binary builds, 24h TTL)
├── archon.db                     # SQLite database (when DATABASE_URL not set)
└── config.yaml                   # Global configuration (non-secrets)
```

**Repo-level (`.archon/` in any repository):**
```
.archon/
├── commands/       # Custom commands
├── workflows/      # Workflow definitions (YAML files)
├── scripts/        # Named scripts for script: nodes (.ts/.js for bun, .py for uv)
├── state/          # Cross-run workflow state (gitignored — never in git)
└── config.yaml     # Repo-specific configuration
```

- `ARCHON_HOME` - Override the base directory (default: `~/.archon`)
- Docker: Paths automatically set to `/.archon/`
