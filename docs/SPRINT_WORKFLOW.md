# Sprint Workflow Guide

> Step-by-step operational guide for running an Agile iteration using Archon.
> Reference `PRPs/ai_docs/AGILE_WORKFLOW.md` for concept mapping and tool reference.

---

## What Is a Sprint?

A sprint is a **focused session or named week** during which agents commit to completing a defined set of stories (Archon tasks). Sprints have no dedicated Archon field — they are tracked via task `description` prefixes and titles.

**Sprint identifier format:** `Week of YYYY-MM-DD` (Monday of the week)

---

## Sprint Ceremonies

### 1. Sprint Planning

**Goal:** Select tasks from the backlog and assign them for the sprint.

```
# List the full backlog, sorted by priority
archon_list_tasks(status="todo")

# For each task chosen for the sprint:
# 1. Add sprint prefix to description
archon_update_task(
  task_id="<uuid>",
  description="[Sprint: Week of YYYY-MM-DD]\n\n<original description>"
)

# 2. Assign to the appropriate agent
archon_update_task(task_id="<uuid>", assignee="<agent>", priority="<priority>")
```

**Output:** A set of tasks with `[Sprint: Week of YYYY-MM-DD]` in their description and an assigned agent.

---

### 2. Daily Check-in

**Goal:** Confirm active work is progressing; surface blockers early.

```
# See all tasks currently in progress
archon_list_tasks(status="doing")

# Review each task's description for blockers ([BLOCKED: ...])
# If a task is blocked, update description with reason and create a blocker task:
archon_add_task(
  title="[BLOCKER] <description of what is needed>",
  description="Blocking: <task_id>\nReason: <reason>",
  assignee="<blocking-agent-or-user>",
  priority="high"
)
```

Also check for tasks awaiting sign-off:

```
# See tasks pending review/approval
archon_list_tasks(status="review")

# Approve: complete the task, or send back to "doing" if rework needed
```

> **Note:** The `review` status is optional — only used when a task requires explicit PO or Lead Developer sign-off before closing.

**Output:** Blockers surfaced and escalated to `user` or reassigned agent.

---

### 3. Sprint Review

**Goal:** Summarize what was completed during the sprint.

```
# List all completed tasks
archon_list_tasks(status="done")

# Filter by sprint: look for "[Sprint: Week of YYYY-MM-DD]" in descriptions
# Review each done task against its original acceptance criteria
```

**Output:** A verbal or written summary of delivered stories, shared with `user` (Product Owner).

---

### 4. Sprint Retrospective

**Goal:** Capture learnings and create follow-on actions in Archon.

```
# Create a Retro task with findings
archon_add_task(
  title="[Retro] Week of YYYY-MM-DD — findings and actions",
  description="## What went well\n- ...\n\n## What to improve\n- ...\n\n## Action items\n- [ ] ...",
  assignee="claude",
  priority="low"
)
```

**Output:** A `[Retro]` task capturing institutional knowledge for future sprints.

---

## Cross-Agent Handoff Protocol

When a task transfers between agents mid-sprint:

1. Update description with `[HANDOFF → <target-agent>]` header and current status.
2. Change `assignee` to target agent.
3. Do **not** call `archon_complete_task` — leave status as `doing`.
4. The target agent will discover the task on their next `archon_list_tasks(status="doing")` poll. To make the handoff visible immediately, prefix the description with `[NOTIFY: <target-agent>]` — the agent's session hook will surface this on their next check-in.

```
archon_update_task(
  task_id="<uuid>",
  assignee="gemini",
  description="[HANDOFF → gemini]\nStatus: backend done, frontend pending.\n\n<original description>"
)
```

---

## Sprint Health Indicators

| Signal | Meaning | Action |
|--------|---------|--------|
| > 3 tasks in `doing` per agent | Overloaded | Deprioritize or move tasks back to backlog |
| Task in `doing` > 2 days with no update | Stale / blocked | Check in, update description with current status |
| No `done` tasks after Day 3 | At risk | Raise with `user`, reduce scope |
| `[BLOCKED]` tasks growing | Systemic blocker | Escalate immediately |

---

## References

- Agile ↔ Archon mapping: `PRPs/ai_docs/AGILE_WORKFLOW.md`
- Definition of Done: `docs/DEFINITION_OF_DONE.md`
- Agent roles: `AGENTS.md`
