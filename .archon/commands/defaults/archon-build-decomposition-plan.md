---
description: Read an Epic's spec attachments and produce a structured JSON decomposition plan listing the tasks/stories to create as Jira tickets.
argument-hint: (none - reads epic-context, attachments, and TechSpec from $ARTIFACTS_DIR)
---

Build a task decomposition plan for this Epic.

Inputs (read from artifacts):
- `$ARTIFACTS_DIR/trigger-payload.json` — Epic key + project.
- `$ARTIFACTS_DIR/epic-context.md` — Epic summary + full description.
- `$ARTIFACTS_DIR/attachments.md` — Concatenated text content of every
  retrievable attachment (TechSpec, DesignDoc, style guide, etc.).
- `$ARTIFACTS_DIR/attachment-inventory.json` — Machine-readable
  attachment list.

Build a plan in this exact JSON shape:
{
  "epic_key": "string",
  "epic_title": "string",
  "planning_assumptions": ["string"],
  "dependency_graph_notes": "string",
  "tasks": [
    {
      "task_id": "T1",
      "title": "string",
      "summary": "string",
      "acceptance_criteria": ["string"],
      "depends_on": ["T#"],
      "suggested_jira_type": "Task",
      "original_estimate_minutes": 60
    }
  ]
}

Rules:
- Decompose the Epic into the SMALLEST tasks that are independently
  executable. Prefer many small tasks over few large ones.
- Cover every implementation domain mentioned in the source
  material (PRD, TechSpec, DesignDoc): scaffolding, schema, auth,
  each user-facing feature, accessibility, error states, tests.
- `depends_on` MUST form a valid DAG. The first task should be
  scaffolding/setup with empty `depends_on`. Most other tasks
  should declare at least one blocker.
- Task IDs are stable labels: T1, T2, T3, ... in plan order.
- `suggested_jira_type` must be one of: Task, Story, Bug.
- `acceptance_criteria` should be testable, concrete, and
  traceable back to the source PRD/spec.
- `original_estimate_minutes` is your good-faith estimate of how long
  an autonomous agent will spend on this task end-to-end (test
  generation + implementation + review + merge). Calibration:
    * Trivial scaffolding/config: 15-30
    * One small CRUD endpoint or simple UI component: 30-60
    * One AC-rich feature with non-trivial logic or AI integration: 60-120
    * Cross-cutting concerns (privacy filter, accessibility pass): 120-240
    * Heavy E2E test suite: 60-120
  Estimates feed Jira's time-tracking reports — they are the visible
  record of how this autonomous system is allocating effort. Be
  thoughtful, not generic.

Write the final JSON to `$ARTIFACTS_DIR/decomposition-plan.json`
(pretty JSON, 2-space indent).

AFTER WRITING, verify the file is on disk: run `ls -la
$ARTIFACTS_DIR/decomposition-plan.json` via the Bash tool and
confirm the size is non-zero. Do NOT return until this check passes.

Narrate as you go: explain what you are reading, what assumptions
you are making, what the major decomposition decisions are, and any
tricky tradeoffs. The user is watching and wants visibility into your
planning. Then return the STRICT JSON pointer below as the LAST line
of your response.

Return JSON pointer at the end:
{ "plan_json": "$ARTIFACTS_DIR/decomposition-plan.json" }

  # --- Plumbing: render plan JSON to plan markdown for human readability ---
