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

1. Discover what exists with the compact catalog: `archon workflow list --json`. Use its
   previews to identify plausible candidates, and treat `descriptionTruncated: true` as an
   explicit signal that a description is incomplete — never assume names from memory.
2. Fetch each plausible candidate's untouched description with `archon workflow list
   <name> --full`. Choose from the full descriptions, not a truncated preview.
3. **Check the input before spending anything.** The message (or the issue, or the
   document the run reads) is the contract the whole run is measured against. Hold it
   against the six in `running-workflows.md` — problem, why it matters, why now,
   outcome, invariants, acceptance. If any is missing, say which, propose a corrected
   input, and get the user's agreement before launching. Do not silently improve it,
   and do not launch anyway.
4. Invoke detached by default (workflows are long-running):

   ```bash
   archon workflow run <workflow> --branch <branch-name> "<the work, as a clear message>" --detach
   ```

5. Find the run id (`archon workflow runs --json`), then arm
   `archon workflow wait <run-id> --json` as a background task of your harness —
   it blocks until the run ends or needs a human decision, waking you at exactly
   the right moment. `archon workflow get <run-id> --json` is for on-demand state,
   not a polling loop.
6. When a run pauses at a gate, resolve it deliberately:
   see `manage-run/manage-runs.md`.

Four hard rules:

- Never launch against a thin brief. A weak input does not produce a weak result — it
  produces a confident, well-formed answer to the wrong question, at full price.

- A fresh launch of an interactive-class workflow refuses `--detach`. Run that
  launch in the foreground as a background *task* of your harness. Once the run
  pauses, `resume`/`approve`/`reject`/`respond --detach` are supported continuation
  actions.
- Prefer `--detach` if the workflow is not interactive.
- One workflow per shell; multiple tasks = separate invocations, separate branches.

## Gotchas

- The current directory selects the project for workflow discovery, launches, and
  project listings. `workflow status` and `workflow runs` default to that project;
  use `--all` only when install-wide visibility is intended. Their JSON output sets
  `scopeFallback: true` when an unregistered project produces an install-wide result.
  `workflow status` fails if the registry lookup itself fails; it does not disguise
  the error as an unregistered-project fallback. Commands given a full run ID remain
  globally addressable. For a git project, run from the repo root. Register a non-git
  project with `workflow run --folder`.
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
