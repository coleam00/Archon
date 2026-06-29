---
title: Archon PRD Handoff - Hermes Agent Workflow Commander
status: handoff
created: '2026-06-29'
updated: '2026-06-29'
---

# Archon PRD Handoff: Hermes Agent Workflow Commander

## Document Purpose

This document is the local Archon product requirements handoff for Hermes Agent Workflow Commander.
It contains only the Archon-owned product requirements needed for isolated implementation inside this repository.
It is intended to be read with `architecture.md` and `epics.md` in this same folder.
Implementation agents must not traverse out of this repository to read parent workspace planning files.

## Product Context

Hermes Agent Workflow Commander makes Hermes the human-facing command surface for BMAD planning, Archon workflow execution, GitHub pull request state, and local project work.
Archon remains the workflow execution system.
Archon owns workflow run state, retry and recovery behavior, approval pauses, event production, callback outbox delivery, and generic controller binding records.
Hermes owns user-facing project bindings, operational project work, human gates, callback validation, Story Timeline rendering, and reconciliation.

The Archon product outcome is a generic controller integration surface that Hermes can consume without Archon becoming Hermes-specific.
Archon must expose parseable control and callback contracts, keep workflow execution independent from callback delivery, and preserve existing workflow behavior outside the new integration surfaces.

## Scope

Archon owns these Workflow Commander capabilities:

- Generic Controller Binding lifecycle records keyed by project or codebase plus controller `provider` and `name`.
- CLI JSON result envelopes for workflow start, status, approve, reject, resume, retry, cancel, and diagnostics.
- CLI JSON result envelopes for Controller Binding create, update, rotate, disable, inspect, and diagnose.
- Workflow event production into a durable callback outbox.
- Signed typed callback payloads for workflow completion, workflow failure, approval request, callback delivery failure, and workflow artifact events.
- Callback delivery status, retry status, terminal failure diagnostics, and health inspection.
- Shared producer fixtures and schema tests for every Archon-produced machine contract consumed by Hermes.

Archon does not own these Workflow Commander capabilities:

- Hermes Project Binding persistence.
- Hermes BMAD skill mounting.
- Hermes materialization of BMAD `sprint-status.yaml` into project work.
- Hermes Project Work Item, phase task, HILT Gate, Story Timeline, or reconciliation persistence.
- Hermes callback ingress validation and profile-scoped callback secret enforcement.
- GitHub pull request reconciliation and done verification decisions.

## User Journeys

### UJ-A1: Hermes Registers A Generic Controller Binding

Hermes needs Archon to know where workflow events for a project or codebase should be delivered.
Hermes creates or updates a Controller Binding using generic controller vocabulary.
Archon persists the binding with `provider`, `name`, callback route or target reference, enabled state, and status metadata.
Hermes can inspect the binding later and distinguish missing, valid, stale, disabled, rotated, and conflicting states.

### UJ-A2: Hermes Controls Workflow Runs Through CLI JSON

Hermes starts and inspects Archon workflow runs from the bound project cwd.
Hermes sends approve, reject, resume, retry, and cancel commands when human gates or recovery actions require them.
Every state-changing CLI result consumed by Hermes is parseable JSON with schema version, success flag, correlation id, workflow run reference or binding reference, and machine-readable result or error payload.
Hermes must never parse human-oriented output to update project-work state.

### UJ-A3: Archon Reports Workflow Events Through A Callback Outbox

Archon emits workflow events and serializes eligible events into signed typed callback payloads.
Archon writes each callback candidate to a non-blocking outbox and attempts delivery to the Controller Binding route.
Workflow execution continues when callback delivery is delayed, retried, or terminally failed.
Hermes treats callbacks as delivery acceleration and reconciles separately when delivery fails.

### UJ-A4: Hermes Inspects Callback Delivery Health

Hermes needs to show whether Archon callback delivery is healthy, delayed, failed, duplicated, terminal, or waiting for reconciliation.
Archon exposes delivery status through parseable status surfaces.
Status includes event identity, workflow run reference, retry state, last error category, terminal failure diagnostics, and recovery-relevant next action when available.

## Functional Requirements

### A-FR-1: Manage Generic Controller Bindings

Archon can create, update, rotate, disable, inspect, and diagnose Controller Bindings for external controllers.
Each binding is keyed by project or codebase reference plus controller `provider` and controller `name`.
The binding stores callback route or target reference, enabled state, status metadata, rotation metadata when applicable, and diagnostic state.
The vocabulary must remain generic and must not add Hermes-specific model fields.

Acceptance criteria:

- Given a Controller Binding is created or updated, when Archon persists it, then Archon stores project or codebase reference plus controller `provider`, controller `name`, callback route or target reference, enabled state, and status metadata.
- Given a Controller Binding is inspected, when Archon returns status JSON, then the response can represent missing, valid, stale, disabled, rotated, and conflicting states.
- Given binding lifecycle actions run, when create, update, rotate, disable, inspect, or diagnose completes, then Archon returns parseable JSON with correlation id and machine-readable result or error payload.

### A-FR-2: Return Strict CLI JSON For Workflow Control

Archon returns schema-versioned JSON for workflow start, status, approve, reject, resume, retry, cancel, and diagnostics when these calls are consumed by external controllers.
The JSON envelope includes success and failure shapes.
The failure shape includes an error code, diagnostic category, and machine-readable details.
The success shape includes the relevant workflow run reference, binding reference when applicable, result payload, and correlation id.

Acceptance criteria:

- Given a workflow control command succeeds, when Archon serializes the response, then the result includes schema version, success flag, correlation id, workflow run reference, binding reference when applicable, and machine-readable payload.
- Given a workflow control command fails, when Archon serializes the failure, then the response includes schema version, success flag, correlation id when available, error code, diagnostic category, and machine-readable details.
- Given Hermes sends approve or reject through CLI, when Archon returns a result, then the result is parseable JSON and does not require dashboard state or human-readable output.
- Given Hermes sends resume, retry, or cancel through CLI, when Archon returns a result, then unexpected workflow state is represented as a machine-readable failure rather than ambiguous text.

### A-FR-3: Produce Signed Typed Callback Payloads

Archon serializes eligible workflow events into signed typed callback payloads.
Payloads include schema version, event id, event type, occurred timestamp, Controller Binding reference, workflow run reference, project or codebase reference, signature metadata, and idempotency key.
Event id and idempotency key remain stable across retries.
Callback payloads must support workflow completed, workflow failed, approval requested, callback delivery failed, and workflow artifact events.

Acceptance criteria:

- Given Archon emits a workflow event for a bound project or codebase, when the event is eligible for external notification, then Archon writes it to a non-blocking callback outbox.
- Given Archon serializes a callback payload, when delivery is attempted, then the payload includes schema version, event id, event type, occurred timestamp, Controller Binding reference, workflow run reference, project or codebase reference, signature metadata, and idempotency key.
- Given Archon retries delivery, when a callback is redelivered, then event id and idempotency key remain stable.

### A-FR-4: Persist Callback Outbox Delivery State

Archon persists callback delivery status independently from workflow execution success.
Delivery status includes pending, retrying, delivered, delayed, duplicate-safe retry, terminal failure, and reconciliation-needed states when applicable.
Terminal failure diagnostics include affected event type, workflow run reference, last error category, last error evidence safe for logs, and recovery option when available.

Acceptance criteria:

- Given callback delivery is delayed or retrying, when Archon reports delivery status, then the status includes retry state, last attempt time when available, next action when available, and whether user action is required.
- Given callback delivery reaches terminal failure, when Archon records the failure, then Archon exposes delivery status, last error category, affected event type, workflow run reference, and recovery option.
- Given callback delivery fails, when workflow execution has already completed or failed independently, then Archon does not rewrite workflow execution state solely because callback delivery failed.

### A-FR-5: Provide Contract Fixtures For Producer Compatibility

Archon producer implementation starts from shared examples and schema validation.
Fixtures must cover Controller Binding payloads, workflow CLI envelopes, callback envelopes, callback delivery status, and Hermes rejection cases required for integration.
Producer stories that rely on a missing fixture family cannot move to implementation-ready until that fixture family exists locally or as a regenerated local equivalent.

Acceptance criteria:

- Given Archon producer code emits a Controller Binding payload, workflow CLI envelope, callback envelope, or delivery status payload, when validation runs, then emitted payloads match the local shared examples and schema version.
- Given a contract fixture changes, when Archon validation runs, then producer tests fail if Archon output no longer matches the shared example.
- Given an Archon producer story depends on a missing fixture family, when implementation readiness is checked, then the story remains blocked until that fixture family exists locally.

## Nonfunctional Requirements

- Archon callback delivery must accelerate notification but must not become the only source of truth for workflow state.
- Archon workflow execution must remain independent when callback delivery fails, retries, or reaches terminal failure.
- Archon must persist enough provenance for workflow commands, callback events, callback delivery state, and diagnostics to support Hermes reconciliation.
- Archon must expose error and delivery-health diagnostics as machine-readable categories rather than raw output alone.
- New Archon integration surfaces must use generic controller vocabulary and must not add Hermes-specific command names or model fields.
- Cross-subproject machine contracts must be JSON, schema-versioned, and compatibility-tested from shared examples.
- Archon implementation must stay on the existing Bun and TypeScript workspace, Hono, Zod, OpenAPI patterns, workflow stores, and CLI validation path.

## Cross-Project Dependency Rules

Archon producer stories may depend on Hermes consumer validation, but Archon owns the producer surface and the generic contract shape.
Dependency records in `epics.md` use this shape:

```text
Depends on: <subproject> Story <id or title>
Contract needed: <API/event/file/interface/schema>
Blocking behavior: <what must exist before this story can be completed>
Integration validation: <how both sides will be proven compatible>
```

Archon stories must include this dependency shape when completion depends on Hermes accepting a produced payload or when Hermes must provide rejection fixtures.

## Validation

Run validation from inside this repository.

```text
bun run validate
```

Archon stories are not complete until relevant producer contract fixtures pass local tests and any Hermes consumer compatibility expectations recorded in `epics.md` are satisfied.
