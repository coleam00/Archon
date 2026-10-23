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

Authentication is optional for a local or trusted solo install. When Web authentication is enabled, the API requires a Better Auth session or a trusted proxy identity unless `ARCHON_WEB_AUTH_REQUIRED=false`. The `/api/auth/` and `/api/health` surfaces are exempt from that general gate, but per-user endpoints still require an identity.

The trusted identity header defaults to `X-Archon-User` and can be changed with `ARCHON_WEB_AUTH_HEADER`. Bind the server to loopback (`HOST=127.0.0.1`) or keep the app port reachable only through a trusted reverse proxy. The proxy must strip client-supplied identity headers. If the proxy supplies an identity header, it must set that value only from an authenticated identity. For network deployments, see the [reverse-proxy deployment guide](/deployment/reverse-proxy/#authentication-and-headers).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/status` | Read Web auth availability and signup posture (no identity required) |
| GET | `/api/auth/github` | Read the current user's GitHub connection status |
| DELETE | `/api/auth/github` | Disconnect the current user's GitHub identity |
| POST | `/api/auth/github/device/start` | Start a GitHub device login for the current user |
| POST | `/api/auth/github/device/poll` | Poll a GitHub device login and persist the authorized connection |

The GitHub connection routes require a resolved Web identity. The device login routes also require per-user GitHub to be enabled on the install.

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

`/api/health` is public, so its `concurrency` object carries counts and the oldest active and queued ages, never conversation ids. The per-conversation view is the authenticated `GET /api/dashboard/conversations`.

`/api/health` also returns `storeId`, the opaque id of the Archon home the server serves. It is random and carries no path. To check that a server serves the home you mean, compare it with that home's `store-id` file; a running server for a home is recorded in `<ARCHON_HOME>/server.json`. See [Archon directories](/reference/archon-directories/).

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
- `codebaseId` (optional) -- Filter by codebase
- `platform` (optional) -- Filter by platform type
- `mine` (optional) -- `true` narrows to the caller's own conversations on every platform when an identity resolves. Where conversations are private the list already holds only the caller's own web and CLI conversations, and `mine=true` also drops chat and forge conversations attributed to anyone else.

Where web auth is enabled or `ARCHON_WEB_AUTH_HEADER` is set, web and CLI conversations are private to their owner; see [Security](/reference/security/#adapter-authorization) for the rules and status codes.

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
  -d '{"codebaseId": "your-codebase-id"}'
```

Returns the created conversation with its `conversationId`.

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
| GET | `/api/codebases` | List codebases with one representative per resolved repository remote |
| GET | `/api/codebases/{id}` | Get a single codebase |
| POST | `/api/codebases` | Register a codebase (clone or local path) |
| PATCH | `/api/codebases/{id}` | Rename a codebase |
| DELETE | `/api/codebases/{id}` | Delete a codebase after container cleanup |
| GET | `/api/codebases/{id}/environments` | List isolation environments for a codebase |
| POST | `/api/codebases/base-branch` | Inspect the remote default branch without registering a project |
| GET | `/api/codebases/{id}/env` | List a codebase's environment variable keys (values are never returned) |
| PUT | `/api/codebases/{id}/env` | Set or update a codebase environment variable |
| DELETE | `/api/codebases/{id}/env/{key}` | Delete a codebase environment variable |

### List Codebases

```bash
curl http://localhost:3090/api/codebases
```

Returns codebases sorted by name. Repository registrations that resolve to the same remote use registration's remote equality rules, including GitHub HTTPS/SSH spellings, trailing slashes, `.git` suffixes, GitHub repository-path case variants, and equivalent local paths. Repository paths on other hosts remain case-sensitive. Only the most recently updated row for each resolved remote is returned. Folder registrations and rows without a repository URL remain separate.

If a stored checkout path is invalid or a remote identity cannot be resolved, the affected row is returned unchanged and separately. Each failure logs a warning with the codebase ID, name and original error; healthy rows remain available. Database query failures still return HTTP 500.

When all stored checkout paths validate, [`archon project list --json`](/reference/cli/#project-list) returns a complete inventory of registrations without collapsing duplicate remotes. An invalid stored checkout path makes that command fail and must be repaired before it can return the inventory. The API list summarizes duplicate remotes; it does not remove stored rows.

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

### Rename a Codebase

```bash
curl -X PATCH http://localhost:3090/api/codebases/{id} \
  -H "Content-Type: application/json" \
  -d '{"name": "my-repo"}'
```

Returns the updated codebase. The name is trimmed and must be 1 to 255 characters. The response is `409` when another codebase already uses the name, or when the new name would change where Archon stores the project's worktrees, state, logs and artifacts. Repository state, logs and artifacts use the `owner/repo` name when supplied, otherwise `_local/<directory name>`; folder storage uses the slug of its name. Default worktree locations also use repository identity, which can come from the checkout path. A configured repo-local `worktree.path` instead anchors worktrees to the checkout. Rename checks the actual storage and worktree locations and succeeds only when they stay unchanged. The Web UI renames from the project's **More actions** menu or by double-clicking its name.

### Delete a Codebase

```bash
curl -X DELETE http://localhost:3090/api/codebases/{id}
```

Removes the codebase registration and cleans up associated worktrees. If active container environments remain, returns `409` with their environment IDs and leaves the registration intact. Deletion does not remove containers or volumes. A worktree cleanup failure returns `500` and keeps the registration and unfinished cleanup records for retry. If a worktree is registered during cleanup, deletion returns `409`; retry the request to clean it up.

If managed-workspace removal fails after the registration is deleted, the response is `500` and names the retained path. Resolve the filesystem error and remove that directory manually.

Run `archon isolation cleanup 0` to remove eligible containers, then retry the DELETE request. Cleanup preserves containers owned by resumable runs; release those runs before cleanup.

### List Environments

```bash
curl http://localhost:3090/api/codebases/{id}/environments
```

Returns the active isolation environments (worktrees and containers) associated with a codebase.

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
| DELETE | `/api/workflows/{name}/node-sessions` | Reset persisted per-node provider sessions with optional `scope` and `node` filters; omitting `scope` requires `confirm=all-scopes`, and returns `403` when conversations are private ([Security](/reference/security/#adapter-authorization)); there `scope` must name an existing conversation, and a web or CLI one must be the caller's own (chat and forge conversations need no ownership) |

#### List Workflows

```bash
curl http://localhost:3090/api/workflows
```

Query parameters:
- `cwd` (optional) -- Working directory to discover project-specific workflows

When `cwd` is omitted, Archon returns bundled default workflows and any from `~/.archon/workflows/` (home-scoped). Project-specific workflows require either the `cwd` query param or a registered codebase, so the endpoint is useful on first launch before any project is registered.

Returns `{ workflows: [...], recommended: [...], errors?: [...] }`.

- `workflows[]` — each entry is `{ workflow, source, parseWarnings? }`. `parseWarnings` contains warning messages identifying the keys the engine silently dropped from that workflow's YAML, each with the node it was found on and what to write instead (see [Unknown keys](/reference/workflow-language/#unknown-keys-are-reported-not-rejected)); it is **omitted entirely** when the workflow is clean, so its presence alone is the signal.
- `recommended[]` — repo-owner-curated workflow names from `.archon/config.yaml`, filtered to discovered names and kept in declared order. Empty when there is no project context.
- `errors[]` — YAML parsing failures encountered during discovery. Unlike `parseWarnings`, these workflows did **not** load.

#### Get a Workflow

```bash
curl http://localhost:3090/api/workflows/archon-investigate
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
| GET | `/api/workflows/runs/{runId}` | Get run details with events (provider events are served by the route below). `run.nodes[]` is the engine's per-node state; a `workflow:` fan-out node also carries `fan_out_outcome`, its [per-slot record and tally](/reference/workflow-language/#a-completed-fan-out-node-is-not-completed-child-work). See [node execution records](/reference/node-execution/) for event fields, reporting availability, and cost scope |
| GET | `/api/workflows/runs/{runId}/provider-events` | The run's provider events as `{events: ProviderEventRecord[]}`: each is `{runId, stepName, attemptId, seq, observedAt, event}`, grouped by node and in emission order within one. `?step=` limits it to one node. `?attemptId=&afterSeq=` (both, and with `step`) returns only the events after that one: the attempt's later events and every later attempt's. Rows written before the engine recorded envelopes come back translated, with `attemptId: null`. Returns **400** for a partial cursor |
| GET | `/api/runs/{runId}/artifacts` | List artifact files produced by a run |
| GET | `/api/workflows/runs/by-worker/{platformId}` | Look up a run by worker conversation ID |
| POST | `/api/workflows/runs/{runId}/cancel` | Cancel a running workflow: a run this server executes stops at its next status check; a run another process owns has that owner stopped first. Returns **409** with the reason, and leaves the run unchanged, when no owner answers (abandon it once its process is gone) or the owner cannot be stopped; **400** for a run that is not running |
| POST | `/api/workflows/runs/{runId}/resume` | Resume a failed or paused workflow. A run started outside the web UI resumes on the server and returns **409** with the reason, leaving the run unchanged, when its resource is full: a paused run that is ready to continue keeps its place and a continuation host continues it, and a failed run stays failed until it is resumed again. A run started from a web conversation reports the same wait in that conversation |
| POST | `/api/workflows/runs/{runId}/abandon` | Abandon a run (running, paused, or failed); stops a live detached owner first, attempts to cancel discovered `workflow:` descendants except completed and cancelled runs within the [500-parent expansion bound](/reference/workflow-language/#max_parallel-bounds-concurrency-not-count), and attempts to remove the worktrees those runs created, keeping their branches. Owner warnings retain affected checkouts: inspect them (`lsof` when output is still held), resolve the warning, then abandon the cancelled run again to retry removal. Returns **409** with the reason, and leaves the run unchanged, when an owner answers but cannot be stopped or the run cannot be abandoned |
| POST | `/api/workflows/runs/{runId}/approve` | Approve a paused workflow; optional `expectedGate` refuses stale answers with 409 (400 if paused blocked on a `workflow:` child — approve the child) |
| POST | `/api/workflows/runs/{runId}/reject` | Reject a paused workflow; optional `expectedGate` refuses stale answers with 409 (400 if paused blocked on a `workflow:` child — reject the child) |
| POST | `/api/workflows/runs/{runId}/respond` | Resolve a paused gate with one of its declared decisions |
| POST | `/api/workflows/runs/{runId}/answer` | Answer a paused attention wait in its declared form, naming the exact occurrence |
| POST | `/api/workflows/runs/{runId}/signal` | Signal an external event wait; use `occurrence` for an exact match |
| DELETE | `/api/workflows/runs/{runId}` | Delete a terminal run and its events |

For `/signal`, send `{ "event": "checks.complete", "occurrence": "<metadata.wait.pauseId>", "payload": { "conclusion": "success" } }`. The occurrence identifies the exact wait, including when deadlines repeat. The legacy `resumeAt` selector remains accepted and is required when `occurrence` is omitted; it cannot distinguish two occurrences with the same event and deadline. If both selectors are supplied, both must match. Waits persisted without a `pauseId` can still be signaled using `resumeAt`.

Run responses expose `status` and `outcome` as separate fields. `status` is the execution
lifecycle. `outcome` is the workflow-authored verdict (`"succeeded"`, `"failed"`, or `null`) and
is never derived by the API from status or output text. Contradictory combinations are valid: for
example, `{"status":"completed","outcome":"failed"}` means execution finished but the workflow
rejected its result. `null` means no verdict has been authored, including undeclared and historical
runs. The list, detail, by-worker, and dashboard run endpoints preserve both fields.

#### Run a Workflow

```bash
# JSON (no attachments)
curl -X POST http://localhost:3090/api/workflows/archon-investigate/run \
  -H "Content-Type: application/json" \
  -d '{"message": "Why does login fail after a password reset?", "conversationId": "conv-123"}'

# multipart (with file attachments — max 5 files, ≤10 MB each)
curl -X POST http://localhost:3090/api/workflows/archon-investigate/run \
  -F "conversationId=conv-123" \
  -F "message=Investigate this trace" \
  -F "files=@stacktrace.txt" \
  -F "files=@screenshot.png"
```

**Adoption and supersede.** JSON requests may supply `adopt_run_id` or `supersedes_run_id`,
but cannot supply both. If the conversation would continue an existing run, either declaration
is refused before continuation or its fresh fallback. The refusal names the existing run: resume
it with `/workflow resume <id>`, abandon it with `/workflow abandon <id>` before retrying, or
use a conversation with no open run. An accepted fresh supersede records the replaced run ID in
`adopted_from_run_id` and `metadata.continuation.mode: "supersede"` on the new run.

For a continuation refusal, the launch response still returns HTTP 200 with `accepted: true`.
The refusal arrives as a `text` event on the conversation's SSE stream. Callers must read
the stream to determine whether the workflow started; the JSON response alone does not confirm it.

**Supplying declared inputs.** A workflow that declares [`inputs:`](/reference/workflow-language/#running-a-workflow-that-declares-inputs) takes their values through an optional `inputs` map — a flat object of string values. Omit a name to take its declared `default:`.

```bash
# JSON: inputs is a nested object
curl -X POST http://localhost:3090/api/workflows/review-block/run \
  -H "Content-Type: application/json" \
  -d '{"message": "review it", "conversationId": "conv-123",
       "inputs": {"diff": "...", "style": "terse"}}'

# multipart: form fields are strings, so the same map travels JSON-encoded
curl -X POST http://localhost:3090/api/workflows/review-block/run \
  -F "conversationId=conv-123" \
  -F "message=review it" \
  -F 'inputs={"diff":"...","style":"terse"}' \
  -F "files=@context.md"
```

Values are validated against the workflow's declaration before any worktree, clone, or AI cost: a missing **required** input and an **undeclared** name are both refused up front, through the same contract a composing `with:` map goes through. `400` if `inputs` is not an object of strings (or, on multipart, not valid JSON). An empty object is the same as omitting the field.

**Rebinding models for one run.** Optional `tiers` and `aliases` maps change only the named tier or existing `@alias` for this invocation. Every other binding keeps its normal user → repo → global → built-in value.

```bash
# JSON: only `large` changes
curl -X POST http://localhost:3090/api/workflows/issue-to-pr/run \
  -H "Content-Type: application/json" \
  -d '{"message":"fix #2481","conversationId":"conv-123",
       "tiers":{"large":"openai/gpt-5.6"},
       "aliases":{"@reviewer":"codex/gpt-5.6-sol"}}'

# multipart: each map is one JSON-encoded form field
curl -X POST http://localhost:3090/api/workflows/issue-to-pr/run \
  -F "conversationId=conv-123" \
  -F "message=fix #2481" \
  -F 'tiers={"large":"openai/gpt-5.6"}'
```

Tier keys are `small`, `medium`, and `large`; alias keys start with `@`. A model spec can name an Archon agent/model, a Pi vendor/model, an unqualified model under the binding's current provider, or another tier/alias preset. Literal model pins in the workflow remain unchanged. To replace all default tiers, author all three mappings explicitly. The run's `metadata.model_bindings` records the effective non-secret bindings for attribution and the sparse resolved overrides for reuse on resume.

**Loading inline config for one run.** Optional `config` content uses the same sparse runtime keys as a CLI run config file. JSON sends it as an object; multipart sends the object JSON-encoded in one form field. Explicit `tiers` and `aliases` fields are the final model layer and replace only matching names from `config`.

```bash
# JSON content
curl -X POST http://localhost:3090/api/workflows/issue-to-pr/run \
  -H "Content-Type: application/json" \
  -d '{"message":"fix #2482","conversationId":"conv-123",
       "config":{"tiers":{"large":{"provider":"pi","model":"minimax/MiniMax-M3"}},
                 "env":{"BENCH_MODE":"1"}},
       "tiers":{"large":"openai/gpt-5.6"}}'

# multipart content
curl -X POST http://localhost:3090/api/workflows/issue-to-pr/run \
  -F "conversationId=conv-123" \
  -F "message=fix #2482" \
  -F 'config={"docs":{"path":"handbook"},"workflows":{"toolCallAttentionMs":600000}}'
```

Supported inline keys are `assistant` or `defaultAssistant`, `assistants`, `tiers`, `aliases`, `workflows`, `docs.path`, and `env`. Unknown or ineffective keys fail with `400` and name the key. `configPath` is always rejected: HTTP callers cannot ask the server to read a filesystem path. Run metadata stores sealed replay content plus redacted source/key attribution, and resume uses the original layer without accepting replacement content.

#### List Run Artifacts

```bash
curl http://localhost:3090/api/runs/{runId}/artifacts
```

Walks the run's on-disk artifact directory and returns `{ files: [{ path, size, modifiedAt }] }`. Used by the console UI's Artifacts tab. It leaves out only the engine's own `$ARTIFACTS_DIR/.archon/` child, the same rule `archon workflow get` applies, so a workflow's own dotfiles are listed. Returns 400 on an invalid run id or path-escape attempt, and 404 if the run does not exist or its output location cannot be resolved.

#### Resume a Failed or Paused Run

```bash
curl -X POST http://localhost:3090/api/workflows/runs/{runId}/resume
```

Resumes the workflow from where it left off, skipping already-completed nodes. Equivalent to `archon workflow resume <run-id>` from the CLI. Plain `archon workflow run <name>` invocations never resume implicitly.

#### Approve / Reject a Paused Run

```bash
# Approve (optionally with a comment)
curl -X POST http://localhost:3090/api/workflows/runs/{runId}/approve \
  -H "Content-Type: application/json" \
  -d '{"comment": "Looks good, proceed", "expectedGate": {"nodeId": "review", "pauseId": "pause-id"}}'

# Reject (optionally with a reason)
curl -X POST http://localhost:3090/api/workflows/runs/{runId}/reject \
  -H "Content-Type: application/json" \
  -d '{"reason": "Please add error handling first", "expectedGate": {"nodeId": "review", "pauseId": "pause-id"}}'
```

Both routes accept optional `expectedGate: { nodeId, pauseId }`. For an approval
gate with a `pauseId`, copy `nodeId` and `pauseId` from `run.metadata.approval`
in the run detail response. For a legacy gate without `pauseId`, send its node ID
as a string instead, for example `expectedGate: "review"`. This legacy identity
can answer only a gate without a pause ID; it cannot answer a later gate with one. For an attention wait, use `run.attention.nodeId` as `nodeId` and
`run.attention.occurrence` as `pauseId`. When
the run is no longer paused at that gate occurrence, the request returns **409**
and leaves the current pause unchanged. The identity is checked atomically with
the answer write. Omitting `expectedGate` answers the current gate as before;
`comment` and `reason` remain optional, and a request without a body is supported.

These routes record the decision and return. The server's continuation scheduler then continues the run on the platform that started it, whichever surface answered; a container run, or a gate that was already paused when you upgraded to this version, is the exception and needs `archon workflow resume <run-id>`. The response message says which applies.

**Sub-run child gates (#2121 Phase 2):** when a `workflow:` sub-run pauses at its own gate, its parent run pauses "blocked on child". Approve/reject the **child** run using the full `run.metadata.approval.childRunId` from the parent's run detail response. The stored block message contains only a short child label; a surface notice may include the full child command. The parent auto-resumes when the child completes. A child inside a `fan_out:` expansion pauses the same way: it stays paused as its own run, and the parent pauses on a `fan_out` gate listing every unfinished child, then continues once they finish. Calling approve/reject on the *parent's* id while it is blocked on a child returns **400** with a redirect to the child id (a fan-out parent's error names every child it waits on). `abandon` on a parent attempts to cancel discovered sub-run descendants except completed and cancelled runs within the [500-parent expansion bound](/reference/workflow-language/#max_parallel-bounds-concurrency-not-count). Completed and cancelled runs are left alone, but the walk still inspects beneath them. The response's `cascadeFailures` counts failed child cancellations, failed lookups, and unresolved subtrees beyond the bound. `blockedParentRunId` is set when the abandoned run was itself a child stranding a paused parent.

---

## Attention queue

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/runs/attention` | List attention queue items or count them with `countBy` |
| GET | `/api/runs/{runId}/attention` | Read `{ item: <attention item> }`, or `{ item: null }` when there is no queue item |
| POST | `/api/runs/{runId}/attention/labels` | Set or remove labels on the exact attention wait occurrence a run is paused at |

Queue items include answerable pauses, `usage_limit` waits that continue automatically
when a provider usage limit resets or a rate limit's wait ends (its reported reset, else a backoff), and `unreadable` pauses needing inspection. Branch on `kind` before acting:
only `attention` and `awaiting_response` accept answers. Outside answerers can submit an
answer through `/api/workflows/runs/{runId}/answer`. Answers and label writes that name a stale occurrence return `409`.

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
| GET | `/api/dashboard/conversations` | Active and queued conversation processing in this server process, with acquisition and enqueue times |

Query parameters include status filters, date ranges, and pagination. Used by the Command Center UI.

Each run includes `active_nodes`, ordered by unresolved `node_started` event order. Completion,
failure, and both skip lifecycle events remove a node; `node_suspended` keeps it active; a retrying start adds it again. Concurrent
nodes remain separate entries. The compatibility fields `current_step_name` and
`current_step_status` are populated only when exactly one node is active, and are `null` for zero
or multiple active nodes. `total_steps` is `null`; observed lifecycle events do not define the
workflow's total node count. This state describes node lifecycle, not process-owner liveness.

Process-owner liveness is `owner_observation`, which dashboard runs and the run in
`GET /api/workflows/runs/{runId}` carry. The server observes it per request, by the rule
`archon workflow wait` uses for `owner_lost`: `reachable` when an owner answers,
`unreachable` when the recorded owner is on the server's host and user and nothing answers,
and `unknown` when the server cannot observe the owner (another host or user, no recorded
owner, or no answer in time). It is `null` for a run that is not running. It is never stored
and never changes `status`; how long a run has been quiet is not an input. The console shows
a run whose owner is `unreachable` or `unknown` as not live and offers Abandon for
`unreachable`.

---

## Configuration

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Get read-only configuration (safe subset) |
| PATCH | `/api/config/assistants` | Update the default assistant and per-provider model defaults |
| PATCH | `/api/config/tiers` | Update model-tier presets (`small`/`medium`/`large`) |
| PATCH | `/api/config/aliases` | Update `@custom` model aliases (per-key merge; `null` unsets) |
| GET | `/api/providers/pi/models` | Pi's model catalog (cost/reasoning metadata; best-effort, `[]` on failure) |
| GET | `/api/providers` | List registered AI providers |
| GET | `/api/providers/opencode/credentials` | Inspect OpenCode's backend catalog and install-wide auth state (metadata only; starts the embedded runtime on demand) |

`GET /api/config` returns the safe config subset, now including the configured `tiers`, the built-in `tierDefaults` for the current default provider (what an unset tier resolves to), and the configured `aliases`.

These config routes write non-secret model config to `~/.archon/config.yaml` and work on solo installs without an identity or `TOKEN_ENCRYPTION_KEY`. They follow the general API authentication gate when enabled. Contrast with the [AI Provider Credentials](#ai-provider-credentials) routes below, which always require an identity.

A `PATCH` whose resulting config would be invalid is refused with `400` and nothing is written. The `error` field names the refused key, for example `Invalid assistants config: 'assistants.codex.modelReasoningEffort': ...`. This includes an invalid value already in the file that the patch leaves in place: fix that key (in the same request or by editing the file) before other changes save.

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
| PATCH | `/api/auth/me/ai-prefs/default` | Set (or clear with `null`) the personal default assistant + default chat model (`{ provider, model? }` — written atomically; an omitted `model` clears any pin, and `model` without a `provider` is rejected) |

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

Per-user provider credentials let each user bill their runs and chats to **their own** API key or subscription instead of the shared install key. These endpoints require a resolved web identity (`X-Archon-User` header or a Better Auth session) — `GET /api/auth/providers` returns `401` without one. The encryption key is auto-provisioned on every install; `TOKEN_ENCRYPTION_KEY` is an optional override for managed deployments.

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

Returns `{ enabled, connections: [{ provider, kind, label }], available, subscriptionAvailable, agents }`:
- `available` -- every **vendor** id you can connect an API key for (`anthropic`, `openai`, `github-copilot`, plus the Pi backends). Legacy `claude`/`codex`/`copilot` ids are accepted on writes and normalized.
- `subscriptionAvailable` -- the subset that supports subscription (OAuth) login: **`anthropic`**, **`openai`**, and **`github-copilot`**. (The ChatGPT/Codex subscription runs an Archon-owned PKCE flow -- see [#1924](https://github.com/coleam00/Archon/issues/1924).)
- `agents` -- the agent -> credential matrix: per registered agent `{ id, displayName, catalog: 'static'|'dynamic', ready, credentials: [{ vendor, displayName, kinds, connected, connectionConsumed, subscriptionAvailable, installEnv, ambientConfigured?, usable }] }`. `connectionConsumed` says whether the agent uses the `connected` credential's kind (a connected `anthropic` subscription is consumed by Claude Code, not Pi). `usable` is true for a consumed connection, install env, or detected ambient chain, and `ready` is true when any credential is `usable`. `installEnv` counts only the env vars that agent reads; `installEnv`/`ambientConfigured` report server-side detection so readiness renders on solo installs too; OpenCode is `catalog:'dynamic'` (introspect via `GET /api/providers/opencode/credentials`).

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
- `manual` (`anthropic`, Claude Pro/Max) -- show the returned `url`; the user authorizes in a browser and pastes the resulting code back via `poll`.
- `device` (`github-copilot`) -- show `userCode` + `verificationUri`; `poll` until connected.

```bash
# 1. Start a login session
curl -X POST http://localhost:3090/api/auth/providers/anthropic/oauth/start \
  -H "X-Archon-User: your-user-id"
# {"sessionId":"...","mode":"manual","url":"https://...","expiresIn":600}

# 2. Poll (pass the pasted `code` once, for manual flows)
curl -X POST http://localhost:3090/api/auth/providers/anthropic/oauth/poll \
  -H "X-Archon-User: your-user-id" \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "...", "code": "the-pasted-code"}'
# {"status":"connected"}
```

`poll` returns `{ status: "pending" | "connected" | "error", detail? }`. A provider that does not support subscription login returns `400` on `start`.

The CLI equivalent of this whole surface is [`archon ai`](/reference/cli/#ai). For the end-to-end setup walkthrough, see [Per-user credentials and AI Settings](/getting-started/ai-assistants/#per-user-credentials-and-ai-settings).

---

## Web push

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/web-push/key` | Get the browser push VAPID public key |
| POST | `/api/web-push/subscriptions` | Subscribe this browser to push notifications for the current user |
| DELETE | `/api/web-push/subscriptions` | Remove a browser push subscription by endpoint for the current user |

Subscription writes require a resolved Web identity, including on solo installs.

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
  -d '{}' | jq -r '.conversationId')

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
  -d '{"codebaseId": "your-codebase-id"}' | jq -r '.conversationId')

# 2. Start the workflow
curl -X POST http://localhost:3090/api/workflows/archon-investigate/run \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"Why does login fail after a password reset?\", \"conversationId\": \"$CONV_ID\"}"

# 3. Monitor via SSE
curl -N http://localhost:3090/api/stream/$CONV_ID
```
