# Sprint War Room — Agile Team Workflow Visualization

**Status:** IN PROGRESS (2026-02-22)
**Sprint:** Archon Control Plane — Sprint 2

---

## What's Already Done

- `python/src/server/api_routes/sprints_api.py` — CRUD endpoints (✅ complete)
- `python/src/server/services/projects/sprint_service.py` — service layer with PO approval gate (✅ complete)
- `migration/0.1.0/015_add_sprints.sql` — DB schema (archon_sprints + sprint_id on tasks) (✅ run)
- `migration/0.1.0/016_sprint_approval_gate.sql` — `ready_for_kickoff` status added to enum (✅ run)
- `PRPs/ai_docs/SPRINT_LIFECYCLE.md` — full lifecycle spec with transition rules (✅ created)
- `PRPs/ai_docs/AGILE_WORKFLOW.md` — updated role table + lifecycle section (✅ updated)

---

## Step 1 — Migration: Add `role` column to agent registry

Create `migration/0.1.0/017_agent_role.sql`:
```sql
ALTER TABLE archon_agent_registry ADD COLUMN IF NOT EXISTS role TEXT;
-- e.g. 'Product Owner', 'Scrum Master', 'Developer', 'QA Tester', 'UI/UX Designer'
INSERT INTO archon_migrations (version, migration_name)
VALUES ('017', 'agent_role')
ON CONFLICT (version, migration_name) DO NOTHING;
```
User runs in Supabase SQL Editor.

---

## Step 2 — Backend: Add `role` to agent registry

**`python/src/server/api_routes/agent_registry_api.py`**
- Add `role: str | None = None` to `AgentRegisterRequest`
- Pass `role` to `service.register_agent()`

**`python/src/server/services/agent_registry_service.py`**
- Add `role: str | None = None` param to `register_agent()` and `update_agent()`
- Include in the upsert payload when provided

---

## Step 3 — Frontend: Agent type — add `role` field

**`archon-ui-main/src/features/agents/types/agent.ts`**
- Add `role?: string` to the `Agent` interface

---

## Step 4 — Frontend: New `features/sprints/` vertical slice

### Types — `features/sprints/types/index.ts`
```typescript
export type SprintStatus = "planning" | "ready_for_kickoff" | "active" | "completed" | "cancelled";

export interface Sprint {
  id: string;
  project_id: string;
  name: string;
  goal: string | null;
  status: SprintStatus;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateSprintRequest {
  project_id: string;
  name: string;
  goal?: string;
  status?: SprintStatus;
  start_date?: string;
  end_date?: string;
}

export interface UpdateSprintRequest {
  name?: string;
  goal?: string;
  status?: SprintStatus;
  start_date?: string;
  end_date?: string;
  requested_by?: string;  // required when status → active (PO gate)
}
```

### Service — `features/sprints/services/sprintService.ts`
- `listSprints(projectId)` → `GET /api/projects/{projectId}/sprints`
- `getSprint(sprintId)` → `GET /api/sprints/{sprintId}`
- `createSprint(data)` → `POST /api/sprints`
- `updateSprint(id, data)` → `PUT /api/sprints/{id}`
- `deleteSprint(id)` → `DELETE /api/sprints/{id}`

### Hooks — `features/sprints/hooks/useSprintQueries.ts`
```typescript
export const sprintKeys = {
  all: ["sprints"] as const,
  byProject: (projectId: string) => ["sprints", "project", projectId] as const,
  detail: (id: string) => ["sprints", "detail", id] as const,
}
// useProjectSprints(projectId) — staleTime: STALE_TIMES.normal
// useCreateSprint() — invalidates byProject
// useUpdateSprint() — invalidates byProject + detail (pass requested_by for PO gate)
// useDeleteSprint() — invalidates byProject
```

### Components

**`SprintSelector.tsx`**
- Project dropdown (reuses existing project list from `useProjects()`)
- Sprint dropdown loaded from selected project — auto-selects "active" sprint
- "New Sprint" button → opens CreateSprintModal
- Sprint status badge inline

**`SprintHeader.tsx`**
- Sprint name, goal, date range, status badge (color-coded)
  - planning=gray, ready_for_kickoff=yellow, active=cyan, completed=green, cancelled=red
- Progress bar: done tasks / total tasks in sprint (%)
- Status action buttons by role:
  - planning: Scrum Master sees "Mark Ready for Kickoff"
  - ready_for_kickoff: user (PO) sees "Approve & Start Sprint" (green); others see "Awaiting PO Approval" banner
  - active: "Complete Sprint" button

**`AgentWarCard.tsx`** (distinct from existing AgentCard)
- Colored avatar icon by agent type: claude=orange, gemini=blue, gpt=green, user=purple
- Agent name + status badge (active=green, busy=yellow, idle=gray)
- Role badge (if set)
- Current task: title + status (tasks where assignee=name AND status='doing' in sprint)
- Today completions count (done tasks updated today)
- Pending handoff arrow indicator

**`SprintKanban.tsx`**
- 4 columns: Todo / Doing / Review / Done
- Tasks filtered by `sprint_id = selectedSprintId` from project tasks (via `useProjectTasks`)
- Task cards: title, assignee avatar, priority indicator
- Click → open existing task detail
- "Assign to sprint" on unassigned tasks (same project, no sprint_id)

**`CreateSprintModal.tsx`**
- Fields: name (required), goal, start_date, end_date
- Project pre-selected from war room context
- Status defaults to "planning"

### View — `features/sprints/views/SprintWarRoomView.tsx`

```
┌─ Project selector | Sprint selector | [New Sprint] ─────────────────┐
│ SprintHeader (name, goal, progress bar, status, PO gate actions)     │
├─ Agent Cards Grid (2-4 cols responsive) ─────────────────────────────┤
│  AgentWarCard  AgentWarCard  AgentWarCard  AgentWarCard              │
├─ Sprint Kanban ───────────────────────────────────────────────────────┤
│  [Todo]        [Doing]       [Review]      [Done]                    │
│  task card     task card     task card     task card                 │
└───────────────────────────────────────────────────────────────────────┘
```

Data loading:
- `useProjects()` — project selector
- `useProjectSprints(selectedProjectId)` — sprint selector, auto-select active sprint
- `useAgents()` — agent cards (polling 5s)
- `useProjectTasks(selectedProjectId)` — filter client-side by sprint_id
- `useHandoffs({ status: "pending" })` — handoff indicators on agent cards

---

## Step 5 — Page + Route + Nav

**`archon-ui-main/src/pages/SprintsPage.tsx`** (NEW)

**`archon-ui-main/src/App.tsx`** — Add `/sprints` route inside projectsEnabled block

**`archon-ui-main/src/components/layout/Navigation.tsx`** — Add "Sprint War Room" nav item with `Swords` icon from lucide-react, after Handoffs

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `migration/0.1.0/017_agent_role.sql` | CREATE |
| `python/src/server/api_routes/agent_registry_api.py` | EDIT — add role field |
| `python/src/server/services/agent_registry_service.py` | EDIT — pass role through |
| `archon-ui-main/src/features/agents/types/agent.ts` | EDIT — add role field |
| `archon-ui-main/src/features/sprints/types/index.ts` | CREATE |
| `archon-ui-main/src/features/sprints/services/sprintService.ts` | CREATE |
| `archon-ui-main/src/features/sprints/hooks/useSprintQueries.ts` | CREATE |
| `archon-ui-main/src/features/sprints/components/SprintSelector.tsx` | CREATE |
| `archon-ui-main/src/features/sprints/components/SprintHeader.tsx` | CREATE |
| `archon-ui-main/src/features/sprints/components/AgentWarCard.tsx` | CREATE |
| `archon-ui-main/src/features/sprints/components/SprintKanban.tsx` | CREATE |
| `archon-ui-main/src/features/sprints/components/CreateSprintModal.tsx` | CREATE |
| `archon-ui-main/src/features/sprints/views/SprintWarRoomView.tsx` | CREATE |
| `archon-ui-main/src/pages/SprintsPage.tsx` | CREATE |
| `archon-ui-main/src/App.tsx` | EDIT — add /sprints route |
| `archon-ui-main/src/components/layout/Navigation.tsx` | EDIT — add nav item |

---

## Verification Checklist
- [ ] Run `017_agent_role.sql` in Supabase SQL Editor
- [ ] Restart archon-server
- [ ] Open `http://localhost:3737/sprints` — Sprint War Room loads
- [ ] Select a project → create a sprint → assign tasks to sprint
- [ ] Kanban shows sprint tasks in correct columns
- [ ] Agent cards show active agents with their current doing tasks
- [ ] SprintHeader shows correct action button per status + role
  - planning → "Mark Ready for Kickoff"
  - ready_for_kickoff (non-PO) → "Awaiting PO Approval" banner
  - ready_for_kickoff (user/PO) → "Approve & Start Sprint" green button
- [ ] Register agent with role → role badge appears on war room card
