---
title: Database
description: Persistence selection and database setup for files, SQLite, and PostgreSQL.
category: reference
area: database
audience: [developer, operator]
status: current
sidebar:
  order: 5
---

Archon supports two database backends: **SQLite** (default, zero setup) and **PostgreSQL** (optional, for cloud/advanced deployments). The database backend is selected automatically based on whether the `DATABASE_URL` environment variable is set.

## File storage for CLI workflows

Database storage remains the default. For a CLI-only install, opt into file storage in
`~/.archon/config.yaml` (or `$ARCHON_HOME/config.yaml`):

```yaml
store: files
```

Use `store: database` or remove the key to return to database storage. `DATABASE_URL`
together with `store: files` is refused because it selects two stores. Switching stores
starts a separate, empty history; Archon does not import existing data. Returning to the
previous store reveals its existing history again.

File storage supports workflow runs, approval, resume, events, node sessions, codebases
and isolation records without creating `archon.db`. It stores records under
`$ARCHON_HOME/store`:

```text
head.json                format version and commit sequence
intent.json              pending commit, present during writes or crash recovery
feed-index.json          derived latest event commit per run, rebuilt from logs when missing
runs/<id>/log.jsonl       append-only run records, events and event retractions
runs/<id>/run.json        derived snapshot, rebuilt when missing or behind the log
archived-runs/<id>/log.jsonl  retained feed log after run deletion
runs/<id>/node-sessions.json
node-sessions/<hash>.json
state/<document-hash>/name.json scope and document name
state/<document-hash>/<revision>.json immutable state revisions
host/codebases.json       project records with per-project envVars
host/isolation.json       isolation records
host/users.json           trigger run-as identities
resource/slots/<hash>.json resource capacity, holders and FIFO request IDs
resource/requests/<hash>.json prepared start requests
resource/receipts/<hash>.json receipts and preparation ownership
resource/deliveries/<hash>.json delivery deduplication identities
```

Every write uses one store-wide lock and a recoverable intent. The next writer or a
reader that sees an intent redoes the committed operation exactly once. A torn final
log line is ignored by readers and truncated only under the lock by the next writer.
Committed lines are never rewritten; cancellation recovery appends event retractions.
File-store run IDs are unique for the store's lifetime: creating a run with an ID
already held by a live or archived run fails, including caller-reserved IDs.

Run cleanup transfers a terminal run's log to `archived-runs` before removing its
current-state directory. The event feed reads its derived index to find changed
runs, then reads their live or archived logs. Writers update the index
under the same lock before publishing the head; a missing or stale index is rebuilt
from the logs.

Use a local filesystem that supports hard links. Network filesystems are unsupported.
The lock records its host, PID and process instance. Archon breaks it only when its owner
is provably gone. A live or unprovable owner produces `FileStoreLockHeldError` with the
owner and path. Inspect the named process before manually removing a lock. A stranded
`lock.break` needs operator inspection; time alone never proves ownership has ended.
An owner record whose PID is not a positive integer, in the lock or in a resource-slot
holder, fails the operation with `ProcessOwnerRecordError` naming its source; it is never
read as a dead owner. `archon ai capacity` lists such a provider-attempt holder with the
error, and `archon ai capacity release <attempt-id>` removes it. Each operation under the store lock removes `.lock-*` and
`.probe-*` scratch files left by a crashed process once their owner is provably gone.
New scratch names carry owner identity, allowing cleanup even when a crash leaves empty
or torn contents. Older UUID-only scratch files still require readable owner contents;
unreadable legacy residue stays and logs a warning on each locked operation.

The intent and file synchronization protect against process crashes. Power-loss durability
is limited by the platform's `fsync` guarantees; macOS does not force drive caches with
`fsync`, and Windows does not support directory `fsync` through this API.

Triggers work with file storage: `archon trigger whoami` records a local run-as identity,
and timer fire, admission, queueing, inspection and drain use the file store. Admission
commits the run, request and resource holder together. A terminal or missing run releases
its slot, and so does a run paused at a host-continued wait or gate. A run paused because
its source is unreadable keeps its slot, including while waiting for a host that can read it.
A wait or gate resume takes a slot again ahead of queued requests. When a resume of a run whose wait is due or
signaled, or whose pause is answered, is refused, the run records `capacity_wait` and
waits; a refused early resume records nothing.
Failed-run resume respects live holders, those waiting runs and queued requests.

The server refuses file storage because its routes read SQL. Provider concurrency caps
(`concurrency.providers`) require `store: database` and fail at startup.
Per-user GitHub identity (`GITHUB_APP_ID` with `TOKEN_ENCRYPTION_KEY`) fails at startup under
file storage, because files hold no user tokens and a run would otherwise use the shared
token. A GitHub App without `TOKEN_ENCRYPTION_KEY` works. Per-user provider credential
mode does not prevent selecting file storage. File-store runs never read or deliver stored
per-user provider credentials. Preflight checks environment credentials and the provider's
own login, including when the CLI supplies a user identity. State documents (`archon state`)
use the selected store. Files keep immutable JSON revisions under `state/<document-hash>/<revision>.json`, with a `name.json` record
containing the scope and name. Writes publish through the store-wide lock and recovery
intent. `workflow cleanup` removes old revisions while keeping each document's latest
revision, including tombstones. User and stored credential management still require
database storage.

## SQLite (Default - No Setup Required)

With `store: database` (the default), **leave `DATABASE_URL` unset** in your shell and Archon's environment files. The app will automatically:
- Create a SQLite database at `~/.archon/archon.db`
- Initialize the schema on first run and skip startup writes when its completion proof is current
- Use this database for operations with `store: database`

**Pros:**
- Zero configuration required
- No external database needed
- Perfect for single-user CLI usage

**Cons:**
- Not suitable for multi-container deployments
- No network access (CLI and server can't share database across different hosts)

Every Archon process on a machine shares one SQLite file, and SQLite lets one writer at a
time hold its lock. When another process holds the lock past the 5-second busy timeout,
replayable operations keep waiting instead of failing: a single statement retries, and a
transaction rolls back and reruns from the start, with a growing pause of up to 2 seconds between
attempts. There is no deadline, so a run whose write is waiting stays alive until the lock
clears. While it waits, Archon logs `db.sqlite_busy_waiting` at warn level every 30
seconds. A repeating warning points at a process that is holding the lock. Other SQLite
errors still fail right away. Schema convergence uses the same retry policy during
synchronous database open (`operation: 'open'`); a needed upgrade waits for the writer
before the constructor returns.

Worktree cleanup first claims the registration with a short write that records the
removing process in its metadata (`worktree_removal_owner`). Git and filesystem
removal then run with no database transaction open. A second short write retires the
registration after success, or releases the claim after a failure, leaving the
registration active and the error reported. While a claim is held, a same-workflow
registration, adoption, and a run start in that checkout are refused. A claim whose
process has exited on this host is released by the next write that meets it; one from
another host stays until an operator removes the key from the environment's metadata.

Cleanup's claim holds registration exclusion through local checkout and branch removal.
Completion and merged cleanup retain remote branches with a warning, including
with force, because registration ownership cannot be proved after the claim
commits. Enable GitHub's
**Automatically delete head branches** setting for merged pull requests, or follow [manual remote branch recovery](/reference/cli/#recovering-remote-branch-cleanup).

## Remote PostgreSQL (Supabase, Neon, etc.)

Set your remote connection string in `~/.archon/.env` for user-wide settings or `<cwd>/.archon/.env` for project overrides. A target repository's `<cwd>/.env` is stripped at startup. See [environment file locations and load order](/reference/configuration/#env-file-locations) for precedence and the source-server exception. For Docker, use the [Compose `.env` file](/deployment/docker/#configure-env).

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
  - `kind` (`'repo'` | `'folder'`, default `'repo'`) discriminates repo projects with Archon-managed git from folder projects (which run in place without managed git machinery, whether or not the directory has git)
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
  - Guards concurrent execution per `working_path`: direct executor dispatch on a path with an active run (status `pending`/`running`/`paused`) is auto-cancelled with an actionable message. Workflows declaring `mutates_checkout: false` bypass this executor guard. [Trigger admission](/guides/workflow-triggers/#choose-a-resource-capacity-and-overlap-policy) queues or skips guarded starts on held paths according to `overlap`, including paths held by manual runs or other resources. Read-only starts may proceed beside foreign holders; same-resource checkout serialization still applies. Pending rows older than 5 minutes are ignored by the path guard without changing their lifecycle state. A `workflow:` sub-run shares its parent's checkout unless the node declares `isolation: worktree`, so the path-lock excludes both the run's ancestor chain and its descendants (via `parent_run_id`) — a child never contends with its own parent. Children of the same `fan_out` node share the checkout by design, so the lock also excludes them, their descendants, and the fan-out siblings of each ancestor; each such pair is recorded as `workflow.checkout_shared` events. Other runs on the path, including children of a different node, still contend.
  - Stores workflow state, step progress, and parent conversation linkage
  - Nullable `user_id` records which user triggered the run
  - Nullable `parent_run_id` (#2121 Phase 2) — self-referential FK (`ON DELETE SET NULL`) linking a `workflow:` sub-run to the run that spawned it; null for top-level runs. Makes the run tree walkable (`findChildRuns`/`getRunAncestry`) for the abandon cascade and cost roll-up.
  - `conversation_id` cascades on conversation delete: a hard `DELETE` of a conversation would erase its run rows and silently drop the live-run cleanup pin for their isolation environments (#2868). Soft delete is the only supported path — a future hard-delete must resolve live runs first.

- **`remote_agent_workflow_events`** - Step-level workflow event log; see [node execution records](/reference/node-execution/) for payloads and resume compatibility
  - Records step transitions, artifacts, and errors per workflow run
  - Every provider event a workflow node streams, as `provider_event` rows: the engine envelope (`attemptId`, `seq`, `observedAt`, `event`) in `data`, the node in `step_name`. The same envelope is a `provider_event` line in the run's JSONL log. `GET /api/workflows/runs/{runId}/provider-events` serves them; the run-detail route leaves them out
  - Enables workflow run detail views and debugging
  - On PostgreSQL, `event_order` follows commit order: a row committed later always has a higher value. A deferred constraint trigger (`archon_workflow_event_order`) assigns it at commit while holding an advisory lock, so committing event writers draw values one at a time. Both SQL dialects retain the committed head in `remote_agent_workflow_event_sequence`, so event or run deletion never moves it backwards. PostgreSQL draws from its non-reusing sequence; SQLite increments the high-water row under its single writer
  - Within one process, a run's standalone event writes (those not part of a larger transaction) go to the database one at a time, in the order they are issued, so they commit and read back in that order. Writes for the same run from two processes (for example the CLI and the server) are not ordered against each other
  - The dashboard event poller follows the store's commit-ordered event feed (`event_order`) across all runs. On PostgreSQL an `AFTER INSERT` trigger (`archon_workflow_event_notify`) calls `pg_notify('archon_dashboard_event', …)` so runs started out of process (the `archon` CLI / `--detach`) stream live to the console; on SQLite the poller picks them up within its interval. The trigger is Postgres-only and best-effort (a role without `CREATE TRIGGER` degrades to poll-only, not a boot failure).
  - A `BEFORE DELETE` trigger copies each deleted row into `remote_agent_workflow_event_archive`, which has the same columns and no run foreign keys, so cursors saved before a deletion can still read the payload. Schema apply adds any column the events table gains to the archive as well

- **`remote_agent_workflow_event_sequence`** - Single-row high-water mark of committed `event_order` values; it never moves backwards when events or runs are deleted

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
  - `role` (`VARCHAR`, default `'admin'`) stores `admin` or `member`. Archon explicitly writes `member` when creating a user. The database default stays `admin` for older binaries; upgrading preserves every existing user's role. Operators manage roles with [`archon user`](/reference/cli/#user). Only a run's starter or an admin can act on it; see [Who can act on a run](/reference/security/#who-can-act-on-a-run). Existing multi-user installs remain unprotected until the operator demotes users who should not be admins

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

- **`remote_agent_web_push_subscriptions`** - Browsers opted in to run-attention Web Push
  - One row per browser endpoint (`UNIQUE(endpoint)`), owned by the user who enabled it and cascaded on user deletion; only that owner can delete it
  - Stores the endpoint and its encryption keys; every row on the install receives notices, and the attention router removes rows the push service reports as expired (404/410)

- **`remote_agent_schema_version`** - Schema vintage and completion metadata
  - Records the Archon build that created the database and the build that last applied its schema
  - A single row (`id = 1`); databases predating this table retain an unknown creation version
  - Nullable `schema_fingerprint` is separate, adapter-owned completion metadata. SQLite publishes it only after successful convergence; PostgreSQL reserves the same column. Older writers can omit it

- **`remote_agent_state_revisions`** - Durable project and install JSON documents and their audit history
  - Primary key: `(project_key, name, revision)`; optimistic writes append a revision
  - Full JSON value (up to 64 KiB), operation, writer identity or run/node, and creation time
  - SQL `NULL` value is a tombstone; run IDs have no foreign key so run cleanup preserves state

- **`remote_agent_start_receipts`** - Source delivery receipts
  - Records source instance, delivery ID, content digest, timestamps, and matching outcome
  - Deduplicates deliveries by `(source_instance_id, delivery_id)` when the source supplies a delivery ID; `delivery_id` is nullable, and the unique constraint does not deduplicate receipts without one

- **`remote_agent_start_receipt_bindings`** - Per-binding preparation state for a source receipt
  - Keyed by `(receipt_id, binding_id)`; deleted with the owning receipt
  - Tracks binding revision, host, intent, preparation status, owner, and error
  - `event_input_names` lists which of the intent's inputs came from the source event; preparation passes those only to a workflow that declares them

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

## Schema initialization and upgrades

The PostgreSQL adapter applies `migrations/000_combined.sql` idempotently on startup
for both fresh installs and upgrades. SQLite initializes its schema
in `packages/core/src/db/adapters/sqlite.ts` and upgrades it in
`packages/core/src/db/adapters/sqlite-migrations.ts`. Neither adapter uses a numbered
migration runner or migration ledger.

SQLite first checks its completion fingerprint in a read snapshot. It covers the schema
DDL and migration steps a convergence executes (comments and layout excluded), the Archon
build, and the SQLite schema counter; pending legacy credentials or
a missing/behind event-sequence head also require repair. A current database opens without
taking the writer lock. Otherwise, a single writer transaction rechecks, converges, and
publishes the fingerprint atomically. Schema changes invalidate the proof; ordinary event
inserts do not. Failed tolerated migrations leave no completion stamp and are retried on
the next open. Diagnostic creation and applied-build vintages keep their existing meanings.

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

## Store event feed

Every workflow store exposes `getWorkflowEventHead()` and `readWorkflowEventsAfter(cursor, { limit, eventTypes? })`. The feed covers all runs in commit order. A page carries each event with its opaque cursor and a `next` cursor that also advances past rows excluded by the type filter. Pass cursors back unchanged; only the issuing store interprets them. A malformed cursor or one from a different store kind throws `WorkflowEventCursorError`.

Start at the head to follow new commits, or resume from a cursor saved by an earlier read. This feed observes committed events; it does not report retractions or undo deliveries when fan-out recovery or cleanup removes events. Earlier cursors can still read those payloads: SQL deletion triggers retain them in a feed archive without run foreign keys, and the file store retains deleted run logs. Feed history has no expiry and is retained for the store's lifetime. `getWorkflowRun` and `listWorkflowEvents` remain the current state of record. File-store reads at the head are cheap; reads with new commits use the derived feed index to select run logs.
