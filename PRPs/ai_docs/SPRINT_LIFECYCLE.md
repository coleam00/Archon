# Sprint Lifecycle — PO Approval Gate

**Status:** Design spec (approved 2026-02-22)
**Applies to:** `archon_sprints` table, `sprint_service.py`, `SprintsTab.tsx`, `SprintWarRoomView.tsx`

---

## The Problem This Solves

Without enforced phase gates, AI agents and the Product Owner can jump from planning directly into execution without a formal handoff. This causes:
- Sprint tasks picked up before requirements are finalized
- No clear moment where the PO commits to the sprint goal
- Agents working on the wrong sprint (e.g. Sprint 2 work during Sprint 1 wind-down)

---

## Status Lifecycle

```
planning
    │
    │  Scrum Master: sprint plan written, tasks committed, team ready
    │  Action: PUT /api/sprints/{id}  { "status": "ready_for_kickoff" }
    ▼
ready_for_kickoff          ← the gate
    │
    │  Product Owner only: reviews goal, capacity, DoD — then approves
    │  Action: PUT /api/sprints/{id}  { "status": "active" }
    │  (any other agent attempting this transition gets 403)
    ▼
active
    │
    │  Work happens. Tasks move: todo → doing → review → done
    │
    ├─► completed   (Scrum Master closes after sprint review)
    └─► cancelled   (PO or Scrum Master — if goal is abandoned)
```

---

## Transition Rules

| From | To | Who can do it | Blocked if |
|------|----|---------------|------------|
| `planning` | `ready_for_kickoff` | Any agent (Scrum Master by convention) | — |
| `ready_for_kickoff` | `active` | **`user` (Product Owner) only** | Requester is not `user` |
| `ready_for_kickoff` | `planning` | Any agent (rollback) | — |
| `active` | `completed` | Any agent | — |
| `active` | `cancelled` | Any agent | — |
| `planning` | `active` | **Nobody** — skipping the gate is blocked | Always |

---

## API Contract

### Request: transition to active
```
PUT /api/sprints/{sprint_id}
{
  "status": "active",
  "requested_by": "user"        ← required for this transition
}
```

### Response: unauthorized agent attempts activation
```
HTTP 403
{
  "error": "Only the Product Owner (user) can activate a sprint. Current status must be ready_for_kickoff."
}
```

---

## What Each Role Sees in the UI

### Sprint in `planning`
- Scrum Master sees: **"Mark Ready for Kickoff"** button
- Others see: status badge only

### Sprint in `ready_for_kickoff`
- Product Owner (user) sees: **"Approve & Start Sprint"** button (prominent, green)
- Other agents see: **"Awaiting PO Approval"** banner — no action available
- War Room header shows: `PHASE: AWAITING KICKOFF APPROVAL`

### Sprint in `active`
- War Room header shows: `PHASE: SPRINT ACTIVE — Day N of M`
- All agents can pick up tasks

---

## Implementation Checklist

- [ ] **Migration** — add `ready_for_kickoff` to the `archon_sprints` status check constraint
- [ ] **Backend** — enforce transition rules in `sprint_service.py` `update_sprint()`
- [ ] **API** — accept `requested_by` field in `PUT /api/sprints/{id}`
- [ ] **Frontend** — `SprintsTab.tsx`: show correct action button per status + role
- [ ] **War Room** — `SprintHeader.tsx`: display phase indicator prominently
- [ ] **Tests** — verify 403 when non-user agent tries to activate

---

## What This Does NOT Do

- It does not authenticate users (Archon is single-user, local deployment). `requested_by` is an agent name passed by the caller — it's a workflow convention, not a security mechanism.
- It does not prevent the PO from manually updating the DB directly. This is a guard rail for the swarm, not a hard security boundary.

---

## References

- Role mapping: `AGILE_WORKFLOW.md`
- Sprint DB schema: `migration/0.1.0/015_add_sprints.sql`
- Sprint service: `python/src/server/services/projects/sprint_service.py`
- Sprint API: `python/src/server/api_routes/sprints_api.py`
- Frontend tabs: `archon-ui-main/src/features/projects/sprints/SprintsTab.tsx`
