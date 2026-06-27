# WDS Shared Activation Steps

Common startup sequence for all WDS agents (Saga, Freya, Mimir).
Each agent's SKILL.md references this file instead of repeating these steps.

---

## Step: sync

Read `~/.claude/wds/tools/sync/SKILL.md` and run it in silent mode.

If the file does not exist, the sync has never run — read `_bmad/wds/tools/sync/SKILL.md`
from the current project instead and run it. This handles first activation after BMad install.

Continue regardless of sync outcome. Never block activation on sync.

---

## Step: state

Check for session state. Read `~/.claude/wds/tools/memory/SKILL.md` and follow
the `load` operation for the current agent_id.

If state found: show resume prompt. Wait for user response before continuing.

---

## Step: scan

Scan workspace for WDS projects:

- Find repos with `_progress/wds-project-outline.yaml` or `_progress/00-design-log.md`
- Skip system repos (bmad-method-wds-expansion, whiteport-design-studio)
- For each project: read design log, note phase status and in-progress work
- Also check current directory for design process folders (A-Product-Brief/ through E-Development/)

---

## Step: select

IF multiple projects found with open work: list them, ask which to work on.
IF single project: continue to agent-specific activation.

---

## Step: brownfield-detect

Check if the project has a codebase (src/, backend/, app/, or similar code folders at root).
IF codebase found → agent-specific brownfield handling.
IF no codebase → agent-specific greenfield flow.
