## Project Overview

**Remote Agentic Coding Platform**: Control AI coding assistants (Claude Code SDK, Codex SDK) remotely from Slack, Telegram, and GitHub. Built with **Bun + TypeScript + SQLite/PostgreSQL**, single-developer tool for AI-assisted development practitioners. Architecture prioritizes simplicity, flexibility, and user control.

## Core Principles

**Single-Developer Tool**
- No multi-tenant complexity

**Platform Agnostic**
- Unified conversation interface across Slack/Telegram/GitHub/cli/web
- Platform adapters implement `IPlatformAdapter`
- Stream/batch AI responses in real-time to all platforms

**Type Safety (CRITICAL)**
- Strict TypeScript configuration enforced
- All functions must have complete type annotations
- No `any` types without explicit justification
- Interfaces for all major abstractions

**Zod Schema Conventions**
- Schema naming: camelCase, descriptive suffix (e.g., `workflowRunSchema`, `errorSchema`)
- Type derivation: always use `z.infer<typeof schema>` — never write parallel hand-crafted interfaces
- Import `z` from `@hono/zod-openapi` (not from `zod` directly)
- All new/modified API routes must use `registerOpenApiRoute(createRoute({...}), handler)` — the local wrapper handles the TypedResponse bypass
- Route schemas live in `packages/server/src/routes/schemas/` — one file per domain
- Engine schemas live in `packages/workflows/src/schemas/` — one file per concern (dag-node, workflow, workflow-run, retry, loop, hooks); `index.ts` re-exports all
- Engine schema naming: camelCase (e.g., `dagNodeSchema`, `workflowBaseSchema`, `nodeOutputSchema`)
- `TRIGGER_RULES` and `WORKFLOW_HOOK_EVENTS` are derived from schema `.options` — never duplicate as a plain array (exception: `@archon/web` must define a local constant since `api.generated.d.ts` is type-only and cannot export runtime values)
- `loader.ts` uses `dagNodeSchema.safeParse()` for node validation; graph-level checks (cycles, deps, `$nodeId.output` refs) remain as imperative code in `validateDagStructure()`

**Git Workflow and Releases**
- `main` is the release branch. Never commit directly to `main`.
- `dev` is the working branch. All feature work branches off `dev` and merges back into `dev`.
- To release, use the `/release` skill. It compares `dev` to `main`, generates changelog entries, bumps the version, and creates a PR to merge `dev` into `main`.
- Releases follow Semantic Versioning: `/release` (patch), `/release minor`, `/release major`.
- Changelog lives in `CHANGELOG.md` and follows Keep a Changelog format.
- Version is the single `version` field in the root `package.json`.

**Git as First-Class Citizen**
- Let git handle what git does best (conflicts, uncommitted changes, branch management)
- Surface git errors to users for actionable issues (conflicts, uncommitted changes)
- Handle expected failure cases gracefully (missing directories during cleanup)
- Trust git's natural guardrails (e.g., refuse to remove worktree with uncommitted changes)
- Use `@archon/git` functions for git operations; use `execFileAsync` (not `exec`) when calling git directly
- Worktrees enable parallel development per conversation without branch conflicts
- Workspaces automatically sync with origin before worktree creation (ensures latest code)
- **NEVER run `git clean -fd`** - it permanently deletes untracked files (use `git checkout .` instead)

## Engineering Principles

These are implementation constraints, not slogans. Apply them by default.

**KISS — Keep It Simple, Stupid**
- Prefer straightforward control flow over clever meta-programming
- Prefer explicit branches and typed interfaces over hidden dynamic behavior
- Keep error paths obvious and localized

**YAGNI — You Aren't Gonna Need It**
- Do not add config keys, interface methods, feature flags, or workflow branches without a concrete accepted use case
- Do not introduce speculative abstractions without at least one current caller
- Keep unsupported paths explicit (error out) rather than adding partial fake support

**DRY + Rule of Three**
- Duplicate small, local logic when it preserves clarity
- Extract shared utilities only after the same pattern appears at least three times and has stabilized
- When extracting, preserve module boundaries and avoid hidden coupling

**SRP + ISP — Single Responsibility + Interface Segregation**
- Keep each module and package focused on one concern
- Extend behavior by implementing existing narrow interfaces (`IPlatformAdapter`, `IAgentProvider`, `IDatabase`, `IWorkflowStore`) whenever possible
- Avoid fat interfaces and "god modules" that mix policy, transport, and storage
- Do not add unrelated methods to an existing interface — define a new one

**Fail Fast + Explicit Errors** — Silent fallback in agent runtimes can create unsafe or costly behavior
- Prefer throwing early with a clear error for unsupported or unsafe states — never silently swallow errors
- Never silently broaden permissions or capabilities
- Document fallback behavior with a comment when a fallback is intentional and safe; otherwise throw

**Determinism + Reproducibility**
- Prefer reproducible commands and locked dependency behavior in CI-sensitive paths
- Keep tests deterministic — no flaky timing or network dependence without guardrails
- Ensure local validation commands (`bun run validate`) map directly to CI expectations

**Reversibility + Rollback-First Thinking**
- Keep changes easy to revert: small scope, clear blast radius
- For risky changes, define the rollback path before merging
- Avoid mixed mega-patches that block safe rollback

## Essential Commands

### Development

```bash
# Start server + Web UI together (hot reload for both)
bun run dev

# Or start individually
bun run dev:server  # Backend only (port 3090)
bun run dev:web     # Frontend only (port 5173)
```

Regenerating frontend API types (requires server to be running at port 3090):

```bash
bun run dev:server  # must be running first
bun --filter @archon/web generate:types
```

Optional: Use PostgreSQL instead of SQLite by setting `DATABASE_URL` in `.env`:

```bash
docker-compose --profile with-db up -d postgres
# Set DATABASE_URL=postgresql://postgres:postgres@localhost:5432/remote_coding_agent in .env
```

### Testing

```bash
bun run test                # Run all tests (per-package, isolated processes)
bun test --watch            # Watch mode (single package)
bun test packages/core/src/handlers/command-handler.test.ts  # Single file
```

**Test isolation (mock.module pollution):** Bun's `mock.module()` permanently replaces modules in the process-wide cache — `mock.restore()` does NOT undo it ([oven-sh/bun#7823](https://github.com/oven-sh/bun/issues/7823)). To prevent cross-file pollution, packages that have conflicting `mock.module()` calls split their tests into separate `bun test` invocations: `@archon/core` (7 batches), `@archon/workflows` (5), `@archon/adapters` (3), `@archon/isolation` (3). See each package's `package.json` for the exact splits.

**Do NOT run `bun test` from the repo root** — it discovers all test files across all packages and runs them in one process, causing ~135 mock pollution failures. Always use `bun run test` (which uses `bun --filter '*' test` for per-package isolation).

### Type Checking & Linting

```bash
bun run type-check
bun run lint
bun run lint:fix
bun run format
bun run format:check
```

### Pre-PR Validation

**Always run before creating a pull request:**

```bash
bun run validate
```

This runs type-check, lint, format check, and tests. All four must pass for CI to succeed.

### ESLint Guidelines

**Zero-tolerance policy**: CI enforces `--max-warnings 0`. No warnings allowed.

**When to use inline disable comments** (`// eslint-disable-next-line`):
- **Almost never** - fix the issue instead
- Only acceptable when:
  1. External SDK types are incorrect (document which SDK and why)
  2. Intentional type assertion after validation (must include comment explaining the validation)

**Never acceptable:**
- Disabling `no-explicit-any` without justification
- Disabling rules to "make CI pass"
- Bulk disabling at file level (`/* eslint-disable */`)

### Database

**Auto-Detection (SQLite is the default — zero setup):**
- **Without `DATABASE_URL`**: Uses SQLite at `~/.archon/archon.db` (auto-initialized, recommended for most users)
- **With `DATABASE_URL` set**: Uses PostgreSQL (optional, for cloud/advanced deployments)

```bash
# PostgreSQL only: Run SQL migrations (manual)
psql $DATABASE_URL < migrations/000_combined.sql
```

### CLI (Command Line)

Run workflows directly from the command line without needing the server. Workflow and isolation commands require running from within a git repository (subdirectories work - resolves to repo root).

```bash
# List available workflows (requires git repo)
bun run cli workflow list

# Machine-readable JSON output
bun run cli workflow list --json

# Run a workflow
bun run cli workflow run assist "What does the orchestrator do?"

# Run in a specific directory
bun run cli workflow run plan --cwd /path/to/repo "Add dark mode"

# Default: auto-creates worktree with generated branch name (isolation by default)
bun run cli workflow run implement "Add auth"

# Explicit branch name for the worktree
bun run cli workflow run implement --branch feature-auth "Add auth"

# Opt out of isolation (run in live checkout)
bun run cli workflow run quick-fix --no-worktree "Fix typo"

# Show running workflows
bun run cli workflow status

# Resume a failed workflow (re-runs, skipping completed nodes)
bun run cli workflow resume <run-id>

# Discard a non-terminal run
bun run cli workflow abandon <run-id>

# Delete old workflow run records (default: 7 days)
bun run cli workflow cleanup
bun run cli workflow cleanup 30  # Custom days

# Emit a workflow event (used inside workflow loop prompts)
bun run cli workflow event emit --run-id <uuid> --type <event-type> [--data <json>]

# List active worktrees/environments
bun run cli isolation list

# Clean up stale environments (default: 7 days)
bun run cli isolation cleanup
bun run cli isolation cleanup 14  # Custom days

# Clean up environments with branches merged into main (also deletes remote branches)
bun run cli isolation cleanup --merged

# Also remove environments with closed (abandoned) PRs
bun run cli isolation cleanup --merged --include-closed

# Validate workflow definitions and their referenced resources
bun run cli validate workflows              # All workflows
bun run cli validate workflows my-workflow  # Single workflow
bun run cli validate workflows my-workflow --json  # Machine-readable output

# Validate command files
bun run cli validate commands               # All commands
bun run cli validate commands my-command    # Single command

# Complete branch lifecycle (remove worktree + local/remote branches)
bun run cli complete <branch-name>
bun run cli complete <branch-name> --force  # Skip uncommitted-changes check

# Start the web UI server (compiled binary only, downloads web UI on first run)
bun run cli serve
bun run cli serve --port 4000
bun run cli serve --download-only  # Download without starting

# Show version
bun run cli version
```

## Architecture

### Directory Structure

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
│       └── index.ts          # Package exports
├── core/                     # @archon/core - Shared business logic
│   └── src/
│       ├── config/           # YAML config loading
│       ├── db/               # Database connection, queries
│       ├── handlers/         # Command handler (slash commands)
│       ├── orchestrator/     # AI conversation management
│       ├── services/         # Background services (cleanup)
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

### Database Schema

**8 Tables (all prefixed with `remote_agent_`):**
1. **`codebases`** - Repository metadata and commands (JSONB)
2. **`conversations`** - Track platform conversations with titles and soft-delete support
3. **`sessions`** - Track AI SDK sessions with resume capability
4. **`isolation_environments`** - Git worktree isolation tracking
5. **`workflow_runs`** - Workflow execution tracking and state
6. **`workflow_events`** - Step-level workflow event log (step transitions, artifacts, errors)
7. **`messages`** - Conversation message history with tool call metadata (JSONB)
8. **`codebase_env_vars`** - Per-project env vars injected into project-scoped execution surfaces (Claude, Codex, bash/script nodes, and direct chat when codebase-scoped), managed via Web UI or `env:` in config

**Key Patterns:**
- Conversation ID format: Platform-specific (`thread_ts`, `chat_id`, `user/repo#123`)
- One active session per conversation
- Codebase commands stored in filesystem, paths in `codebases.commands` JSONB

**Session Transitions:**
- Sessions are immutable - transitions create new linked sessions
- Each transition has explicit `TransitionTrigger` reason (first-message, plan-to-execute, reset-requested, etc.)
- Audit trail: `parent_session_id` links to previous session, `transition_reason` records why
- Only plan→execute creates new session immediately; other triggers deactivate current session

### Architecture Layers

**Package Split:**
- **@archon/paths**: Path resolution utilities, Pino logger factory, web dist cache path (`getWebDistDir`), CWD env stripper (`stripCwdEnv`, `strip-cwd-env-boot`) (no @archon/* deps; `pino` and `dotenv` are allowed external deps)
- **@archon/git**: Git operations - worktrees, branches, repos, exec wrappers (depends only on @archon/paths)
- **@archon/providers**: AI agent providers (Claude, Codex) — owns SDK deps, `IAgentProvider` interface, `sendQuery()` contract, and provider-specific option translation. `@archon/providers/types` is the contract subpath (zero SDK deps, zero runtime side effects) that `@archon/workflows` imports from. Providers receive raw `nodeConfig` + `assistantConfig` and translate to SDK-specific options internally.
- **@archon/isolation**: Worktree isolation types, providers, resolver, error classifiers (depends only on @archon/git + @archon/paths)
- **@archon/workflows**: Workflow engine - loader, router, executor, DAG, logger, bundled defaults (depends only on @archon/git + @archon/paths + @archon/providers/types + @hono/zod-openapi + zod; DB/AI/config injected via `WorkflowDeps`)
- **@archon/cli**: Command-line interface for running workflows and starting the web UI server (depends on @archon/server + @archon/adapters for the serve command)
- **@archon/core**: Business logic, database, orchestration (depends on @archon/providers for AI; provides `createWorkflowStore()` adapter bridging core DB → `IWorkflowStore`)
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
- `/workflow` handles subcommands like `list`, `run`, `status`, `cancel`, `resume`, `abandon`, `approve`, `reject`
- Update database, perform operations, return responses

**3. Orchestrator** (`packages/core/src/orchestrator/`)
- Manage AI conversations
- Load conversation + codebase context from database
- Variable substitution: `$1`, `$2`, `$3`, `$ARGUMENTS`
- Session management: Create new or resume existing
- Stream AI responses to platform

**4. AI Agent Providers** (`packages/providers/src/`)
- Implement `IAgentProvider` interface
- **ClaudeProvider**: `@anthropic-ai/claude-agent-sdk`
- **CodexProvider**: `@openai/codex-sdk`
- Streaming: `for await (const event of events) { await platform.send(event) }`

### Configuration

**Environment Variables:**

see .env.example
see .archon/config.yaml setup as needed

**Assistant Defaults:**

The system supports configuring default models and options per assistant in `.archon/config.yaml`:

```yaml
assistants:
  claude:
    model: sonnet  # or 'opus', 'haiku', 'claude-*', 'inherit'
    settingSources:  # Controls which CLAUDE.md files Claude SDK loads
      - project      # Default: only project-level CLAUDE.md
      - user         # Optional: also load ~/.claude/CLAUDE.md
  codex:
    model: gpt-5.3-codex
    modelReasoningEffort: medium  # 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    webSearchMode: live  # 'disabled' | 'cached' | 'live'
    additionalDirectories:
      - /absolute/path/to/other/repo
    codexBinaryPath: /usr/local/bin/codex  # Optional: custom Codex CLI binary path

# docs:
#   path: docs  # Optional: default is docs/
```

**Configuration Priority:**
1. Workflow-level options (in YAML `model`, `modelReasoningEffort`, etc.)
2. Config file defaults (`.archon/config.yaml` `assistants.*`)
3. SDK defaults

**Model Validation:**
- Workflows are validated at load time for provider/model compatibility
- Claude models: `sonnet`, `opus`, `haiku`, `claude-*`, `inherit`
- Codex models: Any model except Claude-specific aliases
- Invalid combinations fail workflow loading with clear error messages

### Running the App in Worktrees

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

### Archon Directory Structure

**User-level (`~/.archon/`):**
```
~/.archon/
├── workspaces/owner/repo/        # Project-centric layout
│   ├── source/                   # Cloned repo or symlink → local path
│   ├── worktrees/                # Git worktrees for this project
│   ├── artifacts/                # Workflow artifacts (NEVER in git)
│   │   ├── runs/{id}/            # Per-run artifacts ($ARTIFACTS_DIR)
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
└── config.yaml     # Repo-specific configuration
```

- `ARCHON_HOME` - Override the base directory (default: `~/.archon`)
- Docker: Paths automatically set to `/.archon/`

## Development Guidelines

### When Creating New Features

**Quick reference:**
- **Platform Adapters**: Implement `IPlatformAdapter`, handle auth, polling/webhooks
- **AI Providers**: Implement `IAgentProvider`, session management, streaming
- **Slash Commands**: Add to command-handler.ts, update database, no AI
- **Database Operations**: Use `IDatabase` interface (supports PostgreSQL and SQLite via adapters)

### SDK Type Patterns

When working with external SDKs (Claude Agent SDK, Codex SDK), prefer importing and using SDK types directly:

```typescript
// ✅ CORRECT - Import SDK types directly
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';

const options: Options = {
  cwd,
  permissionMode: 'bypassPermissions',
  // ...
};

// Use type assertions for SDK response structures
const message = msg as { message: { content: ContentBlock[] } };
```

```typescript
// ❌ AVOID - Defining duplicate types
interface MyQueryOptions {  // Don't duplicate SDK types
  cwd: string;
  // ...
}
const options: MyQueryOptions = { ... };
query({ prompt, options: options as any });  // Avoid 'as any'
```

This ensures type compatibility with SDK updates and eliminates `as any` casts.

### Testing

**Unit Tests:**
- Test pure functions (variable substitution, command parsing)
- Mock external dependencies (database, AI SDKs, platform APIs)

**Integration Tests:**
- Test database operations with test database
- Test end-to-end flows (mock platforms/AI but use real orchestrator)
- Clean up test data after each test

**Mock isolation rules (IMPORTANT):**
- Bun's `mock.module()` is process-global and irreversible — `mock.restore()` does NOT undo it
- Do NOT add `afterAll(() => mock.restore())` for `mock.module()` cleanup — it has no effect
- Use `spyOn()` for internal modules that other test files import directly (e.g., `spyOn(git, 'checkout')`) — `spy.mockRestore()` DOES work for spies
- Never `mock.module()` a module path that another test file also `mock.module()`s with a different implementation
- When adding a new test file with `mock.module()`, ensure its package.json test script runs it in a separate `bun test` invocation from any conflicting files

**Manual Validation:** Use the web API (`curl`) or CLI commands directly for end-to-end testing of new features.

### Logging

**Structured logging with Pino** (`packages/paths/src/logger.ts`):

```typescript
import { createLogger } from '@archon/paths';

const log = createLogger('orchestrator');

// Event naming: {domain}.{action}_{state}
// Standard states: _started, _completed, _failed, _validated, _rejected
async function createSession(conversationId: string, codebaseId: string) {
  log.info({ conversationId, codebaseId }, 'session.create_started');

  try {
    const session = await doCreate();
    log.info({ conversationId, codebaseId, sessionId: session.id }, 'session.create_completed');
    return session;
  } catch (e) {
    const err = e as Error;
    log.error(
      { conversationId, error: err.message, errorType: err.constructor.name, err },
      'session.create_failed',
    );
    throw err;
  }
}
```

**Event naming rules:**
- Format: `{domain}.{action}_{state}` — e.g. `workflow.step_started`, `isolation.create_failed`
- Avoid generic events like `processing` or `handling`
- Always pair `_started` with `_completed` or `_failed`
- Include context: IDs, durations, error details

**Log Levels:** `fatal` > `error` > `warn` > `info` (default) > `debug` > `trace`

**Verbosity:**
- CLI: `archon --quiet` (errors only) — suppresses Pino logs and workflow progress output
- CLI: `archon --verbose` (debug) — enables debug Pino logs and tool-level workflow progress events
- Server: `LOG_LEVEL=debug bun run start`

**Never log:** API keys or tokens (mask: `token.slice(0, 8) + '...'`), user message content, PII.

### Command System

**Variable Substitution:**
- `$1`, `$2`, `$3` - Positional arguments
- `$ARGUMENTS` - All arguments as single string
- `$ARTIFACTS_DIR` - External artifacts directory for the current workflow run (pre-created by executor)
- `$WORKFLOW_ID` - The workflow run ID
- `$BASE_BRANCH` - Base branch; auto-detected from git when `worktree.baseBranch` is not set; fails only if referenced in a prompt and auto-detection also fails
- `$DOCS_DIR` - Documentation directory path; configured via `docs.path` in `.archon/config.yaml`. Defaults to `docs/`. Never throws.
- `$LOOP_USER_INPUT` - User feedback provided via `/workflow approve <id> <text>` at an interactive loop gate. Only populated on the first iteration of a resumed interactive loop; empty string on all other iterations.
- `$REJECTION_REASON` - Reviewer feedback provided via `/workflow reject <id> <reason>` at an approval gate. Only populated in `on_reject` prompts; empty string elsewhere.

**Command Types:**

1. **Codebase Commands** (per-repo):
   - Stored in `.archon/commands/` (plain text/markdown)
   - Discovered from the repository `.archon/commands/` directory
   - Surfaced via `GET /api/commands` for the workflow builder and invoked by workflow `command:` nodes

2. **Workflows** (YAML-based):
   - Stored in `.archon/workflows/` (searched recursively)
   - Multi-step AI execution chains, discovered at runtime
   - **`nodes:` (DAG format)**: Nodes with explicit `depends_on` edges; independent nodes in the same topological layer run concurrently. Node types: `command:` (named command file), `prompt:` (inline prompt), `bash:` (shell script, stdout captured as `$nodeId.output`, no AI, receives managed per-project env vars in its subprocess environment when configured), `loop:` (iterative AI prompt until completion signal), `approval:` (human gate; pauses until user approves or rejects; `capture_response: true` stores the user's comment as `$<node-id>.output` for downstream nodes, default false), `script:` (inline TypeScript/Python or named script from `.archon/scripts/`, runs via `bun` or `uv`, stdout captured as `$nodeId.output`, no AI, receives managed per-project env vars in its subprocess environment when configured, supports `deps:` for dependency installation and `timeout:` in ms, requires `runtime: bun` or `runtime: uv`) . Supports `when:` conditions, `trigger_rule` join semantics, `$nodeId.output` substitution, `output_format` for structured JSON output (Claude and Codex), `allowed_tools`/`denied_tools` for per-node tool restrictions (Claude only), `hooks` for per-node SDK hook callbacks (Claude only), `mcp` for per-node MCP server config files (Claude only, env vars expanded at execution time), and `skills` for per-node skill preloading via AgentDefinition wrapping (Claude only), and `effort`/`thinking`/`maxBudgetUsd`/`systemPrompt`/`fallbackModel`/`betas`/`sandbox` for Claude SDK advanced options (Claude only, also settable at workflow level)
   - Provider inherited from `.archon/config.yaml` unless explicitly set; per-node `provider` and `model` overrides supported
   - Model and options can be set per workflow or inherited from config defaults
   - `interactive: true` at the workflow level forces foreground execution on web (required for approval-gate workflows in the web UI)
   - Model validation ensures provider/model compatibility at load time
   - Commands: `/workflow list`, `/workflow reload`, `/workflow status`, `/workflow cancel`, `/workflow resume <id>` (re-runs failed workflow, skipping completed nodes), `/workflow abandon <id>`, `/workflow cleanup [days]` (CLI only — deletes old run records)
   - Resilient loading: One broken YAML doesn't abort discovery; errors shown in `/workflow list`
   - `resolveWorkflowName()` (in `router.ts`) resolves workflow names via a 4-tier fallback — exact, case-insensitive, suffix (`-name`), substring — with ambiguity detection; used by both the CLI and all chat platforms
   - Router fallback: if no `/invoke-workflow` is produced, falls back to `archon-assist` (with "Routing unclear" notice); raw AI response returned only when `archon-assist` is unavailable
   - Claude routing calls use `tools: []` to prevent tool use at the API level; Codex tool bypass is detected and triggers the same fallback

**Defaults:**
- Bundled in `.archon/commands/defaults/` and `.archon/workflows/defaults/`
- Binary builds: Embedded at compile time (no filesystem access needed)
- Source builds: Loaded from filesystem at runtime
- Merged with repo-specific commands/workflows (repo overrides defaults by name)
- Opt-out: Set `defaults.loadDefaultCommands: false` or `defaults.loadDefaultWorkflows: false` in `.archon/config.yaml`

**Global workflows** (user-level, applies to every project):
- Path: `~/.archon/.archon/workflows/` (or `$ARCHON_HOME/.archon/workflows/`)
- Load priority: bundled < global < repo-specific (repo overrides global by filename)
- See the docs site at `packages/docs-web/` for details

### Error Handling

**Database Errors:**
```typescript
// INSERT operations
try {
  await db.query('INSERT INTO conversations ...', params);
} catch (error) {
  log.error({ err: error, params }, 'db_insert_failed');
  throw new Error('Failed to create conversation');
}

// UPDATE operations - verify rowCount to catch missing records
try {
  await db.updateConversation(conversationId, { codebase_id: codebaseId });
} catch (error) {
  // updateConversation throws if no rows matched (conversation not found)
  log.error({ err: error, conversationId }, 'db_update_failed');
  throw error; // Re-throw to surface the issue
}
```

**Git Operation Errors (don't fail silently):**
```typescript
// When isolation environment creation fails:
try {
  // ... isolation creation logic ...
} catch (error) {
  const err = error as Error;
  const userMessage = classifyIsolationError(err);
  log.error({ err, codebaseId, codebaseName }, 'isolation_creation_failed');
  await platform.sendMessage(conversationId, userMessage);
}
```

Pattern: Use `classifyIsolationError()` (from `@archon/isolation`) to map git errors (permission denied, timeout, no space, not a git repo) to user-friendly messages. Always log the raw error for debugging and send a classified message to the user.

### API Endpoints

**Web UI REST API** (`packages/server/src/routes/api.ts`):

**Workflow Management:**
- `GET /api/workflows` - List available workflows; optional `?cwd=`; returns `{ workflows: [...], errors?: [...] }`
- `POST /api/workflows/validate` - Validate a workflow definition in-memory (no save); body: `{ definition: object }`; returns `{ valid: boolean, errors?: string[] }`
- `GET /api/workflows/:name` - Fetch a single workflow by name; optional `?cwd=` query param; returns `{ workflow, filename, source: 'project' | 'bundled' }`
- `PUT /api/workflows/:name` - Save (create or update) a workflow YAML; body: `{ definition: object }`; validates before writing; requires `?cwd=` or registered codebase
- `DELETE /api/workflows/:name` - Delete a user-defined workflow; bundled defaults cannot be deleted

**Workflow Run Lifecycle:**
- `POST /api/workflows/runs/{runId}/resume` - Mark a failed run as ready for auto-resume on next invocation
- `POST /api/workflows/runs/{runId}/abandon` - Abandon a non-terminal run (marks as cancelled)
- `DELETE /api/workflows/runs/{runId}` - Delete a terminal workflow run and its events

**Codebases:**
- `GET /api/codebases` / `GET /api/codebases/:id` - List / fetch codebases
- `POST /api/codebases` - Register a codebase (clone or local path)
- `DELETE /api/codebases/:id` - Delete a codebase and clean up resources
- `GET /api/codebases/:id/env` - List env var keys for a codebase (never returns values)
- `PUT /api/codebases/:id/env` / `DELETE /api/codebases/:id/env/:key` - Upsert / delete a single codebase env var
- `GET /api/codebases/:id/environments` - List tracked isolation environments for a codebase

**Artifact Files:**
- `GET /api/artifacts/:runId/*` - Serve a workflow artifact file by run ID and relative path; returns `text/markdown` for `.md` files, `text/plain` otherwise; 400 on path traversal (`..`), 404 if run or file not found

**Command Listing:**
- `GET /api/commands` - List available command names (bundled + project-defined); optional `?cwd=`; returns `{ commands: [{ name, source: 'bundled' | 'project' }] }`

**Providers:**
- `GET /api/providers` - List registered AI providers; returns `{ providers: [{ id, displayName, capabilities, builtIn }] }`

**System:**
- `GET /api/health` - Health check with adapter/system status
- `GET /api/update-check` - Check for available updates; returns `{ updateAvailable, currentVersion, latestVersion, releaseUrl }`; skips GitHub API call for non-binary builds

**OpenAPI Spec:**
- `GET /api/openapi.json` - Generated OpenAPI 3.0 spec for all Zod-validated routes

**Webhooks:**
- `POST /webhooks/github` - GitHub webhook events
- Signature verification required (HMAC SHA-256)
- Return 200 immediately, process async

**Security:**
- Verify webhook signatures (GitHub: `X-Hub-Signature-256`)
- Use `c.req.text()` for raw webhook body (signature verification)
- Never log or expose tokens in responses

**@Mention Detection:**
- Parse `@archon` in issue/PR **comments only** (not descriptions)
- Events: `issue_comment` only
- Note: Descriptions often contain example commands or documentation - these are NOT command invocations (see #96)
