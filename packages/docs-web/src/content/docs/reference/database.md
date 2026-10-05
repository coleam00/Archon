---
title: Database
description: Database setup, schema overview, and migration guide for SQLite and PostgreSQL backends.
category: reference
area: database
audience: [developer, operator]
status: current
sidebar:
  order: 5
---

Archon supports two database backends: **SQLite** (default, zero setup) and **PostgreSQL** (optional, for cloud/advanced deployments). The database backend is selected automatically based on whether the `DATABASE_URL` environment variable is set.

## SQLite (Default - No Setup Required)

Simply **omit the `DATABASE_URL` variable** from your `.env` file. The app will automatically:
- Create a SQLite database at `~/.archon/archon.db`
- Initialize the schema on first run
- Use this database for all operations

**Pros:**
- Zero configuration required
- No external database needed
- Perfect for single-user CLI usage

**Cons:**
- Not suitable for multi-container deployments
- No network access (CLI and server can't share database across different hosts)

## Remote PostgreSQL (Supabase, Neon, etc.)

Set your remote connection string in `.env`:

```ini
DATABASE_URL=postgresql://user:password@host:5432/dbname
```

**No manual migration step is required.** On startup, the Postgres adapter applies the bundled `migrations/000_combined.sql` inside an advisory-lock transaction. The SQL is idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`), so both fresh installs and version upgrades converge automatically — including new tables and columns added in later releases.

Upgrades are verified, not assumed: CI applies the current schema on top of a database built from
every distinct schema Archon has ever released, re-applies it to confirm idempotence, and compares
the result against a fresh install — columns, indexes, column comments, constraints and sequences.
Run the same check yourself against any PostgreSQL with `bun run check:schema-upgrades`.

If schema application fails (permissions, syntax error, network), the process aborts at the first DB operation with the underlying Postgres error logged at `db.pg_schema_init_failed`.

## Local PostgreSQL via Docker

Use the `with-db` Docker Compose profile for automatic PostgreSQL setup.

Set in `.env`:

```ini
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent
```

The app converges the schema automatically on startup (see the note above for remote Postgres). Both fresh installs and upgrades are handled by the same path; the `docker-entrypoint-initdb.d` mount in `docker-compose.yml` is now redundant and is retained only as a no-op on fresh volumes.

## Verifying the Database

**Health check:**
```bash
curl http://localhost:3090/health/db
# Expected: {"status":"ok","database":"connected"}
```

**List tables (PostgreSQL):**
```bash
psql $DATABASE_URL -c "\dt"
```

## Schema Overview

The tables defined in `migrations/000_combined.sql` are prefixed with `remote_agent_`:

- **`remote_agent_codebases`** - Repository metadata
  - Commands stored as JSONB: `{command_name: {path, description}}`
  - Optional explicit AI assistant choice; `NULL` follows project configuration for new conversations
  - Default working directory
  - `kind` (`'repo'` | `'folder'`, default `'repo'`) discriminates git-repo projects from non-git folder projects (which run in place, no worktree)
  - Optional explicit base branch; `NULL` resolves the remote default when needed. Existing stored values remain explicit.

- **`remote_agent_conversations`** - Platform conversation tracking
  - Platform type + conversation ID (unique constraint)
  - Linked to codebase via foreign key
  - AI assistant type locked at creation
  - Nullable `user_id` records the first user who created the conversation (first-user-wins; later replies in the same thread are attributed on the workflow_run, not here)

- **`remote_agent_sessions`** - AI session management
  - Active session flag (one per conversation)
  - Session ID for resume capability
  - Metadata JSONB for command context

- **`remote_agent_isolation_environments`** - Worktree isolation
  - Tracks git worktrees per issue/PR
  - Enables worktree sharing between linked issues and PRs
  - Nullable `created_by_user_id` preserves the original creator across re-activation (the `ON CONFLICT DO UPDATE` clause intentionally omits this column)

- **`remote_agent_workflow_runs`** - Workflow execution tracking
  - Tracks active workflows per conversation
  - Locks concurrent execution per `working_path`: a second dispatch on a path with an active run (status `pending`/`running`/`paused`) is auto-cancelled with an actionable message. Stale `pending` rows older than 5 minutes are treated as orphaned and ignored. A `workflow:` sub-run shares its parent's checkout unless the node declares `isolation: worktree`, so the path-lock excludes both the run's ancestor chain and its descendants (via `parent_run_id`) — a child never contends with its own parent. Siblings are **not** excluded.
  - Stores workflow state, step progress, and parent conversation linkage
  - Nullable `user_id` records which user triggered the run
  - Nullable `parent_run_id` (#2121 Phase 2) — self-referential FK (`ON DELETE SET NULL`) linking a `workflow:` sub-run to the run that spawned it; null for top-level runs. Makes the run tree walkable (`findChildRuns`/`getRunAncestry`) for the abandon cascade and cost roll-up.
  - `conversation_id` cascades on conversation delete: a hard `DELETE` of a conversation would erase its run rows and silently drop the live-run cleanup pin for their isolation environments (#2868). Soft delete is the only supported path — a future hard-delete must resolve live runs first.

- **`remote_agent_workflow_events`** - Step-level workflow event log
  - Records step transitions, artifacts, and errors per workflow run
  - Every provider event a workflow node streams, as `provider_event` rows: the engine envelope (`attemptId`, `seq`, `observedAt`, `event`) in `data`, the node in `step_name`. The same envelope is a `provider_event` line in the run's JSONL log. `GET /api/workflows/runs/{runId}/provider-events` serves them; the run-detail route leaves them out
  - Enables workflow run detail views and debugging
  - Indexed on `created_at` (`idx_workflow_events_created_at`) for the dashboard event poller's cross-run tail. On PostgreSQL an `AFTER INSERT` trigger (`archon_workflow_event_notify`) calls `pg_notify('archon_dashboard_event', …)` so runs started out of process (the `archon` CLI / `--detach`) stream live to the console; on SQLite the poller picks them up within its interval. The trigger is Postgres-only and best-effort (a role without `CREATE TRIGGER` degrades to poll-only, not a boot failure).

- **`remote_agent_messages`** - Conversation message history
  - Persists user and assistant messages with timestamps
  - Stores tool call metadata (name, input, duration) in JSONB
  - Enables message history in Web UI across page refreshes
  - Nullable `user_id` on user-role rows (NULL on assistant rows since the AI isn't a user)

- **`remote_agent_codebase_env_vars`** - Per-project env vars for workflow execution
  - Key-value pairs scoped to a codebase
  - Injected into Claude SDK subprocess environment at execution time
  - Managed by opening **Environment variables** from the project row in the console project rail; `env:` in `.archon/config.yaml` for CLI users

- **`remote_agent_users`** - Archon-internal user identity
  - One row per human (or bot) across all platforms
  - Created lazily on first sight by any chat/forge adapter
  - `display_name` and `email` are nullable until enrichment succeeds
  - `role` (`VARCHAR`, default `'admin'`) is the identity seam for future per-resource scoping; everyone is `admin` today (visibility stays open), `'member'` is reserved

- **`remote_agent_user_identities`** - Platform-to-Archon user mapping
  - One row per `(platform, platform_user_id)` pair — Slack U-id, Telegram chat id, Discord snowflake, GitHub login, the `web` Better Auth user id, etc.
  - `UNIQUE(platform, platform_user_id)` enforces deduplication at the DB level
  - References `users.id` with `ON DELETE CASCADE` (deleting a user removes their identity mappings)
  - All user_id FKs on the four tables above use `ON DELETE SET NULL` so future user deletion never destructively cascades

- **`remote_agent_workflow_run_node_sessions`** - Private provider session handles within a workflow run
  - Keyed by `(workflow_run_id, node_id)`; deleted with the owning run
  - Stores the provider and session ID for same-run session lineage; excluded from run and event APIs

- **`remote_agent_workflow_node_sessions`** - Per-node provider session IDs persisted across workflow re-runs
  - Opt-in via `persist_session`; keyed by `(workflow_name, node_id, scope_key, provider)`
  - `scope_key` is the UUID of the conversation that launched the run (`parent_conversation_id`, else `conversation_id`). A run with neither has no scope, so it reads and writes no rows here
  - A run reads its scope's rows once at start, and each node writes its finished session back, so concurrent runs end with the session that finished last
  - No FK on `scope_key`, so a conversation delete does not cascade here. Soft delete plus a never-reused UUID makes the leftovers harmless; a future hard-delete must delete by `scope_key` itself — the mirror of the cascade caveat on `remote_agent_workflow_runs` above.

- **`remote_agent_user_github_tokens`** - Per-user GitHub device-flow tokens
  - Encrypted at rest (AES-256-GCM); one row per Archon user (`UNIQUE(user_id)`), cascades on user deletion
  - Numeric `github_user_id` anchors the commit no-reply email

- **`remote_agent_user_provider_keys`** - Per-user AI-provider credentials (API key or OAuth subscription blob)
  - Encrypted at rest (AES-256-GCM, same `TOKEN_ENCRYPTION_KEY`); one row per `(user_id, provider)`, cascades on user deletion
  - `kind` records `api_key` vs `oauth`; resolved + injected into the user's runs/chat env at execution time
  - `provider` holds **vendor-canonical** credential ids (`anthropic`, `openai`, `github-copilot`, plus Pi backend vendors) — legacy `claude`/`codex`/`copilot` rows are renamed by an idempotent startup data fix (the vendor row wins when both exist)

- **`remote_agent_user_ai_prefs`** - Per-user AI preferences (personal model tiers, `@custom` aliases, default assistant + default chat model)
  - NON-encrypted (model names aren't secrets); one row per user (`UNIQUE(user_id)`), cascades on user deletion
  - `tiers` / `aliases` are JSON-as-TEXT; folded into model resolution as the highest-precedence layer. `default_model` pins the user's direct-chat model (written atomically with `default_provider`; applied only when the effective chat provider matches — workflows still resolve the `large` tier). Resolution follows the **acting user**: workflow runs use the run starter; chat turns use the message **sender** (the conversation creator's row is only a fallback when no sender identity resolves)
  - Editable via the console "Just me" scope, `archon ai … --scope user`, or `/api/auth/me/ai-prefs*`

- **`remote_agent_schema_version`** - Diagnostic schema vintage
  - Records the Archon build that created the database and the build that last applied its schema
  - A single row (`id = 1`); databases predating this table retain an unknown creation version

- **`remote_agent_start_receipts`** - Source delivery receipts
  - Records source instance, delivery ID, content digest, timestamps, and matching outcome
  - Deduplicates deliveries by `(source_instance_id, delivery_id)` when the source supplies a delivery ID; `delivery_id` is nullable, and the unique constraint does not deduplicate receipts without one

- **`remote_agent_start_receipt_bindings`** - Per-binding preparation state for a source receipt
  - Keyed by `(receipt_id, binding_id)`; deleted with the owning receipt
  - Tracks binding revision, host, intent, preparation status, owner, and error

- **`remote_agent_resource_slots`** - Keyed resource capacity
  - Stores capacity per `resource_key` for workflow and provider-attempt admission

- **`remote_agent_resource_slot_holders`** - Resource capacity holders
  - Tracks workflow runs and provider attempts occupying a slot
  - Provider-attempt holders record their owner host, PID, and instance

- **`remote_agent_resource_start_requests`** - Durable workflow-start requests
  - Stores prepared launches, overlap policy, admission status, and blockers
  - Prepared launches are versioned. Version 2 carries the run's `origin`; version 1 launches queued by older binaries are still admitted, with their conversation and user read as the origin. Older binaries cannot read version 2, so before downgrading, drain or withdraw any queued or admitted request whose run has not started
  - `queue_position` orders waiting requests; optional receipt and binding linkage preserves source provenance

- **`remote_agent_auth_user` / `remote_agent_auth_session` / `remote_agent_auth_account` / `remote_agent_auth_verification`** - Better Auth tables for opt-in web login
  - **PostgreSQL only.** Always created on Postgres via the idempotent schema apply, but populated only when web auth is enabled (`DATABASE_URL` + `BETTER_AUTH_SECRET`)
  - Owned and shaped by Better Auth (text ids, camelCase columns); Archon never queries them directly — a session maps to the canonical `users` row via `user_identities('web', <betterAuthUserId>)`

## Migration List

| Migration | Description |
|-----------|-------------|
| `000_combined.sql` | Combined initial schema (use for fresh installs) |
| `001_initial_schema.sql` | Initial schema (codebases, conversations, sessions) |
| `002_command_templates.sql` | Command templates table |
| `003_add_worktree.sql` | Add worktree columns |
| `004_worktree_sharing.sql` | Worktree sharing support |
| `005_isolation_abstraction.sql` | Isolation abstraction layer |
| `006_isolation_environments.sql` | Isolation environments table |
| `007_drop_legacy_columns.sql` | Drop legacy worktree columns |
| `008_workflow_runs.sql` | Workflow runs table |
| `009_workflow_last_activity.sql` | Workflow last activity tracking |
| `010_immutable_sessions.sql` | Immutable session model |
| `011_partial_unique_constraint.sql` | Partial unique constraint |
| `012_workflow_events.sql` | Workflow events table |
| `013_conversation_titles.sql` | Conversation titles |
| `014_message_history.sql` | Message history table |
| `015_background_dispatch.sql` | Background dispatch support |
| `016_session_ended_reason.sql` | Session ended reason field |
| `017_drop_command_templates.sql` | Drop command templates table |
| `018_fix_workflow_status_default.sql` | Fix workflow status default value |
| `019_workflow_resume_path.sql` | Workflow resume path support |
| `020_codebase_env_vars.sql` | Per-project environment variables |
| `021_add_allow_env_keys_to_codebases.sql` | Allow-listed env keys per codebase |
| `022_workflow_node_sessions.sql` | Per-node provider session persistence |
| `023_add_default_branch_to_codebases.sql` | Detected default branch on codebases |

> The `remote_agent_codebases.kind` column (project `'repo'` | `'folder'` discriminator, commented "From migration 024"), the `remote_agent_users.role` column, and the four `remote_agent_auth_*` Better Auth tables (opt-in web login) are applied inline in `000_combined.sql` rather than as numbered migrations, and converge on startup via the idempotent schema apply.

### Workflow origin compatibility

Runs may have no conversation or user. New writers persist an `origin` object;
`{}` means no origin, while SQL NULL identifies legacy writers whose conversation,
parent and user columns supply the origin on read. The public run's `origin` and
conversation projections are nullable.

The SQL adapter reserves one hidden conversation, UUID
`00000000-0000-4000-8000-000000003640`, with platform `archon` and platform ID
`workflow-store-originless`, to satisfy the shipped conversation foreign key.
It is storage infrastructure: no message history, title, user or isolation state
belongs to it. Application conversation edits, deletion and history operations
reject this identity. Do not edit or delete it directly with SQL: deleting the
row would cascade to its runs.

An origin-free run has no session scope: it reads and writes no
`remote_agent_workflow_node_sessions` rows and no scope artifacts. A resume,
from the CLI or the server, runs it headless and records no conversation history.

Schema upgrades preserve shipped columns and older writers. Older binaries can
open and write the upgraded database, but may display the compatibility anchor
when reading an origin-free run.
