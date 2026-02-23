# Phase 5: Telemetry Dashboard — System Design

## Overview

A real-time observability dashboard for the Archon swarm. Single app, role-based views, WebSocket-powered. Validates WebSocket infrastructure while consuming it — dog-foods the swarm's own comms layer.

**Primary pain solved:** Operators are blind to agent health, token spend, and task throughput until something breaks.

---

## Goals

1. **Real-time agent health** — who is active, busy, idle, last seen
2. **Token spend visibility** — per-agent, per-session, rolling totals
3. **Task throughput** — sprint velocity, completion rate, queue depth
4. **Role-based views** — Ops (granular) vs Budget (aggregated cost)
5. **WebSocket dog-fooding** — validates the WS infra Archon needs for Phase 6 (presence, collab)

---

## Architecture

### Transport Layer

```
Supabase Realtime (Postgres changes) ──► FastAPI WebSocket bridge ──► Frontend
```

- **Supabase Realtime** listens to `archon_agent_registry`, `archon_tasks`, `archon_session_events`
- **FastAPI** `/ws/telemetry` broadcasts change events to all connected dashboard clients
- **Frontend** subscribes via a single shared WebSocket connection (no polling)

Why WebSocket over polling: Telemetry needs sub-second latency. Polling at 1s would generate 86k requests/day per client. WebSocket keeps one connection open.

### Backend

**New service:** `python/src/server/services/telemetry_service.py`
- `get_agent_metrics()` → live status + last_seen delta for all agents
- `get_token_metrics(window_hours)` → aggregated token usage from `archon_session_events`
- `get_sprint_metrics(sprint_id)` → velocity, burn-down, queue depth
- `get_cost_estimate(agent, window)` → maps token counts to $ using model pricing table

**New API route:** `python/src/server/api_routes/telemetry_api.py`
- `GET /api/telemetry/snapshot` — full dashboard snapshot (initial load)
- `WebSocket /ws/telemetry` — streaming updates on change events

**Data sources (no new DB tables needed):**
| Metric | Source |
|--------|--------|
| Agent status / last_seen | `archon_agent_registry` |
| Token usage | `archon_session_events` (type=token_usage) |
| Task velocity | `archon_tasks` (status transitions + updated_at) |
| Sprint burn-down | `archon_tasks` joined with `archon_sprints` |
| Handoff queue | `archon_session_handoffs` (status=pending) |

### Frontend

**New feature slice:** `archon-ui-main/src/features/telemetry/`

```
telemetry/
├── components/
│   ├── AgentHealthGrid.tsx     — 5-card grid, status + last_seen delta
│   ├── TokenBurnChart.tsx      — rolling 24h token spend per agent (recharts)
│   ├── SprintVelocityPanel.tsx — tasks done/day bar chart
│   ├── CostSummaryPanel.tsx    — $ totals by agent (budget view)
│   └── TelemetryLayout.tsx     — role switcher (Ops | Budget)
├── hooks/
│   ├── useTelemetrySocket.ts   — WebSocket connection + reconnect logic
│   └── useTelemetrySnapshot.ts — initial REST fetch (useQuery)
├── services/
│   └── telemetryService.ts
└── types/
    └── index.ts
```

**Role-based views:**
- `?view=ops` — all panels, granular per-agent breakdown
- `?view=budget` — cost summary, token totals, no per-task detail
- Default: detect from `user` agent role (`Product Owner` → budget, else → ops)

### WebSocket Hook Pattern

```typescript
// useTelemetrySocket.ts
export function useTelemetrySocket() {
  const [metrics, setMetrics] = useState<TelemetrySnapshot | null>(null);

  useEffect(() => {
    const ws = new WebSocket("ws://localhost:8181/ws/telemetry");
    ws.onmessage = (e) => setMetrics(prev => merge(prev, JSON.parse(e.data)));
    ws.onclose = () => setTimeout(reconnect, 3000); // auto-reconnect
    return () => ws.close();
  }, []);

  return metrics;
}
```

---

## MVP Scope (start here)

**Panel 1 — Agent Health Grid** (highest pain, lowest complexity)
- 5 cards showing: name, role, status badge, last_seen ("2s ago")
- Data: `archon_agent_registry` polled at 5s (no WS needed for MVP)
- This alone solves the "I don't know if agents are running" problem

**Panel 2 — Sprint Burn-down** (medium complexity)
- Tasks done per day bar chart
- Data: `archon_tasks` grouped by `updated_at::date` where `status=done`

**Panel 3 — Token Spend** (requires session_events to have token data)
- Only build once `archon_session_events` has token_usage event type populated

---

## Page + Route

```typescript
// pages/TelemetryPage.tsx
<Route path="/telemetry" element={<TelemetryPage />} />
```

Navigation entry after Sprint War Room (Swords icon → BarChart2 icon).

---

## Implementation Order

1. `telemetry_service.py` — `get_agent_metrics()` + `get_sprint_metrics()`
2. `telemetry_api.py` — `GET /api/telemetry/snapshot`
3. `AgentHealthGrid.tsx` + `SprintVelocityPanel.tsx` — MVP panels
4. `TelemetryPage.tsx` + route + nav entry
5. `WebSocket /ws/telemetry` — upgrade from polling once panels are validated
6. `TokenBurnChart.tsx` + `CostSummaryPanel.tsx` — once WS is live

---

## Open Questions

- Does `archon_session_events` currently store token counts? If not, agent work orders service needs to log them on task completion.
- Should WebSocket auth use the same Supabase anon key as REST, or a separate WS token?
- Supabase Realtime vs custom FastAPI WS: Realtime is simpler to set up but less flexible for aggregation. Recommend FastAPI WS with Supabase change listener internally.
