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

Returns `{ workflows: [...], errors?: [...] }`. The `errors` array contains any YAML parsing failures encountered during discovery.

#### Get a Workflow

```bash
curl http://localhost:3090/api/workflows/archon-assist
```

Query parameters:
- `cwd` (optional) -- Working directory for project-specific lookup

Returns `{ workflow, filename, source: "project" | "bundled" }`.

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

Validates the definition before saving. Returns the saved workflow.

#### Delete a Workflow

```bash
curl -X DELETE http://localhost:3090/api/workflows/my-workflow
```

Only user-defined workflows can be deleted. Bundled defaults cannot be removed.

### Runs

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/workflows/{name}/run` | Run a workflow |
| GET | `/api/workflows/runs` | List workflow runs |
| GET | `/api/workflows/runs/{runId}` | Get run details with events |
| GET | `/api/workflows/runs/by-worker/{platformId}` | Look up a run by worker conversation ID |
| POST | `/api/workflows/runs/{runId}/cancel` | Cancel a running workflow |
| POST | `/api/workflows/runs/{runId}/resume` | Resume a failed workflow |
| POST | `/api/workflows/runs/{runId}/abandon` | Abandon a non-terminal run |
| POST | `/api/workflows/runs/{runId}/approve` | Approve a paused workflow |
| POST | `/api/workflows/runs/{runId}/reject` | Reject a paused workflow |
| DELETE | `/api/workflows/runs/{runId}` | Delete a terminal run and its events |

#### Run a Workflow

```bash
curl -X POST http://localhost:3090/api/workflows/archon-assist/run \
  -H "Content-Type: application/json" \
  -d '{"message": "Explain the auth module", "conversationId": "conv-123"}'
```

#### Resume a Failed Run

```bash
curl -X POST http://localhost:3090/api/workflows/runs/{runId}/resume
```

Marks the run for auto-resume. The next invocation re-runs the workflow, skipping already-completed nodes.

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
| PATCH | `/api/config/assistants` | Update assistant configuration |

```bash
# Read current config
curl http://localhost:3090/api/config

# Update assistant defaults
curl -X PATCH http://localhost:3090/api/config/assistants \
  -H "Content-Type: application/json" \
  -d '{"claude": {"model": "opus"}}'
```

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
