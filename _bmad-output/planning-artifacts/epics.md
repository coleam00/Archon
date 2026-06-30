---
title: Archon Epics Handoff - BMAD TEA V2 Workflow Orchestration
status: handoff
created: "2026-06-30"
updated: "2026-06-30"
source_parent_epics: ../../../_bmad-output/planning-artifacts/epics-bmad-tea-workflow-orchestration-2026-06-29/epics.md
---

# Archon Epics: BMAD TEA V2 Workflow Orchestration

## Overview

This file contains the Archon-owned subset of the parent BMAD TEA v2 workflow orchestration epics.
It is local planning input for implementation inside `archon`.
It excludes BMAD-METHOD and BMAD-TEA implementation work except where dependency notes are required.
No Archon story may require traversal out of `archon` to read parent workspace planning files during implementation.

## Epic A1: Safe V2 Workflow Entrypoint

Archon can expose a separate v2 workflow without changing the current baseline workflow.

### Story A1.1: Add Versioned V2 Workflow Baseline

As an Archon workflow maintainer,
I want a separate v2 BMAD implementation workflow,
So that the operator can validate the redesigned orchestration without changing the current baseline workflow.

**Requirements Covered:** A-FR-1.

Depends on: none.
Contract needed: Archon workflow YAML schema and bundled-default registry contract.
Blocking behavior: No downstream v2 workflow story can complete until the v2 workflow exists and the original workflow is verified unchanged.
Integration validation: Archon workflow validation proves the source workflow and bundled default are consistent.

**Acceptance Criteria:**

**Given** `bmad-dev-story-with-tea-fix-loop.yml` exists
**When** the v2 workflow is added
**Then** `bmad-dev-story-with-tea-fix-loop.yml` remains unchanged
**And** `bmad-dev-story-with-tea-fix-loop-v2.yml` exists as the redesign surface.

**Given** Archon loads default workflow definitions
**When** the v2 workflow is registered or bundled
**Then** the v2 workflow is discoverable through the same default workflow path as other bundled workflows
**And** source and bundled defaults stay consistent.

### Story A1.2: Preserve Story Input Resolution

As an Archon workflow maintainer,
I want v2 to accept the same `$ARGUMENTS` story input as the current workflow,
So that operators can run v2 against existing BMAD stories without changing create-story behavior.

**Requirements Covered:** A-FR-1.

Depends on: Story A1.1.
Contract needed: `$ARGUMENTS` story reference and normalized `story_ref`.
Blocking behavior: Quality gate stories cannot complete until each node can preserve or validate the same `story_ref`.
Integration validation: A validation fixture proves invalid, missing, ambiguous, and mismatched story input produce `ERROR`.

**Acceptance Criteria:**

**Given** the operator invokes v2 with `$ARGUMENTS`
**When** the workflow starts
**Then** the workflow preserves `$ARGUMENTS` as the input contract
**And** no change is required to `bmad-create-story-with-tea`.

**Given** downstream route-facing contracts are emitted
**When** story identity is validated
**Then** every contract uses the same `story_ref`
**And** mismatch produces `ERROR`.

## Epic A2: Core BMAD And TEA Quality Pipeline

Archon can run the core `DS -> TA -> CR` pipeline and consume BMAD-owned quality contracts.

### Story A2.1: Wire DS TA CR Sequence

As an Archon workflow maintainer,
I want v2 to run development, test automation, and BMAD-native code review in sequence,
So that the workflow reaches a structured quality decision point.

**Requirements Covered:** A-FR-2.

Depends on: Story A1.2, BMAD-METHOD Story M1.1, and BMAD-TEA Story T1.1.
Contract needed: `code-review-auto.gate.json` and test automation evidence pointer.
Blocking behavior: This story cannot complete until BMAD-METHOD exposes `bmad-code-review-auto` and BMAD-TEA exposes automation evidence usable by `gate-planner`.
Integration validation: A fixture run proves `dev-story`, `tea-automate`, and `code-review-auto` share the same `story_ref`.

**Acceptance Criteria:**

**Given** v2 runs the core pipeline
**When** the pipeline reaches `code-review-auto`
**Then** Archon invokes BMAD-METHOD `bmad-code-review-auto`
**And** downstream routing reads the emitted JSON contract.

**Given** `dev-story`, `tea-automate`, or `code-review-auto` fails with execution or contract errors
**When** the workflow evaluates the failure
**Then** the result is `ERROR`
**And** it does not route back to `dev-story` as ordinary quality work.

## Epic A3: Conditional TEA Release Gates

Archon can run `RV` and `NR` conditionally and join resolved branches into final traceability.

### Story A3.1: Add Gate Planner Flags

As an Archon workflow maintainer,
I want `gate-planner` to emit conditional release-gate flags,
So that `RV`, `NR`, and `TR` are planned from structured evidence.

**Requirements Covered:** A-FR-3.

Depends on: Story A2.1.
Contract needed: `gate-planner.json`.
Blocking behavior: Optional TEA branch stories cannot complete until `gate-planner.json` includes `run_rv`, `run_nr`, `run_tr`, and reasons.
Integration validation: Fixtures prove true and false values for `run_rv` and `run_nr`.

**Acceptance Criteria:**

**Given** CR and TA evidence are available
**When** `gate-planner` runs
**Then** it emits `run_rv`, `run_nr`, `run_tr`, and reasons
**And** invalid evidence produces `ERROR`.

### Story A3.2: Wire RV And NR Sibling Branches

As an Archon workflow maintainer,
I want `RV` and `NR` to run as conditional sibling branches,
So that optional gate execution is explicit and observable.

**Requirements Covered:** A-FR-3.

Depends on: Story A3.1 and BMAD-TEA Stories T2.1 and T3.1.
Contract needed: `tea-rv.gate.json`, `tea-rv-skipped.gate.json`, `tea-nr.gate.json`, and `tea-nr-skipped.gate.json`.
Blocking behavior: This story cannot complete until real and skipped contracts are available for both branches.
Integration validation: DAG validation and fixtures prove each true and false flag resolves exactly one branch contract.

**Acceptance Criteria:**

**Given** `run_rv` is true
**When** DAG conditions are evaluated
**Then** `tea-rv` runs
**And** `tea-rv-skipped` does not run.

**Given** `run_rv` is false
**When** DAG conditions are evaluated
**Then** `tea-rv-skipped` emits `SKIPPED`
**And** downstream nodes can distinguish skip from missing evidence.

**Given** `run_nr` is true or false
**When** DAG conditions are evaluated
**Then** exactly one of `tea-nr` or `tea-nr-skipped` resolves.

### Story A3.3: Join TR As Final Gate

As an Archon workflow maintainer,
I want `TR` to run after resolved RV and NR branch outputs,
So that traceability is evaluated as the final release gate.

**Requirements Covered:** A-FR-3.

Depends on: Story A3.2 and BMAD-TEA Story T4.1.
Contract needed: `tea-tr.gate.json` and `tea-tr-skipped.gate.json`.
Blocking behavior: This story cannot complete until TR can consume resolved RV and NR outputs.
Integration validation: DAG validation proves `trigger_rule` and dependencies behave under run and skip cases.

**Acceptance Criteria:**

**Given** `run_tr` is true
**When** RV and NR branches resolve
**Then** `tea-tr` runs with a valid trigger rule
**And** it consumes either real gate contracts or skipped contracts.

**Given** `run_tr` is false
**When** the TR branch resolves
**Then** `tea-tr-skipped` emits `SKIPPED`
**And** the summary can still run from a resolved TR role contract.

## Epic A4: One Quality Route Loop

Archon can aggregate quality results and route exactly one bounded fix loop.

### Story A4.1: Aggregate Quality Gate Summary

As an Archon workflow maintainer,
I want `quality-gate-summary` to aggregate source gate contracts,
So that the workflow has one route-facing quality decision.

**Requirements Covered:** A-FR-4.

Depends on: Stories A2.1, A3.2, and A3.3.
Contract needed: `quality-gate-summary.json`.
Blocking behavior: This story cannot complete until one resolved contract exists for CR, RV, NR, and TR roles.
Integration validation: Fixtures prove PASS, FAIL, decision-needed-only PASS, missing contract ERROR, and story mismatch ERROR.

**Acceptance Criteria:**

**Given** source gate contracts are available
**When** summary runs
**Then** it reads JSON contracts only
**And** it emits `quality-gate-summary.json`.

**Given** blocking findings exist
**When** summary aggregates outputs
**Then** it emits `FAIL`.

**Given** only decision-needed findings exist
**When** summary aggregates outputs
**Then** it can emit `PASS`
**And** it preserves `decision_needed_count`.

### Story A4.2: Route Quality Loop And Error Paths

As an Archon workflow maintainer,
I want one bounded quality route loop after summary,
So that fixable quality findings return to development while errors stop cleanly.

**Requirements Covered:** A-FR-5.

Depends on: Story A4.1.
Contract needed: route-loop configuration and review-loop error artifact.
Blocking behavior: This story cannot complete until PASS, FAIL, ERROR, and exhaustion paths are validated.
Integration validation: A workflow fixture proves FAIL routes to `dev-story`, PASS routes forward, ERROR does not route to `dev-story`, and exhaustion writes `review-loop-error`.

**Acceptance Criteria:**

**Given** summary emits `FAIL`
**When** `quality-route-loop` runs
**Then** the route returns to `dev-story`
**And** the next round keeps the same `story_ref`.

**Given** summary emits `PASS`
**When** `quality-route-loop` runs
**Then** the route continues to `decision-needed-check`.

**Given** loop budget is exhausted
**When** routing runs
**Then** `review-loop-error` records open findings and round count.

## Epic A5: Decision Needed And PR Handoff Orchestration

Archon can turn deferred decisions into Linear follow-up and prepare PR handoff evidence.

### Story A5.1: Orchestrate Decision Needed Follow-Up

As an Archon workflow maintainer,
I want `decision-needed-check` to create or reuse Linear issues and invoke the BMAD-METHOD sync contract,
So that deferred human-judgment items are tracked in Linear and recorded in BMAD artifacts before PR preparation.

**Requirements Covered:** A-FR-6.

Depends on: Story A4.2, BMAD-METHOD Story M3.1, and BMAD-METHOD Story M3.2.
Contract needed: `decision-needed.json`, Linear issue fields, BMAD-METHOD sync request and response, and `decision-needed-check.json`.
Blocking behavior: PR preparation cannot run when Linear issue creation fails, the BMAD-METHOD sync contract is unavailable, or BMAD-METHOD sync returns `ERROR`.
Integration validation: Fixtures prove created, reused, no-op, sync-success, sync-failure, and sync-contract-missing outcomes.

**Acceptance Criteria:**

**Given** unresolved `decision_needed` findings exist
**When** `decision-needed-check` runs
**Then** it creates or reuses Linear issues
**And** sends Linear issue id, Linear URL, finding id, and story reference to the BMAD-METHOD sync contract.

**Given** BMAD-METHOD sync succeeds
**When** `decision-needed-check` emits output
**Then** `decision-needed-check.json` records the created or reused issue count, synced count, and deferred status.

**Given** BMAD-METHOD sync fails or is unavailable
**When** `decision-needed-check` emits output
**Then** it emits `ERROR`
**And** the workflow does not continue to PR preparation.

### Story A5.2: Generate PR Handoff With Evidence Links

As a human reviewer,
I want the PR handoff to show all quality and deferred-decision evidence,
So that I can review the PR without reading Archon node logs.

**Requirements Covered:** A-FR-7.

Depends on: Story A5.1.
Contract needed: PR handoff artifact shape and evidence link fields.
Blocking behavior: PR handoff cannot be complete until CR, RV, NR, TR, summary, and decision-needed evidence links are available.
Integration validation: A fixture proves deferred decisions are listed when present and absent decisions are explicitly reported when none exist.

**Acceptance Criteria:**

**Given** PR handoff is generated
**When** quality evidence exists
**Then** the handoff links CR, RV, NR, TR, quality summary, and decision-needed-check artifacts.

**Given** deferred decision-needed items exist
**When** the handoff is generated
**Then** it lists each item with finding id, title, source gate, Linear issue id, Linear URL, and deferred status.

## Epic A6: End-To-End Archon Validation

Archon can prove the v2 workflow through a representative story run.

### Story A6.1: Validate The Vertical Slice

As an Archon workflow maintainer,
I want one full v2 workflow run to prove the route behavior,
So that the operator can trust the workflow before broad use.

**Requirements Covered:** A-FR-1 through A-FR-7.

Depends on: Stories A1.1 through A5.2, BMAD-METHOD Stories M3.2 and M4.1, and BMAD-TEA Story T5.1.
Contract needed: selected proof story, workflow run evidence, quality contracts, skipped contracts, decision-needed-check output, and PR handoff.
Blocking behavior: This story cannot complete until all cross-project contracts are available.
Integration validation: One run proves first-round CR `FAIL`, route to `dev-story`, second-round pass, conditional TEA branch behavior, final TR, optional decision-needed handling, and PR handoff links.

**Acceptance Criteria:**

**Given** the proof story is selected
**When** v2 runs end to end
**Then** first-round `CR` can produce a patch finding that routes back to `dev-story`
**And** a later round clears blocking findings and routes forward.

**Given** conditional gates are planned
**When** the proof run reaches TEA gates
**Then** at least one optional branch runs or skips with an explicit contract
**And** `TR` runs as final traceability gate when release evaluation proceeds.

**Given** the workflow completes
**When** evidence is reviewed
**Then** the old workflow remains unchanged
**And** the v2 workflow evidence is linked from the PR handoff.
