## Project Overview

**Remote Agentic Coding Platform** — control Claude Code / Codex SDKs from Slack, Telegram, GitHub, CLI, and Web. Bun + TypeScript + SQLite (PostgreSQL optional). Single-developer tool.

## Core Rules

### Type Safety
- Strict TS, no `any` without justification, complete type annotations.
- Interfaces for all major abstractions (`IPlatformAdapter`, `IAgentProvider`, `IDatabase`, `IWorkflowStore`).

### Zod Schemas
- camelCase names with descriptive suffix (`workflowRunSchema`).
- Always `z.infer<typeof schema>` — never parallel hand-written interfaces.
- Import `z` from `@hono/zod-openapi`, not `zod`.
- API routes: `registerOpenApiRoute(createRoute({...}), handler)`.
- Route schemas: `packages/server/src/routes/schemas/`. Engine schemas: `packages/workflows/src/schemas/`.
- `TRIGGER_RULES` / `WORKFLOW_HOOK_EVENTS` derive from schema `.options` — never duplicate (exception: `@archon/web` defines local constants, since `api.generated.d.ts` is type-only).

### Imports
- `import type { ... } from '@archon/core'` for types, named imports for values.
- Never `import * as core from '@archon/core'`.
- `@archon/web` must NOT import from `@archon/workflows` — use `@/lib/api` re-exports from `api.generated.d.ts`.
- Workflow internals: import from subpaths (`@archon/workflows/deps`, `/store`, `/executor`, `/router`, `/schemas/*`).

### Git Workflow
- `dev` is the working branch. Never commit directly to `main`.
- All PRs must use `.github/PULL_REQUEST_TEMPLATE.md` and copy it explicitly with `gh pr create` (auto-applied only via web UI).
- Link issues with `Closes #N` so they auto-close.
- Releases: `/release` skill (`/release`, `/release minor`, `/release major`). Semver, `CHANGELOG.md` (Keep a Changelog), single `version` in root `package.json`.
- Use `@archon/git` functions; when shelling out, use `execFileAsync` (not `exec`).
- **NEVER `git clean -fd`** — use `git checkout .` instead.
- Surface git errors to users (conflicts, uncommitted changes); trust git's guardrails.

## Engineering Principles (apply by default)

- **KISS / YAGNI / DRY**: prefer explicit branches over meta-programming; no speculative abstractions or unused config keys; extract shared utilities only at the third repetition.
- **SRP / ISP**: one concern per module; extend via existing narrow interfaces; never add unrelated methods to an interface.
- **Fail Fast**: throw early on unsupported states; never silently swallow errors or broaden capabilities. Comment intentional fallbacks.
- **Determinism**: tests must be deterministic; local `bun run validate` must mirror CI.
- **Reversibility**: small scope, clear blast radius; define rollback before merging risky changes.

### No Autonomous Lifecycle Mutation Across Process Boundaries
When a process cannot reliably distinguish "actively running elsewhere" from "orphaned by a crash" — typically because the work was started by a different input source (CLI, adapter, webhook, web UI, cron) — it must NOT autonomously mark that work as failed/cancelled/abandoned based on a timer or staleness guess. Surface the ambiguous state and provide a one-click action. Heuristics for *recoverable* operations (retry backoff, subprocess timeouts, hygiene cleanup of terminal-status data) are fine; the rule is about destructive mutation of *non-terminal* state owned by an unknowable other party. Reference: #1216 and `packages/cli/src/cli.ts:256-258`.

## Essential Commands

```bash
bun run dev            # server (3090) + Web UI (5173) with hot reload
bun run test           # all tests (per-package, isolated processes)
bun run type-check
bun run lint           # CI enforces --max-warnings 0
bun run validate       # run before every PR — must pass for CI
bun run generate:bundled  # after editing .archon/{commands,workflows}/defaults/
```

CLI: `bun run cli ...` or `archon ...` — see `archon --help` for the full surface (workflows, isolation, validate, complete, serve, skill, doctor).

### Test Isolation (CRITICAL)
- **Do NOT run `bun test` from the repo root** — discovers all packages in one process, ~135 mock pollution failures. Always use `bun run test`.
- Bun's `mock.module()` is process-global and irreversible — `mock.restore()` does NOT undo it ([oven-sh/bun#7823](https://github.com/oven-sh/bun/issues/7823)). Don't add `afterAll(() => mock.restore())` for it; it has no effect.
- Use `spyOn()` for internal modules other test files import directly — `spy.mockRestore()` works.
- Never `mock.module()` a path that another test file mocks differently; if you must, run them in separate `bun test` invocations (see each package's `package.json`).

### ESLint
Zero-tolerance (`--max-warnings 0`). Inline `// eslint-disable-next-line` is almost never acceptable — fix the issue. Only valid: incorrect SDK types (note the SDK), or a justified type assertion after validation (note the validation). Never bulk-disable; never disable `no-explicit-any` without justification.

## Architecture

Monorepo (Bun workspaces) under `packages/`:

| Package | Role |
|---|---|
| `paths` | Path resolution, Pino logger, web-dist cache. Zero `@archon/*` deps. |
| `git` | Git ops (worktrees, branches, repos, exec wrappers). Depends on `paths`. |
| `providers` | AI providers (Claude, Codex, Pi community). Owns SDK deps. `providers/types` is a zero-SDK contract subpath consumed by `workflows`. |
| `isolation` | Worktree isolation provider/resolver, `classifyIsolationError`. |
| `workflows` | Engine (loader, router, executor, DAG, logger, bundled defaults). DB/AI/config injected via `WorkflowDeps`. |
| `core` | Business logic, DB, orchestration. Provides `createWorkflowStore()` adapter (core DB → `IWorkflowStore`). |
| `adapters` | Slack, Telegram, GitHub, Discord. |
| `server` | OpenAPIHono (Zod + spec generation), Web SSE adapter, REST routes, static UI serving. |
| `web` | React + Vite + Tailwind v4 + shadcn/ui + Zustand. Types derived from `api.generated.d.ts`. |
| `cli` | Command-line entrypoint. |

**Adapter Authorization**: auth checks live INSIDE adapters (constructor parses whitelist env var, handler checks before invoking `onMessage`). Silent rejection for unauthorized users; log masked IDs.

**Conversation IDs**: Web = user string · Slack = `thread_ts` · Telegram = `chat_id` · GitHub = `owner/repo#N` · Discord = channel ID.

**Database**: 8 tables prefixed `remote_agent_`. SQLite default at `~/.archon/archon.db`; PostgreSQL when `DATABASE_URL` set (`psql $DATABASE_URL < migrations/000_combined.sql`). Sessions are immutable — transitions create new linked sessions with explicit `TransitionTrigger` and `parent_session_id`.

**Provider/Model resolution**: `node.provider ?? workflow.provider ?? config.assistant`. Provider IDs validated at load time against the registry; model strings forwarded verbatim to the SDK (vendor SDKs are source of truth for model names).

**Worktree dev**: `bun dev` in a worktree auto-allocates a deterministic port in 3190-4089 (hash of path). Use the web API (`curl`) for self-test rather than running multiple platform adapters.

**Paths**: `~/.archon/workspaces/owner/repo/{source,worktrees,artifacts,logs}/`, `~/.archon/{archon.db,config.yaml}`. Repo: `.archon/{commands,workflows,scripts,state,config.yaml}`. Override base with `ARCHON_HOME`. Home-scoped resources at `~/.archon/{commands,workflows,scripts}/` are auto-discovered (priority: bundled < global < project).

## Implementation Patterns

### SDK Types
Import SDK types directly — never duplicate them. Use type assertions for response structures rather than `as any`.

```typescript
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
const options: Options = { cwd, permissionMode: 'bypassPermissions' };
const message = msg as { message: { content: ContentBlock[] } };
```

### Logging
```typescript
import { createLogger } from '@archon/paths';
const log = createLogger('orchestrator');
log.info({ conversationId, sessionId }, 'session.create_completed');
```
- Event names: `{domain}.{action}_{state}` — pair `_started` with `_completed` or `_failed`. Avoid generic verbs like `processing`.
- Include context (IDs, durations, error details).
- **Never log** API keys/tokens (mask: `token.slice(0,8) + '...'`), user message content, or PII.

### Error Handling
- DB INSERT/UPDATE: wrap in try/catch, log with `err`, re-throw. `update*` functions throw when no rows match — let the throw propagate.
- Isolation/git failures: `classifyIsolationError()` from `@archon/isolation` maps to user-friendly messages. Log raw error, send classified message.

### Webhooks
- Verify signatures (GitHub: `X-Hub-Signature-256`, HMAC SHA-256). Use `c.req.text()` for raw body.
- Return 200 immediately, process async. Never log/expose tokens.
- `@archon` mentions: `issue_comment` events only, never descriptions (descriptions contain examples — see #96).

## Configuration

- Env vars: `.env.example`.
- Per-project / per-assistant config: `.archon/config.yaml` (see `packages/docs-web/` for full schema, including `assistants.{claude,codex,pi}` model/options, `claudeBinaryPath`/`codexBinaryPath`, `settingSources`, `defaults.loadDefault*`, `docs.path`).

## Bundled Defaults

After adding/removing/editing a file in `.archon/{commands,workflows}/defaults/`, run `bun run generate:bundled`. `bun run validate` (and CI) run `check:bundled` + `check:bundled-skill` and fail if generated bundles are stale.

## API & Workflow Reference

- REST endpoints: see `packages/server/src/routes/` and `GET /api/openapi.json`.
- Workflow node types, `$NODE.output` substitution, `when`/`trigger_rule`/`hooks`/`mcp`/`skills`/`agents`, approval/loop semantics, variable substitution (`$1`, `$ARGUMENTS`, `$ARTIFACTS_DIR`, `$WORKFLOW_ID`, `$BASE_BRANCH`, `$DOCS_DIR`, `$LOOP_USER_INPUT`, `$REJECTION_REASON`, `$LOOP_PREV_OUTPUT`): see `packages/docs-web/`.
