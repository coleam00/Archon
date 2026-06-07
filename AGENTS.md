## Project Overview

**Remote Agentic Coding Platform**: Control AI coding assistants (Claude Code SDK, Codex SDK) remotely from Slack, Telegram, and GitHub. Built with **Bun + TypeScript + SQLite/PostgreSQL**, single-developer tool for AI-assisted development practitioners. Architecture prioritizes simplicity, flexibility, and user control.

> **Reference docs (detail lives here, keep this file lean):**
> - [`docs/commands.md`](docs/commands.md) — full command surface (dev, test, validate, CLI)
> - [`docs/architecture.md`](docs/architecture.md) — directory layout, database schema, package split, configuration
> - [`docs/development.md`](docs/development.md) — UI/design rules, SDK patterns, testing, logging, command system, error handling, API endpoints
>
> When you change behavior documented in the reference docs, update the doc — not this file.

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
- Import `z` from `@hono/zod-openapi` (not from `zod` directly). Exception: `@archon/providers` imports `z` from `zod` directly in `claude/native-tools.ts` — it only builds the Zod shape the Claude SDK's `tool()` expects (never an OpenAPI schema), and being an SDK-deps-only leaf package it must not pull in Hono.
- Record schemas: always pass an explicit key type — `z.record(z.string(), valueSchema)` — zod v4 dropped the single-arg `z.record(valueSchema)` form
- All new/modified API routes must use `registerOpenApiRoute(createRoute({...}), handler)` — the local wrapper handles the TypedResponse bypass. Two narrow exceptions exist: (1) routes that serve raw non-JSON content (e.g. `/api/artifacts/:runId/*` returns `text/markdown`/`text/plain`) AND use wildcard path params that OpenAPI 3.0 can't represent, use `app.get(...)` with an explanatory comment; (2) multipart-or-JSON routes (e.g. `/api/conversations/:id/message`, `/api/workflows/:name/run`) register through `registerOpenApiRoute` but drop `request.body` from the route config so Zod doesn't validate multipart payloads against a JSON schema — the handler parses both content types manually.
- Core row schemas live in `packages/core/src/schemas/` — one file per data shape (conversation, message, user, codebase, session, workflow-event, env-var, workflow-run); `index.ts` re-exports all
- Route schemas live in `packages/server/src/routes/schemas/` — one file per domain
- Engine schemas live in `packages/workflows/src/schemas/` — one file per concern (dag-node, workflow, workflow-run, retry, loop, hooks, node-artifact); `index.ts` re-exports all
- Engine schema naming: camelCase (e.g., `dagNodeSchema`, `workflowBaseSchema`, `nodeOutputSchema`)
- `TRIGGER_RULES` and `WORKFLOW_HOOK_EVENTS` are derived from schema `.options` — never duplicate as a plain array (exception: `@archon/web` must define a local constant since `api.generated.d.ts` is type-only and cannot export runtime values)
- `loader.ts` uses `dagNodeSchema.safeParse()` for node validation; graph-level checks (cycles, deps, `$nodeId.output` refs) remain as imperative code in `validateDagStructure()`

**Git Workflow and Releases**
- `main` is the release branch. Never commit directly to `main`.
- `dev` is the working branch. All feature work branches off `dev` and merges back into `dev`.
- All PRs must use the template at `.github/PULL_REQUEST_TEMPLATE.md` — fill in every section. When opening a PR via `gh pr create`, copy the template into the body explicitly; GitHub only auto-applies it through the web UI.
- Link the issue with `Closes #<number>` (or `Fixes` / `Resolves`) in the PR description so it auto-closes on merge.
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

**No Autonomous Lifecycle Mutation Across Process Boundaries**
- When a process cannot reliably distinguish "actively running elsewhere" from "orphaned by a crash" — typically because the work was started by a different process or input source (CLI, adapter, webhook, web UI, cron) — it must not autonomously mark that work as failed/cancelled/abandoned based on a timer or staleness guess.
- Surface the ambiguous state to the user and provide a one-click action.
- Heuristics for *recoverable* operations (retry backoff, subprocess timeouts, hygiene cleanup of terminal-status data) remain appropriate; the rule is about destructive mutation of *non-terminal* state owned by an unknowable other party.
- Reference: #1216 and the CLI orphan-cleanup precedent at `packages/cli/src/cli.ts:256-258`.

**Determinism + Reproducibility**
- Prefer reproducible commands and locked dependency behavior in CI-sensitive paths
- Keep tests deterministic — no flaky timing or network dependence without guardrails
- Ensure local validation commands (`bun run validate`) map directly to CI expectations

**Reversibility + Rollback-First Thinking**
- Keep changes easy to revert: small scope, clear blast radius
- For risky changes, define the rollback path before merging
- Avoid mixed mega-patches that block safe rollback

## Essential Commands

High-frequency commands — see [`docs/commands.md`](docs/commands.md) for the full surface (CLI, isolation, telemetry, etc.).

```bash
bun run dev          # Server + Web UI (hot reload). dev:server (3090) / dev:web (5173) to split
bun run test         # All tests, per-package isolated processes. NEVER `bun test` from repo root
bun run validate     # Pre-PR gate: bundled checks + type-check + lint + format + tests (all must pass)
bun run type-check   # Type check only
bun run lint         # Lint (CI enforces --max-warnings 0)
bun run cli <...>     # Run workflows / isolation / serve without the server (see docs/commands.md)
```

- **Database**: SQLite at `~/.archon/archon.db` by default (zero setup); set `DATABASE_URL` for PostgreSQL (schema auto-applied).
- **ESLint**: zero-tolerance. Fix issues rather than disabling rules; inline disables are almost never acceptable (see [`docs/commands.md`](docs/commands.md)).

## Architecture

Monorepo of focused Bun-workspace packages with strict dependency direction:
`paths → git → providers/isolation → workflows → core → adapters → server → cli/web`.
SDK deps live in `@archon/providers`; the workflow engine receives DB/AI/config via `WorkflowDeps`
injection. Platform adapters implement `IPlatformAdapter`; AI providers implement `IAgentProvider`.

See [`docs/architecture.md`](docs/architecture.md) for the full directory tree, import patterns,
the 16-table database schema, the per-package split, and configuration (`.archon/config.yaml`,
assistant defaults, tiers/aliases, worktree port allocation, Archon directory layout).

**Import patterns (critical):** always use typed imports — `import type` for type-only, named
imports for values, never a generic `import * as core from '@archon/core'`. In `@archon/web`
never import from `@archon/workflows`; use re-exports from `@/lib/api`.

## Development Guidelines

Detailed guidance lives in [`docs/development.md`](docs/development.md). Key rules:

- **UI / Visual design**: all visual surfaces must align with the Archon brand foundation
  (https://archon.diy/brand/). Use brand tokens (`packages/web/src/index.css`), never ad-hoc hex.
- **New features**: adapters implement `IPlatformAdapter`; providers implement `IAgentProvider`;
  slash commands go in `command-handler.ts` (no AI); DB access via the `IDatabase` interface.
- **SDK types**: import and use SDK types directly (e.g. `Options` from the Claude Agent SDK);
  don't duplicate them and don't paper over with `as any`.
- **Testing**: mock isolation matters — `mock.module()` is process-global and irreversible; use
  `spyOn()` for internal modules; never let two test files `mock.module()` the same path differently.
- **Logging**: structured Pino, event names `{domain}.{action}_{state}`, pair `_started` with
  `_completed`/`_failed`. Never log secrets, user message content, or PII.
- **Command system**: workflows are YAML DAGs in `.archon/workflows/`; node types, variable
  substitution (`$1`, `$ARGUMENTS`, `$ARTIFACTS_DIR`, …), and the full API endpoint surface are
  documented in [`docs/development.md`](docs/development.md).
- **Defaults**: after editing bundled defaults run `bun run generate:bundled`; after editing
  `migrations/000_combined.sql` run `bun run generate:bundled-schema` (CI fails on stale bundles).
- **@Mention detection**: parse `@archon` in issue/PR **comments only**, never descriptions.
