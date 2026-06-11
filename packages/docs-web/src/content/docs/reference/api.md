---
title: API Reference
description: REST API endpoints for programmatic access to Archon.
category: reference
area: server
audience: [developer]
sidebar:
  order: 6
---

Archon exposes a REST API via a [Hono](https://hono.dev/) server with OpenAPI spec generation. All endpoints are prefixed with `/api/`.

## Base URL

By default, the API server runs at:

```
http://localhost:3090/api/
```

Override the port with the `PORT` environment variable or let Archon auto-allocate when running inside a worktree (range 3190-4089).

## OpenAPI Specification

A machine-readable OpenAPI 3.0 spec is available at:

```
GET /api/openapi.json
```

You can feed this into tools like Swagger UI or use it to generate typed API clients.

## Authentication

None. Archon is a single-developer tool -- there is no authentication on the API by default. If you expose Archon on a network, use a reverse proxy or firewall to restrict access.

---

## Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Basic health check |
| GET | `/api/health` | API-level health check |

```bash
curl http://localhost:3090/health
# {"status":"ok"}

curl http://localhost:3090/api/health
# {"status":"ok","adapter":"...","concurrency":{...},"runningWorkflows":0}
```

---

## Conversations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/conversations` | List conversations |
| GET | `/api/conversations/{id}` | Get a single conversation |
| POST | `/api/conversations` | Create a new conversation |
| PATCH | `/api/conversations/{id}` | Update a conversation (rename) |
| DELETE | `/api/conversations/{id}` | Soft-delete a conversation |
| GET | `/api/conversations/{id}/messages` | List messages in a conversation |
| POST | `/api/conversations/{id}/message` | Send a message to a conversation |

### List Conversations

```bash
curl http://localhost:3090/api/conversations
```

Query parameters:
- `codebase_id` (optional) -- Filter by codebase
- `include_deleted` (optional) -- Include soft-deleted conversations

### Create a Conversation

```bash
curl -X POST http://localhost:3090/api/conversations \
  -H "Content-Type: application/json" \
  -d '{}'
```

Optionally specify a codebase:

```bash
curl -X POST http://localhost:3090/api/conversations \
  -H "Content-Type: application/json" \
  -d '{"codebase_id": "your-codebase-id"}'
```

Returns the created conversation with its `platform_conversation_id`.

### Send a Message

```bash
curl -X POST http://localhost:3090/api/conversations/{id}/message \
  -H "Content-Type: application/json" \
  -d '{"message": "What does this codebase do?"}'
```

The message is dispatched to the orchestrator asynchronously. The response confirms dispatch -- actual AI responses arrive via SSE streaming or can be polled via the messages endpoint.

### Get Messages

```bash
curl http://localhost:3090/api/conversations/{id}/messages
```

Query parameters:
- `limit` (optional) -- Number of messages to return
- `before` (optional) -- Cursor for pagination

### Update a Conversation

```bash
curl -X PATCH http://localhost:3090/api/conversations/{id} \
  -H "Content-Type: application/json" \
  -d '{"title": "My feature discussion"}'
```

### Delete a Conversation

```bash
curl -X DELETE http://localhost:3090/api/conversations/{id}
```

Performs a soft delete -- the conversation is hidden but not destroyed.

---

## Codebases

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/codebases` | List registered codebases |
| GET | `/api/codebases/{id}` | Get a single codebase |
| POST | `/api/codebases` | Register a codebase (clone or local path) |
| DELETE | `/api/codebases/{id}` | Delete a codebase and clean up resources |
| GET | `/api/codebases/{id}/environments` | List isolation environments for a codebase |

### List Codebases

```bash
curl http://localhost:3090/api/codebases
```

### Register a Codebase

Clone from a URL:

```bash
curl -X POST http://localhost:3090/api/codebases \
  -H "Content-Type: application/json" \
  -d '{"url": "https://github.com/user/repo"}'
```

Register a local path:

```bash
curl -X POST http://localhost:3090/api/codebases \
  -H "Content-Type: application/json" \
  -d '{"path": "/home/user/projects/my-repo"}'
```

### Delete a Codebase

```bash
curl -X DELETE http://localhost:3090/api/codebases/{id}
```

Removes the codebase registration and cleans up associated worktrees and isolation environments.

### List Environments

```bash
curl http://localhost:3090/api/codebases/{id}/environments
```

Returns the isolation environments (worktrees) associated with a codebase.

---

## Workflows

### Definitions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/workflows` | List available workflows |
| GET | `/api/workflows/{name}` | Get a single workflow definition |
| POST | `/api/workflows/validate` | Validate a workflow definition (in-memory, no save) |
| PUT | `/api/workflows/{name}` | Save (create or update) a workflow |
| DELETE | `/api/workflows/{name}` | Delete a user-defined workflow |

#### List Workflows

```bash
curl http://localhost:3090/api/workflows
```

Query parameters:
- `cwd` (optional) -- Working directory to discover project-specific workflows

When `cwd` is omitted, Archon returns bundled default workflows and any from `~/.archon/workflows/` (home-scoped). Project-specific workflows require either the `cwd` query param or a registered codebase, so the endpoint is useful on first launch before any project is registered.

Returns `{ workflows: [...], errors?: [...] }`. The `errors` array contains any YAML parsing failures encountered during discovery.

#### Get a Workflow

```bash
curl http://localhost:3090/api/workflows/archon-assist
```

Query parameters:
- `cwd` (optional) -- Working directory for project-specific lookup

Returns `{ workflow, filename, source: "project" | "global" | "bundled" }`. The endpoint auto-discovers across all three scopes in order (project → home-scoped → bundled). `source: "global"` is returned when the workflow comes from `~/.archon/workflows/`.

#### Validate a Workflow

```bash
curl -X POST http://localhost:3090/api/workflows/validate \
  -H "Content-Type: application/json" \
  -d '{"definition": {"name": "my-wf", "description": "Test", "nodes": [{"id": "a", "prompt": "hello"}]}}'
```

Returns `{ valid: true }` or `{ valid: false, errors: ["..."] }`. Does not save anything.

#### Save a Workflow

```bash
curl -X PUT http://localhost:3090/api/workflows/my-workflow \
  -H "Content-Type: application/json" \
  -d '{"definition": {"name": "my-workflow", "description": "My custom workflow", "nodes": [{"id": "plan", "prompt": "Plan the feature"}]}}'
```

Query parameters:
- `cwd` (optional) -- Target directory (must have `.archon/workflows/`)
- `source` (optional, enum: `project` \| `global`) -- Scope to write the workflow to. Defaults to `project` (writes to `<cwd>/.archon/workflows/`). Pass `source=global` to write to the home-scoped location (`~/.archon/workflows/`). Returns `400 "Invalid workflow source"` if any other value is supplied.

Validates the definition before saving. Returns the saved workflow.

#### Delete a Workflow

```bash
curl -X DELETE http://localhost:3090/api/workflows/my-workflow
```

Query parameters:
- `cwd` (optional) -- Target directory (must have `.archon/workflows/`)
- `source` (optional, enum: `project` \| `global`) -- Scope to delete from. Defaults to `project`. Pass `source=global` to delete from `~/.archon/workflows/`. Returns `400 "Invalid workflow source"` if any other value is supplied.

Only user-defined workflows can be deleted. Bundled defaults cannot be removed.

### Runs

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/workflows/{name}/run` | Run a workflow (JSON or multipart) |
| GET | `/api/workflows/runs` | List workflow runs |
| GET | `/api/workflows/runs/{runId}` | Get run details with events |
| GET | `/api/runs/{runId}/artifacts` | List artifact files produced by a run |
| GET | `/api/workflows/runs/by-worker/{platformId}` | Look up a run by worker conversation ID |
| POST | `/api/workflows/runs/{runId}/cancel` | Cancel a running workflow |
| POST | `/api/workflows/runs/{runId}/resume` | Resume a failed workflow |
| POST | `/api/workflows/runs/{runId}/abandon` | Abandon a non-terminal run |
| POST | `/api/workflows/runs/{runId}/approve` | Approve a paused workflow |
| POST | `/api/workflows/runs/{runId}/reject` | Reject a paused workflow |
| DELETE | `/api/workflows/runs/{runId}` | Delete a terminal run and its events |

#### Run a Workflow

```bash
# JSON (no attachments)
curl -X POST http://localhost:3090/api/workflows/archon-assist/run \
  -H "Content-Type: application/json" \
  -d '{"message": "Explain the auth module", "conversationId": "conv-123"}'

# multipart (with file attachments — max 5 files, ≤10 MB each)
curl -X POST http://localhost:3090/api/workflows/archon-assist/run \
  -F "conversationId=conv-123" \
  -F "message=Investigate this trace" \
  -F "files=@stacktrace.txt" \
  -F "files=@screenshot.png"
```

#### List Run Artifacts

```bash
curl http://localhost:3090/api/runs/{runId}/artifacts
```

Walks the run's on-disk artifact directory (dotfiles skipped) and returns `{ files: [{ path, size, modifiedAt }] }`. Used by the console UI's Artifacts tab. Returns `{ files: [] }` when the run has no codebase or the codebase name is not in `owner/repo` form; 400 on invalid run id or path-escape attempt, 404 if the run does not exist.

#### Resume a Failed Run

```bash
curl -X POST http://localhost:3090/api/workflows/runs/{runId}/resume
```

Resumes the workflow from where it left off, skipping already-completed nodes. Equivalent to `archon workflow resume <run-id>` from the CLI. Plain `archon workflow run <name>` invocations never resume implicitly.

#### Approve / Reject a Paused Run

```bash
# Approve (optionally with a comment)
curl -X POST http://localhost:3090/api/workflows/runs/{runId}/approve \
  -H "Content-Type: application/json" \
  -d '{"comment": "Looks good, proceed"}'

# Reject (optionally with a reason)
curl -X POST http://localhost:3090/api/workflows/runs/{runId}/reject \
  -H "Content-Type: application/json" \
  -d '{"reason": "Please add error handling first"}'
```

---

## Commands

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/commands` | List available command names |

```bash
curl http://localhost:3090/api/commands
```

Query parameters:
- `cwd` (optional) -- Working directory for project-specific commands

Returns `{ commands: [{ name, source: "bundled" | "project" }] }`.

---

## Dashboard

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/dashboard/runs` | List enriched workflow runs for the dashboard |

Query parameters include status filters, date ranges, and pagination. Used by the Command Center UI.

---

## Configuration

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Get read-only configuration (safe subset) |
| PATCH | `/api/config/assistants` | Update the default assistant and per-provider model defaults |
| PATCH | `/api/config/tiers` | Update model-tier presets (`small`/`medium`/`large`) |
| PATCH | `/api/config/aliases` | Update `@custom` model aliases (per-key merge; `null` unsets) |
| GET | `/api/providers/pi/models` | Pi's model catalog (cost/reasoning metadata; best-effort, `[]` on failure) |

`GET /api/config` returns the safe config subset, now including the configured `tiers`, the built-in `tierDefaults` for the current default provider (what an unset tier resolves to), and the configured `aliases`.

These config routes are **ungated** -- they write non-secret model config to `~/.archon/config.yaml` and work on solo installs (no `TOKEN_ENCRYPTION_KEY` required). Contrast with the [AI Provider Credentials](#ai-provider-credentials) routes below, which require an identity.

```bash
# Read current config (includes `tiers` + `tierDefaults`)
curl http://localhost:3090/api/config

# Set the default assistant
curl -X PATCH http://localhost:3090/api/config/assistants \
  -H "Content-Type: application/json" \
  -d '{"assistant": "claude"}'

# Or update per-provider model defaults
curl -X PATCH http://localhost:3090/api/config/assistants \
  -H "Content-Type: application/json" \
  -d '{"assistants": {"claude": {"model": "opus"}}}'

# Set a model tier (a `null` tier value unsets it, falling back to the built-in default)
curl -X PATCH http://localhost:3090/api/config/tiers \
  -H "Content-Type: application/json" \
  -d '{"tiers": {"large": {"provider": "claude", "model": "opus"}}}'

# Set a @custom alias (a `null` value unsets it)
curl -X PATCH http://localhost:3090/api/config/aliases \
  -H "Content-Type: application/json" \
  -d '{"aliases": {"@fast": {"provider": "claude", "model": "haiku"}}}'
```

---

## Per-User AI Preferences

Each user can override the install-wide model config with **personal** tiers, `@custom` aliases, and a default assistant — the highest-precedence resolver layer, applied to runs and chats *they* start. These routes require a resolved web identity (`X-Archon-User` header or a Better Auth session) but **no** `TOKEN_ENCRYPTION_KEY` — model names aren't secrets. Without an identity they return `401`, and model resolution stays config-only (solo installs are unchanged).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/me/ai-prefs` | The current user's stored prefs (raw layer, not merged) |
| PATCH | `/api/auth/me/ai-prefs/tiers` | Update personal tier presets (per-key merge; `null` unsets) |
| PATCH | `/api/auth/me/ai-prefs/aliases` | Update personal `@custom` aliases (per-key merge; `null` unsets) |
| PATCH | `/api/auth/me/ai-prefs/default` | Set (or clear with `null`) the personal default assistant |

```bash
# Point YOUR `large` tier at opus without touching the install config
curl -X PATCH http://localhost:3090/api/auth/me/ai-prefs/tiers \
  -H "X-Archon-User: your-user-id" \
  -H "Content-Type: application/json" \
  -d '{"tiers": {"large": {"provider": "claude", "model": "opus"}}}'
```

All writes validate the provider (registered), effort (provider vocabulary), and alias names (`@` prefix, not a reserved tier keyword), and return the updated prefs. The console exposes the same scopes as the **"This install / Just me"** toggle on AI Settings; the CLI as `archon ai … --scope user`.

---

## AI Provider Credentials

Per-user provider credentials let each user bill their runs and chats to **their own** API key or subscription instead of the shared install key. Unlike the config routes above, these endpoints are **gated**: they require `TOKEN_ENCRYPTION_KEY` (a 64-char hex secret) to be set *and* a resolved web identity (the `X-Archon-User` header, or a Better Auth session). On a solo install with no `TOKEN_ENCRYPTION_KEY`, `GET /api/auth/providers` returns `enabled: false` and the write routes return `404`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/providers` | List the current user's connected credentials (metadata only) |
| PUT | `/api/auth/providers/{provider}` | Connect (upsert) an API key for a provider |
| DELETE | `/api/auth/providers/{provider}` | Disconnect a provider credential (idempotent) |
| POST | `/api/auth/providers/{provider}/oauth/start` | Begin a subscription (OAuth) login |
| POST | `/api/auth/providers/{provider}/oauth/poll` | Poll a subscription login session |

Credentials are encrypted at rest; **no endpoint ever returns a secret value** -- responses carry only `provider`/`kind`/`label` metadata.

### List Connected Providers

```bash
curl http://localhost:3090/api/auth/providers \
  -H "X-Archon-User: your-user-id"
```

Returns `{ enabled, connections: [{ provider, kind, label }], available, subscriptionAvailable }`:
- `available` -- every provider id you can connect an API key for.
- `subscriptionAvailable` -- the subset that supports subscription (OAuth) login: **`claude`** and **`copilot`**. (`codex` is API-key-only; its subscription path is gated -- see [#1924](https://github.com/coleam00/Archon/issues/1924).)

### Connect an API Key

```bash
curl -X PUT http://localhost:3090/api/auth/providers/openrouter \
  -H "X-Archon-User: your-user-id" \
  -H "Content-Type: application/json" \
  -d '{"apiKey": "sk-...", "label": "personal"}'
```

Returns `{ success, provider, kind: "api_key", label }`. An unknown provider or a blank key returns `400`.

### Disconnect a Provider

```bash
curl -X DELETE http://localhost:3090/api/auth/providers/openrouter \
  -H "X-Archon-User: your-user-id"
```

Idempotent -- disconnecting a provider that was never connected still returns `{ success: true }`.

### Subscription Login (OAuth)

Subscription login is a two-step `start` -> `poll` flow held server-side. `start` returns a `mode`:
- `manual` (Claude) -- show the returned `url`; the user authorizes in a browser and pastes the resulting code back via `poll`.
- `device` (Copilot) -- show `userCode` + `verificationUri`; `poll` until connected.

```bash
# 1. Start a login session
curl -X POST http://localhost:3090/api/auth/providers/claude/oauth/start \
  -H "X-Archon-User: your-user-id"
# {"sessionId":"...","mode":"manual","url":"https://...","expiresIn":600}

# 2. Poll (pass the pasted `code` once, for manual flows)
curl -X POST http://localhost:3090/api/auth/providers/claude/oauth/poll \
  -H "X-Archon-User: your-user-id" \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "...", "code": "the-pasted-code"}'
# {"status":"connected"}
```

`poll` returns `{ status: "pending" | "connected" | "error", detail? }`. A provider that does not support subscription login returns `400` on `start`.

The CLI equivalent of this whole surface is [`archon ai`](/reference/cli/#ai). For the end-to-end setup walkthrough, see [Per-user credentials and AI Settings](/getting-started/ai-assistants/#per-user-credentials-and-ai-settings).

---

## System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/update-check` | Check for available updates (binary builds only) |

Returns `{ updateAvailable, currentVersion, latestVersion, releaseUrl }`. For non-binary (source) builds, always returns `updateAvailable: false` without making external requests.

---

## SSE Streaming

| Path | Description |
|------|-------------|
| `/api/stream/{conversationId}` | Real-time events for a conversation |
| `/api/stream/__dashboard__` | Multiplexed workflow events across all conversations |

These are Server-Sent Events (SSE) endpoints -- connect with `EventSource` in a browser or any SSE client.

```bash
# Listen to a conversation stream
curl -N http://localhost:3090/api/stream/your-conversation-id
```

Events are JSON-encoded with a `type` field. See the [Web UI documentation](/adapters/web/#sse-streaming) for the full list of event types.

---

## Common Patterns

### Create a Conversation and Send a Message

```bash
# 1. Create a conversation
CONV_ID=$(curl -s -X POST http://localhost:3090/api/conversations \
  -H "Content-Type: application/json" \
  -d '{}' | jq -r '.platform_conversation_id')

# 2. Send a message
curl -X POST http://localhost:3090/api/conversations/$CONV_ID/message \
  -H "Content-Type: application/json" \
  -d '{"message": "/status"}'

# 3. Poll for messages
curl http://localhost:3090/api/conversations/$CONV_ID/messages
```

### Run a Workflow via the API

```bash
# 1. Create a conversation scoped to a codebase
CONV_ID=$(curl -s -X POST http://localhost:3090/api/conversations \
  -H "Content-Type: application/json" \
  -d '{"codebase_id": "your-codebase-id"}' | jq -r '.platform_conversation_id')

# 2. Start the workflow
curl -X POST http://localhost:3090/api/workflows/archon-assist/run \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"How does auth work?\", \"conversationId\": \"$CONV_ID\"}"

# 3. Monitor via SSE
curl -N http://localhost:3090/api/stream/$CONV_ID
```
