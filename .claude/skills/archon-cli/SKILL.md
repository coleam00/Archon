---
name: archon-cli
description: |
  Drive Archon through its CLI: run AI workflows on a repo, watch and answer the runs
  that need a decision, drive the SDLC pack (label intake, its stages from triage to
  land, the asks they leave, its bindings), set up Archon or change its config, and author and validate workflows.
  Use when the user says "use archon", "run archon", "archon workflow", "fix issue #N
  with archon", "have archon review this PR", "what's running / check run <id>",
  "approve/reject/answer/cancel/resume that run", "triage this issue with the SDLC
  pack", "install the SDLC bindings", "set up archon", "configure archon", "change my archon config",
  "create a workflow", "author a workflow", or asks how to write a better Archon prompt.
  NOT for: doing the coding work yourself. Archon delegates it to isolated runs.
argument-hint: "[workflow | run-id | intent]"
---

# Archon CLI

Archon runs multi-step AI workflows through the `archon` CLI. Git projects run in
isolated worktrees by default; registered folder projects run in place. You sit on
top of the runs: you write the brief, launch, watch one stream, answer the decisions
that reach you, and read what each run left behind.

Route by intent:

| The user wants to... | Read |
|---|---|
| Run a workflow on real work | `operate/running.md` |
| Inspect, answer, cancel or resume runs | `operate/managing-runs.md` |
| Set up the SDLC pack on a project | the pack README's setup guide (see `operate/queues.md`, "Setting up and installing the bindings"), then `operate/queues.md` |
| Drive the SDLC pack, or answer its asks | `operate/queues.md` |
| Find out why a run failed or hangs | `operate/troubleshooting.md` |
| Set up Archon or change config | `setup/setup-and-config.md` |
| Author or change a workflow | `authoring/authoring-workflows.md` (then `node-reference.md` and `variables.md` in the same folder) |
| Improve a node prompt or a run message | `authoring/prompting-mistakes.md` |

- When the intent is clear ("build me a workflow for X", "triage issue #42 with the
  SDLC pack"), go straight to the reference. Do not ask.
- When it is ambiguous, ask which of these the user wants.
- On a machine where `archon doctor` fails, start with `setup/setup-and-config.md`.

## The operating loop

1. **Discover.** `archon workflow list --json` gives compact descriptions. For each
   plausible candidate, read the full description with `archon workflow list <name>
   --full`. Choose from full descriptions, never from names you remember.
2. **Check the brief.** The message, issue body or document the run reads is the
   contract the run is measured against. It must state the problem, why it is worth
   solving, why now, the desired outcome, the invariants and the acceptance. If any
   is missing, say which, propose wording, and get the user's agreement before
   launching. `operate/running.md` has the full check.
3. **Launch detached.** Pass the work as a message, the workflow's declared inputs
   with `--input`, or both:

   ```bash
   archon workflow run <workflow> --branch <branch-name> "<the work>" --detach
   archon workflow run <workflow> --input <name>=<value> --input <name>=<value> --detach
   ```

4. **Watch once.** Run one stream as a background task of your harness, however many
   runs you launched:

   ```bash
   archon workflow attention --watch --json        # this project; add --all for the install
   ```

   Its `needs` field says what a line asks of you: `answer` for an `attention` line that
   wants a decision, `look` for a `terminal` line (a run failed or completed with
   `outcome: "failed"`), and `nothing` for a `resolved` line, which only tells you an
   ask you were shown has closed, so stop working on it. A run that completes otherwise writes no line unless you add
   `--notices`, which also writes the `needs: "nothing"` lines for runs that completed,
   were cancelled or resumed. Or check `archon workflow runs --json`, or block on one run
   with `archon workflow wait <run-id> --json`. Act on the line, then keep reading.
5. **Answer deliberately.** Read the item's question, its recommendation and the
   evidence it links. Answer with a reason, detached:
   `archon workflow respond <run-id> <decision> "<reason>" --detach`.
   Add `--as <name>` on an attention wait so the record says which agent answered.
   `operate/managing-runs.md` covers every form.
6. **Read the result.** A completed run is not a verdict. `archon workflow get
   <run-id> --json` gives the normalized `outcome` and `leave_behind.artifactFiles`.
   Read the report before telling the user what the run concluded.

## Hard rules

- **Never launch on a thin brief.** A weak input does not produce a weak result. It
  produces a confident, well-formed answer to the wrong question, at full price.
- **Launch and answer with `--detach`.** A detached run starts its own session and
  survives your shell. A foreground `respond` or `resume` continues the run inside
  your shell, and closing the shell stops it.
- **Never put a shell `timeout` on a run.** A full pipeline outlasts any wrapper you would pick, and the wrapper kills it mid-node. The task's exit status is then the wrapper's, not the run's, so a killed run can read as success. Launch with `--detach` or as a background task with no timeout, and read `archon workflow get <run-id>` for the real status. A `failed` or `paused` run is resumable: `archon workflow resume <run-id> --detach` skips completed nodes, so resume it instead of relaunching. A killed run can still show `running`; `archon workflow resume <run-id>` continues it too. Resume checks for a live owner first: if one still answers it refuses and names its host and pid, and if the recorded owner is on another host or user it refuses because it cannot ask. To keep a run with a live owner resumable, wait for that process to exit or stop that process yourself, then resume. Do not `archon workflow cancel` it first: cancel ends the run as `cancelled`, and resume refuses a cancelled run. Resume never picks a run for you; find the id with `archon workflow runs` (`--item <key>` narrows it to one item).
- **One watcher, not one per run.** One `workflow attention --watch` stream covers
  every run in scope, including runs that triggers or other sessions start. A
  `workflow wait <run-id>` per run is fine for one or two runs; with dozens it
  contends for the database.
- **Stop work only when you mean to end it.** `archon workflow cancel` stops the run
  mid-node, and that node's provider session and unsaved work are lost. Let a run reach
  its next pause or end when you only want to stop launching more. When one turn is
  stuck on a tool or background command that never finishes, `archon workflow
  end-turn <run-id>` ends that turn and keeps the run (`operate/managing-runs.md`,
  "A stalled turn").
- **Merge only what was reviewed.** When you merge a pull request by hand, pin the
  merge to the reviewed head (`gh pr merge <n> --match-head-commit <sha>`), read the
  open review threads first, and sync your checkout afterwards.
- **Author agent-first.** In a workflow you write, an agent node with typed output
  judges, scripts read facts and act at boundaries, and YAML only wires them.
  `authoring/authoring-workflows.md` ("Agent-first") has the rule and an example.

## Gotchas

- The current directory selects the project for discovery, launches and project
  listings. `workflow status`, `workflow runs` and `workflow attention` default to
  that project; add `--all` for the whole install. For a git project, run from the
  repo root. Register a non-git folder with `workflow run --folder`. A full run ID
  works from any directory.
- Attention items are paused runs. A running run stuck on a stalled tool call is
  not an item: `workflow wait <run-id>` and `workflow status` show it.
- `workflow status` and `workflow runs` set `scopeFallback: true` in JSON when an
  unregistered project produced an install-wide result.
- Prefer `--json` whenever you will parse output.
- `archon --help` is authoritative. If a flag this skill names is rejected, trust the
  CLI's help and tell the user about the drift.
