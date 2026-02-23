# Multi-Agent Communication Protocol Specification

**Version:** 1.0
**Status:** Canonical
**Date:** 2026-02-22
**Author:** Tech Lead (claude-opus)

---

## Overview

This document defines the full communication protocol for the Archon multi-agent swarm. It is grounded in the codebase as it exists at Phase 4 completion (migrations 007, 008, 009 applied) and extends forward to Phase 5 (WebSocket telemetry) and Phase 6 (Supabase Realtime presence).

All agents — whether Claude Code sessions, PydanticAI agents, or external tooling — that participate in the Archon swarm MUST follow this protocol. Deviations cause inconsistent registry state and break the telemetry dashboard.

**Base URL:** `http://localhost:8181` (Docker) or `http://localhost:8181` (local uv run)

---

## 1. Agent Identity

### 1.1 Schema

Agent identity lives in `archon_agent_registry`. The authoritative fields are:

| Field | Type | Description |
|---|---|---|
| `id` | UUID | Auto-generated primary key |
| `name` | text (unique) | Unique agent identifier. Used as the primary key for all protocol operations. Case-sensitive. |
| `role` | text | Human-readable role label (e.g. `"Developer"`, `"Scrum Master"`, `"Product Owner"`) |
| `capabilities` | text[] | Array of capability strings (see §1.2) |
| `status` | text | Current agent status: `"active"` \| `"inactive"` \| `"busy"` |
| `last_seen` | timestamptz | UTC timestamp of the last heartbeat or registration |
| `metadata` | jsonb | Arbitrary agent-specific data bag |
| `created_at` | timestamptz | Auto-set on first insert |

### 1.2 Capability Strings

Capabilities are free-form strings but SHOULD follow this convention to remain machine-readable:

```
{domain}:{action}
```

Examples:
- `"code:write"` — can produce code changes
- `"code:review"` — can review PRs and produce comments
- `"tasks:manage"` — can create, update, and close tasks
- `"knowledge:crawl"` — can trigger knowledge base crawls
- `"knowledge:search"` — can query knowledge base via RAG
- `"sessions:manage"` — can create and end agent work sessions
- `"handoffs:initiate"` — can create handoffs to other agents
- `"handoffs:receive"` — can accept and complete incoming handoffs

The `metadata` field MAY carry a `"model"` key indicating the underlying LLM (e.g. `{"model": "claude-sonnet-4-6"}`).

### 1.3 Registration

An agent MUST register before sending heartbeats or initiating handoffs. Registration is idempotent: calling register again updates the record without creating a duplicate (upsert on `name`).

```
POST /api/agents/register
Content-Type: application/json

{
  "name": "claude",
  "role": "Developer",
  "capabilities": ["code:write", "code:review", "tasks:manage", "handoffs:initiate", "handoffs:receive"],
  "metadata": {
    "model": "claude-sonnet-4-6",
    "session_started": "2026-02-22T10:00:00Z"
  }
}
```

**Response:**
```json
{
  "success": true,
  "agent": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "claude",
    "role": "Developer",
    "status": "active",
    "capabilities": ["code:write", "code:review", "tasks:manage", "handoffs:initiate", "handoffs:receive"],
    "last_seen": "2026-02-22T10:00:00Z",
    "metadata": {"model": "claude-sonnet-4-6", "session_started": "2026-02-22T10:00:00Z"},
    "created_at": "2026-02-19T08:00:00Z"
  }
}
```

### 1.4 Agent Discovery

Any agent can discover the current swarm state:

```
GET /api/agents                    # all agents
GET /api/agents?status=active      # only active agents
GET /api/agents/{name}             # specific agent by name
```

Use discovery to verify a target agent is active before initiating a handoff.

---

## 2. Heartbeat Protocol

### 2.1 Purpose

Heartbeats keep `last_seen` fresh. The telemetry dashboard (Phase 5) and the presence layer (Phase 6) derive "agent is alive" from this timestamp. An agent with a stale `last_seen` is treated as offline regardless of its `status` field.

### 2.2 Endpoint

```
POST /api/agents/{name}/heartbeat
```

No request body. The server sets `last_seen = NOW()` and `status = "active"`.

**Response:**
```json
{
  "success": true,
  "agent": {
    "name": "claude",
    "status": "active",
    "last_seen": "2026-02-22T10:00:30Z"
  }
}
```

### 2.3 Interval

| Context | Interval |
|---|---|
| Active work session | Every 30 seconds |
| Idle / waiting for input | Every 60 seconds |
| Telemetry poll interval (Phase 5 MVP) | 5 seconds (read-only, no write) |

The 30-second active interval ensures the dashboard shows a "live" agent for at least 60 seconds after work stops. It also prevents a race where the telemetry snapshot shows an agent as stale mid-task.

### 2.4 Staleness Threshold

An agent is considered **stale** if:

```
NOW() - last_seen > 2 minutes
```

Stale does NOT mean the record is deleted. It means the telemetry AgentHealthGrid renders the status badge as degraded (orange/gray). The `status` field itself is only set to `"inactive"` when:

1. The agent explicitly calls `POST /api/agents/{name}/deactivate` at session end, or
2. A future scheduled job (Phase 6) applies the staleness rule automatically.

### 2.5 Deactivation

An agent SHOULD call deactivate before intentional session end:

```
POST /api/agents/{name}/deactivate
```

This sets `status = "inactive"` and is the clean shutdown signal. Agents that crash without deactivating are identified by staleness, not by explicit status.

---

## 3. Task Dispatch

### 3.1 Task as the Unit of Work

Work assignments flow through `archon_tasks` (table in Supabase). The task board is the single source of dispatch truth. Agents do NOT send work to each other directly — they read from the shared task board and pick up tasks that match their role.

### 3.2 Task Status Lifecycle

```
todo → doing → review → done
                      ↘ todo (rejected from review, returned for rework)
```

Exact database values: `"todo"` | `"doing"` | `"review"` | `"done"`

### 3.3 Task Assignee Field

The `assignee` field on `archon_tasks` is the dispatch signal:

- `"claude"` — Claude Code agent picks this up
- `"gemini"` — Gemini agent picks this up
- `"gpt"` — GPT agent picks this up
- `"user"` — Human operator handles this

An agent picks up a task by:
1. Querying `GET /api/tasks?assignee={name}&status=todo`
2. Claiming it: `PUT /api/tasks/{task_id}` with `{"status": "doing"}`

This MUST be done as close to atomic as possible (query then immediately update) to avoid two agents claiming the same task. In Phase 6, this will be protected by a Supabase row-level lock or optimistic concurrency check.

### 3.4 Task Completion

When done:
```
PUT /api/tasks/{task_id}
{"status": "done"}
```

If the task requires human review:
```
PUT /api/tasks/{task_id}
{"status": "review"}
```

### 3.5 Sprint Board Integration

Sprint membership lives in `archon_sprints` and the join table linking tasks to sprints. Agents do not need to manage sprint assignment directly — that is a Product Owner / Scrum Master concern. Agents operate at the task level only.

---

## 4. Handoff Schema

### 4.1 Purpose

Handoffs transfer context between agents when a session boundary occurs. They are not task assignment — they are context transfer. A handoff says "I did this work, here is the state, you continue from here."

### 4.2 Table: `archon_session_handoffs`

| Field | Type | Description |
|---|---|---|
| `id` | UUID | Primary key |
| `session_id` | UUID | FK to `archon_sessions` — the session being handed off |
| `from_agent` | text | Agent initiating the handoff (matches `archon_agent_registry.name`) |
| `to_agent` | text | Target agent name |
| `context` | jsonb | Structured context payload (see §4.4) |
| `notes` | text | Free-text instructions for the receiving agent |
| `status` | text | Status: `"pending"` \| `"accepted"` \| `"completed"` \| `"rejected"` |
| `metadata` | jsonb | Arbitrary extra data |
| `accepted_at` | timestamptz | Set when receiving agent accepts |
| `completed_at` | timestamptz | Set when receiving agent completes the work |
| `created_at` | timestamptz | Auto-set on insert |

### 4.3 Status Lifecycle

```
[from_agent creates] → pending
[to_agent calls /accept] → accepted
[to_agent calls /complete] → completed

[to_agent calls /reject] → rejected
  └─ from_agent is responsible for either re-routing or escalating
```

### 4.4 Context Payload Schema

The `context` field is free-form jsonb but MUST include at minimum:

```json
{
  "task_id": "uuid-of-current-task",
  "task_title": "Human readable summary",
  "progress": "What has been done so far",
  "blockers": ["List of blockers or empty array"],
  "artifacts": ["List of file paths or resource URLs created"],
  "next_steps": "What the receiving agent should do next"
}
```

Additional fields are permitted. The `notes` field (free text) is for anything that doesn't fit the schema.

### 4.5 Creating a Handoff

```
POST /api/handoffs
Content-Type: application/json

{
  "session_id": "550e8400-e29b-41d4-a716-446655440001",
  "from_agent": "claude",
  "to_agent": "gemini",
  "context": {
    "task_id": "550e8400-e29b-41d4-a716-446655440002",
    "task_title": "Implement telemetry service backend",
    "progress": "telemetry_service.py created with get_agent_metrics() and get_sprint_metrics(). Unit tests passing.",
    "blockers": [],
    "artifacts": ["python/src/server/services/telemetry_service.py"],
    "next_steps": "Wire telemetry_service to GET /api/telemetry/snapshot endpoint"
  },
  "notes": "See PRPs/ai_docs/TELEMETRY_DASHBOARD_DESIGN.md §Backend for the route spec."
}
```

### 4.6 Receiving a Handoff

The receiving agent polls:
```
GET /api/handoffs/pending/{agent_name}
```

This returns all handoffs where `to_agent = {agent_name}` and `status = "pending"`, ordered oldest-first (FIFO).

To accept:
```
POST /api/handoffs/{handoff_id}/accept
```

To complete after finishing the work:
```
POST /api/handoffs/{handoff_id}/complete
```

To reject (agent cannot take this work):
```
POST /api/handoffs/{handoff_id}/reject
```

### 4.7 Polling Interval for Handoffs

Agents that can receive handoffs (`"handoffs:receive"` in capabilities) SHOULD poll `GET /api/handoffs/pending/{name}` every 30 seconds during an active session. This interval matches the heartbeat cadence and avoids double-polling.

---

## 5. Shared Context

### 5.1 Purpose

`archon_shared_context` is a cross-agent key-value board for ambient state. It is NOT a message bus and NOT a task queue. It is a whiteboard: agents post state they want all other agents to see, and read state posted by others.

### 5.2 Table: `archon_shared_context`

| Field | Type | Description |
|---|---|---|
| `id` | UUID | Primary key |
| `context_key` | text (unique) | The key. See §5.3 for naming convention. |
| `value` | jsonb | JSON-serialisable value |
| `set_by` | text | Agent name that last wrote this key |
| `session_id` | UUID | Optional FK to `archon_sessions` |
| `expires_at` | timestamptz | Optional TTL. Expired entries are logically stale (no auto-delete yet). |
| `created_at` | timestamptz | First write |
| `updated_at` | timestamptz | Last write (auto-updated by trigger) |

All writes are audited to `archon_shared_context_history` via a DB trigger. The history table captures `changed_at`, `old_value`, and `new_value` for every upsert.

### 5.3 Key Naming Convention

Keys follow a `namespace:identifier` scheme using colon separators:

| Namespace | Pattern | Example | Purpose |
|---|---|---|---|
| `sprint` | `sprint:{sprint_id}:*` | `sprint:current:goal` | Sprint-scoped state |
| `task` | `task:{task_id}:*` | `task:abc123:status` | Per-task state broadcast |
| `agent` | `agent:{name}:*` | `agent:claude:current_task` | Agent self-reported state |
| `brainstorm` | `brainstorm:{idea_id}` | `brainstorm:idea-0021` | Brainstorm graph data |
| `reference` | `reference:{slug}` | `reference:agile-book` | Shared reference material |
| `session` | `session:{session_id}:*` | `session:abc123:summary` | Session-scoped context |
| `swarm` | `swarm:*` | `swarm:active_agents` | Swarm-wide coordination signals |
| `config` | `config:*` | `config:current_project_id` | Shared configuration |

Avoid generic top-level keys (e.g. `"status"`, `"data"`). Always qualify with a namespace.

### 5.4 Read Pattern

```
GET /api/context/{key}                     # get one key
GET /api/context?prefix=agent:claude:      # all keys under a namespace
GET /api/context/{key}/history?limit=10   # audit trail for a key
```

### 5.5 Write Pattern

```
PUT /api/context/{key}
Content-Type: application/json

{
  "value": {"current_task": "a7d89f74-987a-431e-a39b-c600057f53f9", "started_at": "2026-02-22T10:00:00Z"},
  "set_by": "claude",
  "session_id": "optional-session-uuid",
  "expires_at": "2026-02-22T18:00:00Z"
}
```

### 5.6 TTL Usage

Use `expires_at` for ephemeral signals that should not persist across sessions:
- Agent-reported current task: set `expires_at` to `NOW() + 8 hours`
- Sprint goal: set `expires_at` to sprint end date
- Handoff flags: set `expires_at` to `NOW() + 1 hour`

Do NOT use `expires_at` for reference material or persistent configuration.

### 5.7 Delete

```
DELETE /api/context/{key}
```

Only use delete for keys that should be permanently gone. Prefer `expires_at` for time-bounded data.

---

## 6. Message Envelope

### 6.1 Purpose

When an agent needs to convey a typed, routable message to another agent (beyond what the task board and handoff records handle), it uses the standard message envelope. In Phase 4 (current), envelopes are stored in `archon_shared_context` under the `msg:` namespace. In Phase 6, they transit over Supabase Realtime channels.

### 6.2 Standard Envelope Schema

All inter-agent messages MUST conform to this JSON structure:

```json
{
  "type": "string",
  "sender": "string",
  "recipient": "string",
  "payload": {},
  "timestamp": "ISO-8601 UTC",
  "correlation_id": "UUID",
  "reply_to": "UUID | null"
}
```

| Field | Required | Description |
|---|---|---|
| `type` | YES | Message type (see §6.3) |
| `sender` | YES | Sending agent name (matches `archon_agent_registry.name`) |
| `recipient` | YES | Target agent name or `"broadcast"` for all-agent messages |
| `payload` | YES | Type-specific data object |
| `timestamp` | YES | ISO-8601 UTC timestamp of when the message was created |
| `correlation_id` | YES | UUID v4 generated by the sender. Used to group related messages (e.g. request/response). |
| `reply_to` | NO | `correlation_id` of the message being responded to. Null for initiating messages. |

### 6.3 Defined Message Types

| Type | Direction | Description |
|---|---|---|
| `task.assigned` | swarm → agent | A task has been assigned to the recipient |
| `task.status_changed` | agent → swarm | Agent reports a task status transition |
| `handoff.created` | agent → agent | Sender has created a handoff record (notification) |
| `handoff.accepted` | agent → agent | Recipient has accepted the handoff |
| `handoff.rejected` | agent → agent | Recipient has rejected the handoff |
| `heartbeat.ack` | server → agent | Server acknowledges a heartbeat (Phase 6 WS only) |
| `context.updated` | agent → swarm | Agent announces it has written a shared context key |
| `session.started` | agent → swarm | Agent has started a new work session |
| `session.ended` | agent → swarm | Agent is ending a work session |
| `error.reported` | agent → swarm | Agent encountered an unrecoverable error on a task |

### 6.4 Phase 4 Envelope Storage (REST)

In the current REST-only architecture, broadcast envelopes are stored in shared context:

```
PUT /api/context/msg:{correlation_id}
{
  "value": { /* full envelope */ },
  "set_by": "claude",
  "expires_at": "NOW + 1 hour"
}
```

Direct envelopes (agent-to-agent) are stored under:
```
msg:{recipient}:{correlation_id}
```

Recipients poll `GET /api/context?prefix=msg:{name}:` to check for inbound messages. This is a polling-based approximation of the Phase 6 push model.

### 6.5 Example: Task Status Change Envelope

```json
{
  "type": "task.status_changed",
  "sender": "claude",
  "recipient": "broadcast",
  "payload": {
    "task_id": "a7d89f74-987a-431e-a39b-c600057f53f9",
    "previous_status": "doing",
    "new_status": "done",
    "session_id": "550e8400-e29b-41d4-a716-446655440001"
  },
  "timestamp": "2026-02-22T11:30:00Z",
  "correlation_id": "7f3b8c2a-1d4e-4f5a-9b6c-2e7d8f0a1b3c",
  "reply_to": null
}
```

---

## 7. Error Protocol

### 7.1 Dependency Unavailability

When an agent cannot reach the Archon server (`http://localhost:8181`), it MUST follow this sequence:

1. **Retry with exponential backoff:** 3s → 6s → 12s → 24s, capped at 60s. Maximum 5 retries.
2. **Log the failure locally** with the attempted endpoint, timestamp, and HTTP status or connection error.
3. **After 5 failed retries:** Stop retrying. Record the failure in shared context if the server becomes reachable later using key `agent:{name}:last_error`.
4. **Do NOT abandon in-progress work.** If the agent was mid-task, continue local execution. Report status change when the server is reachable again.

```json
// Stored under agent:{name}:last_error when recovery is possible
{
  "endpoint": "POST /api/agents/claude/heartbeat",
  "first_failure": "2026-02-22T10:15:00Z",
  "retry_count": 5,
  "last_attempt": "2026-02-22T10:19:00Z",
  "error": "Connection refused"
}
```

### 7.2 Handoff Target Unavailable

If an agent wants to create a handoff but the target agent is not active in the registry (or `last_seen` is stale per §2.4):

1. Check `GET /api/agents/{target}` — if 404 or `status != "active"`, do not create the handoff.
2. Write the intended handoff context to shared context under `agent:{sender}:pending_handoff` with `expires_at = NOW() + 4 hours`.
3. Create an `archon_tasks` entry with `assignee = "user"` and `title = "Manual handoff required: {target} unavailable"`.
4. Set agent's own status to `"inactive"` via deactivate endpoint and end the session cleanly.

### 7.3 Task Claim Race Condition

If two agents simultaneously claim the same task (both read `status=todo`, both write `status=doing`), Supabase returns the last writer's update and both believe they own it. In Phase 4 (no row locking), agents MUST:

1. After claiming a task, re-read it immediately: `GET /api/tasks/{task_id}`
2. Verify the response has `assignee == {own_name}` (if the backend stores it) or that no other agent has logged a session event against that task in `archon_session_events` within the last 60 seconds.
3. If a conflict is detected, the agent that detects it releases the task: `PUT /api/tasks/{task_id}` with `{"status": "todo"}`.

Phase 6 will replace this with a Supabase row-level advisory lock or optimistic concurrency (version counter).

### 7.4 Heartbeat Failure During Active Work

If an agent's heartbeat fails:

1. Log the failure. Continue work.
2. Retry heartbeat on next interval.
3. If 3 consecutive heartbeats fail: write current task progress to shared context under `agent:{name}:recovery_state` before attempting to end the session.

This ensures another agent can resume if the session is lost.

### 7.5 HTTP Error Response Handling

| Status | Meaning | Agent Action |
|---|---|---|
| `400` | Bad request / validation error | Do not retry. Fix the payload. Log the error. |
| `404` | Resource not found | Expected in negative checks (agent not registered, handoff not found). Handle gracefully. |
| `409` | Conflict | Rare. Indicates concurrent write conflict. Back off 5s and retry once. |
| `500` | Server error | Retry with backoff (see §7.1). |
| `503` | Server starting up | Retry with backoff. Docker cold start takes ~10s. |

---

## 8. Phase 6 Forward — WebSocket Presence Layer

### 8.1 What Changes in Phase 6

Phase 4 agents communicate entirely via REST polling (heartbeats, handoff polling, context reads). Phase 5 adds a WebSocket endpoint (`/ws/telemetry`) that is read-only and dashboard-facing. Phase 6 makes WebSockets bidirectional and agent-facing.

The multi-agent protocol above is designed to be transport-agnostic. The envelope format (§6.2), handoff schema (§4), and context key conventions (§5.3) do not change. Only the transport layer changes.

### 8.2 Supabase Realtime Integration

Phase 6 uses Supabase Realtime to broadcast database change events directly to agents:

```
Supabase Postgres changes
  └─ archon_session_handoffs (INSERT, UPDATE)
  └─ archon_tasks (UPDATE where assignee = {agent_name})
  └─ archon_agent_registry (UPDATE — presence events)
       └─► FastAPI WebSocket bridge (/ws/agents)
             └─► Each connected agent receives push notifications
```

This eliminates the 30-second polling lag for handoff receipt and task assignment.

### 8.3 Agent WebSocket Endpoint (Phase 6 Design)

```
WebSocket ws://localhost:8181/ws/agents/{agent_name}
```

On connect:
1. Agent authenticates with Supabase anon key (same key used for REST).
2. Server registers the WebSocket as the agent's push channel.
3. Server immediately delivers any pending handoffs for `{agent_name}`.

On receive (server → agent):
```json
{
  "type": "handoff.created",
  "sender": "gemini",
  "recipient": "claude",
  "payload": { "handoff_id": "uuid", "context": {} },
  "timestamp": "2026-02-22T14:00:00Z",
  "correlation_id": "uuid",
  "reply_to": null
}
```

On send (agent → server):
```json
{
  "type": "heartbeat",
  "sender": "claude",
  "recipient": "server",
  "payload": { "status": "active" },
  "timestamp": "2026-02-22T14:00:30Z",
  "correlation_id": "uuid",
  "reply_to": null
}
```

### 8.4 Presence Channel (Phase 6)

Supabase Realtime's Presence feature tracks which agents are connected in real time without polling:

```typescript
// Frontend (Phase 6)
const channel = supabase.channel("swarm:presence");
channel.on("presence", { event: "sync" }, () => {
  const state = channel.presenceState(); // { claude: [{online_at: "..."}], gemini: [...] }
});
channel.subscribe(async (status) => {
  if (status === "SUBSCRIBED") {
    await channel.track({ agent: "claude", online_at: new Date().toISOString() });
  }
});
```

The `archon_agent_registry.last_seen` field continues to be the durable record. Supabase Presence is the ephemeral real-time layer; the registry is the persistent record. They complement each other:

- Presence drops: agent is definitely offline right now
- Registry `last_seen` stale but Presence connected: agent is alive but heartbeat failed
- Registry `status = active` but Presence dropped: agent may be in a cold restart

### 8.5 Protocol Backward Compatibility

Phase 6 agents continue to support REST heartbeats and REST handoff polling as fallbacks. The server advertises WebSocket availability at:

```
GET /api/agents/capabilities
```

Response:
```json
{
  "websocket": true,
  "websocket_endpoint": "ws://localhost:8181/ws/agents/{name}",
  "presence_channel": "swarm:presence",
  "polling_fallback": true
}
```

Agents SHOULD prefer WebSocket when available and fall back to polling on connection failure using the retry policy in §7.1.

### 8.6 Telemetry WebSocket (Phase 5, already designed)

`/ws/telemetry` is the first WebSocket endpoint and is implemented in Phase 5 as part of the telemetry dashboard. It is dashboard-facing (read-only broadcast), not agent-facing. See `TELEMETRY_DASHBOARD_DESIGN.md` for the full design.

The telemetry socket follows the same envelope format as §6.2 with `recipient = "dashboard"` and `sender = "server"`. This consistency means the Phase 6 agent socket implementation can share infrastructure with the Phase 5 telemetry socket.

---

## Appendix A: Endpoint Reference

| Operation | Method | Path |
|---|---|---|
| Register agent | POST | `/api/agents/register` |
| Send heartbeat | POST | `/api/agents/{name}/heartbeat` |
| List agents | GET | `/api/agents` |
| Get agent | GET | `/api/agents/{name}` |
| Deactivate agent | POST | `/api/agents/{name}/deactivate` |
| Create handoff | POST | `/api/handoffs` |
| List handoffs | GET | `/api/handoffs` |
| Get pending handoffs | GET | `/api/handoffs/pending/{agent}` |
| Get handoff | GET | `/api/handoffs/{id}` |
| Accept handoff | POST | `/api/handoffs/{id}/accept` |
| Complete handoff | POST | `/api/handoffs/{id}/complete` |
| Reject handoff | POST | `/api/handoffs/{id}/reject` |
| Set context | PUT | `/api/context/{key}` |
| Get context | GET | `/api/context/{key}` |
| List context | GET | `/api/context?prefix={prefix}` |
| Get context history | GET | `/api/context/{key}/history` |
| Delete context | DELETE | `/api/context/{key}` |

---

## Appendix B: Agent Startup Checklist

Every agent session MUST execute these steps in order:

1. `POST /api/agents/register` — establish identity in the registry
2. `GET /api/handoffs/pending/{name}` — check for queued handoffs from previous sessions
3. `GET /api/context?prefix=agent:{name}:` — read own last-known state
4. `GET /api/context/swarm:active_agents` — discover who else is running
5. Begin work loop, with heartbeat timer running at 30s intervals
6. At session end: `POST /api/agents/{name}/deactivate` and `PUT /api/context/agent:{name}:current_task` with `null` value

---

## Appendix C: Key Existing Swarm Agents

| Name | Role | Capabilities (typical) |
|---|---|---|
| `claude` | Developer / Tech Lead | `code:write`, `code:review`, `tasks:manage`, `handoffs:initiate`, `handoffs:receive` |
| `gemini` | Developer | `code:write`, `tasks:manage`, `handoffs:initiate`, `handoffs:receive` |
| `gpt` | Developer | `code:write`, `tasks:manage`, `handoffs:initiate`, `handoffs:receive` |
| `user` | Product Owner / Human | `tasks:manage` (via UI, not this protocol) |
