---
title: Archon Architecture Handoff - Hermes Agent Workflow Commander
status: handoff
created: '2026-07-02'
updated: '2026-07-02'
source_spine: workflow-engine parent workspace ARCHITECTURE-SPINE.md (architecture-workflow-engine-2026-06-26)
---

# Architecture: Archon Slice For Hermes Agent Workflow Commander

## Scope

This is the Archon-owned slice of the Hermes Agent Workflow Commander architecture. It covers only what Archon implements as the first workflow provider. The full spine (all 10 architecture decisions, all subprojects) lives in the parent workspace; this file exists so no Archon implementation agent needs to read it.

## Design Paradigm (Archon's role in it)

The parent architecture uses Bounded Context + Ports and Adapters + Outbox/Reconciliation. Within that:
- Archon owns workflow execution primitives, workflow run state, retry behavior, approval pauses, event production, and delivery.
- Hermes controls Archon only through a strict CLI adapter (never HTTP, for the state-changing control path).
- Archon reports state changes to Hermes only through signed, typed workflow events delivered via a non-blocking outbox.

## Relevant Architecture Decisions

### AD-2 - Split Project Binding and Workflow Provider Binding ownership [ADOPTED]

Archon owns the reverse binding: from codebase/project execution context to generic controller `provider` + `name` + workflow event route. Archon does not know or store Hermes profile identity, cwd, or GitHub context — those belong to Hermes's forward Project Binding.

### AD-3 - Control workflow providers through adapters and receive signed typed workflow events [ADOPTED]

Archon's CLI is the only state-changing control surface Hermes uses (no HTTP). Archon CLI commands must capture and return: cwd (when applicable), stdout, stderr, exit code, timeout, correlation id, and a JSON result. Archon delivers events from its own event outbox; events are accepted by Hermes only after schema, signature, replay, idempotency, profile, and binding checks — Archon's job is producing events that can pass those checks, not performing them.

### AD-7 - Version every cross-subproject machine contract [ADOPTED]

Workflow command envelopes, workflow event envelopes, and workflow provider binding records that Archon produces are JSON, schema-versioned, and must be compatibility-tested against shared examples before Archon's producer code is considered complete. Archon-specific fixtures live under the provider-specific fixture namespace inside the shared contracts package.

### AD-8 - Ratify the brownfield stack, avoid new runtime infrastructure for v1 [ADOPTED]

Archon stays on its existing workspace: Bun ^1.3.0, TypeScript ^5.3.0, Hono ^4.12.16, Zod ^4.4.3, Hono Zod OpenAPI ^1.4.0, `@archon/workflows` 0.4.1, `@archon/cli` 0.4.1 (workspace version 0.4.1 overall). No new database, queue, or runtime for this feature.

### AD-9 - Build contract-first, then split implementation by subproject [ADOPTED]

Archon producer work must not start against invented field names — it consumes the shared workflow command envelope, workflow event envelope, and workflow provider binding schema/examples from the parent's contract package (see "Blocked Dependencies" in local `prd.md` — these don't exist yet as of this handoff).

## Consistency Conventions (Archon-relevant subset)

| Concern | Convention |
| --- | --- |
| Controller naming | Generic `provider` and `name` vocabulary for external controller identity — never Hermes-specific. |
| Control direction | Hermes controls Archon through CLI only. |
| Event direction | Archon reports events to Hermes through a signed, non-blocking event outbox. |
| Data format | Cross-subproject contracts use JSON with explicit schema version and shared examples. |
| Command envelope | Every state-changing command result includes schema version, success flag, correlation id, run/binding reference, machine-readable result payload, and machine-readable error shape. |
| Workflow event envelope | Every event includes schema version, event id, event type, occurred timestamp, provider binding reference, workflow run reference, project/codebase/provider execution context reference, signature metadata, and idempotency key. |

## Stack (Archon-relevant rows)

| Name | Version |
| --- | --- |
| Archon workspace | 0.4.1 |
| Bun runtime | ^1.3.0 |
| TypeScript | ^5.3.0 |
| Hono | ^4.12.16 |
| Zod | ^4.4.3 |
| Hono Zod OpenAPI | ^1.4.0 |
| Archon workflows package | 0.4.1 |
| Archon CLI package | 0.4.1 |

## Source Tree Seed (Archon-owned files only)

```text
Archon/
  packages/cli/src/commands/
    provider-binding.ts      # Generic provider/name binding commands.
    workflow.ts               # Workflow control JSON output used by Hermes.
  packages/core/src/db/
    provider-bindings.ts      # Persistent reverse workflow event binding records.
    workflow-event-outbox.ts  # Durable workflow event delivery state.
  packages/workflows/src/
    store.ts                  # Workflow run and event source of truth.
    event-emitter.ts          # Event production integration point.
  packages/server/src/
    workflow-events/          # Optional delivery helpers, not Hermes control APIs.
```

Cross-check against Archon's actual current package layout (`packages/cli/src/commands/`, `packages/core/src/db/`, `packages/workflows/src/`) confirms these paths are consistent with the existing codebase structure — this is additive work inside existing packages, not a new package.

## Operational Envelope (Archon-relevant rows)

| Area | Boundary |
| --- | --- |
| Runtime | Archon runs as its existing local process/CLI — no new runtime. |
| Persistence | Archon keeps Workflow Provider Binding, workflow run state, workflow events, retry state, and event outbox status in Archon's existing persistence (SQLite/Postgres per existing config). |
| Network | Hermes-to-Archon control is local CLI execution only. Provider-to-Hermes notification is a configured workflow event route with signature and replay checks. |

## Capability Map (Archon-owned)

| Capability | Lives in | Governed by |
| --- | --- | --- |
| CAP-4 provider control (producer side) | Archon CLI JSON command surfaces | AD-3, AD-7, AD-9 |
| CAP-5 controller event routing (producer side) | Workflow Provider Binding + Archon event outbox | AD-2, AD-3, AD-7 |

## Deferred (Archon-relevant)

| Deferred Decision | Owner | Gate Before Implementation |
| --- | --- | --- |
| Exact provider command names and argument syntax | Archon (provider owner) | Shared command examples and schema tests exist before producer code merges. |
| Exact provider command JSON result schemas | Archon with Hermes consumer review | Shared success/error examples pass compatibility tests in both subprojects. |
| Exact workflow event signature algorithm, replay window, header names | Archon with Hermes security review | Event examples include signed, expired, duplicate, wrong-binding, invalid-schema cases. |

## Blocked Dependencies

Same as noted in local `prd.md`: the shared contract schemas/examples this architecture references do not exist yet in the parent workspace's `_bmad-output/planning-artifacts/contracts/workflow-commander/` (only a README placeholder as of 2026-07-02). Do not mark Archon producer stories implementation-ready until these are populated here or regenerated locally.

## Source

Derived from the parent workspace's `ARCHITECTURE-SPINE.md` (architecture-workflow-engine-2026-06-26, current as of 2026-07-01) and `epics.md` (current as of 2026-07-01, post `bmad-correct-course`).
