# Phase 5 Backlog — Telemetry & WebSockets

**Product Owner sign-off:** 2026-02-22
**Input:** TELEMETRY_DASHBOARD_DESIGN.md (Tech Lead), brainstorm:idea-0021 (Shared Context)
**Target sprint:** Sprint 2 (immediately after Sprint 1 — Swarm Infrastructure closes)

---

## Priority Framework

| Level | Meaning |
|-------|---------|
| P0 | Sprint-ready, unblocks all other items — build first |
| P1 | High value, no unresolved dependencies — next in queue |
| P2 | Valuable but blocked on a precondition — deferred |

---

## Backlog

### P0 — Foundation (Backend)

**[P0-1] Build `telemetry_service.py`**
- `get_agent_metrics()` — live status + last_seen delta from `archon_agent_registry`
- `get_sprint_metrics(sprint_id)` — velocity, burn-down, queue depth from `archon_tasks`
- No new DB tables — sources from existing schema
- *Assignee: claude | Effort: S*

**[P0-2] Build `GET /api/telemetry/snapshot` REST endpoint**
- Full dashboard snapshot: agents + sprint metrics bundled in one response
- Wires `telemetry_service.py` to a FastAPI route with ETag support
- Unblocks all frontend MVP panels
- *Assignee: claude | Effort: S | Depends on: P0-1*

---

### P1 — MVP Panels (Frontend)

**[P1-1] Build `AgentHealthGrid.tsx`**
- 5-card grid: name, role badge, status dot, "Xs ago" last_seen delta
- Polls `GET /api/telemetry/snapshot` at 5s (no WS needed for MVP)
- Solves the #1 pain: "I don't know if agents are running"
- *Assignee: claude | Effort: S | Depends on: P0-2*

**[P1-2] Build `SprintVelocityPanel.tsx`**
- Bar chart: tasks done per day over current sprint window
- Data: `archon_tasks` grouped by `updated_at::date` where `status=done`
- Uses Recharts (already in bundle from existing charts)
- *Assignee: claude | Effort: S | Depends on: P0-2*

**[P1-3] Wire `TelemetryPage.tsx` + `/telemetry` route + nav entry**
- Page scaffold: `AgentHealthGrid` + `SprintVelocityPanel` with `TelemetryLayout` wrapper
- Route: `<Route path="/telemetry" element={<TelemetryPage />} />`
- Nav: `BarChart2` icon after Sprint War Room
- *Assignee: claude | Effort: XS | Depends on: P1-1, P1-2*

---

### P1 — WebSocket Infrastructure

**[P1-4] Build `WebSocket /ws/telemetry` FastAPI endpoint**
- Connects to Supabase Realtime change listener on `archon_agent_registry` + `archon_tasks`
- Broadcasts partial-update events to all connected clients
- Auth: same Supabase service key as REST (anon key for frontend subscribers)
- *Assignee: claude | Effort: M | Depends on: P0-1*

**[P1-5] Build `useTelemetrySocket.ts` — frontend WebSocket hook**
- Single shared connection, exponential backoff reconnect (3s → 10s → 30s cap)
- Merges incoming partial updates into `TelemetrySnapshot` state
- Replaces polling in `AgentHealthGrid` once WS is stable
- *Assignee: claude | Effort: S | Depends on: P1-4*

---

### P2 — Budget View (deferred — token data not yet populated)

**[P2-1] Instrument agent work orders to log `token_usage` events**
- On task completion in `agent_work_orders`, POST event to `archon_session_events` with `type=token_usage`, model, input/output token counts
- *Precondition: confirm work orders service has access to response metadata*
- *Assignee: claude | Effort: S*

**[P2-2] Build `TokenBurnChart.tsx`**
- Rolling 24h token spend per agent (stacked bar chart)
- Data: `archon_session_events` filtered by `type=token_usage`
- *Depends on: P2-1 (token data must be present)*

**[P2-3] Build `CostSummaryPanel.tsx`**
- $ totals per agent using model pricing table (Sonnet: $3/$15 per M tokens)
- Budget view only — not shown to ops role
- *Depends on: P2-1*

**[P2-4] Build `TelemetryLayout.tsx` — role switcher**
- Ops view: all panels + per-agent task detail
- Budget view: cost summary + token totals, no task detail
- Auto-route: Product Owner role → budget, all others → ops
- *Depends on: P2-2, P2-3*

---

## Build Order

```
P0-1 telemetry_service.py
  └─► P0-2 snapshot API
        ├─► P1-1 AgentHealthGrid
        ├─► P1-2 SprintVelocityPanel
        │     └─► P1-3 TelemetryPage (wire + nav)
        └─► P1-4 WS /ws/telemetry
              └─► P1-5 useTelemetrySocket (upgrade polling → WS)

[gate: session_events populated]
  └─► P2-1 instrument token logging
        ├─► P2-2 TokenBurnChart
        ├─► P2-3 CostSummaryPanel
        └─► P2-4 TelemetryLayout role switcher
```

---

## Acceptance Criteria (Sprint 2 MVP)

1. `/telemetry` page loads with 5 agent health cards — status + last_seen visible
2. Sprint velocity bar chart shows tasks completed per day for current sprint
3. `GET /api/telemetry/snapshot` responds in < 200ms
4. AgentHealthGrid updates within 5s of a heartbeat change (polling phase)
5. WebSocket endpoint connects and delivers first event within 1s of `archon_agent_registry` change

---

## Deferred / Out of Scope for Phase 5

- WebSocket auth tokens (use service key; revisit in Phase 6 with multi-user auth)
- Alerting / notifications on threshold breach (Phase 6)
- Historical metric retention beyond what Supabase stores by default
