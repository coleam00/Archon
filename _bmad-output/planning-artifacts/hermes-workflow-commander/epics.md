---
title: Archon Epics Handoff - Hermes Agent Workflow Commander
status: handoff
created: '2026-07-02'
updated: '2026-07-02'
storyOwnershipNote: >
  Story numbering is kept identical to the parent workspace's epics.md (Epic 3) so
  cross-references between Archon, hermes-agent, and the parent stay unambiguous.
  This file contains ONLY Archon-owned stories. Parent Epic 1 (contract fixtures and
  handoff generation) is parent-workspace work, not something Archon implements.
---

# Archon Epics: Hermes Agent Workflow Commander

## Overview

This file contains the Archon-owned subset of the parent Hermes Agent Workflow Commander epics (all from parent Epic 3: "Workflow Provider Control And Event Delivery"). It excludes all hermes-agent-owned work. Cross-project dependencies on hermes-agent are recorded explicitly per story.

**Blocked dependency (all stories below):** every story references shared contract fixtures (workflow command envelope, workflow event envelope, workflow provider binding schema) from parent Stories 1.3a/1.3b/1.3c. As of this handoff (2026-07-02), those fixtures do not exist yet — only a README placeholder exists at `_bmad-output/planning-artifacts/contracts/workflow-commander/` in the parent workspace. No story below should move to implementation-ready until those fixtures exist here or are regenerated into this local handoff.

## Archon-Owned Stories (7 of 35 parent stories)

### Story 3.1: Implement Archon Workflow Provider Binding Lifecycle

As an implementation coordinator,
I want Archon to manage provider-neutral reverse event bindings with provider and name identity,
So that external controllers can receive workflow events without Hermes-specific Archon commands or model names.

**Requirements Covered:** FR-7.

**Implementation Scope:** Archon-owned reverse workflow event binding persistence, lifecycle commands, status JSON, and diagnostics for provider `archon`.

Depends on: shared Workflow Provider Binding payload schema, generic `provider`/`name` vocabulary, event route field, binding status result shape, malformed JSON failure shape (from parent Story 1.3a — blocked, see above).
Contract needed: Workflow Provider Binding payload schema.
Blocking behavior: Cannot be marked complete until shared Workflow Provider Binding examples and status result fixtures exist locally.
Integration validation: Validates create, rotate, disable, status, stale, disabled, rotated, missing, and conflicting provider binding fixtures without introducing Hermes-specific fields.

**Acceptance Criteria:**

**Given** Archon stores a workflow provider binding
**When** the binding is created or updated
**Then** Archon persists the controller by project or codebase reference plus generic `provider` and `name`
**And** the record includes the workflow event route or target reference required for event delivery.

**Given** a workflow provider binding is inspected
**When** Archon returns status JSON
**Then** the response can represent missing, valid, stale, disabled, rotated, and conflicting states
**And** the response uses the shared status result shape from the contract fixtures.

**Given** a workflow provider binding needs rotation, removal, or disabling
**When** Archon performs the lifecycle action
**Then** Archon returns parseable CLI JSON with correlation id, actor when available, timestamp, resulting binding state, and machine-readable error shape when failed
**And** Archon does not expose Hermes-specific command names or fields.

**Given** a provider binding command receives malformed input or cannot produce valid JSON
**When** the command fails
**Then** Archon returns a machine-readable failure envelope
**And** downstream consumers can fail closed without inspecting human-readable text.

**Depends on hermes-agent:** none directly — this is the producer-side foundation `hermes-agent` Story 3.2 consumes.
Contract needed: Workflow Provider Binding payload schema and status result shape (this story's own output).
Blocking behavior: `hermes-agent` Story 3.2 cannot register/diagnose bindings until this story's CLI surface exists.
Integration validation: Both sides validate against the same shared Workflow Provider Binding fixture.

---

### Story 3.3a: Define Shared Workflow Provider Command Envelope

As an implementation coordinator,
I want workflow provider commands to share one versioned result envelope,
So that external controllers can fail closed and validate command output consistently.

**Requirements Covered:** FR-8.

**Implementation Scope:** Provider-neutral command result envelope, schema version, success flag, correlation id, workflow run reference, binding reference when applicable, machine-readable result payload, machine-readable error shape, timeout classification, and schema mismatch classification. Provider `archon` implements the first adapter-specific CLI mapping.

Depends on: shared envelope schema (parent Story 1.3a — blocked, see above).
Contract needed: Shared workflow command success envelope, error envelope, timeout representation, schema mismatch representation, workflow run reference, binding reference, and correlation id.
Blocking behavior: Provider command-family stories cannot be marked complete until they use the shared envelope and return parseable JSON for success and failure.
Integration validation: Validates shared envelope fixtures for success, failure, timeout, malformed request, schema mismatch, and unexpected state without introducing Hermes-specific command names.

**Acceptance Criteria:**

**Given** any workflow control command returns a success result
**When** Archon serializes the response
**Then** the result includes schema version, success flag, correlation id, workflow run reference when applicable, binding reference when applicable, and machine-readable result payload.

**Given** any workflow control command returns a failure result
**When** Archon serializes the response
**Then** the result includes schema version, success flag, correlation id if available, machine-readable error code, diagnostic category, and machine-readable details.

**Given** an external controller consumes a workflow control result
**When** malformed JSON, schema mismatch, timeout, unexpected exit code, or unexpected state occurs
**Then** the shared envelope lets the controller fail closed without relying on human-readable output.

---

### Story 3.3b: Provide Archon Start And Status CLI JSON

As an implementation coordinator,
I want provider `archon` to expose workflow start and status through parseable CLI JSON,
So that external controllers can create and inspect workflow references without using the Archon dashboard.

**Requirements Covered:** FR-8.

**Implementation Scope:** Provider `archon` workflow start and status commands using the shared envelope from Story 3.3a.

Depends on: Story 3.3a (this file).
Contract needed: Workflow command start, status, timeout, success, and error envelope schemas.
Blocking behavior: Cannot be marked complete until both commands use the shared envelope and match shared fixtures.
Integration validation: Validates start and status fixtures for success, failure, timeout, malformed request, and unexpected state without introducing Hermes-specific command names.

**Acceptance Criteria:**

**Given** a workflow run can be started from Archon CLI
**When** Archon starts the run
**Then** Archon returns parseable JSON with schema version, success flag, correlation id, workflow run reference, binding reference when applicable, and machine-readable result payload
**And** the command accepts the project cwd or codebase reference needed by the controller contract.

**Given** a workflow run is inspected from Archon CLI
**When** Archon returns status
**Then** the result includes run state, workflow name, workflow run reference, correlation id when available, and machine-readable error shape when failed
**And** the result matches the shared status fixture.

**Given** a start or status command fails
**When** Archon returns the failure
**Then** the response includes schema version, success flag, correlation id if available, machine-readable error code, and diagnostic category
**And** consumers can fail closed on malformed JSON, schema mismatch, timeout, or unexpected exit code.

**Depends on hermes-agent:** none directly — `hermes-agent` Story 3.4a consumes this.
Contract needed: start/status envelope shape (this story's own output).
Blocking behavior: `hermes-agent` Story 3.4a cannot start/inspect provider runs until this exists.
Integration validation: Both sides validate against the same shared start/status fixtures.

---

### Story 3.3c: Provide Archon Provider Decision Command CLI JSON

As an implementation coordinator,
I want provider `archon` to expose approve and reject through parseable CLI JSON,
So that human gate decisions can be sent through external controllers without relying on human-readable output.

**Requirements Covered:** FR-8, FR-14.

**Implementation Scope:** Provider `archon` approve and reject commands using the shared envelope from Story 3.3a.

Depends on: Story 3.3a, Story 3.3b (this file).
Contract needed: Workflow command approve, reject, timeout, success, and error envelope schemas.
Blocking behavior: Cannot be marked complete until approve and reject commands use the shared envelope and keep command results distinct from human gate decisions.
Integration validation: Validates approve and reject fixtures for success, failure, timeout, malformed request, and unexpected state without introducing Hermes-specific command names.

**Acceptance Criteria:**

**Given** a workflow run accepts an approval or rejection
**When** Archon performs the action
**Then** Archon returns parseable JSON for the action result
**And** the result can be consumed without relying on human-readable output.

**Given** an approve or reject command fails
**When** Archon returns the failure
**Then** the response uses the shared workflow command envelope
**And** consumers can fail closed on malformed JSON, schema mismatch, timeout, unexpected state, or unexpected exit code.

**Depends on hermes-agent:** none directly — `hermes-agent` Story 3.4b sends these commands; Story 4.3 owns the authoritative human decision record (Archon's response is transport evidence only, not proof gate evidence was sufficient).
Contract needed: approve/reject envelope shape (this story's own output).
Blocking behavior: `hermes-agent` cannot send decision commands until this exists.
Integration validation: Both sides validate against the same shared approve/reject fixtures.

---

### Story 3.3d: Provide Archon Recovery Command CLI JSON

As an implementation coordinator,
I want provider `archon` to expose resume, retry, and cancel through parseable CLI JSON,
So that external controllers can route recovery actions consistently.

**Requirements Covered:** FR-8.

**Implementation Scope:** Provider `archon` resume, retry, and cancel commands using the shared envelope from Story 3.3a.

Depends on: Story 3.3a, Story 3.3b (this file).
Contract needed: Workflow command resume, retry, cancel, timeout, success, and error envelope schemas.
Blocking behavior: Cannot be marked complete until resume, retry, and cancel commands use the shared envelope and represent unexpected state machine outcomes.
Integration validation: Validates resume, retry, cancel, timeout, and unexpected-state fixtures without introducing Hermes-specific command names.

**Acceptance Criteria:**

**Given** a workflow run accepts resume, retry, or cancel
**When** Archon performs the action
**Then** Archon returns parseable JSON for the action result
**And** the result can be consumed without relying on human-readable output.

**Given** a resume, retry, or cancel command fails
**When** Archon returns the failure
**Then** the response uses the shared workflow command envelope
**And** consumers can fail closed on malformed JSON, schema mismatch, timeout, unexpected state, or unexpected exit code.

**Depends on hermes-agent:** none directly — `hermes-agent` Story 3.4c consumes this.

---

### Story 3.5: Produce Signed Typed Archon Workflow Events From Outbox

As a workflow operator,
I want provider `archon` to emit workflow events through a signed typed event outbox,
So that workflow execution remains independent while Hermes receives compatible event notifications.

**Requirements Covered:** FR-9.

**Implementation Scope:** Provider `archon` event producer, outbox, signature metadata, and delivery attempts.

Depends on: shared workflow event envelope schema (parent Story 1.3b — blocked, see above), Story 3.1, Story 3.3a, Story 3.3b (this file).
Contract needed: Workflow event envelope schema, workflow provider event route and binding reference, signature metadata shape, replay metadata, idempotency key, and workflow delivery status shape.
Blocking behavior: Cannot be completed until shared workflow event examples exist locally and the provider binding surface (Story 3.1) can supply an event route and binding reference.
Integration validation: Validates signed workflow event fixtures and Hermes event rejection fixtures without introducing Hermes-specific Archon model names.

**Acceptance Criteria:**

**Given** Archon emits a workflow event for a bound project or codebase
**When** the event is eligible for Hermes notification
**Then** Archon writes the event to a non-blocking event outbox
**And** Archon workflow execution continues even if workflow event delivery later fails.

**Given** Archon prepares a workflow event payload for delivery
**When** the payload is serialized
**Then** it includes schema version, event id, event type, occurred timestamp, provider binding reference, workflow run reference, project or codebase reference, signature metadata, and idempotency key
**And** it matches the shared workflow event envelope example.

**Given** workflow event delivery fails, retries, or reaches terminal failure
**When** Archon records delivery status
**Then** it persists retry state, last attempt time if available, last error category, terminal failure state when applicable, and affected workflow run reference
**And** it keeps workflow execution independent from workflow event delivery success.

**Given** Archon emits duplicate or retried workflow event delivery attempts
**When** events are delivered
**Then** each payload carries stable event id and idempotency key values
**And** Hermes can detect duplicate-safe delivery from those fields.

**Depends on hermes-agent:** `hermes-agent` Stories 3.6a/3.6b/3.6c consume these events.
Contract needed: workflow event envelope schema (this story's own output).
Blocking behavior: `hermes-agent` cannot validate/ingest events until this exists.
Integration validation: Both sides validate against the same shared workflow event fixtures and rejection-case fixtures (bad signature, stale timestamp, duplicate event id, wrong binding, unknown project, schema mismatch, wrong-profile-secret).

---

### Story 3.7: Expose Archon Workflow Event Delivery Health

As an implementation coordinator,
I want provider `archon` to expose workflow event delivery and outbox health as parseable status,
So that external controllers can distinguish delayed, failed, duplicated, and terminal event delivery states.

**Requirements Covered:** FR-10.

**Implementation Scope:** Provider `archon` workflow event delivery status persistence, retry status, terminal failure diagnostics, and CLI status output.

Depends on: shared delivery status schema (parent Story 1.3a — blocked, see above), Story 3.1, Story 3.5 (this file).
Contract needed: Workflow delivery status schema, retry state, terminal failure category, duplicate-safe marker, and reconciliation-needed marker.
Blocking behavior: Cannot be marked complete until delivery status is persisted independently of workflow execution success.
Integration validation: Validates healthy, delayed, retrying, failed, duplicated, terminal failure, and waiting-for-reconciliation fixtures without blocking workflow execution.

**Acceptance Criteria:**

**Given** Archon workflow event delivery is delayed or retrying
**When** Archon reports delivery status through CLI JSON
**Then** the status includes retry state, last attempt time if available, next action if available, and whether user action is required
**And** the status links to the affected workflow event and workflow run reference.

**Given** Archon workflow event delivery reaches terminal failure
**When** Archon records the failure
**Then** Archon exposes delivery status, last error category, affected event type, workflow run reference, and recovery option
**And** Archon does not block workflow execution solely because event notification failed.

**Given** Archon retries or redelivers a workflow event
**When** Archon reports outbox health
**Then** the status preserves event id and idempotency key
**And** consumers can classify duplicate delivery without mutating project work.

**Depends on hermes-agent:** `hermes-agent` Story 3.8 displays this status.
Contract needed: delivery status schema (this story's own output).
Blocking behavior: `hermes-agent` Story 3.8 cannot surface health until this exists.
Integration validation: Both sides validate against the same shared delivery-status fixture.

## Validation Command

```text
cd Archon
bun run validate
```
