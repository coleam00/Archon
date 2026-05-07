# Archie — Product Requirements Document

**Status:** Draft v0.1 — written 2026-05-07 to capture the system as it exists today, not as future aspiration. Sections marked _(future)_ are explicit deltas from current behavior.

**Author:** Josh Rossi + Claude (collaborative authoring during ConflictCoach run 1).

---

## 1. What Archie is

**Archie is a single-developer autonomous SDLC pipeline.** A human (the "owner") authors a Jira Epic with a PRD, TechSpec, design doc, and acceptance criteria; Archie decomposes the Epic into ordered child tickets and then drives each ticket through grooming → contract → tests → implementation → review → merge → done with deterministic gates between every station. The owner does not write code, write tests, run tests, open PRs, review PRs, or transition Jira tickets in the normal flow. They author intent, watch, intervene when Archie surfaces a label-coded pause, and unstick edge cases.

**Archie is built on Archon.** Archon is a generic agentic-workflow runtime: DAGs of `command:` / `prompt:` / `bash:` / `script:` / `loop:` / `approval:` nodes, with worktree isolation, structured `$node.output` substitution, and pluggable AI providers (Claude, Codex, Pi). Archie is a specific configuration of Archon: a set of YAML workflows (`epic-decompose`, `task-tests`, `task-implement`, `task-done`, `bug-pipeline`, `jira-router`), per-station prompt files in `.archon/commands/`, deterministic helper scripts in `.archon/scripts/`, and a Jira webhook adapter that wires Jira events to those workflows. Archon is the engine; Archie is the production line.

**Archie's defining shape is the Toyota Production System "Jidoka" station model.** Each agent does one thing and only one thing. Deterministic gates (lint, typecheck, vitest, Playwright, contract checks) run between every station. Quality is built in at each station, not inspected at the end. When a station fails, the line stops, a label goes on the ticket, and the human is the only one allowed to restart it.

---

## 2. Why Archie exists

### 2.1 Problem

A capable solo developer using AI tools today moves through a roughly fixed loop: write a ticket, paste it into an AI, copy the output back, run tests, paste failures back to the AI, hand-tweak, open a PR, review it themselves, merge, repeat. Each step is at most a few minutes; in aggregate, an Epic of ~10 tickets is days of pure context-switching. The bottleneck is not capability — modern coding agents can write production-quality React, TypeScript, and tests — it is **transcription, coordination, and supervision overhead** between agents.

### 2.2 Hypothesis

If we put the AI work behind a deterministic conveyor belt — events drive transitions, agents are scoped to single stations, gates between agents are objective, and humans interact only with the ticket queue — the owner can author intent on Friday and find an Epic of merged PRs on Monday. The owner's role shifts from "operator of agents" to "product manager + line supervisor."

### 2.3 Non-goals

- **Multi-tenant SaaS.** Archie is single-developer. Multi-tenant complexity (auth roles, billing, isolation between users) is explicitly excluded.
- **A new IDE or chat UI.** The human interface is Jira (queue + comments + labels) and GitHub (PRs + branches). No bespoke front end.
- **Human replacement.** Archie raises the floor of what one person can ship; it does not eliminate judgment, taste, or accountability. The owner reads PRs, reads merge conflicts, and decides when the line should pause.
- **Replacing the engineering process.** Archie does not write the PRD, decide the architecture, or pick the tech stack. Those are the owner's job.
- **Generic CI replacement.** Archie's gates run inside Archon during the agent loop; the project's GitHub Actions still run on the resulting PRs. Archie does not replace CI/CD.

---

## 3. Users and the user journey

### 3.1 Personas

There is one primary persona: **the Owner.**

The Owner is a single experienced engineer who:
- Has authored a PRD and TechSpec for a green-field or extension project.
- Wants to ship product without writing all the code themselves.
- Is comfortable with Jira, GitHub, terminal, and reading code.
- Cannot afford (or doesn't want) a team. The point of Archie is to replace 1–4 hires.

Implicit secondary "personas" exist inside the system but are not human: the dev agent, the test-gen agent, the contract author, the reviewers, the synthesizer, the test-repair agent. Their shape and constraints are part of the spec because they are what the Owner is conceptually managing.

### 3.2 Journey

1. **Setup (one-time per project).** Owner registers the codebase in Archon (clone or symlink), wires Jira webhooks to the Archon server, fills `.env` with credentials, and authors PRD + TechSpec + design docs as Jira Epic attachments.
2. **Author Epic.** Owner creates a Jira Epic with description, attaches PRD/TechSpec/style guide. The Epic stays in Backlog while authoring is in flight.
3. **Promote Epic to Selected for Development.** This is the Owner's signal "go." Archie's `epic-decompose` workflow fires: it reads the Epic + attachments, produces a decomposition plan (an ordered list of child tickets with `Blocks` dependencies), creates each child ticket in Jira labeled `archon-blocked-pending`, wires Blocks links, then strips the label from root tasks (no blockers) and transitions them to Selected for Development. Children with blockers stay in Backlog with the label removed, awaiting their dependencies.
4. **Per-ticket flow (automatic).** Each child ticket transitioning Backlog → Selected for Development triggers `task-tests` (grooming + contract + failing-test commit) → ticket transitions to In Progress → `task-implement` runs (5-attempt dev loop with deterministic gates after each, reviewer after each, then a final implementation-quality reviewer, then optional test-side salvage, then docs generation, then PR open, then code/scope/error/comment/docs reviewers in parallel, then synthesis, then conditional auto-fix, then merge, then `task-done`).
5. **Owner observation.** Owner watches Jira's Selected → In Progress → Done flow. PRs appear in GitHub with the ticket link in the description. Tests pass. CI is green. Merges happen automatically (when the repo is configured for `gh pr merge --auto`).
6. **Pause signals.** When something needs human judgment, Archie either:
   - Adds the `archon-blocked-pending` label and pauses the ticket in Backlog, OR
   - Transitions the ticket back to Backlog with a comment explaining what failed, OR
   - Leaves the PR open with reviewer feedback as a comment and stops short of merging.
   The Owner is expected to read, decide, and unstick.
7. **Done.** The ticket reaches Done; `task-done` deletes the outward Blocks links so dependents are unblocked, sweeps the project for tickets whose blockers are now all Done and promotes them to Selected for Development, and rolls up the parent Epic to Done if all children are Done.
8. **Bug tickets.** When the Owner files a Bug ticket and promotes it Backlog → Selected for Development, the `bug-pipeline` workflow fires (groom + contract + test-strategy + red-bar test commit) and then transitions to In Progress, where `task-implement` takes over identically to a Story.

---

## 4. System architecture

### 4.1 Components

```
┌─────────────────────────────────────────────────────────────────┐
│                      Owner                                      │
│  Jira (intent, queue, labels)         GitHub (PRs, code review) │
└──────────┬───────────────────────────────────────┬──────────────┘
           │ webhooks                              │
           ▼                                       │
┌──────────────────────┐                           │
│  Jira webhook        │                           │
│  adapter             │                           │
│  (packages/adapters/ │                           │
│   .../forge/jira/)   │                           │
└──────────┬───────────┘                           │
           │ synthesizes /workflow run jira-router │
           ▼                                       │
┌──────────────────────┐                           │
│  jira-router.yaml    │                           │
│  (decode + dispatch) │                           │
└──────────┬───────────┘                           │
           │ nohup background dispatch             │
           ▼                                       │
┌────────────────────────────────────────────┐     │
│  Per-ticket workflow                       │     │
│  • epic-decompose                          │     │
│  • task-tests                              │     │
│  • task-implement (the meat)               │─────┘
│  • task-done                               │
│  • bug-pipeline                            │
└──────────┬─────────────────────────────────┘
           │ uses Archon engine for           
           │   - DAG execution                
           │   - worktree isolation           
           │   - $node.output substitution    
           │   - AI provider routing          
           ▼
┌──────────────────────┐
│  Archon runtime      │
│  (Bun + TS + SQLite) │
└──────────────────────┘
```

### 4.2 Workflow inventory

| Workflow | Trigger | Output |
|---|---|---|
| `epic-decompose` | Epic transitions Backlog → Selected for Development | N child tickets created in Jira with Blocks links; root tasks promoted |
| `task-tests` | Story / Task ticket transitions Backlog → Selected for Development | Contract artifact, grooming comment, red-bar test commit pushed to feature branch; ticket transitions to In Progress |
| `task-implement` | Story / Task / Bug ticket transitions to In Progress | PR opened, reviewers run, synthesis, optional auto-fix, merge, ticket transitions to Done |
| `task-done` | Ticket transitions to Done | Outward Blocks deleted, project swept for newly-unblocked tickets, parent Epic rolled up if all children Done |
| `bug-pipeline` | Bug ticket transitions Backlog → Selected for Development | Same as task-tests but bug-shaped: groom, contract, test-gap analysis, red-bar test commit; transitions to In Progress |
| `jira-router` | Every Jira webhook event | Decodes payload, dispatches the correct downstream workflow, no-op for events that don't match |

### 4.3 The dev loop inside `task-implement`

This is the heart of Archie. Up to 5 attempts, each shaped:

```
┌────────────────────────────────────────────────────────────────┐
│ Attempt N (1..5)                                               │
│                                                                │
│  dev-attempt-N  ──► test-N (vitest, lint, tsc, playwright)     │
│       │                │                                       │
│       │                ▼                                       │
│       │         validate-N  (parses test output → passed?)     │
│       │                │                                       │
│       ▼                ▼                                       │
│  review-dev-attempt-N (reviewer agent reads diff + feedback,   │
│   conditional on validate-N.passed == false                    │
│   OR parse-dev-review-(N-1).passed == false)                   │
│       │                                                        │
│       ▼                                                        │
│  parse-dev-review-N (extracts {passed, required_repairs} JSON) │
│       │                                                        │
│       └── if both gates green: skip remaining attempts         │
│           (downstream substitutions resolve to empty)          │
└────────────────────────────────────────────────────────────────┘
                               │
                               ▼
                implementation-quality-final
                  (reviewer's verdict snapshotted to
                   dev-review-final.json,
                   classified failure_scope:
                   none|production|tests|mixed)
                               │
              ┌────────────────┴───────────────┐
              │ scope == tests                 │ otherwise
              ▼                                ▼
   repair-tests-from-final-review       (no salvage)
              │
              ▼
   validate-after-test-repair
              │
              ▼
        implementation-ready  (consolidates: validation passed?
                              quality reviewer passed?
                              test-salvage saved it?
                              → ready: true|false)
              │
        ┌─────┴─────┐
        │ ready     │ not ready
        ▼           ▼
   generate-docs   fail-implementation-not-ready
   open-pr            (label ticket archon-blocked-pending,
        │              comment, exit nonzero)
        ▼
   verify-pr-ready
        │
        ▼
   ┌─────────── parallel reviewers ────────────┐
   │  review-code  review-scope  review-docs   │
   │  review-error-handling  review-comment-quality │
   └────────────────────┬──────────────────────┘
                        ▼
                synthesize  (aggregates all reviewer
                              verdicts into a single
                              decision: approved | changes_requested)
                        │
                ┌───────┴───────┐
                │ approved      │ changes_requested
                ▼               ▼
             merge-pr      auto-fix loop (bounded)
                              │
                              └─► back to merge-pr or fail
```

### 4.4 Data model

Archon's database (SQLite by default, Postgres optional) tracks:

- **codebases** — registered repositories (clone URL or symlinked local path).
- **conversations** — per-platform conversation IDs (for Jira: the issue key, e.g. `WOR-123`).
- **sessions** — AI SDK sessions, immutable, with explicit `TransitionTrigger` reasons.
- **isolation_environments** — git worktrees per active workflow run.
- **workflow_runs** — execution state (status, current step, started_at, last_activity_at).
- **workflow_events** — per-node events: started, completed, skipped, failed, with structured `data` JSON.
- **messages** — full conversation history with tool-call metadata.
- **codebase_env_vars** — per-project env vars injected into project-scoped execution surfaces.

Outside Archon's DB, Archie uses two filesystem layers:

- **Workspace per codebase** at `~/.archon/workspaces/owner/repo/`: source clone or symlink, `worktrees/` for isolation, `artifacts/runs/{id}/` for per-run artifacts (contract, feedback.json, dev-review-*.json, instructions.md, attachments), and `logs/` for JSONL execution logs.
- **Repo-level config** at `<repo>/.archon/`: `commands/`, `workflows/`, `scripts/` overrides; `state/` for cross-run workflow state; `config.yaml` for repo-specific options.

### 4.5 Jira event interface

| Event | Trigger | Workflow fired |
|---|---|---|
| Issue transitioned to Selected for Development | type=Epic, from=Backlog | epic-decompose |
| Issue transitioned to Selected for Development | type=Story \| Task, from=Backlog | task-tests |
| Issue transitioned to Selected for Development | type=Bug, from=Backlog | bug-pipeline |
| Issue transitioned to In Progress | type=Story \| Task \| Bug | task-implement |
| Issue transitioned to Done | any type | task-done |
| Issue created / content_changed | any type | jira-router (no-op or attachment refresh) |

The router workflow's `when:` conditions enforce this matrix; the Jira adapter is dumb and only synthesizes the `/workflow run jira-router <base64-payload>` slash command from any incoming webhook.

### 4.6 Pause / human-needed signals

| Signal | Set by | Means |
|---|---|---|
| `archon-blocked-pending` label | `epic-decompose` (children awaiting blockers); `fail-implementation-not-ready` (dev loop exhausted); manual | Pipeline ignores this ticket. JQL sweeps in `task-done` exclude it. Human removes label by hand. |
| Ticket transitioned back to Backlog | `bug-pipeline` on grooming failure | Owner reads the comment, edits the ticket, re-promotes when ready. |
| PR open with reviewer changes-requested verdict | `synthesize` when auto-fix budget exhausted | Owner reads the synthesized review, decides whether to fix and resubmit or close. |

---

## 5. Detailed requirements

### 5.1 Functional requirements

#### F1. Epic decomposition
- **F1.1** Given a Jira Epic with PRD/TechSpec/design-doc attachments and a transition Backlog → Selected for Development, the system MUST produce a decomposition plan as a structured artifact (`tasks: [{task_id, summary, description, acceptance_criteria, blocked_by}]`).
- **F1.2** The system MUST create each task as a Jira ticket linked to the Epic (Epic Link field), labeled `archon-blocked-pending`, with `Blocks` issue links matching `blocked_by`.
- **F1.3** The system MUST strip `archon-blocked-pending` from root tasks (no blockers) and transition them to Selected for Development.
- **F1.4** The system MUST strip `archon-blocked-pending` from non-root tasks but leave them in Backlog.
- **F1.5** The system MUST be idempotent: re-running on the same Epic must not create duplicate tickets (use a marker on the Epic to record decomposition has run).

#### F2. Test authoring (task-tests / bug-pipeline)
- **F2.1** Before any production code is written, a contract artifact MUST be authored that names every file, export, signature, and invariant the implementation will be measured against.
- **F2.2** A failing-test commit MUST be pushed to the feature branch — tests that exercise the contract and ACs and fail against `main`.
- **F2.3** The contract MUST be the canonical source of truth read by every downstream agent (dev, reviewer, test-repair). Disagreements between the contract and validation feedback are resolved in favor of the contract.
- **F2.4** _(future)_ Contract authoring MUST classify each declared action as public or internal at contract time, so reviewer can flag missing auth on public actions.

#### F3. Dev loop (task-implement)
- **F3.1** The dev agent MUST be cage-restricted to writing production source only — never tests, fixtures, or generated files. The cage is enforced by per-tool hook scripts (`PreToolUse`) executed by Archon, not by prompt text.
- **F3.2** The dev loop MUST execute up to 5 attempts; an early-converged attempt skips downstream attempts via DAG `when:` conditions, not by manual loop count.
- **F3.3** Between every dev attempt and the next reviewer call, deterministic gates (vitest blocking; lint/typecheck/playwright non-blocking but reported) MUST run and their JSON output MUST be the input to both the validator and the reviewer.
- **F3.4** The reviewer MUST produce a strictly-shaped JSON artifact (`dev-review-latest.json`) including `passed`, `summary`, `why_previous_attempt_failed`, `broken_contract`, `pattern_compatibility`, `required_repairs[]`, with `exact_solution` and `example_code` mandatory when `passed: false`.
- **F3.5** The reviewer MUST NOT read tests, fixtures, Playwright artifacts, or test file paths — only the contract, task context, attachments, validation feedback, and production diff.
- **F3.6** When the dev loop fails to satisfy the gates after 5 attempts but the reviewer's `failure_scope` is `tests`, a test-side salvage agent (with the inverse cage — may write tests, must not touch production) MUST run, validate-after-test-repair MUST re-run the gates, and the implementation-ready node MUST treat green post-salvage gates as `ready: true`.

#### F4. PR lifecycle
- **F4.1** When the implementation is ready, the system MUST open a PR with a populated body (the project's `.github/PULL_REQUEST_TEMPLATE.md`), commit metadata, and a `Closes <ticket-key>` link.
- **F4.2** Five reviewer agents MUST run in parallel against the open PR: code, scope, docs, error-handling, comment-quality. Each emits a structured JSON verdict.
- **F4.3** A synthesizer MUST aggregate all reviewer verdicts into a single decision (`approved` or `changes_requested`) with combined feedback.
- **F4.4** If the synthesizer says `changes_requested`, an auto-fix agent MUST attempt to apply the consolidated fixes (bounded; one round only). After auto-fix, the reviewers re-run; if still `changes_requested`, the line stops and the human is needed.
- **F4.5** When the synthesizer says `approved`, the system MUST attempt `gh pr merge --auto --squash --delete-branch`. The merge happens once GitHub's required checks pass.

#### F5. Status and lifecycle (task-done)
- **F5.1** When a ticket reaches Done, the system MUST delete its outward `Blocks` links so dependents are unblocked.
- **F5.2** The system MUST sweep the project for tickets whose blockers are all now Done and which do not carry `archon-blocked-pending`, and transition them to Selected for Development.
- **F5.3** When all children of an Epic are Done, the system MUST roll up the Epic to Done.

#### F6. Pause / human-needed handling
- **F6.1** A ticket carrying `archon-blocked-pending` MUST NOT be auto-promoted by any sweep. JQL filters MUST use `(labels is EMPTY OR labels not in ("archon-blocked-pending"))` to avoid the silent "labels exists" gotcha.
- **F6.2** When the dev loop fails terminally (5 attempts exhausted, no test-salvage path applied), the implementing workflow MUST add `archon-blocked-pending` to the ticket and post a comment summarizing what failed.
- **F6.3** When grooming fails (insufficient AC, ambiguous spec), the bug-pipeline MUST transition the ticket back to Backlog with an explanatory comment, leaving the label off so the human can re-promote after editing.

#### F7. Concurrency and isolation
- **F7.1** Each task-implement run MUST execute inside a fresh git worktree, so multiple tickets can run in parallel without trampling each other's branches.
- **F7.2** The router workflow MUST be `mutates_checkout: false` so concurrent webhooks don't serialize.
- **F7.3** _(future)_ Concurrency MUST be capped per-Anthropic-account at a configurable rate (current limit: ~5h tokens/window, no hard cap enforced).

#### F8. Observability
- **F8.1** Every workflow node MUST emit `node_started` / `node_completed` / `node_skipped` / `node_failed` events to `remote_agent_workflow_events` with structured JSON `data`.
- **F8.2** Every run MUST persist its artifacts (`feedback.json`, `dev-review-*.json`, `task-context.md`, `attachments.md`, `pr-info.json`, etc.) to `~/.archon/workspaces/owner/repo/artifacts/runs/{run_id}/`.
- **F8.3** Every Jira-side action (transition, label, comment) MUST be logged with the actor user, timestamp, and reason.

#### F9. Configuration
- **F9.1** The Owner MUST be able to override per-codebase env vars without committing them to git, via `.archon/config.yaml` `env:` block or via the Web UI.
- **F9.2** The Owner MUST be able to disable the Archie pipeline for a specific Jira project by leaving the webhook unwired or setting `archon-blocked-pending` on the entire backlog.
- **F9.3** AI provider, model, and per-node options (effort, thinking, fallback model) MUST be configurable per workflow at YAML and per node, with config-file defaults.

### 5.2 Non-functional requirements

#### NFR1. Determinism
- The same Epic seeded twice must produce the same decomposition (modulo non-determinism in the upstream LLM, which is bounded by `effort: minimal` for routing).
- Local validation (`bun run validate`) must produce identical results to CI.
- Bash node `$node.output` substitutions must be unambiguous: string outputs are wrapped in single quotes for shell-safety, booleans/numbers emitted bare, missing/skipped nodes resolve to empty. Workflow authors MUST reference `$node.output.field` _bare_ (no surrounding `"..."`) inside bash bodies — duplicate quoting was the WOR-87 root cause.

#### NFR2. Reversibility
- Every Archie action that mutates external state (Jira transition, label, comment; GitHub branch, PR, merge) must be auditable in a structured log and reversible by hand within minutes.
- Worktrees must clean up on success and remain on failure for forensic inspection. Cleanup is opt-in via `archon isolation cleanup`.

#### NFR3. Cost transparency
- Each workflow run must record `total_cost_usd` in `metadata`. The Owner must be able to query "how much did Epic E cost end-to-end" from `workflow_runs.metadata` joined on conversation_id matching child tickets.
- _(future)_ Per-ticket metrics: dev-loop attempts, reviewer rounds, auto-fix invocations, total wall time, total tokens.

#### NFR4. Failure modes that are explicit, not silent
- Reviewer says `passed: true` while validation is red → engine MUST treat as a contract violation and refuse to advance.
- Substitution misses (skipped node, missing field) → engine MUST resolve to empty string, and consumer scripts MUST tolerate empty without crashing (e.g. drop `set -u`).
- Reviewer hallucination (description does not match diff) → currently surfaces as a stuck dev-loop; _(future)_ a sanity-check agent should compare reviewer claims against the actual diff before the reviewer's verdict is gated on.

#### NFR5. Operational simplicity
- The Owner MUST be able to install Archie with `bun install && archon serve` and a populated `.env`. No Kubernetes, no message queue, no separate worker tier.
- SQLite is the default DB; Postgres is optional for cloud installs.
- Archie's process model is one server (`archon serve`) and N background workflow runs spawned via `nohup archon workflow run …`.

#### NFR6. Security boundaries
- Every webhook MUST be signature-verified.
- Tokens (Jira PAT, GitHub PAT, AI API keys, Resend API key) MUST live in env vars, never in the DB or logs.
- AI provider HTTP calls MUST go through the SDK; no raw curl with API keys in scripts unless explicitly fenced.
- The dev agent's tool cage (PreToolUse hooks) MUST be the authoritative authority on what files it may edit; prompt text alone is insufficient.

---

## 6. What's deliberately out of scope (today)

- **Multi-project routing.** Archie currently assumes one Jira project ↔ one codebase. The user has explicitly committed to a future "single mandatory discriminator field" approach (label, component, or custom field — TBD); routing fails closed if absent. Tracked in backlog.
- **Real-user e2e auth in CI.** Currently Playwright tests in CI run against deployed previews and fail because the test-mode auth shim isn't in the preview build. Decision pending: enable it on previews (operational risk: public test-mode endpoint), or run e2e only against a local webserver, or invest in real-auth flow.
- **PRD authoring assistance.** Archie consumes a PRD; it does not help write one. The `archon-interactive-prd` workflow exists in Archon but is not part of Archie's required path.
- **Cross-team review / approvals.** Single-developer model. PR reviewers are agents, not humans; the Owner is the only human in the loop.
- **Long-running pipelines (> 5 hours).** Pipeline duration is bounded by Anthropic's 5-hour rolling window; for now Archie is expected to complete an Epic of ~10 tickets within that window. Multi-day Epics are out of scope until concurrency caps are formalized.

---

## 7. Success metrics

### 7.1 Primary metric

**Tickets shipped per Epic per human-hour of Owner time.**

The Owner's hands-on time is the bottleneck Archie targets. A successful Epic is one where the Owner spends < 10 minutes per shipped child ticket — authoring, intervening on labeled pauses, reviewing produced PRs.

### 7.2 Secondary metrics

| Metric | Definition | Target (current state) |
|---|---|---|
| Auto-merge rate | % of tickets where Archie merges without human edit | _baseline TBD_ |
| Dev-loop convergence | Distribution of attempts at which the dev loop converges | Mode at attempt 1–2; tail < attempt 5 |
| Test-salvage save rate | % of tickets where post-loop test-salvage rescues an otherwise-failed ticket | Should be small; high rate signals test-gen contract drift |
| Reviewer hallucination incidents | Tickets where the dev loop stalls because the reviewer's diagnosis doesn't match the diff | Currently has happened (WOR-87); should trend to zero |
| Engine bug incidents | Tickets where Archon (not Archie) gates incorrectly because of a substitution / quoting / lifecycle bug | Currently 1 per ~5 Epics; should trend to zero |
| Cost per shipped ticket | `sum(workflow_runs.metadata.total_cost_usd) / merged_tickets` | _baseline TBD; aim for < $5/ticket_ |

### 7.3 Qualitative success

After running Archie through an Epic, the Owner should be able to:
- Read the resulting PRs and not be surprised.
- Trust the test suite to actually exercise the ACs.
- Trust that gates that say "green" are green for the right reasons.
- Trust that gates that fail honestly fail (no false greens, no silent hallucinations).
- Walk away on Friday and have produced more on Monday than they would have hand-coded.

---

## 8. Known weaknesses (ack'd, tracked)

These are the recurring failure classes from run 1 (ConflictCoach Epic). They are explicit inputs into run 2 / future runs:

1. **Reviewer / dev coordination drift** — reviewer agent describes a state of the codebase that doesn't match the actual diff (WOR-87). Mitigation: a sanity-check pass that compares reviewer's "production code is X" claims against the actual file before the verdict gates the next step.
2. **Engine substitution traps** — bash bodies referencing `$node.output.field` with the wrong quoting can silently produce wrong values. Documented in NFR1; engine could surface a lint that warns on `"$.*\.output\."` patterns inside bash blocks.
3. **Tests authored against the wrong calling context** — test-gen and dev-gen disagree on whether a component is connected vs presentational, leading to multi-attempt dev loops. Mitigation: F2.1 contract artifact, but the contract author needs to also classify "connected/presentational, mock vs real fixtures, public/internal action" up front.
4. **No multi-project discriminator** — currently Archie can only safely run one Jira project at a time. Tracked.
5. **Operational state in code prompts** — too much of "what to do" is in agent prompts vs. in deterministic scripts. Drift in any prompt re-introduces bugs. Mitigation: keep migrating prescriptive logic into scripts and contract artifacts; agent prompts should describe *judgment*, not *procedure*.
6. **CI vs pre-commit drift** — pre-commit hooks miss some files that CI catches (PR #96 prettier). Mitigation: CI is canonical; pre-commit is opportunistic.

---

## 9. Glossary

- **Archon** — the generic agentic-workflow runtime (Bun + TS, DAG executor, worktree isolation, AI provider abstraction). Open-source-shaped, single-developer-shaped.
- **Archie** — the specific Jira-driven SDLC pipeline built on top of Archon. Composed of YAML workflows, command prompts, and helper scripts in `.archon/`.
- **Owner** — the single human running Archie. Replaces "team," "manager," "tech lead" for the scope Archie handles.
- **Station** — an agent or deterministic gate in the pipeline. Each station has a single responsibility and a structured input/output.
- **Contract** — the artifact authored before any code is written that names every interface (file, export, signature, invariant) the implementation will be measured against. Single source of truth across stations.
- **Cage** — the per-tool restriction enforced by `PreToolUse` hooks that prevents the dev agent from editing tests, and the test-repair agent from editing production. Hook scripts, not prompt text.
- **Pause label** — `archon-blocked-pending`. Carrying it means "human needed; sweep ignores; line stopped."
- **Salvage path** — the test-side repair node that runs after the dev loop has exhausted attempts but the reviewer's `failure_scope` says only test files are wrong.
- **Run** — one execution of one workflow against one ticket. Bounded scope, recorded in `workflow_runs` + `workflow_events`.

---

## 10. Open questions

These are not blockers for run 1 but should be resolved before run 2:

1. **Multi-project discriminator field** — what is it (label, component, or custom field)? Where is it set? How does the router fail closed if absent?
2. **NFR-as-AC pattern** — confirmed: decomposer should inline NFR excerpts into each ticket's AC. Is the canonical NFR source the Epic attachment or a project-level config file?
3. **Convex-test mandate** — should the test-author reviewer reject tests that mock Convex hooks instead of using `convex-test`? (Convex run 1 didn't enforce this; Codex review flagged it.)
4. **Public-vs-internal action classification at contract time** — proposed in run 1 retrospective; needs spec.
5. **Per-ticket metrics emission** — JSONL append per ticket so the Owner can review cost / time / convergence after the fact. Not yet implemented.
6. **Auto-fix bound vs. unbounded** — currently auto-fix runs once on `changes_requested`. Should it run twice? Conditional on which reviewer requested changes? Tracked.

---

_End of PRD v0.1._
