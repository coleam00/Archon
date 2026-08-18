## Project Overview

**Archon — a self-hostable, governed agentic automation engine.** Archon runs multi-step workflows that mix deterministic steps (bash/scripts) with AI agents (Claude Code SDK, Codex SDK, and others), with human approval gates and full audit trails — driven remotely from Slack, Telegram, GitHub, Discord, the web UI, or the CLI. Its most mature surface today is agentic **coding** (controlling Claude Code / Codex against repos); the same engine is being extended to drive general **business-operations** automation. Built with **Bun + TypeScript + SQLite/PostgreSQL** and deployed as a single-tenant install (one isolated instance per operator or client — see *Single-Tenant per Install*). Architecture prioritizes simplicity, flexibility, governance, and user control.

## Product Direction

Archon is being positioned as a governed agentic automation engine for business operations, not only coding.

## Core Principles

**Single-Tenant per Install**
- One isolated instance per operator or client — the deployment model is one install (e.g. one VPS) per client, **not** one install serving many tenants. Keep the data model and runtime single-tenant: no per-tenant isolation, row-scoping, or tenant multiplexing. Client isolation is achieved at the **deployment** layer, not in code — a deliberate simplification, not a limitation.
- Multi-**user** within one install (several humans sharing an instance, each with their own identity and credentials) **is** supported, and is distinct from multi-**tenant**. Don't conflate them.

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
- Recursive schemas: use zod v4 getter properties plus an explicit `z.ZodType<T>` annotation with a hand-written `T` to break the inference cycle — the annotation forces structural agreement so drift is a compile error. Established precedent: `loopGroupNodeConfigSchema`/`LoopGroupNodeConfig` in `packages/workflows/src/schemas/dag-node.ts` (the one sanctioned exception to the z.infer-only rule)
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
- All PRs must use the template at `.github/pull_request_template.md`. Always keep Problem and outcome, Review guidance, Solution, and Validation; include the conditional sections only when they add material information, and delete the rest along with every instructional comment. Do not write "N/A" to preserve a section. When opening a PR via `gh pr create`, copy the template into the body explicitly; GitHub only auto-applies it through the web UI.
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
- Workspace sync is non-destructive by default: fetch, classify state, and fast-forward only when safe
- Use explicit `mode: 'reset'` only for Archon-owned checkout paths where the caller intentionally wants to hard-reset to `origin/<branch>` before creating a managed worktree
- **NEVER run `git clean -fd`**. For user-owned workspaces, preserve tracked and untracked changes and surface the state for user action; never commit their artifacts or logs. Explicit reset mode is limited to Archon-owned checkout paths.

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

**Natural Language Is Not a Wire Format** — trust the agent to interpret; make the code validate
- Never reconstruct a user's intent from prose with regexes, keyword lists, or hand-written parsers. Let the agent read the complete message, then hand it a typed tool (`NativeTool` + JSON Schema) or a resolver that turns that understanding into a deterministic id, path, or action. Precedents: `manage_run` (`packages/core/src/orchestrator/manage-run-tool.ts`) and `resolveWorkflowName` (`packages/workflows/src/router.ts`) — tiered matching that throws on ambiguity rather than guessing.
- Put determinism after interpretation, at the tool boundary: validate resolved arguments, permissions, and invariants — never the grammar of the prose. When exact syntax is genuinely required, expose an explicit structured interface (slash command, CLI flag, button `action_id`) instead of disguising it as natural language.
- Deciding an intent *without* interpreting it is the same violation inverted. Applying one fixed action to arbitrary prose — "any message here means approve" — promises understanding and delivers a hard-coded branch. Either interpret, or expose the structured interface; never claim the first while doing the second.
- In workflows: **prose inside a node is the model thinking; prose between nodes is a wire format you invented.** A node told to emit an exact token so a later node can grep it must instead use `output_format` + `when: $node.output.field`, a bash/script exit code, or `until_bash`. Loops have the same three tiers since #2563: `until_bash` when completion is externally checkable, `output_format` + `until_field` when it is the model's judgment, and the `until:` prose sentinel when the iteration output is a message a human reads at an interactive gate (declaring `output_format` would replace that prose with JSON). A loop must declare at least one; none is required, so a deterministic loop carries no live prose matcher.
- Classifying third-party output you don't control — git stderr, SDK error strings, vendor limit text surfaced as assistant prose — is NOT this rule; neither is repairing a model's own JSON that you then schema-validate. Don't cite this rule to delete an error classifier.
- Axis note: this governs runtime code and node wiring. The Workflow Language Constitution below governs the authoring-time YAML surface. Related values, different objects — don't collapse them.

**Workflow Language Constitution — YAML coordinates, code computes, agents judge**
- The workflow YAML expresses only what the ENGINE must see to govern a run: ordering, gates, joins, retries, sessions, artifacts, reusable structure. Computation stays out of the YAML and lives inside a node's body (the `bash:`/`script:` source or the `prompt:` text) — node fields like `when:`/`retry:` are YAML surface and stay declarative. This boundary is what keeps load-time validation, the visual builder, resume, and audit trails possible.
- **The rule governs the YAML surface, not what an agent does inside a node.** A `prompt:` node that computes is a legitimate authoring choice — often the right one when the author doesn't know the rule and wants the model to decide. Script nodes and prompt nodes are both escape hatches from the language; picking between them is ordinary engineering, not a constitutional question. Never cite the constitution to argue a prompt should become a script. (The one narrow exception is a *reliability* argument, not a constitutional one: a check with no judgment content whose failure is irreversible is better as a node that can't decline to fire.)
- Admissibility test for every new YAML surface feature (field, node type, expression capability): (1) does the engine need to see it to govern? (2) is it declarative data, not evaluation? (3) could a script node + existing wiring express it today? A feature that computes rather than coordinates is rejected — point to the escape hatch instead.
- `when:` never grows incrementally (no parens, no functions, no arithmetic). The answer to "when: can't express X" is a script node that computes the decision + `when:` on its structured output. If expression demand ever genuinely accumulates, adopt CEL wholesale in one versioned change — never home-grow operators.
- Composition features must resolve fully at LOAD time (the executor runs a flat static DAG); include parameterization, if ever added, is data-only. Runtime-resolved structure = a sub-run (its own governance object), not a language feature.
- New per-provider capabilities default to provider config / tier-alias presets, not new node fields; capability mismatches warn loudly (capabilities.ts is the source of truth).
- Implicit behaviors need the same scrutiny as new fields: documented, individually defeatable, fail-safe — or not added.
- Full rationale, case law, and the five failure smells: `packages/docs-web/src/content/docs/reference/workflow-language-constitution.md` (archon.diy/reference/workflow-language-constitution/). Cite it in `feat(workflows)` PRs touching the YAML surface.

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

`bun run dev` starts server + Web UI together with hot reload; `bun run dev:server` (port 3090) and `bun run dev:web` (port 5173) run them individually. Regenerating the frontend API types needs the server already running: `bun --filter @archon/web generate:types`. To use PostgreSQL instead of the default SQLite, `docker-compose --profile with-db up -d postgres` and set `DATABASE_URL` in `.env`.

### Testing

`bun run test` runs everything (per-package, isolated processes). `bun test --watch` and `bun test <path>` work within a single package.

**Test isolation (mock.module pollution):** Bun's `mock.module()` permanently replaces modules in the process-wide cache — `mock.restore()` does NOT undo it ([oven-sh/bun#7823](https://github.com/oven-sh/bun/issues/7823)). To prevent cross-file pollution, packages with conflicting `mock.module()` calls split their tests into separate `bun test` invocations — see each package's `package.json` `test` script for the current splits.

**Do NOT run `bun test` from the repo root** — it discovers all test files across all packages and runs them in one process, causing ~135 mock pollution failures. Always use `bun run test` (which uses `bun --filter '*' --parallel test` for per-package isolation).

**`bunfig.toml` is read from the cwd only, in both directions.** `bun --filter` runs each package script from that package's directory, so the root config never applies to a package's tests — hence `@archon/adapters`' own copy for the no-network guard. But the root `test` script ends with `bun test ./scripts/`, which *does* run from the root, so the root config's keys — `coverage` today — apply to that leg. Stating only the first half is how #2306 ruled coverage out for the wrong leg.

**When a subprocess-spawning test times out on windows-latest, get its healthy baseline before theorising (#2306).** `bun test`'s default reporter does not reliably print a passing test's duration — a fully green run can print none at all — so a failure log gives you the timeout and no baseline to compare it against — use `--reporter=junit` locally, and read passing durations out of past green CI job logs (`gh api /repos/<owner>/<repo>/actions/jobs/<id>/logs`; note `gh run view --job` can return a different run's logs). The baseline tells you which of two mechanisms you have, and they take opposite fixes:

- **Bimodal** — tight cluster far below 5000 ms, then an isolated jump to ~5015 ms, nothing between. A bounded stall, and every cause proven so far was a specific bound meeting Bun's 5000 ms default: #2473 was SQLite's `PRAGMA busy_timeout = 5000`, the same number; #2240 was a "fully mocked" test silently opening a real database. Find the bound. Raising the timeout would have buried both, and it disarms the only alarm that catches undeclared I/O.
- **Gradient** — a high, variable baseline creeping toward the budget. Genuine cost, so count the work. Windows has no `fork`, and Git-Bash/MSYS emulation makes each process creation far dearer than on Linux, so a shell loop that forks per item is the usual culprit.

Either way prefer removing work over widening the window: #2310 dropped a `tar` spawn for an in-process fixture, and #2306 stopped a dry run creating a database. Best of all, keep subprocess-spawning tests rare and cheap in the first place — every one of them is a test whose cost you do not control.

### Type Checking & Linting

`bun run type-check`, `lint`, `lint:fix`, `format`, `format:check`.

### Pre-PR Validation

**Always run `bun run validate` before creating a pull request.** Every step must pass for CI to succeed — see the `validate` script in the root `package.json` for the current list.

CI runs one check that `validate` does not: `bun run check:schema-upgrades` needs a live PostgreSQL, so it runs as its own job. A change to `migrations/000_combined.sql` is not fully validated locally until you run it too (see *Schema changes are additive-only* below).

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
- **With `DATABASE_URL` set**: Uses PostgreSQL (schema auto-applied on startup; no manual `psql` needed). The Postgres adapter runs the idempotent `migrations/000_combined.sql` inside an advisory-lock transaction on first connection, so upgrades that add tables or columns converge automatically.

**Schema changes are additive-only (both dialects) — this is a hard rule, not a convention.**

There is no migration ledger and no version gate. Both schemas are re-applied in full on every connection, by every process that opens the database — the server, *every* CLI invocation, every `--detach` child — including an **older** Archon binary that happens to be on `PATH` beside a dev checkout. Any writer may apply any vintage of the schema at any time. Therefore:

- **Only ADD** tables, columns, and indexes. Never rename, retype, or drop anything a shipped version still reads or writes.
- **Every `ADD COLUMN ... NOT NULL` must carry a `DEFAULT`.** Without one the statement fails outright on a non-empty table, and a writer that predates the column would produce rows the newer writer rejects. This holds for every `ADD COLUMN` in the tree today — keep it that way.
- **Adding `NOT NULL` to a column already in a `CREATE TABLE` body only binds databases created after the change.** `CREATE TABLE IF NOT EXISTS` is a no-op on existing tables and SQLite has no `ALTER COLUMN`, so the old shape survives forever. Treat such a constraint as documentation and keep application code tolerant of NULL, or do a full table rebuild in `migrateColumns()`.
- **New indexes and `COMMENT ON COLUMN` statements go in the trailing "Indexes and column comments" section of `migrations/000_combined.sql`, never beside the table body.** A column declared only in a `CREATE TABLE IF NOT EXISTS` body does not exist while that block runs on an upgrade — the table is already there, so the statement is a no-op and the column arrives later, in the additive `ALTER TABLE` block. An index or column comment placed next to its table therefore passes on a fresh install and aborts the entire single-transaction apply with `42703` on an upgrade, crash-looping every boot (#2508). `migration-statement-order.test.ts` enforces the placement; `bun run check:schema-upgrades` proves it against real databases.
- **Test an upgrade, not just a fresh install.** `bun run check:schema-upgrades` applies the current schema on top of databases created by older releases, re-applies it to prove idempotence, and compares the result against a fresh install across columns, indexes, column comments, constraints and sequences. Baselines are every DISTINCT schema ever shipped in a release tag (tags that did not touch the schema share a file, so 21 tags give 8 baselines) — the set of vintages an install can actually have, not a sample. Exactly one divergence is expected and excused, `remote_agent_codebases_kind_check`, matched on the exact constraint identity in one direction only and printed on every run; if it ever stops occurring the check fails as stale, so the exception cannot outlive its reason. It needs a reachable PostgreSQL (`PGHOST`/`PGUSER`/… or `DATABASE_URL`; it creates and drops its own scratch databases), so it is a CI job rather than part of `bun run validate`.
- **Mirror every change into both schemas** (see the generated-files note in the Defaults section). The parity test in `sqlite.test.ts` checks table names and columns in both directions, against small tracked allowlists — so a column added to one dialect and forgotten in the other fails CI.
- `remote_agent_schema_version` records which Archon build created the database and which last applied schema to it, surfaced by `archon doctor` and `GET /api/health`. It is diagnostic only — nothing gates on it, and the values come from `APP_VERSION` in `packages/core/src/db/schema-version.ts`, never from a hand-bumped number.

### CLI (Command Line)

Run workflows directly from the command line without needing the server.

`archon --help` is the authoritative command list, and the docs site's CLI reference
(`packages/docs-web/src/content/docs/reference/cli.md`) is the authoritative detail — both stay
current with the code in a way a transcription here would not. From source, prefix any command
with `bun run cli` (e.g. `bun run cli workflow list`).

The rules `--help` will not tell you:

- Workflow and isolation commands must run inside a git repository; subdirectories resolve to the repo root. `--folder` is the escape hatch for a non-git directory.
- Isolation is the default for `workflow run` — it creates a worktree unless you pass `--no-worktree` or `--folder`.
- `--json` is supported on the read/write subcommands (`list`, `status`, `runs`, `get`, `approve`, `reject`, `abandon`, `resume`). On `approve`/`reject`/`resume` it records the decision and returns an ack **without** the inline auto-resume, leaving the run resumable — drive continuation separately.

## Architecture

### Directory Structure

**Monorepo Layout (Bun Workspaces):**

```
packages/
├── paths/        # @archon/paths      - path resolution + Pino logger factory
├── git/          # @archon/git        - worktrees, branches, repos, exec wrappers
├── providers/    # @archon/providers  - AI agent providers (owns the SDK deps)
├── isolation/    # @archon/isolation  - worktree + container isolation
├── workflows/    # @archon/workflows  - workflow engine (loader, router, DAG executor)
├── core/         # @archon/core       - business logic, database, orchestration
├── adapters/     # @archon/adapters   - Slack, Telegram, GitHub, Discord
├── server/       # @archon/server     - OpenAPIHono HTTP server + Web adapter (SSE)
├── cli/          # @archon/cli        - command-line interface
├── web/          # @archon/web        - React frontend
└── docs-web/     # the docs site (astro)
```

Listed in dependency order — each package may depend only on those above it. *Package Split*
under **Architecture Layers** below states each one's exact allowed dependencies; that list is
the rule, and it is what a change must respect. Inside a package, `ls` and the file docblocks
are more current than any tree drawn here.

**Import Patterns:**

- `import type` for types, named imports for values, `import *` only for submodules with many exports (`@archon/core/db/conversations`, `@archon/git`) — **never** `import * as core from '@archon/core'`.
- Import workflow-engine types and functions from their direct subpaths (`@archon/workflows/deps`, `/store`, `/executor`, `/router`, `/schemas/workflow`), not from a package root.
- `@archon/web` must never import from `@archon/workflows` — it is a server package. Use the re-exports in `@/lib/api`, which derive from the generated OpenAPI spec.

### Database Schema

**19 Tables (all prefixed with `remote_agent_`):**
1. **`codebases`** - Repository/project metadata and commands (JSONB); `kind` (`'repo'`/`'folder'`, default `'repo'`) discriminates git repos from **folder projects** (non-git workspaces — multi-repo roots or plain ops folders — that run in place with named `_folder/<slug>/` storage; `repository_url`/`default_branch` are null)
2. **`conversations`** - Track platform conversations with titles and soft-delete support; nullable `user_id` records first creator (provenance + execution-identity **fallback** only — chat turns execute as the message sender, #1982)
3. **`sessions`** - Track AI SDK sessions with resume capability
4. **`isolation_environments`** - Isolation tracking (git worktrees AND folder-project containers — `provider` is `'worktree'`/`'container'`; container rows use a `''` `branch_name` sentinel and store `{containerId, volume, image, overlayMode, …}` in `metadata`); nullable `created_by_user_id` preserves first creator
5. **`workflow_runs`** - Workflow execution tracking and state; nullable `user_id` for per-run attribution; nullable `parent_run_id` (self-referential FK, `ON DELETE SET NULL`) links a `workflow:` sub-run to the parent run that spawned it (#2121 Phase 2); nullable `output_root` records the resolved `~/.archon/workspaces/<project>/` this run's artifacts, logs, and state live under, written ONCE at run start (never on resume) so historical artifacts stay addressable across a codebase rename (#2200/#1192) — readers prefer it and re-derive identity only when it is NULL
6. **`workflow_events`** - Step-level workflow event log (step transitions, artifacts, errors)
7. **`messages`** - Conversation message history with tool call metadata (JSONB); nullable `user_id` (NULL for assistant rows). Split write-path: the **web** adapter persists its own turns via `MessagePersistence`; the **orchestrator** persists non-web turns (Slack/Telegram/GitHub/Discord/CLI) fire-and-forget, guarded by `isWebAdapter` to avoid double-writing web turns — only AI-bound turns get a user row (deterministic-command and approval-only turns return earlier), so a `user` row always pairs with an `assistant` row
8. **`codebase_env_vars`** - Per-project env vars injected into project-scoped execution surfaces (Claude, Codex, bash/script nodes, and direct chat when codebase-scoped), managed via Web UI or `env:` in config
9. **`users`** - Archon-internal identity (one row per human/bot); created lazily on first sight by any adapter; `role` (`'admin'`(default)`/'member'`) is the identity seam for future per-resource scoping (visibility stays open today)
10. **`user_identities`** - Per-platform mapping (Slack U-id, Telegram chat id, Discord snowflake, GitHub login, Better Auth web user id) → `users.id`; `UNIQUE(platform, platform_user_id)`
11. **`workflow_node_sessions`** - Per-node provider session IDs persisted across workflow re-runs (opt-in via `persist_session`); keyed by `(workflow_name, node_id, scope_key, provider)`; `scope_key` is typically the conversation UUID
12. **`user_github_tokens`** - Per-user GitHub device-flow tokens encrypted at rest (AES-256-GCM); one row per Archon user (`UNIQUE(user_id)`), cascades on user deletion; numeric `github_user_id` anchors the commit no-reply email
13. **`user_provider_keys`** - Per-user AI-provider credentials encrypted at rest (AES-256-GCM); one row per `(user_id, provider)` (`UNIQUE(user_id, provider)`), cascades on user deletion; `kind` is `api_key` or `oauth`; resolved + injected into the **acting user's** (run starter / message sender) runs/chat env at execution time. Always available — the encryption key is auto-provisioned at `~/.archon/credential-key` when `TOKEN_ENCRYPTION_KEY` is not set. Since #1955 the `provider` column holds **vendor-canonical credential ids** (`anthropic`, `openai`, `github-copilot`, plus the Pi backend vendors) — NOT agent ids; legacy `claude`/`codex`/`copilot` rows are renamed by an idempotent startup data fix (vendor row wins on conflict), and the connectable catalog is derived from provider registrations (`acceptedCredentials` via `credentials:` on `ProviderRegistration`), never hand-listed
14. **`user_ai_prefs`** - Per-user AI preferences (Phase 3): personal model `tiers`/`aliases` (JSON-as-TEXT) + `default_provider` + `default_model` (#1998 — per-user default CHAT model, written atomically with `default_provider`; replaces the `large`-tier lookup for direct chat only when the effective provider matches — workflows still resolve `large`). NON-encrypted (model names aren't secrets — mirrors `codebase_env_vars`, not the provider-key store); one row per user (`UNIQUE(user_id)`), cascades on user deletion. Folded into `buildAiProfile` as the highest-precedence layer at the userId-aware seams (workflow executor: run starter; chat orchestrator: message **sender**-first, conversation creator only as fallback — #1982); needs a web/CLI identity but NO `TOKEN_ENCRYPTION_KEY`
15–18. **`remote_agent_auth_user` / `remote_agent_auth_session` / `remote_agent_auth_account` / `remote_agent_auth_verification`** - Better Auth tables for opt-in web login (**PostgreSQL only**; always created on Postgres via the idempotent schema apply, but populated only when web auth is enabled — `DATABASE_URL` + `BETTER_AUTH_SECRET`). Owned and shaped by Better Auth (text ids, camelCase columns); Archon never queries them directly — a session maps to the canonical `users` row via `user_identities('web', <betterAuthUserId>)`
19. **`remote_agent_schema_version`** - Diagnostic schema vintage (#2316): single row (`id = 1`) recording `created_app_version` (the Archon build that created this database — NULL, never guessed, for databases predating the table) and `app_version`/`applied_at` (the build that last applied schema). Written from `APP_VERSION` by both adapters' existing idempotent apply-on-connect path, and only when the value changes. Surfaced by `archon doctor` and `GET /api/health`; **nothing gates on it**

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
- **@archon/providers**: AI agent providers (Claude, Codex, Pi community) — owns SDK deps, `IAgentProvider` interface, `sendQuery()` contract, and provider-specific option translation. `@archon/providers/types` is the contract subpath (zero SDK deps, zero runtime side effects) that `@archon/workflows` imports from. Providers receive raw `nodeConfig` + `assistantConfig` and translate to SDK-specific options internally. Core providers live under `claude/` and `codex/`; community providers live under `community/` (currently `community/pi/`, registered with `builtIn: false`). `@archon/providers/oauth` is the SDK-boundary subpath wrapping Pi's `@earendil-works/pi-ai/oauth` (subscription login: Claude Pro/Max, Copilot) — `@archon/core` drives Pi-based subscription OAuth through it so the Pi SDK dep stays in `@archon/providers`. The ChatGPT/Codex subscription login is NOT Pi-driven: it's Archon-owned PKCE in `@archon/core` `credentials/openai-oauth.ts` (Pi drops the `id_token` the Codex CLI requires, #1924).
- **@archon/isolation**: Worktree isolation types, providers, resolver, error classifiers, and the folder-project backend seam — `IIsolationBackend`/`resolveFolderBackend` + the `ExecutionContext` it produces (depends only on @archon/git + @archon/paths + @archon/providers/types — the types-only import that carries the shared `ExecutionContext` + write-back result contracts). The container backend's full lifecycle: `prepare` (per-run upper volume + labeled container) → in-container exec → `suspend` (`docker stop` on pause) / `resumeEnv` (rediscover by `diy.archon.env-id` label + restart, or recreate over the surviving volume; fails loud if the volume is gone) → `finalize` (overlay diff walk) → approval-gated `applyChanges` (the ONE live-root write) / `discardChanges` → `destroy`. The engine drives suspend + the write-back gate through a structural write-back port (`ContainerWriteBackBackend`, injected via `ExecuteWorkflowOptions.container`) so @archon/workflows never imports @archon/isolation. The write-back gate reuses the pause/approve machinery with a `type: 'writeback'` ApprovalContext (synthetic `__writeback__` node); the resume path branches on the persisted `metadata.pending_writeback` marker (idempotent via `writeback_resolved`). Container pauses are CLI-resumable only (chat/web resume fails fast with a CLI pointer, run stays resumable). `isolation list/cleanup` cover container envs; a paused run's container is never auto-pruned.
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
- The orchestrator treats only these top-level commands as deterministic: `/help`, `/status`, `/reset`, `/workflow`, `/register-project`, `/update-project`, `/remove-project`, `/setproject` (binds by DB conversation id, clears cwd/worktree override, deactivates the session with `project-changed`), `/commands`, `/init` (falls back to the selected project root when `conversation.cwd` is null), `/worktree`
- `/workflow` handles subcommands like `list`, `run`, `status`, `cancel`, `resume`, `abandon`, `approve`, `reject`, `reset-sessions`
- Update database, perform operations, return responses

**3. Orchestrator** (`packages/core/src/orchestrator/`)
- Manage AI conversations
- Load conversation + codebase context from database
- Variable substitution: `$ARGUMENTS`/`$USER_MESSAGE` (the whole trigger message; positional `$1`/`$2`/`$3` are not supported)
- Session management: Create new or resume existing
- Stream AI responses to platform
- System prompt gets a "Managing Workflow Runs" section (`buildRunManagementSection` in `prompt-builder.ts`) teaching the chat agent to drive run management (`archon workflow runs/get/status/run --detach/approve/reject/abandon`) directly via bash. It is appended **only for project-scoped chats on providers without the native `manage_run` tool** (Codex/OpenCode/Copilot) — gated in `orchestrator-agent.ts` on `!scopedCaps.nativeTools`. Claude and Pi instead receive the in-process `manage_run` native tool (the prompt section would be redundant for them). This is the CLI-bash delivery path for providers that have neither native tools nor `skills:` (direct chat doesn't consume the `skills:` option — it is workflow-node-only).

**4. AI Agent Providers** (`packages/providers/src/`)
- Implement `IAgentProvider` interface
- **ClaudeProvider**: `@anthropic-ai/claude-agent-sdk`
- **CodexProvider**: `@openai/codex-sdk`
- **PiProvider** (community, `builtIn: false`): `@earendil-works/pi-coding-agent` — one harness for ~20 LLM backends via `<provider>/<model>` refs (e.g. `anthropic/claude-haiku-4-5`, `openrouter/qwen/qwen3-coder`); supports extensions, skills, tool restrictions, thinking level, best-effort structured output. See `packages/docs-web/src/content/docs/getting-started/ai-assistants.md` for setup, capability matrix, and extension config.
- Streaming: `for await (const event of events) { await platform.send(event) }`

### Configuration

**Environment Variables:**

see .env.example
see .archon/config.yaml setup as needed

**Assistant Defaults:**

Per-assistant model and option defaults live in `.archon/config.yaml` under `assistants.<provider>`, alongside `tiers:` and `aliases:`. The docs site's configuration reference (`packages/docs-web/src/content/docs/reference/configuration.md`) carries the full key set and value ranges; the schema in `@archon/core/config` is the authority. Two keys are worth knowing before you look: `claudeBinaryPath`/`codexBinaryPath` are required in compiled binaries when the matching `*_BIN_PATH` env var is unset, and `settingSources` controls which `CLAUDE.md`, skills, commands and agents the Claude SDK loads — use exactly `['project']` to restrict a run to project-only sources.

**Configuration Priority:**
1. Workflow-level options (in YAML `model`, `effort`, etc.)
2. Config file defaults (`.archon/config.yaml` `assistants.*`)
3. SDK defaults

**Model Validation:**
- Workflows are validated at load time for provider _identity_ only — `provider:` (workflow-level and per-node) must be a registered provider id, otherwise the YAML is rejected with `Unknown provider '<id>'. Registered: claude, codex, pi`.
- Model strings are classified by `resolveModelSpec()` in `packages/workflows/src/model-validation.ts`: tier keywords (`small`/`medium`/`large`) resolve via built-in defaults plus `tiers:` overrides; `@<name>` refs resolve via the merged alias map from config; anything else remains a literal SDK model string.
- Tier and alias refs can resolve provider, model, and provider-specific options. Literal model strings keep the normal provider chain (`node.provider ?? workflow.provider ?? config.assistant`).
- `tiers:` and `aliases:` are valid on global and repo config (repo overrides global). Reserved names `small`, `medium`, `large` cannot be used as custom alias names. Custom alias keys must start with `@` (e.g. `@fast`).

### Running the App in Worktrees

Agents working in worktrees can run the app for self-testing (make changes → run app → test via curl → fix). `bun dev` auto-allocates a port and logs it at startup.

**Port Allocation:**
- Worktrees: Automatic unique port (3190-4089 range, hash-based on path)
- Main repo: Default 3090
- Override: `PORT=4000 bun dev` (works in both contexts)
- Same worktree always gets same port (deterministic)

**Important:**
- Use the web API routes for manual validation (avoid running multiple platform adapters)
- Database is shared (same conversations/codebases available)
- Stop the server when done using its recorded PID. If that PID is unavailable, identify and stop only the process bound to the exact configured port; never use a broad process-name match across worktrees.

### Archon Directory Structure

**User-level (`~/.archon/`):** per-project workspaces under `workspaces/owner/repo/` (`source/`, `worktrees/`, `artifacts/`, `logs/`), with folder projects at `workspaces/_folder/<slug>/` (no `source/` or `worktrees/` — they run in place), plus `archon.db` and the global `config.yaml`. The docs site's directory reference (`packages/docs-web/src/content/docs/reference/archon-directories.md`) has the full layout.

What matters here: **artifacts and logs live outside the repo and must never be committed** — `$ARTIFACTS_DIR` points at `artifacts/runs/{id}/`, and typed node sidecars land in its `nodes/` subdirectory. `ARCHON_HOME` overrides the base directory; Docker sets it to `/.archon/`.

**Repo-level (`.archon/` in any repository):**

```text
.archon/
├── commands/       # Custom commands
├── workflows/      # Workflow definitions (YAML files)
├── scripts/        # Named scripts for script: nodes (.ts/.js for bun, .py for uv)
└── config.yaml     # Repo-specific configuration
```

The repo directory holds SOURCE only — every byte a run produces lives under
`~/.archon/workspaces/<project>/`. `.archon/state/` is the LEGACY location for cross-run
state: it had no engine support (prompts did `mkdir -p .archon/state` relative to cwd), so
inside an isolated run it wrote to the worktree and died at cleanup, and in a user's repo it
was stageable. Use `$STATE_DIR` instead. Archon detects a legacy directory, WARNs once with
the `mv`, and never moves it; `scripts/migrate-state-dir.ts` is the operator's one-shot
(dry run by default; pass `--apply` to move).

- `ARCHON_HOME` - Override the base directory (default: `~/.archon`)
- Docker: Paths automatically set to `/.archon/`

## Development Guidelines

### UI and Visual Design

All UI changes — production web (`packages/web/`), experiments (`packages/web/src/experiments/`), the docs site, marketing surfaces, and any future visual surface — must align with the Archon brand foundation.

- **Canonical brand guide:** https://archon.diy/brand/ (source: `packages/docs-web/src/content/docs/brand/index.md` + `packages/docs-web/public/brand/foundation.html`).
- **Use brand tokens, not ad-hoc values.** Colors, gradients, surfaces, and typography must come from the established design tokens (`packages/web/src/index.css`) or the brand guide. Don't hard-code hex values that aren't in the system.
- **Introducing a new visual token** (color, font, radius, spacing) means updating both the token source and the brand guide. Don't fork the palette per package.
- **When in doubt, consult the brand guide first** before inventing new visual treatments. Open a discussion if the guide doesn't cover your case.

### When Creating New Features

**Quick reference:**
- **Platform Adapters**: Implement `IPlatformAdapter`, handle auth, polling/webhooks
- **AI Providers**: Implement `IAgentProvider`, session management, streaming
- **Slash Commands**: Add to command-handler.ts, update database, no AI
- **Database Operations**: Use `IDatabase` interface (supports PostgreSQL and SQLite via adapters)
- **Plan insertion points**: Use stable text anchors (e.g., "after the `it('throws on ...')` test block"), never raw line numbers — line numbers drift on every preceding edit.

### SDK Type Patterns

Import and use external SDK types directly (`import { query, type Options } from '@anthropic-ai/claude-agent-sdk'`) rather than redeclaring an equivalent local interface. Duplicated shapes drift on every SDK bump and force `as any` at the call site; the SDK's own type keeps compatibility checked by the compiler. Use a narrow type assertion where an SDK response shape needs pinning.

### Testing

**Unit Tests:**
- Test pure functions (variable substitution, command parsing)
- Mock external dependencies (database, AI SDKs, platform APIs)

**Integration Tests:**
- Test database operations with test database
- Test end-to-end flows (mock platforms/AI but use real orchestrator)
- Clean up test data after each test

**Mock isolation rules (IMPORTANT):**
- **`mock.module()` MERGES over the real module — it does NOT replace the namespace.** An export omitted from the factory keeps its REAL implementation (verified on bun 1.3.11). So adding a new export to a production module silently un-mocks it in every test that mocks that module, and those tests start doing real I/O with no signal. This is exactly how `/workflow abandon` tests began opening a real SQLite DB: `findChildRuns` was added to `db/workflows` by #2121 but never added to `command-handler.test.ts`'s factory (see #2240). **When you add an export to a module, grep for `mock.module('<that module>'` and update every factory.**
- Unit tests must not touch real external resources. A missing stub does not fail loudly — it stalls, and the only bound is Bun's 5000 ms per-test timeout, which surfaces on CI as an intermittent, hard-to-attribute timeout (#2186, #2240). To audit a suspect file, run it with `ARCHON_HOME` pointed at an empty temp dir and check whether an `archon.db` appears.
- `@archon/adapters` enforces the network half via `packages/adapters/bunfig.toml` → `src/test/no-network.ts` (other packages can adopt it with the same three lines). Two limits, both verified: it traps only `globalThis.fetch`, so axios/undici clients (`@slack/web-api`, `@discordjs/rest`) slip past it; and **Bun reads `bunfig.toml` only from cwd**, so the guard is INACTIVE in the `bun test packages/…` single-file form above — it applies to `bun run test` and to `bun test` run from inside `packages/adapters/`. That same cwd rule means the ROOT `bunfig.toml` never applies to the `bun --filter` half of `bun run test`, since each package runs from its own directory — but it DOES apply to that script's trailing `bun test ./scripts/`, which runs from the root. See the cwd note under **Testing**.
- Bun's `mock.module()` is process-global and irreversible — `mock.restore()` does NOT undo it
- Do NOT add `afterAll(() => mock.restore())` for `mock.module()` cleanup — it has no effect
- Use `spyOn()` for internal modules that other test files import directly (e.g., `spyOn(git, 'checkout')`) — `spy.mockRestore()` DOES work for spies
- Never `mock.module()` a module path that another test file also `mock.module()`s with a different implementation
- When adding a new test file with `mock.module()`, ensure its package.json test script runs it in a separate `bun test` invocation from any conflicting files

**Manual Validation:** Use the web API (`curl`) or CLI commands directly for end-to-end testing of new features.

### Logging

Structured logging uses Pino via `createLogger('<module>')` from `@archon/paths`. Log a structured object first, event name second — `log.info({ conversationId, sessionId }, 'session.create_completed')`. On failure include `error: err.message`, `errorType: err.constructor.name`, and `err` itself.

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
- `$ARGUMENTS`, `$USER_MESSAGE` - The user's full trigger message as a single string. Positional `$1`/`$2`/`$3` args are NOT supported — command/workflow prompts receive the whole message only.
- `$ARTIFACTS_DIR` - External artifacts directory for the current workflow run (pre-created by executor)
- `$STATE_DIR` - External cross-run state directory (`~/.archon/workspaces/<project>/state/`), pre-created by the executor. Scoped per PROJECT — shared by every workflow, conversation, and invocation surface; namespace inside it (`$STATE_DIR/<name>/`) for isolation. Survives worktree teardown and never appears in `git status`. Throws when referenced but unresolved, mirroring `$BASE_BRANCH`. No engine locking — see the authoring guide for the concurrent read-modify-write hazard.
- `$WORKFLOW_ID` - The workflow run ID
- `$BASE_BRANCH` - Base branch; auto-detected from git when `worktree.baseBranch` is not set; fails only if referenced in a prompt and auto-detection also fails
- `$DOCS_DIR` - Documentation directory path; configured via `docs.path` in `.archon/config.yaml`. Defaults to `docs/`. Never throws.
- `$LOOP_USER_INPUT` - User feedback provided via `/workflow approve <id> <text>` at an interactive loop gate. Only populated on the first iteration of a resumed interactive loop; empty string on all other iterations. Note: on a gate whose iteration emitted the completion signal, approving with NO text finalizes the node from the already-computed output (no new iteration, so `$LOOP_USER_INPUT` is never read) — providing text runs another iteration with it (#2074).
- `$REJECTION_REASON` - Reviewer feedback provided via `/workflow reject <id> <reason>` at an approval gate. Only populated in `on_reject` prompts; empty string elsewhere.
- `$LOOP_PREV_OUTPUT` - Cleaned output of the previous loop iteration (loop nodes only). Empty string on the first iteration (no prior output exists). Useful for `fresh_context: true` loops that need to reference what the previous pass produced or why it failed without carrying full session history.

**Command Types:**

1. **Codebase Commands** (per-repo):
   - Stored in `.archon/commands/` (plain text/markdown)
   - Discovered from the repository `.archon/commands/` directory
   - Surfaced via `GET /api/commands` for the workflow builder and invoked by workflow `command:` nodes

2. **Workflows** (YAML-based):
   - Stored in `.archon/workflows/`; recommended copyable layout is `.archon/workflows/<pack>/<workflow>/` with one YAML plus optional `commands/` and `scripts/`. Both directory names are author-chosen. Flat and one-level grouped YAML remain supported.
   - Multi-step AI execution chains, discovered at runtime
   - **`nodes:` (DAG format)**: Nodes with explicit `depends_on` edges; independent nodes in the same topological layer run concurrently. Node types: `command:` (named command file), `prompt:` (inline prompt), `bash:` (shell script, stdout captured as `$nodeId.output`, no AI, receives managed per-project env vars in its subprocess environment when configured), `loop:` (iterative AI prompt until a declared completion channel fires — `until` signal / `until_bash` exit 0 / `until_field` boolean), `loop_group:` (multi-node sub-DAG body repeated per iteration until `until` signal / `until_bash` exit 0 / `max_iterations`; body is sealed for `depends_on` but may read outer outputs via `$nodeId.output` and the previous iteration via `$LOOP_PREV.<nodeId>.output`; a failed body node fails the group immediately; group-level `model`/`provider` become body defaults), `approval:` (human gate; pauses until user approves or rejects; `capture_response: true` stores the user's comment as `$<node-id>.output` for downstream nodes, default false), `script:` (inline TypeScript/Python or named script from `.archon/scripts/`, runs via `bun` or `uv`, stdout captured as `$nodeId.output`, no AI, receives managed per-project env vars in its subprocess environment when configured, supports `deps:` for dependency installation and `timeout:` in ms, requires `runtime: bun` or `runtime: uv`), `include:` (load-time inlining of another workflow's nodes as a flattened, namespaced sub-DAG — each included node becomes `<includeId>__<nodeId>`; the include node's `depends_on`/`when`/`trigger_rule` attach to the block's entry nodes, and `$includeId.output` resolves to the block's terminal (primary) sink; expansion happens at discovery so the executor sees ordinary nodes; `with:` passes an identifier-keyed string map the block reads as `$INPUTS.<name>`, substituted VERBATIM at load time (never expressions) across every inline text surface including inside code fences — an unsupplied name is a load error, and `$INPUTS` works in a `command:`/`loop.command` file too — the body is resolved and snapshotted during composition, then gets the same input binding and node-id namespacing as an inline prompt; an unresolvable command file fails a fresh execution rather than being skipped. A composed workflow RUNS AS AUTHORED (#1764): its node-affecting config (`provider`/`model`/`effort`/`thinking`/`fallbackModel`/`betas`/`sandbox`/`persist_sessions`) is collapsed onto its own nodes at expansion and the workflow-level layer is then removed, so a block declaring nothing resolves from config/tiers/user prefs rather than inheriting the parent's; `requires:` unions upward; `interactive`/`worktree`/`container`/`evidence_policy`/`mutates_checkout` stay run-owned and are warned about; `webSearchMode` is the one node-affecting field that cannot travel (no per-node form). a composed `approval:` node requires `interactive: true` on the INVOKED workflow — enforced at invocation (`assertComposedGateDriveable`), not at load, because load time cannot tell which discovered workflow owns the run, and only web background dispatch is refused (CLI/chat present the gate normally); a composed block's entry node starts a fresh session (`context: shared` opts out); its declared inputs reach `bash:`/`script:` nodes as `INPUTS_<UPPER_SNAKE>` including NAMED script files; `isolation`/`fan_out`/`input`/`mutates_checkout` on an include node are load errors. Display surfaces read the authored values via `WorkflowWithSource.declared`; execution reads the collapsed DAG — see the "Composing Another Workflow" guide), `workflow:` (runtime sub-run — starts another workflow by static name as a separate governed CHILD run with its own `workflow_runs` row (`parent_run_id`), artifacts, gates, cost, and audit trail; `input:` forwards a data string (substituted like prompt bodies) as the child's `$ARGUMENTS`; the child's terminal output threads back as `$nodeId.output`; a child gate pauses the whole tree (approve the CHILD by run id — the parent auto-resumes on child completion); `isolation:` chooses the child's checkout — `inherit` (default; shares the parent's) or `worktree` (its own git worktree + branch, opt-in only, never inferred; requires an injected child-isolation resolver, so it fails fast on folder projects and surfaces that don't wire one), `with:` passes an identifier-keyed string map (mutually exclusive with `input:`) resolved at run time and persisted to the child as `$INPUTS.<name>` or `INPUTS_<UPPER_SNAKE>` for bash/script nodes; the resolved child input contract is enforced before any worktree or run row exists; `retry:` rejected, disallowed inside a `loop_group` body; abandon cascade-cancels descendants; `fan_out:` runs ONE CHILD PER ITEM of a runtime list — `items` (a `$node.output` ref or literal JSON array), `max_parallel` (default 5, bounds concurrency not total count or spend), `join` (default `all_done`: every terminal outcome aggregates with failures as `{error,status}`; `all_success` for the genuinely dependent case), `as` names the per-item value as `$INPUTS.<as>` inside each child (rejected only when it collides with a `with:` key; without `as`, the item still travels as `$ARGUMENTS`). Children are INDEPENDENT: every index spawns, each runs to its own terminal state, and none cancels another — the sole exception is a child that pauses at a gate, which is cancelled because a parent has one approval slot (gate before/after the fan-out, never inside a child). Racing (`join: first_success`) is rejected outright, not deferred. Concurrent children on a SHARED checkout collide on the path lock, so a spawn-time preflight refuses that expansion unless the child declares `mutates_checkout: false`, the node sets `isolation: worktree`, or `max_parallel: 1`) . Supports `when:` conditions, `trigger_rule` join semantics, `$nodeId.output` substitution, `output_format` for structured JSON output (SDK-enforced on Claude/Codex/OpenCode; best-effort prompt-augmentation + repair on Pi/Copilot — the parsed output is **validated against the declared schema for every provider**, best-effort providers (Pi/Copilot) re-ask up to 3× on a validation miss, and a node that declares `output_format` but returns no schema-valid output **fails** rather than degrading silently; `$nodeId.output.field` access is strict — a field not in the producer's schema, or a schemaless node whose output isn't JSON / lacks the key, fails the consuming node, while an author-declared-optional field resolves to `''`), `allowed_tools`/`denied_tools` for per-node tool restrictions (all providers except Codex), `hooks` for per-node SDK hook callbacks (Claude only), `mcp` for per-node MCP server config files (all providers except Pi, env vars expanded at execution time), and `skills` for per-node skill preloading via AgentDefinition wrapping (per-node injection on Claude/Pi/OpenCode/Copilot; Codex instead auto-discovers skills from `.agents/skills/` on the filesystem — the `skills:` list is informational for Codex nodes), `agents` for inline sub-agent definitions invokable via the Task tool (Claude only), and `effort` for reasoning depth (Claude/Codex/Pi/Copilot) and `thinking` (Claude/Pi/Copilot) plus the Claude-only SDK advanced options `fallbackModel`/`betas`/`sandbox` (also settable at workflow level) and `maxBudgetUsd`/`systemPrompt` (per-node only), and `persist_session` for cross-run provider session continuity (node-level opt-in; workflow-level default via `persist_sessions: true`; requires a provider with the `sessionResume` capability), and `output_type` (any node type) for engine-written typed output sidecars — when set, the executor writes `$ARTIFACTS_DIR/nodes/<id>.md` + `<id>.meta.json` after the node completes (best-effort) so downstream nodes and later runs can locate output by type instead of guessing filenames
   - Workflow-level `requires: [github]` hard-blocks invocation (before any worktree/clone/AI cost) when the originating user hasn't connected their GitHub identity — enforced only when per-user GitHub is enabled (GitHub App + `TOKEN_ENCRYPTION_KEY`); a no-op for solo PAT installs
   - Workflow-level **signature** (`inputs:` / `returns:`) declares the contract a workflow exposes to callers. `inputs:` maps names to `{ required?, default?, description? }`; callers provide values through `with:` (`include:` validates at load time, `workflow:` validates before runtime child spawn). Defaults are applied, missing required and undeclared inputs are rejected, and workflows without `inputs:` preserve passthrough behavior. `returns:` names the node whose output becomes `$<callerNodeId>.output`, replacing positional first-sink selection without changing dependency completion.
   - Provider inherited from `.archon/config.yaml` unless explicitly set; per-node `provider` and `model` overrides supported
   - Model and options can be set per workflow or inherited from config defaults
   - `interactive: true` at the workflow level forces foreground execution on web (required for approval-gate workflows in the web UI)
   - Model validation ensures provider/model compatibility at load time
   - Commands: `/workflow list`, `/workflow reload`, `/workflow status`, `/workflow cancel`, `/workflow resume <id>` (re-runs a failed or paused workflow, skipping completed nodes), `/workflow abandon <id>`, `/workflow cleanup [days]` (CLI only — deletes old run records), `/workflow reset-sessions <name> [<node-id>]` (clears persisted `persist_session` memory; chat auto-scopes to the current conversation, CLI adds `--scope`/`--yes` for cross-scope control)
   - Resilient loading: One broken YAML doesn't abort discovery; errors shown in `/workflow list`
   - `resolveWorkflowName()` (in `router.ts`) resolves workflow names via a 4-tier fallback — exact, case-insensitive, suffix (`-name`), substring — with ambiguity detection; used by both the CLI and all chat platforms
   - Router fallback: if no `/invoke-workflow` is produced, falls back to `archon-assist` (with "Routing unclear" notice); raw AI response returned only when `archon-assist` is unavailable
   - Claude routing calls use `tools: []` to prevent tool use at the API level; Codex tool bypass is detected and triggers the same fallback

**Defaults:**
- Bundled in `.archon/commands/defaults/` and `.archon/workflows/defaults/`
- Packaged bundled workflows may use any `.archon/workflows/<pack>/<workflow>/` path; `defaults` has no special packaged-workflow semantics. The generator embeds the YAML, local commands, local scripts, and internal ownership metadata.
- Binary builds: Embedded at compile time (no filesystem access needed) via `packages/workflows/src/defaults/bundled-defaults.generated.ts`
- Source builds: Loaded from filesystem at runtime
- Merged with repo-specific commands/workflows (repo overrides defaults by name)
- Opt-out: Set `defaults.loadDefaultCommands: false` or `defaults.loadDefaultWorkflows: false` in `.archon/config.yaml`
- **After adding, removing, or editing a default file, run `bun run generate:bundled`** to refresh the embedded bundle. A new default file must be staged in git first (`git add`); `bun run generate:bundled` (and `check:bundled`) refuse to embed untracked files in `defaults/`. After editing `migrations/000_combined.sql`, run `bun run generate:bundled-schema` to keep the embedded schema in sync, AND mirror any new table into `createSchema()` in `packages/core/src/db/adapters/sqlite.ts` — the SQLite schema is hand-maintained separately and is NOT generated from the migration; the only intentional Postgres-only exception is the `remote_agent_auth_*` Better Auth tables, and the schema-parity test in `sqlite.test.ts` fails CI on any other drift. After a `@earendil-works/pi-ai` upgrade, run `bun run generate:pi-vendor-map` to regenerate the Pi backend → env-var map + credential specs from the installed SDK (a new upstream backend must be classified in `scripts/generate-pi-vendor-map.ts`). After changing any provider's `capabilities.ts` (or adding a provider/capability axis), run `bun run generate:capability-matrix` to refresh the canonical provider capability matrix at `packages/docs-web/src/content/docs/reference/provider-capabilities.md` — it is generated from the registry's capability constants (the same objects the dag-executor reads for ignored-capability warnings), so the docs can never drift from runtime behavior; a new `ProviderCapabilities` field fails the generator until it gets a matrix axis in `scripts/generate-capability-matrix.ts`. `bun run validate` (and CI) run `check:bundled`, `check:bundled-skill`, `check:bundled-schema`, `check:pi-vendor-map`, and `check:capability-matrix` and will fail loudly if any generated file is stale.

**Home-scoped ("global") workflows, commands, and scripts** (user-level, applies to every project):
- Workflows: `~/.archon/workflows/` (or `$ARCHON_HOME/workflows/`)
- Commands: `~/.archon/commands/` (or `$ARCHON_HOME/commands/`)
- Scripts: `~/.archon/scripts/` (or `$ARCHON_HOME/scripts/`)
- Source label: `source: 'global'` on workflows and commands (scripts don't have a source label)
- Load priority: bundled < global < project (repo overrides global by filename or script name)
- Layouts: flat YAML and one-level grouped YAML remain supported. Packaged workflows use exactly `~/.archon/workflows/<pack>/<workflow>/`; YAML must be directly inside the workflow folder. Deeper YAML is not loaded, and a workflow folder without exactly one direct YAML reports a validation error.
- Discovery is automatic — `discoverWorkflowsWithConfig(cwd, loadConfig)` and `discoverScriptsForCwd(cwd)` both read home-scoped paths unconditionally; no caller option needed
- **Migration from pre-0.x `~/.archon/.archon/workflows/`**: if Archon detects files at the old location it emits a one-time WARN with the exact `mv` command and does NOT load from there. Move with: `mv ~/.archon/.archon/workflows ~/.archon/workflows && rmdir ~/.archon/.archon`
- See the docs site at `packages/docs-web/` for details

### Error Handling

**Database errors.** Wrap writes in try/catch, log with the failing parameters, and re-throw — never swallow. Archon's update helpers already throw when no row matched, so a re-thrown error is how a missing record surfaces; don't check rowCount yourself.

**Git/isolation errors — don't fail silently.** Map the raw error through `classifyIsolationError()` (`@archon/isolation`), which turns permission-denied / timeout / no-space / not-a-git-repo into a user-facing message. Log the raw error for debugging **and** send the classified message to the user; doing only one of the two is the bug this pattern exists to prevent.

### API Endpoints

**Web UI REST API** (`packages/server/src/routes/api.ts`):

**Workflow Management:**
- `GET /api/workflows` - List available workflows; optional `?cwd=`; returns `{ workflows: [...], recommended: [...], errors?: [...] }`. Each entry is `{ workflow, source, parseWarnings? }` — `parseWarnings` (#2213) holds warning messages naming the keys the engine silently dropped from that YAML and is **omitted** when the workflow is clean, so presence alone is the signal
- `POST /api/workflows/validate` - Validate a workflow definition in-memory (no save); body: `{ definition: object }`; returns `{ valid: boolean, errors?: string[] }`
- `GET /api/workflows/:name` - Fetch a single workflow by name; optional `?cwd=` query param; returns `{ workflow, filename, source: 'project' | 'bundled' }`
- `PUT /api/workflows/:name` - Save (create or update) a workflow YAML; body: `{ definition: object }`; validates before writing; requires `?cwd=` or registered codebase
- `DELETE /api/workflows/:name` - Delete a user-defined workflow; bundled defaults cannot be deleted
- `DELETE /api/workflows/:name/node-sessions` - Reset persisted per-node provider sessions; optional `?scope=` and `?node=` narrow the deletion; omitting `?scope=` is a cross-scope wipe and requires `?confirm=all-scopes`; returns `{ success, deleted }`

**Workflow Run Lifecycle:**
- `POST /api/workflows/runs/{runId}/resume` - Resume a failed or paused run from where it left off (skips already-completed DAG nodes; AI session context is not restored).
- `POST /api/workflows/runs/{runId}/abandon` - Abandon a non-terminal run (marks as cancelled); cascade-cancels non-terminal `workflow:` sub-run descendants (#2121 Phase 2) and reports `cascadeFailures`/`blockedParentRunId`
- `DELETE /api/workflows/runs/{runId}` - Delete a terminal workflow run and its events

**Codebases:**
- `GET /api/codebases` / `GET /api/codebases/:id` - List / fetch codebases
- `POST /api/codebases` - Register a codebase (clone or local path). A non-git local `path` now auto-registers as a folder project (`kind: 'folder'`, runs in place) instead of erroring
- `DELETE /api/codebases/:id` - Delete a codebase and clean up resources
- `GET /api/codebases/:id/env` - List env var keys for a codebase (never returns values)
- `PUT /api/codebases/:id/env` / `DELETE /api/codebases/:id/env/:key` - Upsert / delete a single codebase env var
- `GET /api/codebases/:id/environments` - List tracked isolation environments for a codebase

**Artifact Files:**
- `GET /api/runs/:runId/artifacts` - List artifact files for a run; walks the on-disk artifact directory (dotfiles skipped) and returns `{ files: [{ path, size, modifiedAt }] }`; 400 on invalid run id or path-escape attempt, 404 if the run does not exist
- `GET /api/artifacts/:runId/*` - Serve a workflow artifact file by run ID and relative path; returns `text/markdown` for `.md` files, `text/plain` otherwise; 400 on path traversal (`..`), 404 if run or file not found

**Command Listing:**
- `GET /api/commands` - List available command names (bundled + project-defined); optional `?cwd=`; returns `{ commands: [{ name, source: 'bundled' | 'project' }] }`

**Providers:**
- `GET /api/providers` - List registered AI providers; returns `{ providers: [{ id, displayName, capabilities, builtIn }] }`. `capabilities.nativeTools` is `true` for providers that accept in-process native tools (Claude, Pi) — Archon's `manage_run` tool is auto-injected into project-scoped chat for those providers only. `capabilities.structuredOutput` is a tiered union `'enforced' | 'best-effort' | false` (not a boolean): `'enforced'` = SDK/backend grammar-constrained (Claude/Codex/OpenCode), `'best-effort'` = prompt-augmentation + validate (Pi/Copilot), `false` = unsupported.

**Web Auth (opt-in Better Auth; Postgres + `BETTER_AUTH_SECRET`):**
- Better Auth mounts email/password login at `/api/auth/*` (sign-up/sign-in/sign-out/get-session). Mounted only when enabled; the catch-all explicitly falls through (`isArchonOwnedAuthPath` in `auth/config.ts`, guard-tested) for Archon-owned `/api/auth/status` + `/api/auth/github*` + `/api/auth/providers*` + `/api/auth/me/ai-prefs*` paths so they aren't shadowed (a missing exemption 404s the route — see #1918).
- `GET /api/auth/status` - Web auth availability + signup posture (no auth required); returns `{ enabled: boolean, signup: 'allowlist' | 'open' | 'disabled' }`. Drives the Web UI login gate.
- The per-request identity seam is `resolveAuthContext(c): { userId, role } | undefined` (in `routes/api.ts`): Better Auth session first, then the `X-Archon-User` header, then undefined. `resolveWebUserId` delegates to it; `requireWebUser` is the session-aware strict variant (401 missing / 503 backend). `role` rides the canonical user row (default `admin`).
- **Server-side API gate** (`isApiGateEnabled`): when web auth is enabled, every `/api/*` request must resolve to an identity or gets **401** — except `/api/auth/*` (login surface) and `/api/health*` (healthcheck must stay reachable). `/webhooks/*` and `/internal/*` are outside `/api/*` and untouched. On by default; `ARCHON_WEB_AUTH_REQUIRED=false` keeps login-UI-only. This is what lets Better Auth replace the Caddy `forward_auth` sidecar as the real access boundary.
- **Signup safety** (`getSignupMode`): with web auth on and no `ARCHON_AUTH_ALLOWED_EMAILS`, signup defaults to **disabled** (login only) + a boot WARN — never silently open. `ARCHON_AUTH_OPEN_SIGNUP=true` opts into open public signup.
- `GET /api/workflows/runs?mine=true` and `GET /api/conversations?mine=true` - Non-enforcing "my" filter (narrows to `ctx.userId` only when an identity resolves; default lists everything). Not a security boundary.

**GitHub Identity (per-user device flow; App mode + `TOKEN_ENCRYPTION_KEY`):**
- `POST /api/auth/github/device/start` - Begin the device flow for the current web user (from `X-Archon-User`); returns `{ device_code, user_code, verification_uri, interval, expires_in }`; 401 if no web-auth header
- `POST /api/auth/github/device/poll` - Single non-blocking poll; body `{ device_code }`; returns `{ status: 'pending' | 'connected' | 'expired' | 'denied' | 'error', githubLogin?, detail? }`
- `GET /api/auth/github` - Connection status for the current web user; returns `{ connected, githubLogin }`
- `DELETE /api/auth/github` - Disconnect the current web user's GitHub identity

**AI-Provider Keys (per-user; `requireWebUser`):**
- `GET /api/auth/providers` - List the current web user's connected provider keys; returns `{ enabled, connections: [{ provider, kind, label }], available: string[], subscriptionAvailable: string[], agents: [...] }` (no secret values; `available` = registry-derived connectable **vendor** catalog, `subscriptionAvailable` = subset that supports OAuth login; `enabled` is always `true` — vault is auto-provisioned). `agents` (#1955) is the agent → credential matrix: per registered agent `{ id, displayName, catalog: 'static'|'dynamic', ready, credentials: [{ vendor, displayName, kinds, connected, subscriptionAvailable, installEnv, ambientConfigured? }] }` — `installEnv`/`ambientConfigured` report server-env detection so readiness works on solo installs too; OpenCode is `catalog:'dynamic'` (introspect via the endpoint below). `requireWebUser` (401 without identity)
- `PUT /api/auth/providers/:provider` - Connect (upsert) an API key by **vendor id** (legacy `claude`/`codex`/`copilot` accepted + normalized); body `{ apiKey, label? }`; returns `{ success, provider: <vendor>, kind: 'api_key', label }` (never echoes the key). 400 on unknown vendor / blank key, 404 when per-user keys disabled, 500 (opaque) on storage failure
- `DELETE /api/auth/providers/:provider` - Disconnect a credential (idempotent, vendor-normalized); returns `{ success }`. 404 when disabled
- `POST /api/auth/providers/:provider/oauth/start` - Begin a subscription (OAuth) login (`anthropic`/`openai`/`github-copilot`); returns `{ sessionId, mode: 'manual'|'device', url?, userCode?, verificationUri?, expiresIn }` (no secret). 400 non-subscription vendor, 404 disabled, 503 when a previous login still holds the OAuth callback port (#1963 — retryable). Held server-side by the `oauth-bridge`: Pi's `login()` for anthropic/github-copilot; an Archon-OWNED PKCE flow for openai/ChatGPT (`openai-oauth.ts` — captures the `id_token` Pi drops, manual-paste only with no local callback server, #1924). `SUBSCRIPTION_PROVIDERS` (in `oauth-providers.ts`) is the single source of truth.
- `POST /api/auth/providers/:provider/oauth/poll` - Poll the login session; body `{ sessionId, code? }` (`code` = pasted manual-code); returns `{ status: 'pending'|'connected'|'error', detail? }`. Session bound to the caller's userId.
- Credentials (API keys + subscriptions) injected into runs/chat env at execution time (vault always active — `TOKEN_ENCRYPTION_KEY` overrides the auto-key on managed deploys). Subscription tokens refresh-on-read and re-save on rotation. Subscriptions are delivered to native Claude/Codex (env / `CODEX_HOME/auth.json`) AND to Pi — in workflow runs via a per-run `auth.json` (`ARCHON_PI_AUTH_PATH`), and in env-only direct chat (no artifacts dir) an `anthropic` subscription rides `ANTHROPIC_OAUTH_TOKEN` in the env bag, which the Pi env bridge reads ahead of `ANTHROPIC_API_KEY` (#1984).

**Per-User AI Prefs (Phase 3; `requireWebUser` — identity only, NO `TOKEN_ENCRYPTION_KEY`):**
- `GET /api/auth/me/ai-prefs` - The current user's stored prefs (raw per-user layer, not merged with config); returns `{ tiers?, aliases?, defaultProvider? }`. 401 without identity — the console hides "Just me" on failure.
- `PATCH /api/auth/me/ai-prefs/tiers` / `…/aliases` - Per-key merge writes (`null` unsets); validate provider via `isRegisteredProvider`, effort via `isEffortValidForProvider`, alias names (`@` prefix, not a reserved tier keyword). All return the updated prefs.
- `PATCH /api/auth/me/ai-prefs/default` - Set the personal default assistant + default chat model: `{ provider, model? }` written ATOMICALLY (omitted `model` clears any pin; `model` without `provider` → 400; `provider: null` clears both). Chat model precedence (#1998, chat call-site only): user `default_model` (provider must match) → configured `large` tier (user > repo > global) → install `assistants.<p>.model` (beats only the built-in tier default) → built-in tier default.
- Stored in `remote_agent_user_ai_prefs` (non-encrypted); folded into `buildAiProfile` as the **highest-precedence** layer (global < repo < user) at the userId-aware seams — workflow executor (`deps.getUserAiPrefs`, resolved from the run starter) and chat orchestrator (sender-first: `executionUserId = context.userId ?? conversation.user_id` — the SENDER's prefs and credentials win; the conversation creator is only the fallback when no sender identity resolves, see #1982). The per-user `defaultProvider` rebases tier defaults and the chat assistant. No identity → byte-for-byte config-only behavior (solo unchanged). A chat request for tier `large` that resolves via the fallback chain emits a one-line non-blocking nudge (`orchestrator.tier_fallback_nudge`). Note: on genuinely shared threads (Slack/Telegram), per-sender prefs mean the provider can differ per turn within one thread (session transitions churn accordingly), and a sender's turn carries the shared thread history into a call billed to their credential — accepted semantics.

**Config and provider metadata (System; not `requireWebUser`, but covered by the global API gate):**

- These routes are ungated on solo installs and when `ARCHON_WEB_AUTH_REQUIRED=false`. With web auth's default API gate enabled, they require either a Better Auth session or the trusted reverse-proxy identity header; only `/api/auth/*` and `/api/health*` bypass that gate. The proxy header is safe only when a trusted proxy strips client-supplied copies (or Archon binds to loopback).
- The config `PATCH` routes do not add a route-specific identity requirement. Consequently, disabling the global API gate leaves them writable whether or not the optional proxy header is present; deployments that opt out must enforce the equivalent boundary at their proxy.
- `GET /api/config` - Read-only safe config; returns `{ config, database }`. `config` includes `tiers` (configured small/medium/large presets), `tierDefaults` (built-in presets for the default provider, computed via `buildAiProfile` — lets the UI show what an unset tier resolves to), and `aliases` (configured `@custom` aliases, merged repo > global).
- `PATCH /api/config/assistants` - Update default assistant + per-provider model defaults.
- `PATCH /api/config/tiers` - Update model-tier presets; body `{ tiers: { small?, medium?, large? } }` where each tier is `{ provider, model, effort? }` or `null` (unset). Per-key merge; validates each `provider` via `isRegisteredProvider`. Writes `~/.archon/config.yaml`. Drives the console "AI Settings → Model Tiers" panel + `archon ai tier` CLI.
- `PATCH /api/config/aliases` - Update `@custom` model aliases; body `{ aliases: Record<'@name', entry | null> }`. Same per-key merge + validation as `/tiers`, plus alias-name checks (`@` prefix, not reserved). Drives the console "Model Aliases" panel + `archon ai alias` CLI.
- `GET /api/providers/pi/models` - Pi's model catalog (`{ models: [{ ref, provider, id, name, reasoning, cost, contextWindow }] }`) for the tier picker's cost/reasoning hint. Best-effort: returns `{ models: [] }` on any catalog failure — never blocks tier/alias saves.
- `GET /api/providers/opencode/credentials` - Introspect OpenCode's backend providers (#1955): proxies the embedded server's `GET /provider` + `/provider/auth`; returns `{ providers: [{ id, name, env, connected, modelCount, authMethods }] }` (metadata only; `connected` is install-wide — OpenCode's auth store is server-global). **Heavyweight**: starts the embedded OpenCode runtime when not already running — call on demand from the settings card, never on passive page load. 503 (never a silent `[]`) when the runtime is unavailable.

**System:**
- `GET /api/health` - Health check with adapter/system status
- `GET /api/update-check` - Check for available updates; returns `{ updateAvailable, currentVersion, latestVersion, releaseUrl }`; skips GitHub API call for non-binary builds

**OpenAPI Spec:**
- `GET /api/openapi.json` - Generated OpenAPI 3.0 spec for all Zod-validated routes

**Webhooks:**
- `POST /webhooks/github` - GitHub webhook events
- Signature verification required (HMAC SHA-256)
- Return 200 immediately, process async

**Internal (App mode only; bind 127.0.0.1):**
- `POST /internal/git-credential` - Git credential helper endpoint. Returns `{token}` for the installation matching the requested host/path. Used by the `git-credential-archon` script in worktree `.git/config` to refresh installation tokens for long-running workflow `git` operations. Hands out installation tokens — MUST NOT be exposed beyond loopback. Server **refuses to start** (not just WARN) if App mode is active and `hostname != 127.0.0.1/localhost`, unless `ARCHON_ALLOW_INTERNAL_ON_PUBLIC_BIND=1` is set as an opt-in escape hatch for deployments where the reverse proxy already drops `/internal/*`.

**Security:**
- Verify webhook signatures (GitHub: `X-Hub-Signature-256`)
- Use `c.req.text()` for raw webhook body (signature verification)
- Never log or expose tokens in responses
- `/internal/*` paths hand out live credentials — the reverse proxy in production MUST drop them, or the server MUST bind to `127.0.0.1` only.

**@Mention Detection:**
- Parse `@archon` in issue/PR **comments only** (not descriptions)
- Events: `issue_comment` only
- Note: Descriptions often contain example commands or documentation - these are NOT command invocations (see #96)
