---
name: archon
description: |
  Use when the user wants Codex to run or monitor Archon workflows, initialize
  Archon in a repo, create or edit Archon commands/workflows, inspect Archon CLI
  behavior, or customize Archon for Codex usage rather than handling the task
  directly in the current session.
  Triggers: "use archon", "run archon", "archon workflow", "archon assist",
            "codex archon assist", "have archon handle this", "use archon codex",
            "archon init", "create an archon workflow", "create an archon command",
            "archon config", "archon variables", "archon cli".
  Also use when the user wants help choosing the Codex-safe Archon workflow or
  authoring/customization surface for a task.
  NOT for: Direct local implementation when the user wants Codex to do the work here
  without handing off to Archon or without using Archon surfaces.
---

# Archon Host Skill

This skill tree is mirrored in both:

- `.agents/skills/archon/`
- `.claude/skills/archon/`

Codex and Claude discover different host-skill roots, so both locations exist.
They must stay byte-identical. In this repo, treat `.agents/skills/archon/` as
the authored source and sync the `.claude` mirror whenever the skill changes.

Archon runs long-form workflows through its own CLI and workflow engine. This
mirrored host skill exists to route work into the right Archon workflow from
either outer assistant while keeping provider-specific assumptions explicit.

This skill is intentionally narrower than the full Archon product surface:

- it is Codex-first
- it covers workflow operation, debugging, and Archon customization
- it does not try to duplicate setup/install or broad platform-adapter docs

Direct workflow routing comes first.

- If the task clearly matches a specific Codex-safe workflow, run that workflow.
- Use `archon-assist-codex` only when no narrower Codex-safe workflow fits.
- Do not route guided implementation or interactive review loops through assist
  first just to "get into Archon."

## First Step

Check the available workflows before suggesting or running one:

```bash
archon workflow list --json
```

This is expected to return clean machine-readable JSON on stdout. If it emits
non-JSON chatter before the payload, treat that as an Archon CLI regression and
fall back to human inspection instead of assuming the output is safe to parse.

If `archon` is unavailable, report that the Archon CLI is not installed or not on
`PATH`. Do not perform setup unless the user explicitly asks.

## Routing

Choose the smallest surface that matches the user's need:

| Intent | Action |
| --- | --- |
| pick or run a Codex-safe workflow | continue in this file |
| monitor an active workflow | read `references/monitoring.md` |
| debug a confusing, failed, or stalled run | read `references/log-debugging.md` |
| relay an interactive workflow cleanly | read `references/interactive-workflows.md` |
| initialize `.archon/` in a repo | read `references/repo-init.md` |
| inspect variable substitution | read `references/variables.md` |
| create or edit Archon commands | read `references/authoring-commands.md` |
| create or edit Archon workflow YAML | read `references/workflow-dag.md` |
| inspect Archon CLI surfaces | read `references/cli-commands.md` |
| inspect or modify Archon config | read `references/configuration.md` |
| inspect Codex vs Claude capability boundaries | read `references/codex-capability-crosswalk.md` |

## Codex Naming Convention

Prefer Archon workflows ending in `-codex` when they exist. That suffix indicates
the workflow has been tuned or separated for Codex behavior.

Known Codex-specific lanes in this repo:

- `archon-assist-codex` for general Archon help, debugging, exploration, and
  one-off questions when no narrower Codex-safe lane fits
- `archon-piv-loop-codex` for guided Plan-Implement-Validate workflows with
  Codex

If the user asks for a general Archon task and a Codex-specific workflow exists,
prefer that workflow over the Claude/default variant.

If the user explicitly names a Claude-tuned workflow, respect that request but
warn when the workflow includes Claude-only features that Codex ignores.

## Codex Limitations In Archon

Archon already warns when a Codex workflow node contains Claude-only features.
Plan around those limits instead of assuming they work:

- node-level `skills`
- node-level `hooks`
- node-level `mcp`
- node-level `allowed_tools`
- node-level `denied_tools`

When a workflow relies on those features, prefer a `-codex` workflow if one
exists. Otherwise tell the user the workflow may run with degraded behavior on
Codex.

## Running Workflows

Use explicit workflow names whenever possible.

General Codex assist:

```bash
archon workflow run archon-assist-codex --branch <branch-name> "<message>"
```

Guided Codex PIV:

```bash
archon workflow run archon-piv-loop-codex --branch <branch-name> "<message>"
```

Rules:

1. Use `--branch` unless the user explicitly wants `--no-worktree`.
2. Use descriptive branch names, for example `assist/codex-readme` or
   `piv/codex-auth-refactor`.
3. For substantial implementation work, interactive refinement, or any guided
   human-in-the-loop build request, prefer `archon-piv-loop-codex` over
   `archon-assist-codex`.
4. For read-only questions or exploration, `--no-worktree` is acceptable.
5. Prefer one Archon workflow per command rather than combining unrelated tasks.
6. Treat Archon workflows as long-running jobs. Keep the run ID, working path,
   and current status available for follow-up checks instead of assuming the
   launch command alone is the full observability surface.

## Interactive Operator Protocol

Use this protocol for interactive workflows such as `archon-piv-loop-codex`.

### Launch

1. Run or continue the workflow directly with `archon workflow run ...` or
   `archon continue ...`.
2. Capture:
   - workflow name
   - run ID
   - working path
   - branch name if available
3. Immediately verify the launched run with `archon workflow status --json`.

### State Machine

Treat Codex as the human-facing operator for the workflow run until it reaches a
terminal state.

| Status | Action |
| --- | --- |
| `running` | keep monitoring; report only meaningful changes |
| `paused` | fetch the latest workflow output, relay it directly, wait for the user's answer |
| `completed` | report the terminal result and stop |
| `failed` | report the failure evidence and stop |

### Post-Transition Rule

After every `archon workflow run`, `archon continue`, `archon workflow approve`,
`archon workflow reject`, or `archon workflow resume`:

1. check `archon workflow status --json`
2. if `workflow approve` or `workflow reject` only recorded a decision, continue
   with explicit `archon workflow resume <run-id>`
3. continue until the run is back at one of:
   - `paused`
   - `completed`
   - `failed`

Do not stop after recording approval or rejection alone. In the CLI, those
commands only store the decision; `workflow resume` is the long-running runner
surface. Treat the resume process as the live workflow owner until it pauses
again or reaches a terminal state.

Attached terminal output is not authoritative. If an attached
`archon workflow run` or `archon continue` session goes quiet before a terminal
state, immediately poll `archon workflow status --json`. If the run is
`paused`, relay `metadata.approval.lastOutput` or the latest run-log output in
the current Codex conversation yourself.

### Relay Boundary

Archon's internal CLI conversation is not the same thing as the current outer
Codex UI thread.

- a workflow can pause correctly and persist its question inside Archon without
  creating a new message in the outer Codex conversation
- when status returns to `paused`, fetch the paused prompt and repost it in the
  current Codex conversation yourself
- do not assume the user saw Archon's stdout or the internal worker
  conversation history

### Pause Detection Rule

For interactive loops, treat a new human checkpoint as real only when the run is
currently `paused`.

Track the paused fingerprint:

- `approval.nodeId`
- `approval.iteration`
- `approval.message`

Important nuance:

- approval metadata can persist while the run is `running`
- do not treat `metadata.approval` by itself as proof that the loop has paused again
- workflow truth comes from the current `status`, not from stale approval metadata

### Surface Boundaries

- `archon workflow run ...` is the correct direct CLI surface for interactive workflows
- `archon continue ...` follows the same relay contract and still requires status polling
- `archon chat ...` is single-shot orchestration, not a persistent multi-turn workflow chat
- web foreground runs can resume from natural-language replies in the same thread
- CLI `workflow approve` and `workflow reject` record the decision only; use
  `archon workflow resume <run-id>` explicitly after the status check
- the `workflow resume` process is the live runner; do not kill it while the run
  is still active
- `/workflow approve` is a different surface; do not assume it behaves like the CLI command

## Monitoring

Start with:

```bash
archon workflow status --json
```

Default live-monitoring cadence:

- check once shortly after launch to confirm the run exists
- if the user is actively waiting, re-check about every 30 seconds

Silence in an attached CLI or PTY session is a status-check trigger, not proof
that nothing happened. If the run has not exited and no output arrives for one
monitoring interval, run `archon workflow status --json` before waiting longer.

Rationale:

- the web client already has a 15 second fallback poll, but CLI monitoring is
  heavier because each check is a full Archon CLI invocation with database
  access

State handling:

- `running`: keep monitoring, surface only meaningful progress
- `paused`: read the latest workflow output and relay it transparently
- `completed` or `failed`: report the terminal result and stop polling
- `running` with unchanged `last_activity_at` plus no new JSONL activity for 5
  minutes: report a possible stall, not a confirmed failure

When an interactive workflow pauses, do not summarize the workflow's question.
Read the latest output and pass the user's answer back through the Archon
approval or reject command rather than trying to continue locally.

When a paused checkpoint is tied to a mutable artifact such as a plan-review
loop, reopen the current artifact from disk before relaying any state summary.
Do not assume a previously read file path or artifact contents are still the
latest truth.

If the user explicitly wants unattended follow-up and the current Codex surface
supports thread heartbeat automations, attach one to the current thread and have
it report only meaningful changes: approval gates, terminal state changes, or a
possible stall. If automation is unavailable on the current surface, continue
with in-session polling instead.

Read `references/monitoring.md` for the detailed monitoring contract and
`references/interactive-workflows.md` for the transparent-relay loop.

## Repo Guidance

Do not assume Codex auto-loaded `CLAUDE.md` even if a fallback filename is
configured globally. If repo conventions are load-bearing for the delegated task,
read `CLAUDE.md` explicitly before recommending or running the workflow.

For Archon customization requests, keep the boundary clear:

- use the shared Archon authoring docs for commands, workflows, variables, and
  repo initialization
- use `references/configuration.md` for repo and global Archon config changes
- use `references/codex-capability-crosswalk.md` whenever provider capability
  differences are load-bearing
- do not imply that Claude-only per-node controls automatically become Codex
  node features
- keep `archon chat` documented as single-shot orchestration rather than a
  persistent workflow conversation
