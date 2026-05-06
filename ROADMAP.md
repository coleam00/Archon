# Archon Upgrade Roadmap

This roadmap is for the `shhaider/Archon` fork as a standalone product.

Archon is the baseline product. SimpleAgent, AgentOS-NG, OpenSWE, and Emdash
are reference or extraction candidates only. They are not architecture
authorities for this repo unless a later task explicitly imports a specific
module, workflow, UI surface, or design pattern.

## Product Direction

Archon should become the user-facing system for deterministic AI coding:

- a user chats with one coordinating agent per project or workstream
- the coordinator turns roadmap items into dependency-aware task graphs
- independent work is farmed out to multiple isolated coding agents
- each coding agent works in a branch/worktree sandbox
- results are verified by tests, evidence checks, code review, commit, push,
  and PR creation
- failures, crashes, stuck runs, and bad outputs become Archon improvement
  tasks instead of being treated as one-off operator cleanup

## Source Authority

1. This repo's runtime code and tests.
2. This repo's `CLAUDE.md`, `README.md`, and public roadmap data in
   `packages/docs-web/src/data/roadmap.ts`.
3. Current upstream Archon docs at `https://archon.diy`.
4. Sidecar source checkouts only when explicitly referenced by a task:
   - Emdash for GUI, multi-agent chat, provider/worktree UX, and sandbox design.
   - SimpleAgent and AgentOS-NG for enforceability, gate, memory, and prior
     coding-harness ideas.
   - OpenSWE for LangGraph/deep-agent coding harness patterns.

## Near-Term Priority Order

### P0 - Standalone Repo And Baseline

Status: in progress.

Goals:

- Keep Archon in its own fork/repo: `shhaider/Archon`.
- Treat upstream `coleam00/Archon` as the base product.
- Do not rely on SimpleAgent's roadmap as an Archon roadmap.
- Establish local validation commands for this repo.

Acceptance:

- dedicated Archon checkout exists
- branch and PR target are Archon's `dev` branch
- this roadmap is committed in the Archon repo
- baseline CLI/workflow status is recorded

### P1 - Local GUI Repair And Real-User Verification

Goal: make the Archon web UI the local operator surface for dogfooding Archon
on Archon.

Tasks:

- install/bootstrap dependencies in the Archon checkout
- run the source web/server dev path, not only the binary cache
- verify the Chat, Dashboard, Workflow Builder, and Workflow Execution views
  load
- run at least one real-user browser journey with Playwright or equivalent:
  register the Archon repo, open a chat, start or inspect a workflow, and
  confirm visible workflow state
- record screenshots and console/network failures

Acceptance:

- `bun run dev` or an equivalent split server/web path starts cleanly
- GUI test evidence exists
- server and web logs identify the served source checkout
- GUI failures become concrete bugs on this roadmap

### P2 - Parallel Runtime Reliability

Goal: Archon must safely run several instances at once.

Initial observed bug:

- On 2026-05-06, two concurrent read-only CLI calls against the installed
  SQLite DB produced `Error: database is locked`.

Tasks:

- reproduce the lock with a deterministic test or script
- harden SQLite access for concurrent CLI/server reads and writes
- add busy timeout/WAL handling or retry policy where appropriate
- ensure read-only status/list commands do not fail under normal concurrent
  operation

Acceptance:

- a concurrency regression test fails before the fix and passes after
- concurrent `archon workflow status` / `archon isolation list` style calls
  do not fail with database lock errors
- the fix does not silently mark active workflows failed/cancelled

### P3 - Enforceable Real-Execution Proof

Goal: Archon should never report a coding workflow complete when no real code
was shipped.

Tasks:

- define a coding-result evidence contract:
  changed files, diff, test commands, test output, commit SHA, pushed branch,
  PR URL, and provider/run IDs
- add validation hooks or workflow nodes that block success when required proof
  is missing
- distinguish planning artifacts from real external-coder execution
- add negative tests for fake success and artifact-only success

Acceptance:

- a workflow can require real execution proof before terminal success
- fake or incomplete proof fails deterministically
- PR-producing workflows include evidence in their final summary

### P4 - Multi-Root Coordinator Architecture

Goal: support multiple root-level coordinator conversations, each capable of
dispatching multiple coding workers.

Architecture direction:

- one project may have several root coordinators, each bound to a roadmap,
  phase, or user chat window
- each root coordinator owns a durable task graph with dependencies, claims,
  worker slots, and evidence state
- root coordinators may spawn child planning agents when prompt-pack creation
  becomes the bottleneck
- worker agents remain isolated in branch/worktree environments
- merge and PR activity is serialized by dependency/ownership gates, not by
  hidden chat memory

Tasks:

- model coordinator runs, roadmap tasks, dependencies, worker claims, and
  evidence in the database
- expose status and controls in CLI and Web UI
- add max-parallel worker limits per root coordinator and per repo
- support crash/restart/resume of coordinator-owned task graphs

Acceptance:

- one user can open multiple root chat windows against the same repo
- each root can dispatch independent worker runs without clobbering another
  root's claims
- status surfaces show roots, child workers, dependencies, blockers, and PRs

### P5 - Emdash Feature Evaluation And Selective Port

Goal: borrow the useful Emdash product experience without making Emdash the
backend authority.

Evaluate:

- multi-agent task/conversation UI
- task branch/worktree creation UX
- provider selection and provider status surfaces
- diff, PR, and review UX
- sandbox/worktree trust and cleanup behavior

Decision options:

- selective UI port into Archon's React web app
- separate Emdash adapter/front-end shell for Archon backend APIs
- no port, only extract UX patterns

Acceptance:

- architecture decision record documents import/port/no-port
- any ported feature uses Archon's workflow/coordinator/evidence backend
- no SimpleAgent-only bridge assumptions are imported as authority

### P6 - Sidecar Extraction From SimpleAgent / AgentOS-NG / OpenSWE

Goal: extract proven ideas only after Archon-native gaps are explicit.

Candidate areas:

- gate runner and evidence package patterns
- standards/enforceability checks
- memory/context compaction ideas
- OpenSWE/LangGraph coding-harness lessons
- Project OS style coordination ledgers

Acceptance:

- each extraction has a named Archon gap and a specific target module
- no broad repo fusion happens without an ADR
- LangGraph and YAML workflow designs are treated as separate orchestration
  choices unless an adapter layer is explicitly designed

## Operating Rule For Dogfooding

Use Archon to upgrade Archon, with bounded parallelism.

- run up to five Archon workflow instances at once
- each instance owns an isolated branch/worktree
- if Archon crashes, diagnose the Archon bug, fix it, and resume the blocked
  task
- mistakes made by Archon-generated workers become roadmap tasks or immediate
  fixes depending on severity
- do not close a task on prompt-pack generation alone; real code tasks require
  real code, tests, commit, push, and PR evidence

## Initial Worker Queue

1. P2-A: reproduce and fix concurrent SQLite lock failures.
2. P1-A: bootstrap source GUI and add a real-user GUI smoke journey.
3. P3-A: design and implement real-execution proof validation for PR-producing
   workflows.
4. P4-A: design the coordinator/run/task/claim database model and API surface.
5. P5-A: audit Emdash for GUI/worktree/conversation features worth porting.
