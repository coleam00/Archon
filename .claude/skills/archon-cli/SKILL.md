---
name: archon-cli
description: |
  Drive Archon through its CLI: run AI workflows on a repo, manage those runs
  (inspect, approve, reject, cancel, resume), set up Archon or change its config,
  author new workflows, and improve workflow prompts. Use when the user says "use archon", "run archon",
  "archon workflow", "fix issue #N with archon", "have archon review this PR",
  "what's running / check run <id>", "approve/reject/cancel/resume that run",
  "set up archon", "configure archon", "change my archon config",
  "create a workflow", "author a workflow", or asks how to write a better Archon prompt.
  NOT for: doing the coding work yourself — Archon delegates it to isolated runs.
argument-hint: "[workflow | run-id | intent]"
---

# Archon CLI

Archon runs multi-step AI workflows through the `archon` CLI. Git projects use
isolated worktrees by default; registered folder projects run in place. This
skill has five capabilities; route by intent:

| User wants to... | Read |
|---|---|
| **Run** workflows on real work | `running-workflows/running-workflows.md` |
| **Manage** existing runs (inspect/approve/reject/cancel/resume) | `manage-run/manage-runs.md` |
| **Set up** Archon or change config | `setup-and-config/setup-and-config.md` |
| **Author** a new workflow | `authoring-workflows/authoring-workflows.md` (+ its `node-reference.md`) |
| **Improve prompts** for workflow nodes or run messages | `prompting-mistakes/prompting-mistakes.md` |

Routing rules:

- Intent is clear from the request ("build me a workflow for X", "run archon-ship
  on issue #42") → route directly. Do not ask.
- Genuinely ambiguous → ask the user which capability they want, listing these five.
- First contact with an unconfigured machine → `setup-and-config/setup-and-config.md` before anything else.

## Quick spine: running a workflow

Most requests land here. The short version; details in the running reference:

1. Discover what exists: `archon workflow list`. Map the user's intent to a workflow
   by reading descriptions — never assume names from memory.
2. Invoke detached by default (workflows are long-running):

   ```bash
   archon workflow run <workflow> --branch <branch-name> "<the work, as a clear message>" --detach
   ```

3. Find the run id and monitor: `archon workflow runs --json`, then
   `archon workflow get <run-id> --json`.
4. When a run pauses at a gate, resolve it deliberately:
   see `manage-run/manage-runs.md`.

Three hard rules:

- A fresh launch of an interactive-class workflow refuses `--detach`. Run that
  launch in the foreground as a background *task* of your harness. Once the run
  pauses, `resume`/`approve`/`reject`/`respond --detach` are supported continuation
  actions.
- Prefer `--detach` if the workflow is not interactive.
- One workflow per shell; multiple tasks = separate invocations, separate branches.

## Gotchas

- The current directory scopes every command to that project. For a git project,
  run from the repo root. Register a non-git project with `workflow run --folder`.
- A completed run does not mean the work succeeded. Use `workflow get <run-id>
  --json` for the normalized `outcome` and `leave_behind.artifactFiles`; use a
  separate `--verbose --json` call for node summaries.
- Prefer `--json` whenever you will parse output.

## Resources

- `running-workflows/running-workflows.md` — discovery, invocation, isolation, monitoring
- `manage-run/manage-runs.md` — every run-control verb, gate semantics, JSON shapes
- `manage-run/troubleshooting.md` — log locations, JSONL event types, jq recipes
- `setup-and-config/setup-and-config.md` — install, doctor, config.yaml scopes, provider auth
- `authoring-workflows/authoring-workflows.md` — designing a workflow: primitives, gates, prompts
- `prompting-mistakes/prompting-mistakes.md` — common prompt mistakes, for authored nodes and
  for the messages you pass when invoking workflows
