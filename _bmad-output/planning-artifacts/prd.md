---
title: Archon PRD Handoff - BMAD TEA V2 Workflow Orchestration
status: handoff
created: "2026-06-30"
updated: "2026-06-30"
source_parent_prd: ../../../_bmad-output/planning-artifacts/prds/prd-workflow-engine-2026-06-29/prd.md
source_parent_epics: ../../../_bmad-output/planning-artifacts/epics-bmad-tea-workflow-orchestration-2026-06-29/epics.md
---

# Archon PRD Handoff: BMAD TEA V2 Workflow Orchestration

## Document Purpose

This document is the local Archon product requirements handoff for the BMAD TEA v2 workflow orchestration feature.
It contains only the Archon-owned requirements needed for isolated implementation inside this repository.
It is intended to be read with `architecture.md` and `epics.md` in this same folder.
Implementation agents must not traverse out of this repository to read parent workspace planning files.

## Product Context

The operator needs a generalized Archon workflow that can run BMAD story implementation with BMAD TEA quality evidence and a single fix loop.
The workflow must preserve BMAD-METHOD ownership of story, development, and code-review semantics.
The workflow must preserve BMAD-TEA ownership of test automation evidence, test quality review, NFR review, and traceability review.
Archon owns orchestration, DAG wiring, route decisions, branch conditions, loop behavior, external issue-sync orchestration, and final PR handoff wiring.

The v2 workflow must be created as `bmad-dev-story-with-tea-fix-loop-v2.yml`.
The existing `bmad-dev-story-with-tea-fix-loop.yml` is the baseline and must not be modified by this feature.
The workflow input remains `$ARGUMENTS`.
The v2 workflow must not require changes to `bmad-create-story-with-tea`.

## Scope

Archon owns these capabilities:

- Add and register `bmad-dev-story-with-tea-fix-loop-v2.yml`.
- Keep the source workflow and bundled default workflow registry consistent.
- Invoke BMAD-METHOD `bmad-code-review-auto` directly for `CR`.
- Wire `dev-story`, `tea-automate`, `code-review-auto`, `gate-planner`, `tea-rv`, `tea-rv-skipped`, `tea-nr`, `tea-nr-skipped`, `tea-tr`, `tea-tr-skipped`, `quality-gate-summary`, `quality-route-loop`, `decision-needed-check`, `review-loop-error`, and `create-pull-request`.
- Route only on stable JSON contracts.
- Treat markdown reports as human evidence, not route APIs.
- Use `when:` expressions and skipped-contract nodes for optional TEA gates.
- Use one `route_loop` after `quality-gate-summary`.
- Route quality `FAIL` back to `dev-story`.
- Route `PASS` forward to `decision-needed-check`.
- Route tooling, schema, contract, evidence, and external sync `ERROR` to explicit error handling.
- Create or reuse Linear follow-up issues for unresolved `decision_needed` findings before PR preparation.
- Link CR, RV, NR, TR, quality summary, and decision-needed evidence in final workflow output and PR handoff.
- Validate the v2 workflow through Archon's existing workflow validation process.

Archon does not own these capabilities:

- BMAD-METHOD review layers, triage vocabulary, or `bmad-code-review-auto` internals.
- BMAD-TEA gate semantics, TEA report content, or TEA evidence generation internals.
- Changing `bmad-create-story-with-tea`.
- Hermes callback behavior or Hermes-specific contract fields.
- The full lifecycle after Linear decision-needed issue creation and sync.

## Functional Requirements

### A-FR-1: Add Versioned V2 Workflow Without Changing Baseline

Archon must add `bmad-dev-story-with-tea-fix-loop-v2.yml` as the redesign surface.
Archon must keep `bmad-dev-story-with-tea-fix-loop.yml` unchanged.
The v2 workflow must accept `$ARGUMENTS` as the story input contract.
The v2 workflow must not require changes to `bmad-create-story-with-tea`.

Acceptance criteria:

- Given the existing workflow file exists, when v2 is added, then the existing workflow remains unchanged and the new v2 workflow exists.
- Given Archon loads default workflows, when v2 is registered, then the workflow is discoverable through the same default workflow mechanism as other bundled workflows.
- Given Archon validates workflows, when validation runs, then the v2 workflow passes schema and DAG validation.

### A-FR-2: Invoke BMAD-Owned Code Review Auto

Archon must invoke BMAD-METHOD `bmad-code-review-auto` directly for the `CR` step.
Archon must not use a wrapper that reinterprets BMAD findings.
Archon must consume the `code-review-auto.gate.json` route contract.

Acceptance criteria:

- Given the v2 workflow reaches `code-review-auto`, when it invokes code review, then it calls the BMAD-METHOD automation surface.
- Given `code-review-auto.gate.json` exists, when downstream nodes route, then they read the JSON contract and not the markdown review report.
- Given the BMAD-METHOD contract is missing or invalid, when Archon validates the node output, then the workflow enters `ERROR`.

### A-FR-3: Plan Conditional TEA Release Gates

Archon must add a `gate-planner` node that emits `gate-planner.json`.
The planner output must include `run_rv`, `run_nr`, `run_tr`, and reasons.
Archon must model `RV` and `NR` as sibling branches controlled by `when:` expressions.
Each optional branch must have a skipped-contract node.
`TR` must join resolved `RV` and `NR` branches before final traceability evaluation.

Acceptance criteria:

- Given `gate-planner.json` has `run_rv: true`, when the DAG evaluates `RV`, then `tea-rv` runs.
- Given `gate-planner.json` has `run_rv: false`, when the DAG evaluates `RV`, then `tea-rv-skipped` emits a `SKIPPED` contract.
- Given `gate-planner.json` has `run_nr: true`, when the DAG evaluates `NR`, then `tea-nr` runs.
- Given `gate-planner.json` has `run_nr: false`, when the DAG evaluates `NR`, then `tea-nr-skipped` emits a `SKIPPED` contract.
- Given `run_tr` is true, when `RV` and `NR` are resolved, then `tea-tr` joins the resolved contracts.

### A-FR-4: Aggregate One Route Contract

Archon must run `quality-gate-summary` after CR, RV, NR, and TR are resolved.
`quality-gate-summary` must read only JSON contracts.
It must emit `quality-gate-summary.json` as the only route source for the quality loop.

Acceptance criteria:

- Given one or more source gate contracts contain blocking findings, when summary runs, then it emits `gate: FAIL`.
- Given no source gate contains blocking findings, when summary runs, then it emits `gate: PASS`.
- Given only `decision_needed` findings remain, when summary runs, then it can still emit `gate: PASS` and preserve `decision_needed_count`.
- Given any source contract is missing, invalid, untrusted, or has a mismatched `story_ref`, when summary validates input, then it emits or routes to `ERROR`.

### A-FR-5: Use One Quality Route Loop

Archon must use a single `quality-route-loop` after `quality-gate-summary`.
The negative route must return to `dev-story`.
The positive route must continue to `decision-needed-check`.
Loop exhaustion must route to `review-loop-error`.
`ERROR` outcomes must not route back to `dev-story`.

Acceptance criteria:

- Given summary emits `FAIL`, when the route loop runs, then the workflow returns to `dev-story`.
- Given summary emits `PASS`, when the route loop runs, then the workflow continues to `decision-needed-check`.
- Given the loop exhausts, when routing runs, then `review-loop-error` records the open findings and exhausted round count.
- Given any gate emits `ERROR`, when routing runs, then the workflow follows an explicit error path.

### A-FR-6: Orchestrate Decision-Needed Follow-Up Before PR

Archon must run `decision-needed-check` after the route loop passes and before PR preparation.
If unresolved `decision_needed` findings exist, Archon must create or reuse Linear issues and sync references back into BMAD artifacts through the owning contract.
If issue creation or sync fails, the workflow must not continue to PR preparation.

Acceptance criteria:

- Given `decision_needed_count > 0`, when `decision-needed-check` runs, then it creates or reuses one Linear issue per unresolved finding.
- Given a Linear issue is created, when sync completes, then the issue id and URL are written back to BMAD artifacts.
- Given issue creation or sync fails, when the node emits output, then it emits `ERROR`.
- Given no decision-needed findings exist, when the node runs, then it emits a successful no-op result.

### A-FR-7: Prepare PR Handoff With Quality Evidence

Archon must link quality evidence in the final workflow output and PR handoff.
The handoff must show whether decision-needed items were deferred to Linear.
The handoff must not imply deferred human-judgment work was fixed in the PR.

Acceptance criteria:

- Given PR handoff is generated, when quality evidence exists, then the handoff links CR, RV, NR, TR, quality summary, and decision-needed-check artifacts.
- Given deferred decision-needed items exist, when the handoff is generated, then each item lists finding id, title, source gate, Linear issue id, Linear URL, and deferred status.
- Given no deferred items exist, when the handoff is generated, then it explicitly states that no decision-needed items were deferred.

## Non-Functional Requirements

- Archon must fail closed on missing, invalid, or untrusted JSON contracts.
- Archon must preserve the same `story_ref` across all route-facing contracts for a workflow run.
- Archon must keep workflow source and bundled defaults consistent.
- Archon must keep route logic explicit through `when:`, `trigger_rule`, `output_format`, and `route_loop`.
- Archon must not parse markdown reports for routing.
- Archon must keep Hermes-specific callback behavior out of this v2 scope.
