---
title: Archon Epics Handoff - Hermes Agent Workflow Commander
status: handoff
created: '2026-06-27'
updated: '2026-06-27'
---

# Archon Epics: Hermes Agent Workflow Commander

## Overview

This file contains the Archon-owned subset of the parent Hermes Agent Workflow Commander epics.
It is local planning input for implementation inside `Archon`.
It excludes Hermes-owned implementation work except where dependency notes are required for integration.
Shared contract fixtures are planned under `_bmad-output/planning-artifacts/contracts/workflow-commander/` and must be regenerated into this local handoff before producer code depends on them.
No Archon story may require traversal out of `Archon` to read parent workspace planning files during implementation.

## Archon NFR Coverage

| NFR | Archon Story Coverage | Required Validation Evidence |
| --- | --- | --- |
| NFR-1 | Stories A4.1 and A4.2 | Callback outbox and delivery-health fixtures prove callbacks accelerate delivery but do not become the sole source of truth. |
| NFR-5 | Stories A1.1 and A4.1 | Callback envelope and Hermes rejection fixtures prove invalid signed callbacks can be rejected by consumers. |
| NFR-9 | Stories A2.1, A3.1a, A3.1b, A3.1c, A3.1d, A4.1, and A4.2 | Producer fixtures include correlation ids, workflow references, callback event ids, delivery status, retry state, and machine-readable result or error payloads. |
| NFR-14 | Stories A3.1a, A3.1b, A3.1c, A3.1d, and A4.2 | Error and delivery-health fixtures expose diagnostic categories and recovery-relevant details instead of raw output alone. |
| NFR-15 | Stories A1.1, A2.1, A3.1a, A3.1b, A3.1c, A3.1d, A4.1, and A4.2 | Dependency records keep Archon ownership to generic Controller Binding, workflow CLI, callback outbox, signed events, and delivery status. |
| NFR-16 | Stories A2.1, A3.1a, A3.1b, A3.1c, A3.1d, A4.1, and A4.2 | Producer fixtures and command contracts use generic controller vocabulary and avoid Hermes-specific Archon surfaces. |
| NFR-17 | Story A1.1 | Local handoff validation proves Archon implementation agents can use local `prd.md`, `architecture.md`, `epics.md`, and local fixture copies without parent traversal. |

## Epic 1: Contract Readiness For Archon Producers

Archon implementation starts from local shared examples before producer code merges.

### Story A1.1: Adopt Shared Controller And Workflow Contract Fixtures

As an Archon implementation agent,
I want shared contract examples available inside the Archon planning package,
So that Archon producer work can validate against the same source of truth Hermes consumers use.

**Requirements Covered:** FR-7, FR-8, FR-9, FR-10, FR-19.

Depends on: parent Story 1.1, parent Story 1.3a, and parent Story 1.3b.
Contract needed: Controller Binding payload schema, workflow CLI envelope schema, callback envelope schema, callback delivery status schema, and Hermes rejection fixtures.
Blocking behavior: Archon producer implementation cannot be marked complete until the relevant shared examples exist locally.
Integration validation: Archon producer tests and Hermes consumer tests parse the same examples.
Validation evidence required: local schema or fixture validation proves Controller Binding, workflow CLI envelope, callback envelope, callback delivery status, and Hermes rejection fixtures parse inside the Archon planning package before producer stories move to implementation-ready.
Producer stories that rely on a missing fixture family cannot move to implementation-ready until that fixture family exists locally or as a regenerated local equivalent.

**Acceptance Criteria:**

**Given** Archon implementation starts
**When** contract fixtures are loaded
**Then** Archon has local examples for Controller Binding, workflow control, callback events, callback delivery health, and Hermes rejection cases including valid signature under the wrong profile secret
**And** implementation does not require parent workspace path traversal.

**Given** a contract fixture changes
**When** Archon validation runs
**Then** producer tests fail if Archon output no longer matches the shared example
**And** the failure names the affected schema version.

**Given** an Archon producer story depends on a workflow CLI, Controller Binding, callback event, or delivery-health contract
**When** implementation readiness is checked
**Then** the relevant schema and example fixtures are available inside the local Archon handoff package
**And** the story does not require reading parent workspace files.

## Epic 2: Generic Controller Binding

Archon can manage generic Controller Bindings for external controllers without Hermes-specific vocabulary.

### Story A2.1: Implement Generic Controller Binding Lifecycle

As an Archon implementation agent,
I want Archon to manage generic Controller Bindings with `provider` and `name`,
So that Hermes and future controllers can register callback routing without Archon becoming controller-specific.

**Requirements Covered:** FR-7.

Depends on: Story A1.1.
Contract needed: Controller Binding payload schema, callback route field, status result shape, and machine-readable failure envelope.
Blocking behavior: This story cannot complete until Controller Binding fixtures exist and use generic vocabulary.
Integration validation: Hermes registration fixtures parse Archon binding status without Hermes-specific fields.

**Acceptance Criteria:**

**Given** Archon stores a Controller Binding
**When** the binding is created or updated
**Then** Archon persists project or codebase reference plus controller `provider`, controller `name`, and callback route or target reference
**And** Archon does not require Hermes-specific fields.

**Given** a binding is inspected
**When** Archon returns status JSON
**Then** the response can represent missing, valid, stale, disabled, rotated, and conflicting states
**And** it matches the shared status result fixture.

**Given** binding lifecycle actions run
**When** create, rotate, disable, inspect, or diagnose completes
**Then** Archon returns parseable JSON with correlation id and machine-readable result or error payload.

## Epic 3: Workflow Control CLI JSON

Archon exposes workflow control actions through strict JSON envelopes that Hermes can consume through CLI.

### Story A3.1a: Define Shared Workflow CLI Envelope

As an Archon implementation agent,
I want workflow CLI commands to share one versioned result envelope,
So that external controllers can fail closed and validate command output consistently.

**Requirements Covered:** FR-8.

Depends on: Story A1.1 and Story A2.1.
Contract needed: Workflow control success envelope, error envelope, timeout representation, schema mismatch representation, workflow run reference, binding reference, and correlation id.
Blocking behavior: Workflow command-family stories cannot complete until they use the shared envelope and return parseable JSON for success and failure.
Integration validation: Hermes CLI adapter tests consume Archon workflow fixtures and fail closed on malformed JSON.

**Acceptance Criteria:**

**Given** any workflow control command succeeds
**When** Archon serializes the response
**Then** the result includes schema version, success flag, correlation id, workflow run reference, binding reference when applicable, and machine-readable payload.

**Given** any workflow control command fails
**When** Archon returns the failure
**Then** the response includes schema version, success flag, correlation id when available, error code, diagnostic category, and machine-readable details.

### Story A3.1b: Provide Workflow Start And Status CLI JSON

As an Archon implementation agent,
I want workflow start and status to return parseable JSON,
So that external controllers can create and inspect workflow references without parsing human-readable output.

**Requirements Covered:** FR-8.

Depends on: Story A1.1, Story A2.1, and Story A3.1a.
Contract needed: Workflow start, status, timeout, success, and error envelope schemas.
Blocking behavior: This story cannot complete until start and status commands use the shared envelope and match shared fixtures.
Integration validation: Hermes start and status adapter tests consume Archon workflow fixtures and fail closed on malformed JSON.

**Acceptance Criteria:**

**Given** Archon starts a workflow run
**When** the CLI command succeeds
**Then** the result includes schema version, success flag, correlation id, workflow run reference, binding reference when applicable, and machine-readable payload.

**Given** Archon returns workflow status
**When** the CLI command succeeds
**Then** the result includes run state, workflow name, workflow run reference, correlation id when available, and machine-readable error shape when failed.

### Story A3.1c: Provide Workflow Decision Command CLI JSON

As an Archon implementation agent,
I want workflow approve and reject to return parseable JSON,
So that Hermes can send human gate decisions without parsing human-readable output.

**Requirements Covered:** FR-8, FR-14.

Depends on: Story A1.1, Story A2.1, Story A3.1a, and Story A3.1b.
Contract needed: Workflow approve, reject, timeout, success, and error envelope schemas.
Blocking behavior: This story cannot complete until approve and reject commands use the shared envelope and keep command results distinct from Hermes human gate records.
Integration validation: Hermes decision-command adapter tests consume Archon fixtures and fail closed on malformed JSON.

**Acceptance Criteria:**

**Given** Archon receives approve or reject
**When** the command completes
**Then** the result is parseable JSON
**And** the result does not require dashboard state or human-readable output.

### Story A3.1d: Provide Workflow Recovery Command CLI JSON

As an Archon implementation agent,
I want workflow resume, retry, and cancel to return parseable JSON,
So that Hermes can route recovery actions consistently.

**Requirements Covered:** FR-8.

Depends on: Story A1.1, Story A2.1, Story A3.1a, and Story A3.1b.
Contract needed: Workflow resume, retry, cancel, timeout, success, and error envelope schemas.
Blocking behavior: This story cannot complete until resume, retry, and cancel commands use the shared envelope and represent unexpected state machine outcomes.
Integration validation: Hermes recovery-command adapter tests consume Archon fixtures and fail closed on malformed JSON.

**Acceptance Criteria:**

**Given** Archon receives resume, retry, or cancel
**When** the command completes
**Then** the result is parseable JSON
**And** the result does not require dashboard state or human-readable output.

## Epic 4: Callback Outbox And Signed Events

Archon emits workflow events through a signed callback outbox without blocking workflow execution.

### Story A4.1: Produce Signed Typed Callback Events

As an Archon implementation agent,
I want workflow events to be serialized into signed typed callback payloads,
So that Hermes can validate and process workflow completion, failure, approval request, and artifact events.

**Requirements Covered:** FR-9.

Depends on: Story A1.1, Story A2.1, Story A3.1a, and Story A3.1b.
Contract needed: Callback event envelope, Controller Binding callback route and reference, signature metadata, replay metadata, event id, and idempotency key.
Blocking behavior: This story cannot complete until callback payloads include Controller Binding reference and stable idempotency fields.
Integration validation: Hermes accepts valid callback fixtures and rejects bad signature, stale timestamp, duplicate event id, wrong binding, unknown project, schema mismatch, and valid signature under the wrong profile secret fixtures.

**Acceptance Criteria:**

**Given** Archon emits a workflow event for a bound project or codebase
**When** the event is eligible for Hermes notification
**Then** Archon writes it to a non-blocking callback outbox
**And** workflow execution continues if delivery fails later.

**Given** Archon serializes a callback payload
**When** delivery is attempted
**Then** the payload includes schema version, event id, event type, occurred timestamp, controller binding reference, workflow run reference, project or codebase reference, signature metadata, and idempotency key.

**Given** Archon retries delivery
**When** a callback is redelivered
**Then** event id and idempotency key remain stable
**And** Hermes can classify duplicate delivery safely.

### Story A4.2: Expose Callback Delivery Health

As an Archon implementation agent,
I want callback delivery status to be persisted and exposed through parseable status,
So that Hermes can show delayed, failed, duplicated, terminal, and reconciliation-needed delivery states.

**Requirements Covered:** FR-10.

Depends on: Story A1.1 and Story A4.1.
Contract needed: Callback delivery status schema, retry state, terminal failure category, duplicate-safe marker, and reconciliation-needed marker.
Blocking behavior: This story cannot complete until callback delivery status is independent from workflow execution success.
Integration validation: Hermes health display consumes Archon delivery fixtures without treating callback delivery as the only source of truth.

**Acceptance Criteria:**

**Given** callback delivery is delayed or retrying
**When** Archon reports delivery status
**Then** the status includes retry state, last attempt time when available, next action when available, and whether user action is required.

**Given** callback delivery reaches terminal failure
**When** Archon records the failure
**Then** Archon exposes delivery status, last error category, affected event type, workflow run reference, and recovery option
**And** workflow execution remains independent from callback delivery success.

**Given** Archon reports duplicate or retried delivery
**When** outbox health is inspected
**Then** status preserves event id and idempotency key
**And** consumers can classify duplicate delivery without mutating project work.

## Validation

Run from inside `Archon`.

```text
bun run validate
```

All Archon stories must preserve generic Controller Binding vocabulary and must not add Hermes-specific command names or model fields.
