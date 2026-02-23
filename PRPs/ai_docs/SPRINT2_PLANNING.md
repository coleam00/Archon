# Sprint 2 Planning — Telemetry & WebSockets

**Facilitated by:** Scrum Master (gpt)
**Date:** 2026-02-22
**Sprint window:** 2026-03-07 → 2026-03-21 (2 weeks)

---

## Sprint 1 Retrospective Snapshot

| Metric | Value |
|--------|-------|
| Tasks committed | 15 |
| Tasks completed | 10 |
| Velocity | 10 tasks / sprint |
| Carry-over (doing) | 4 tasks |
| Carry-over (todo) | 1 task |

**What worked:**
- Copy-Prompt dispatch pattern → agents self-assigned tasks from War Room
- Heartbeat auto-scheduler removed a recurring manual impediment
- QA caught TypeScript type error (`beforeEach` return) before it hit CI

**Impediment logged:** Sprint 1 carry-over (5 tasks still open) enters Sprint 2 as unplanned work. Scrum Master will track daily to prevent scope creep.

---

## Sprint 2 Goal

> **Ship Phase 5 MVP: live agent health dashboard + sprint velocity panel + WebSocket infrastructure**

Operators will be able to navigate to `/telemetry` and see:
1. All 5 agent health cards with live status and last_seen delta
2. Sprint burn-down bar chart (tasks done per day)
3. WebSocket endpoint live and delivering sub-second change events

---

## Capacity

| Agent | Role | Sprint 1 Output | Sprint 2 Capacity |
|-------|------|-----------------|-------------------|
| claude | Software Developer | 5 tasks | 5 tasks |
| claude-opus | Tech Lead | 2 tasks | 2 tasks |
| gpt | Scrum Master | 2 tasks (facilitation) | 2 tasks (facilitation) |
| gemini | QA Tester | 3 tasks | 3 tasks (review + test) |
| user | Product Owner | 2 tasks (direction) | 1 task (approval gate) |

**Total capacity: ~13 task-slots** (same team, 2-week sprint)
**Sprint 2 commitment: 7 tasks** — well within capacity, leaves room for Sprint 1 carry-over.

---

## Sprint Backlog (Committed)

### P0 — Must complete first (unblocks all panels)

| # | Task | Assignee | Effort | Depends on |
|---|------|----------|--------|------------|
| 1 | Build `telemetry_service.py` (get_agent_metrics + get_sprint_metrics) | claude | S | — |
| 2 | Build `GET /api/telemetry/snapshot` REST endpoint | claude | S | #1 |

### P1 — MVP panels + WebSocket

| # | Task | Assignee | Effort | Depends on |
|---|------|----------|--------|------------|
| 3 | Build `AgentHealthGrid.tsx` — 5-card live health panel | claude | S | #2 |
| 4 | Build `SprintVelocityPanel.tsx` — burn-down bar chart | claude | S | #2 |
| 5 | Wire `TelemetryPage.tsx` + `/telemetry` route + nav entry | claude | XS | #3, #4 |
| 6 | Build `WebSocket /ws/telemetry` FastAPI endpoint | claude | M | #1 |
| 7 | Build `useTelemetrySocket.ts` — WS hook with auto-reconnect | claude | S | #6 |

### Backlog (not committed — P2)

| Task | Status | Gate |
|------|--------|------|
| Instrument agent work orders: token_usage events | Backlog | Precondition: confirm response metadata accessible |
| Build `TokenBurnChart.tsx` + `CostSummaryPanel.tsx` | Backlog | Needs token_usage data populated |
| Build `TelemetryLayout.tsx` — Ops/Budget role switcher | Backlog | Needs P2 cost panels complete |

---

## Build Sequence

```
Day 1-2:  #1 telemetry_service.py     [claude]
Day 2-3:  #2 snapshot API endpoint    [claude]
Day 3-4:  #3 AgentHealthGrid          [claude]  ← validates data model
Day 4-5:  #4 SprintVelocityPanel      [claude]
Day 5:    #5 TelemetryPage wire       [claude]  ← /telemetry live
Day 6-8:  #6 WS /ws/telemetry         [claude]  ← can run parallel with #3-5
Day 8-9:  #7 useTelemetrySocket       [claude]
Day 9-10: QA + polish                 [gemini]
```

---

## Definition of Done

A Sprint 2 task is done when:
1. Implementation matches spec in `TELEMETRY_DASHBOARD_DESIGN.md`
2. TypeScript compiles with no errors (`npx tsc --noEmit`)
3. Biome passes (`npm run biome`)
4. Backend: Docker restart succeeds + endpoint returns 200
5. QA Tester validates the feature against acceptance criteria
6. Task status set to `done` via API

### Sprint 2 Acceptance Criteria

1. `GET /api/telemetry/snapshot` responds in < 200ms with agents + sprint metrics
2. `/telemetry` page loads with 5 agent health cards (status + last_seen visible)
3. Sprint velocity bar chart shows tasks done per day for current sprint
4. AgentHealthGrid updates within 5s of a heartbeat change
5. WebSocket endpoint connects and delivers first event within 1s of DB change
6. All tests pass (`npm run test:coverage:stream`)

---

## Impediment Register

| ID | Impediment | Owner | Status |
|----|-----------|-------|--------|
| IMP-001 | Sprint 1 carry-over: 5 tasks still in flight | Scrum Master | Monitoring |
| IMP-002 | `archon_session_events` has no token_usage data yet | Product Owner | Deferred to P2 gate |
| IMP-003 | WS auth strategy undefined (service key vs dedicated token) | Tech Lead | Accepted risk — service key for Sprint 2 |

---

## Sprint 2 Kickoff Checklist

- [x] Sprint 2 created in Archon (id: 18ae8f3a)
- [x] 7 tasks committed and assigned to sprint
- [x] P2 tasks remain in backlog (unassigned to sprint)
- [x] Sprint goal agreed by team
- [x] Definition of Done written
- [x] Impediments logged
- [ ] Sprint 1 formally closed (pending 5 carry-over tasks completing)
- [ ] Sprint 2 kickoff: start date 2026-03-07
