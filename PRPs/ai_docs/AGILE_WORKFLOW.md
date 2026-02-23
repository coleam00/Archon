# Agile ↔ Archon Mapping (Rosetta Stone)

> Canonical reference for how Agile concepts map to Archon data structures and MCP tools.
> All swarm agents must ground their workflow in this document.

---

## Concept Mapping

| Agile Concept | Archon Equivalent | Notes |
|---------------|-------------------|-------|
| **Epic** | Archon Project | A project groups related stories. Query: `archon_list_tasks(status="todo")` filtered by project. |
| **User Story** | Archon Task (`status: todo`) | One deliverable unit of work for a single agent or pair. |
| **Sprint** | `archon_sprints` table | Full DB record: name, goal, status lifecycle, start/end dates, linked tasks via `sprint_id`. See `SPRINT_LIFECYCLE.md`. |
| **Task / Sub-task** | Checklist inside task `description` | Use markdown `- [ ]` checkboxes in the `description` field. |
| **Backlog** | All `todo` tasks sorted by `priority` | `archon_list_tasks(status="todo")`. High priority = top of list. |
| **Work In Progress** | Tasks with `status: doing` | `archon_list_tasks(status="doing")`. |
| **Done** | Tasks with `status: done` | Only set after Definition of Done is satisfied. See `docs/DEFINITION_OF_DONE.md`. |
| **Review** | Tasks with `status: review` | Task awaiting sign-off from Lead Developer or PO before closing. |
| **Blocked** | Task marked in `description` | Prepend `[BLOCKED: reason]` to description. Create a dependency task if needed. |
| **Handoff** | Handover note in `description` + reassign `assignee` | Leave context for the next agent before changing assignee. |

---

## Agent Identity → Agile Role

| Agent | Agile Role | Responsibilities |
|-------|-----------|------------------|
| `user` | **Product Owner** | Priority calls, sprint approval gate, final sign-off — the only agent that can activate a sprint |
| `claude` | Software Developer | Task execution, architecture, implementation |
| `claude-opus` | Tech Lead | Design decisions, code review, unblocking |
| `gemini` | QA Tester | Testing, validation, browser compat |
| `gpt` | Scrum Master | Facilitation, sprint planning, impediment removal |

---

## Lifecycle Diagram

```
Backlog (todo)
     │
     │  archon_start_task(task_id)
     │  + set assignee to self
     ▼
In Progress (doing)
     │
     │  Work → satisfy DoD checklist
     │  (docs/DEFINITION_OF_DONE.md)
     ▼
Review (review)  ← optional: only when task needs PO/Lead sign-off
     │
     │  Approved by Lead Developer or PO
     ▼
Done (done)
     │
     │  archon_complete_task(task_id)
     ▼
Closed ✓
```

---

## MCP Tool Reference

All swarm agents interact with Archon via these tools:

| Action | Tool | Example |
|--------|------|---------|
| List backlog | `archon_list_tasks` | `archon_list_tasks(status="todo")` |
| Get task details | `archon_get_task` | `archon_get_task(task_id="<uuid>")` |
| Claim a task | `archon_start_task` | `archon_start_task(task_id="<uuid>")` |
| Update description / assignee | `archon_update_task` | `archon_update_task(task_id="<uuid>", assignee="claude", description="...")` |
| Complete a task | `archon_complete_task` | `archon_complete_task(task_id="<uuid>")` |
| Create a new task | `archon_add_task` | `archon_add_task(title="...", description="...", assignee="claude", priority="medium")` |

> **Tool name context**: These names (`archon_list_tasks`, `archon_start_task`, etc.) are the **Claude Code MCP proxy** names. If you are a non-Claude agent connecting to Archon MCP directly (port 8051), use `archon:find_tasks` (for list/search/get) and `archon:manage_task` (for create/update/delete) instead.

---

## Standard Workflow (Pick Up → Work → Complete)

```
1. archon_list_tasks(status="todo")
   → Pick the highest-priority unowned task
   → Scan results: skip tasks where `assignee` is already set.
     Pick the highest-priority task with a null/empty assignee.

2. archon_start_task(task_id="<uuid>")
   → Status becomes "doing"

3. archon_update_task(task_id="<uuid>", assignee="<your-agent-id>")
   → Claim ownership. Do this immediately after step 2 to minimise the
     window where the task is "doing" but unowned. You can combine
     assignee + description updates into a single call.

4. Execute the work described in the task

5. Verify every item in docs/DEFINITION_OF_DONE.md

6. archon_complete_task(task_id="<uuid>")
   → Status becomes "done"
```

---

## Sprint Lifecycle

Sprints follow a strict status progression. See `SPRINT_LIFECYCLE.md` for the full spec.

```
planning → ready_for_kickoff → active → completed
                                      → cancelled
```

**Key rule:** Only the `user` (Product Owner) can transition a sprint from `ready_for_kickoff` → `active`. No AI agent can bypass this gate.

---

## Cross-Agent Handoffs

When you cannot finish a task and another agent must continue:

1. Leave a handover note at the **top** of the `description`:
   ```
   [HANDOFF → gemini]
   Status as of 2026-02-22: completed backend, frontend pending.
   Next: implement UI in archon-ui-main/src/features/...
   ```
2. Update `assignee` to the target agent:
   `archon_update_task(task_id="<uuid>", assignee="gemini", description="<updated>")`
3. Do **not** call `archon_complete_task` — leave it in `doing`.

---

## Priority Values

| Priority | When to use |
|----------|-------------|
| `high` | Blocking other agents or sprint goal at risk |
| `medium` | Standard story (default) |
| `low` | Nice-to-have, deferred |

---

## References

- Operational sprint guide: `docs/SPRINT_WORKFLOW.md`
- Definition of Done: `docs/DEFINITION_OF_DONE.md`
- Agent roles (full context): `AGENTS.md`
- Archon MCP tool patterns: `PRPs/ai_docs/ARCHITECTURE.md`
