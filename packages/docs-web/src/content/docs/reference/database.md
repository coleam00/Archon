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

**For fresh installations**, run the combined migration:

```bash
psql $DATABASE_URL < migrations/000_combined.sql
```

**For updates to existing installations**, run only the migrations you haven't applied yet:

```bash
# Check which migrations you've already run, then apply new ones:
psql $DATABASE_URL < migrations/002_command_templates.sql
psql $DATABASE_URL < migrations/003_add_worktree.sql
psql $DATABASE_URL < migrations/004_worktree_sharing.sql
psql $DATABASE_URL < migrations/005_isolation_abstraction.sql
psql $DATABASE_URL < migrations/006_isolation_environments.sql
psql $DATABASE_URL < migrations/007_drop_legacy_columns.sql
psql $DATABASE_URL < migrations/008_workflow_runs.sql
psql $DATABASE_URL < migrations/009_workflow_last_activity.sql
psql $DATABASE_URL < migrations/010_immutable_sessions.sql
psql $DATABASE_URL < migrations/011_partial_unique_constraint.sql
psql $DATABASE_URL < migrations/012_workflow_events.sql
psql $DATABASE_URL < migrations/013_conversation_titles.sql
psql $DATABASE_URL < migrations/014_message_history.sql
psql $DATABASE_URL < migrations/015_background_dispatch.sql
psql $DATABASE_URL < migrations/016_session_ended_reason.sql
psql $DATABASE_URL < migrations/017_drop_command_templates.sql
psql $DATABASE_URL < migrations/018_fix_workflow_status_default.sql
psql $DATABASE_URL < migrations/019_workflow_resume_path.sql
psql $DATABASE_URL < migrations/020_codebase_env_vars.sql
```

## Local PostgreSQL via Docker

Use the `with-db` Docker Compose profile for automatic PostgreSQL setup.

Set in `.env`:

```ini
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent
```

**For fresh installations**, the database schema is created automatically when you start with `docker compose --profile with-db`. The combined migration runs on first startup.

**For updates to existing Docker installations**, you need to manually run new migrations:

```bash
# Connect to the running postgres container
docker compose exec postgres psql -U postgres -d remote_coding_agent

# Then run the migrations you haven't applied yet
\i /migrations/012_workflow_events.sql
\i /migrations/013_conversation_titles.sql
\i /migrations/014_message_history.sql
\i /migrations/015_background_dispatch.sql
\i /migrations/016_session_ended_reason.sql
\i /migrations/017_drop_command_templates.sql
\i /migrations/018_fix_workflow_status_default.sql
\i /migrations/019_workflow_resume_path.sql
\i /migrations/020_codebase_env_vars.sql
\q
```

Or from your host machine (requires `psql` installed):

```bash
psql postgresql://postgres:postgres@localhost:5432/remote_coding_agent < migrations/020_codebase_env_vars.sql
# ... and so on for each migration not yet applied
```

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

The database has 8 tables, all prefixed with `remote_agent_`:

1. **`remote_agent_codebases`** - Repository metadata
   - Commands stored as JSONB: `{command_name: {path, description}}`
   - AI assistant type per codebase
   - Default working directory

2. **`remote_agent_conversations`** - Platform conversation tracking
   - Platform type + conversation ID (unique constraint)
   - Linked to codebase via foreign key
   - AI assistant type locked at creation

3. **`remote_agent_sessions`** - AI session management
   - Active session flag (one per conversation)
   - Session ID for resume capability
   - Metadata JSONB for command context

4. **`remote_agent_isolation_environments`** - Worktree isolation
   - Tracks git worktrees per issue/PR
   - Enables worktree sharing between linked issues and PRs

5. **`remote_agent_workflow_runs`** - Workflow execution tracking
   - Tracks active workflows per conversation
   - Locks concurrent execution per `working_path`: a second dispatch on a path with an active run (status `pending`/`running`/`paused`) is auto-cancelled with an actionable message. Stale `pending` rows older than 5 minutes are treated as orphaned and ignored.
   - Stores workflow state, step progress, and parent conversation linkage

6. **`remote_agent_workflow_events`** - Step-level workflow event log
   - Records step transitions, artifacts, and errors per workflow run
   - Lean UI-relevant events (verbose logs stored in JSONL files)
   - Enables workflow run detail views and debugging

7. **`remote_agent_messages`** - Conversation message history
   - Persists user and assistant messages with timestamps
   - Stores tool call metadata (name, input, duration) in JSONB
   - Enables message history in Web UI across page refreshes

8. **`remote_agent_codebase_env_vars`** - Per-project env vars for workflow execution
   - Key-value pairs scoped to a codebase
   - Injected into Claude SDK subprocess environment at execution time
   - Managed via Web UI Settings panel; `env:` in `.archon/config.yaml` for CLI users

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
