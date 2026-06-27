# Analyze Findings - Route Loop Decisions

**Status:** PENDING
**Generated:** 2026-06-27T15:45:46+07:00
**Spec:** spec.md
**Plan:** plan.md
**Tasks:** tasks.md
**Mode:** batch

**Instructions:**

- Review Section 2 Findings table.
- For each finding, edit the matching `### <ID>` block in Section 3 Resolutions Log.
- Fill `Category:` with one of: `spec-fix`, `new-OQ`, `accepted-risk`, `out-of-scope`, `skipped`.
- Fill `Payload:` per the category contract shown in each stub.
- Save the file, then run `/analyzebatch --apply`.
- Add `--allow-historical-edits` if any `spec-fix` targets `specs/002-route-loop-decisions/spec.md`, `plan.md`, or `tasks.md`.
- Pass `--dry-run` to preview the integration plan without writing.

---

## 1. Session Summary

Pending maintainer review.
The spec and plan broadly reflect the grill-me decision log, including the later safety additions from the archived red-team pass.
The remaining risks are mostly task-level gaps where accepted requirements are present in `spec.md` and `plan.md` but are not explicit enough in `tasks.md` to reliably drive implementation.

## 2. Findings

| ID  | Category           | Severity | Location(s)                                                                    | Summary                                                                                                                                                                                                                           | Recommendation                                                                                                                                                                         | Status   |
| --- | ------------------ | -------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| V1  | Coverage Gap       | HIGH     | spec.md:L230, plan.md:L156, tasks.md:L63-67, tasks.md:L95-100                  | FR-068 and the plan require rerun path self-containment validation at both loader and runtime, but the task list only clearly schedules loader validation and rerun invalidation.                                                 | Add explicit runtime validation and test tasks before or alongside T036 so stale persisted state, resume, retry, or bypassed loader validation cannot invalidate an unsafe rerun path. | spec-fix |
| A1  | Ambiguity          | MEDIUM   | spec.md:L182-185, tasks.md:L55                                                 | T012 says `when` rejection and `trigger_rule` rejection, but the spec has four distinct cases: reject `when` on `route_loop`, reject `trigger_rule` on `route_loop`, reject `when` on `from`, and allow `trigger_rule` on `from`. | Split T012 into explicit test cases, or add a companion task that names all four validation outcomes.                                                                                  | spec-fix |
| U1  | Underspecification | MEDIUM   | spec.md:L337, spec.md:L295-296, plan.md:L166, tasks.md:L127-130, tasks.md:L163 | SC-005 requires route decisions to appear within one live refresh cycle, and the plan calls out SSE or dashboard refetch behavior if needed, but tasks only cover typed event streaming and rendering.                            | Add a task to verify the Web store, SSE bridge, or polling refetch path propagates `node_routed` events with route metadata inside the expected live refresh cycle.                    | spec-fix |
| V2  | Coverage Gap       | MEDIUM   | spec.md:L181, plan.md:L132, tasks.md:L54-68                                    | FR-027 and the plan require a loader warning when `routes.negative` targets `from` directly, but no task explicitly covers the warning behavior or its test.                                                                      | Amend T012 or T019 to add the warning assertion and implementation path for direct negative-to-from routing.                                                                           | spec-fix |

**Coverage Summary:**

| Requirement Key   | Has Task? | Task IDs                                          | Notes                                                                                                                             |
| ----------------- | --------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| FR-001 to FR-018  | yes       | T011, T014-T018, T022-T023, T051-T065             | Public YAML, exclusivity, required outcomes, safe ids, and Web shape are covered.                                                 |
| FR-019 to FR-026  | yes       | T012, T018-T019                                   | Core loader validation and route target checks are covered.                                                                       |
| FR-027            | partial   | T012, T019                                        | Direct negative-to-from warning is required but not explicitly tasked.                                                            |
| FR-028 to FR-031  | partial   | T012, T018                                        | The task text is ambiguous about route-loop node fields versus `from` node fields.                                                |
| FR-032 to FR-049  | yes       | T013, T020-T021, T033, T047                       | Condition semantics and strict output resolution are covered.                                                                     |
| FR-050 to FR-067  | yes       | T032, T035-T037, T070, T074                       | Route activation, dormant targets, reruns, and compatibility branch behavior are covered.                                         |
| FR-068            | partial   | T019, T036                                        | Loader validation is clear, but runtime self-containment validation is not explicitly tasked.                                     |
| FR-069 to FR-080C | yes       | T008-T010, T024-T031, T034, T038-T039, T072, T075 | Counters, attempts, sequence, atomic state transitions, and stale-write protection are covered.                                   |
| FR-081 to FR-097  | yes       | T040-T049, T056-T057, T067                        | Latest outputs, event history, route metadata, and safe condition projection are covered.                                         |
| FR-098 to FR-106  | yes       | T070-T079                                         | Session, lifecycle, resume, and retry compatibility are covered.                                                                  |
| FR-107 to FR-124  | partial   | T051-T069                                         | Builder, graph, API, and route event rendering are covered, but live refresh verification for SC-005 is under-specified.          |
| FR-125 to FR-127  | yes       | T057, T074, T087-T089                             | Generated types, bundled checks, and backward compatibility are covered.                                                          |
| SC-001 to SC-004  | yes       | T001, T011-T039, T070, T074, T080                 | Authoring, runtime routing, and compatibility outcomes are covered.                                                               |
| SC-005            | partial   | T048, T067, T083                                  | Live refresh propagation needs an explicit verification task.                                                                     |
| SC-006 to SC-007  | yes       | T001, T051-T069, T090                             | Builder blocking and the route-loop TDD artifact are covered.                                                                     |
| CR-001 to CR-006  | yes       | T027-T031, T043-T049, T080-T089                   | Constitutional boundaries, type contracts, deterministic workflow behavior, lifecycle safety, and secret hygiene are represented. |

**Constitution Alignment Issues:** V1 touches Principle IV and Principle VI because runtime self-containment validation is part of deterministic fail-fast workflow behavior.

**Unmapped Tasks:** None.

**Metrics:**

- Total Requirements: 145
- Total Tasks: 90
- Coverage % (requirements with full or partial task coverage): 100%
- Ambiguity Count: 1
- Duplication Count: 0
- Critical Issues Count: 0

## 3. Resolutions Log

Fill exactly one resolution category per finding.
For `spec-fix`, `Before:` must be a verbatim substring that appears exactly once in the target file.

### V1

Category: spec-fix
Payload:
Target: specs/002-route-loop-decisions/tasks.md
Before:

- [ ] T036 [US2] Rerun completed selected targets as fresh attempts and invalidate only the selected rerun path back to the route-loop controller in `packages/workflows/src/dag-executor.ts`
      After:
- [ ] T036 [US2] Rerun completed selected targets as fresh attempts, validate the selected rerun path self-containment at runtime before invalidating latest-output state, and add executor coverage for stale persisted state, resume, retry, or loader-bypassed rerun paths in `packages/workflows/src/dag-executor.ts` and `packages/workflows/src/dag-executor.test.ts`
      Rationale: FR-068 requires rerun path self-containment validation at both load time and runtime in `specs/002-route-loop-decisions/spec.md:230`, the execution plan requires runtime validation before latest-output invalidation in `specs/002-route-loop-decisions/plan.md:156`, and D084 says runtime validation specifically guards resume, retry, stale persisted state, and loader-bypassed graph shapes in `plans/grill-me/260625-2337-route-loop-decisions.md:967-971`, so extending T036 is the smallest correct fix because T036 owns executor rerun-path invalidation.

### A1

Category: spec-fix
Payload:
Target: specs/002-route-loop-decisions/tasks.md
Before:

- [ ] T012 [US1] Add loader tests for required routes, `depends_on` and `from` mismatch, missing targets, self-target routes, `when` rejection, and `trigger_rule` rejection in `packages/workflows/src/loader.test.ts`
      After:
- [ ] T012 [US1] Add loader tests for required routes, `depends_on` and `from` mismatch, missing targets, self-target routes, rejecting `when` on `route_loop`, rejecting `trigger_rule` on `route_loop`, rejecting `when` on the `from` node, and allowing `trigger_rule` on the `from` node in `packages/workflows/src/loader.test.ts`
      Rationale: FR-028 through FR-031 split the validation contract into four distinct outcomes in `specs/002-route-loop-decisions/spec.md:182-185`, and D069 through D072 preserve the same distinction between forbidden route-loop fields and allowed `from` node `trigger_rule` behavior in `plans/grill-me/260625-2337-route-loop-decisions.md:790-828`, so T012 should name those cases explicitly instead of grouping them under ambiguous `when` and `trigger_rule` labels.

### U1

Category: spec-fix
Payload:
Target: specs/002-route-loop-decisions/tasks.md
Before:

- [ ] T056 [P] [US4] Add component tests for route-loop node handles and typed route event rendering in `packages/web/src/components/workflows/DagNodeComponent.test.ts`
      After:
- [ ] T056 [P] [US4] Add component, Web store, and SSE/refetch bridge tests for route-loop node handles, typed `node_routed` rendering, and route decision propagation within one live refresh cycle in `packages/web/src/components/workflows/DagNodeComponent.test.ts`, `packages/web/src/components/workflows/WorkflowExecution.test.tsx`, `packages/web/src/stores/workflow-store.test.ts`, and `packages/server/src/adapters/web/workflow-bridge.test.ts`
      Rationale: SC-005 requires run detail to show route decisions within one live refresh cycle in `specs/002-route-loop-decisions/spec.md:337`, the plan explicitly leaves SSE or dashboard refetch updates in scope in `specs/002-route-loop-decisions/plan.md:166`, and the current Web path uses fixed SSE handler and bridge mappings without a `node_routed` case in `packages/web/src/stores/workflow-store.ts:368-374`, `packages/web/src/hooks/useSSE.ts:176-193`, and `packages/server/src/adapters/web/workflow-bridge.ts:228-233`, so the task must verify the event crosses the live propagation path rather than only rendering a static typed event.

### V2

Category: spec-fix
Payload:
Target: specs/002-route-loop-decisions/tasks.md
Before:

- [ ] T019 [US1] Add route-edge cycle validation, positive and exhausted exit-path validation, nested route-loop allowance, and self-contained negative path validation in `packages/workflows/src/loader.ts`
      After:
- [ ] T019 [US1] Add route-edge cycle validation, positive and exhausted exit-path validation, nested route-loop allowance, warning behavior when `routes.negative` targets `route_loop.from` directly, and self-contained negative path validation in `packages/workflows/src/loader.ts`
      Rationale: FR-027 requires a loader warning when `routes.negative` targets the `from` node directly in `specs/002-route-loop-decisions/spec.md:181`, the implementation plan repeats that warning in `specs/002-route-loop-decisions/plan.md:132`, and D039 explains the shape is valid for polling or flaky checks but should warn in review-fix flows in `plans/grill-me/260625-2337-route-loop-decisions.md:459-463`, so T019 is the right implementation task because it already owns route-edge and negative-path validation in the loader.

---

## 5. Session Metadata

```yaml
session:
  generated_at: 2026-06-27T15:45:46+07:00
  feature_dir: specs/002-route-loop-decisions
  artifacts_analyzed:
    - spec.md
    - plan.md
    - tasks.md
    - .specify/memory/constitution.md
    - plans/grill-me/260625-2337-route-loop-decisions.md
  findings:
    total: 4
    by_severity:
      critical: 0
      high: 1
      medium: 3
      low: 0
    by_category:
      duplication: 0
      ambiguity: 1
      underspecification: 1
      constitution: 0
      coverage: 2
      inconsistency: 0
    overflow_dropped: 0
apply: {}
```
