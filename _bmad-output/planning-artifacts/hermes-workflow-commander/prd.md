---
title: Archon Planning Handoff - Hermes Agent Workflow Commander
status: handoff
created: '2026-07-02'
updated: '2026-07-02'
source: workflow-engine parent workspace, materialized per cross-project-isolated-handoff-contract.md
---

# PRD: Archon Slice For Hermes Agent Workflow Commander

## Purpose

Hermes Agent Workflow Commander makes Hermes Agent the human-facing command center for BMAD planning, Archon workflow execution, GitHub PR state, and local project work.
Archon is the first workflow provider Hermes controls. This document defines only the requirements Archon must satisfy as that provider — not the full cross-project product.
The full parent PRD lives at `_bmad-output/planning-artifacts/prds/prd-workflow-engine-2026-06-26/prd.md` in the parent workspace; this file exists so no Archon implementation agent needs to read it.

## Scope Boundary

Archon owns the provider `archon` implementation of: Workflow Provider Binding (reverse binding from codebase/project to controller identity), Archon CLI JSON producer contracts, workflow run state, retry/resume/cancel behavior, workflow event production, event outbox, delivery status, and signed workflow event production.

Archon does **not** own: Project Binding, BMAD mount, materialization, Project Work Items, HILT gates, Story Timeline, reconciliation, or any user-facing dashboard surface — those belong to `hermes-agent` (see its own local handoff).

Archon must not require Hermes-specific command names or model vocabulary — all controller identity uses generic `provider` and `name` fields.

## Functional Requirements Owned By Archon

### FR-7: Register generic workflow provider bindings

Archon can create or update the provider-side workflow binding for a project using generic `provider` and `name` vocabulary.

**Consequences (testable):**
- Archon never exposes provider commands or models named specifically for Hermes.
- Workflow provider binding vocabulary uses `provider` and `name`, not `profile`, `agent_name`, `agent`, or `agent_provider`.
- Archon's stored binding can be compared against a consumer's Project Binding metadata to detect disagreement (Archon exposes enough state for the consumer to do this).
- Archon surfaces binding rotation, removal, stale delivery, and missing binding states as actionable diagnostics via CLI JSON.

### FR-8: Expose provider workflow control through CLI JSON

Archon exposes start, status, approve, reject, resume, retry, and cancel for workflow runs through Archon CLI JSON — this is the producer side of the provider adapter Hermes calls.

**Consequences (testable):**
- Archon returns parseable JSON responses for every CLI call whose result updates consumer state.
- Archon does not expose an HTTP API for this state-changing control path — CLI only.
- Every response includes schema version, success flag, correlation id, workflow run reference when applicable, binding reference when applicable, machine-readable result payload, and machine-readable error shape when failed.
- Archon fails closed (returns a machine-readable error envelope) rather than emitting unstructured text on malformed input or unexpected state.

### FR-9: Produce signed typed workflow events

Archon emits signed workflow events for workflow completion, failure, approval-requested, delivery-failed, and artifact events through a non-blocking outbox, consumed by Hermes at `/p/{profile}/webhooks/workflow-events/{provider}`.

**Consequences (testable):**
- Archon writes events to a durable, non-blocking outbox — workflow execution continues even if event delivery later fails.
- Every event includes schema version, event id, event type, occurred timestamp, provider binding reference, workflow run reference, project/codebase reference, signature metadata, and idempotency key.
- Archon delivers duplicate-safe event ids so consumers can detect redelivery.
- Archon does not need to know how Hermes validates events (schema/signature/replay/idempotency/profile/binding) — only that its events must satisfy that contract; the shared event envelope schema and rejection fixtures are the source of truth (`_bmad-output/planning-artifacts/contracts/workflow-commander/`, not yet populated — see "Blocked Dependencies" below).

### FR-10: Surface provider event delivery and outbox health

Archon can report whether workflow event delivery is healthy, delayed, failed, duplicated, or waiting for reconciliation.

**Consequences (testable):**
- Archon persists delivery status, retry status, last error, and terminal failure diagnostics independent of workflow execution success.
- Archon does not block workflow execution solely because event delivery failed.
- Archon exposes this status through CLI JSON so a consumer can request or display it.

## Non-Functional Requirements Relevant To Archon

- **NFR-1 (Reliability):** Workflow events are delivery acceleration, not the only source of truth — Archon must not assume Hermes has processed an event just because delivery succeeded.
- **NFR-5 (Security):** Archon's events must be signed and schema-versioned so a consumer can reject invalid ones (signature, schema, replay, binding, provider, authorization) — Archon owns producing correct signed events, not the rejection logic itself.
- **NFR-6 (Security):** Event secrets must be scoped correctly so a signed event cannot be replayed against the wrong profile.
- **NFR-9 (Auditability):** Archon persists workflow commands, workflow events, and delivery state with enough detail for audit.
- **NFR-14 (Usability):** Archon's error and delivery-health responses expose diagnostic categories and machine-readable detail, not raw stack traces.
- **NFR-15 (Maintainability):** Archon's implementation keeps ownership bounded to provider `archon` surfaces — it does not reach into Hermes-owned concerns (Project Binding, gates, reconciliation).
- **NFR-16 (Maintainability):** All new provider integration surfaces stay generic (`provider`/`name` vocabulary) — never Hermes-specific.

## Non-Goals (Archon-relevant subset)

- Archon will not expose an HTTP API for the Hermes-to-Archon state-changing control path — CLI only, per architecture AD-3.
- Archon will not add Hermes-specific commands or model vocabulary.
- Archon will not implement Project Binding, materialization, HILT gates, or Story Timeline — those are `hermes-agent`'s responsibility.

## Glossary (Archon-relevant terms)

- **Workflow Provider** — Archon is the first implementation, under provider key `archon`.
- **Workflow Provider Binding** — the persisted reverse binding from a project/codebase to controller `provider` + `name` + event route, owned by Archon.
- **Controller Identity** — the generic `provider` + `name` pair identifying an external controller.
- **Workflow Event** — a signed, typed, schema-versioned event Archon emits (completed, failed, approval-requested, delivery-failed, artifact).

## Blocked Dependencies

The shared contract fixtures this PRD's FRs reference (workflow command envelope, workflow event envelope, workflow provider binding schema — see `_bmad-output/planning-artifacts/contracts/workflow-commander/README.md`) are **not yet created** in the parent workspace as of this handoff (2026-07-02). Parent workspace Stories 1.3a/1.3b/1.3c produce them. Archon producer stories (see local `epics.md`) should not be marked implementation-ready until those fixtures exist here or are regenerated into this local handoff.

## Cross-Project Dependencies

Archon's producer work is consumed by `hermes-agent`'s adapter/consumer stories (see `hermes-agent/_bmad-output/planning-artifacts/epics.md`, Epic "Workflow Provider Control And Event Delivery — Hermes Consumer Side"). Story-level dependency records use:

```text
Depends on: <subproject> Story <id or title>
Contract needed: <API/event/file/interface/schema>
Blocking behavior: <what must exist before this story can be completed>
Integration validation: <how both sides will be proven compatible>
```

## Source

Derived from the parent workspace's `prds/prd-workflow-engine-2026-06-26/prd.md` and `epics.md`, both current as of 2026-07-02 (post `bmad-correct-course` pass — see parent `sprint-change-proposal-2026-07-02.md`).
