# Analyze Findings - Manual Failed-Node Retry Decisions

**Status:** ARCHIVED
**Applied:** 2026-06-21-225739
**Generated:** 2026-06-21T22:50:30+07:00
**Spec:** spec.md
**Plan:** plan.md
**Tasks:** tasks.md
**Mode:** batch

**Instructions:**

- Review §2 Findings table.
- For each finding, edit the matching `### <ID>` block in §3 Resolutions Log.
  Fill `Category:` with one of: `spec-fix`, `new-OQ`, `accepted-risk`, `out-of-scope`, `skipped`.
  Fill `Payload:` per the category contract (see §3 stubs for templates).
- Save the file, then run `/analyzebatch --apply` (add `--allow-historical-edits` if any
  `spec-fix` targets `specs/<feature-id>/spec.md` / `plan.md` / `tasks.md`).
- Pass `--dry-run` to preview the integration plan without writing.

---

## 1. Session Summary

Analysis used `spec.md`, `plan.md`, `tasks.md`, `.specify/memory/constitution.md`, and the origin grill-me decision log at `plans/grill-me/260621-1239-manual-node-retry-decisions.md`. The feature intent is mostly consistent across artifacts. Findings concentrate on task-level gaps where high-risk MUST requirements could be missed during implementation: checkpoint persistence contracts, mandatory retry audit event durability, tracked reset validation, `mutates_checkout: false` no-reset behavior, and git failure modes.

The project constitution is still the default placeholder and contributes no concrete MUST/SHOULD gates beyond the project instructions already reflected in the plan.

## 2. Findings

| ID  | Category           | Severity | Location(s)                                                                     | Summary                                                                                                                                                                                                                                                                       | Recommendation                                                                                                                                                                                  | Status   |
| --- | ------------------ | -------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| U1  | Underspecification | HIGH     | plan.md:L141-146; tasks.md:L35-38, L68-76, L104-108; contracts/events.md:L11-14 | The plan correctly says mandatory retry audit events cannot rely only on the current non-throwing workflow-store event writer, but tasks only say to "write" retry events and never add a strict persistence path or verification task.                                       | Add an explicit task for a throwing/verified retry audit event writer and wire `node_retry_requested`, `node_retry_reset`, and `node_retry_failed` through it before dispatch/failure recovery. | spec-fix |
| V1  | Coverage           | HIGH     | plan.md:L70-77; tasks.md:L29-46, L98-103                                        | Checkpoint rows must be written from workflow execution, but tasks do not explicitly extend the `@archon/workflows` store/deps contract so `dag-executor.ts` can request checkpoint persistence through the core store adapter.                                               | Add tasks to extend `IWorkflowStore`/workflow deps with narrow checkpoint methods and wire the core store adapter before implementing DAG pre-node checkpoint writes.                           | spec-fix |
| V2  | Coverage           | HIGH     | spec.md:L198-199; tasks.md:L90-108                                              | The spec requires `git rev-parse --verify <ref-or-sha>^{commit}` validation before reset and `node_retry_failed` on validation failure, but the tasks cover `git check-ref-format` and reset failure without a distinct ref/SHA commit-resolution validation task or test.    | Add a git/core task and failing test for checkpoint ref/SHA verification before reset, including invalid/missing refs producing `node_retry_failed` and no dispatch.                            | spec-fix |
| V3  | Coverage           | HIGH     | spec.md:L107, L154-155; tasks.md:L56-76, L98-108                                | `mutates_checkout: false` requires checkpointing to be skipped by default and retry to proceed without checkout reset when no checkpoint exists, but implementation tasks T049-T054 do not state that gate and the only `mutates_checkout: false` test is a retry-scope test. | Add explicit tasks/tests for `mutates_checkout: false`: no checkpoint creation by default, no reset when no checkpoint exists, and `node_retry_reset.reset_skipped = true`.                     | spec-fix |
| V4  | Coverage           | MEDIUM   | spec.md:L108-110, L201, L207; tasks.md:L90-108                                  | The spec calls out non-git repositories and missing git identity as fail-fast edge cases, but the git/helper tasks do not explicitly test or implement clear guidance for those cases.                                                                                        | Add focused tests/tasks for non-git repo rejection and missing `user.name`/`user.email` commit failures, ensuring no stash fallback and no executor dispatch.                                   | spec-fix |

(One row per finding. `Status` column blank - `/analyzebatch --apply` fills it with
the resolution category from the §3 block.)

**Coverage Summary:**

| Requirement Key | Has Task? | Task IDs                    | Notes                                                                                            |
| --------------- | --------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| FR-015-FR-018   | partial   | T016-T018, T035, T055, T056 | Retry event types are covered, but mandatory durable persistence is not explicit.                |
| FR-025-FR-036   | partial   | T009-T015, T045, T049-T052  | Storage/query work is covered, but the workflow-store checkpoint write contract is not explicit. |
| FR-031          | partial   | T027, T049-T054             | `mutates_checkout: false` no-checkpoint/no-reset behavior needs direct coverage.                 |
| FR-052-FR-053   | partial   | T043, T047, T054, T056      | Ref-name validation is covered; commit-resolution validation before reset is not.                |
| FR-055, FR-061  | partial   | T003, T046, T053, T054      | Git failure modes need explicit tests and user-facing error behavior.                            |

**Constitution Alignment Issues:** None. `.specify/memory/constitution.md` contains placeholder principle text only.

**Unmapped Tasks:** None detected. The concern is weak coverage for specific MUST clauses, not orphaned tasks.

**Metrics:**

- Total Requirements: 114
- Total Tasks: 97
- Coverage % (requirements with >=1 task): 96%
- Ambiguity Count: 0
- Duplication Count: 0
- Critical Issues Count: 0

## 3. Resolutions Log

### U1

Category: spec-fix
Payload:
Target: specs/001-manual-node-retry-decisions/tasks.md
Before:

- [ ] T024 Add retry operation request/result/error types in `packages/core/src/operations/workflow-retry.ts`
      After:
- [ ] T024 Add retry operation request/result/error types and a strict retry audit event writer in `packages/core/src/operations/workflow-retry.ts`; T035/T055/T056 MUST call this writer instead of `IWorkflowStore.createWorkflowEvent()` for retry audit events
      Rationale: The finding is valid because retry audit events are hard MUSTs in `specs/001-manual-node-retry-decisions/spec.md:136-139`, and the plan explicitly says mandatory retry audit events need a DB path that throws or verifies persistence in `specs/001-manual-node-retry-decisions/plan.md:141-146`. The local event contract repeats that these three events must not rely only on the normal non-throwing writer in `specs/001-manual-node-retry-decisions/contracts/events.md:11-14`, and the existing `IWorkflowStore.createWorkflowEvent()` contract is intentionally observable-only/non-throwing in `packages/workflows/src/store.ts:99-110` with the core adapter swallowing unexpected errors in `packages/core/src/workflows/store-adapter.ts:61-72`. Updating T024 is the smallest durable task change because it creates the strict writer at the shared retry operation boundary before T035, T055, and T056 write the three mandatory events.
      Status: applied
      Applied-at: 2026-06-21T22:57:39+07:00
      Downstream-ref: specs/001-manual-node-retry-decisions/tasks.md

### V1

Category: spec-fix
Payload:
Target: specs/001-manual-node-retry-decisions/tasks.md
Before:

- [ ] T015 Export checkpoint DB module from `packages/core/src/db/index.ts`
      After:
- [ ] T015 Export checkpoint DB module from `packages/core/src/db/index.ts` and extend `IWorkflowStore`/workflow deps with narrow checkpoint persistence methods that the core store adapter implements for pre-node DAG checkpoint writes
      Rationale: The finding is valid because checkpoint rows are mandatory storage, not optional observability: `specs/001-manual-node-retry-decisions/spec.md:149-158` requires a dedicated checkpoint table and executable-node checkpointing, while `specs/001-manual-node-retry-decisions/plan.md:70-77` names `packages/core/src/workflows/store-adapter.ts` as the bridge for new `IWorkflowStore` methods. Existing tasks create DB queries (T014) and later say DAG execution should persist rows (T049-T050), but no task explicitly extends the workflow-store/deps contract that lets `packages/workflows/src/dag-executor.ts` call into core-owned storage. Extending T015 keeps the fix in the foundational storage/export phase and avoids a broader redesign.
      Status: applied
      Applied-at: 2026-06-21T22:57:39+07:00
      Downstream-ref: specs/001-manual-node-retry-decisions/tasks.md

### V2

Category: spec-fix
Payload:
Target: specs/001-manual-node-retry-decisions/tasks.md
Before:

- [ ] T043 [P] [US2] Add retry safety ref/commit and `git reset --hard` failure test in `packages/git/src/git.test.ts`
      After:
- [ ] T043 [P] [US2] Add retry safety ref/commit, checkpoint ref/SHA `git rev-parse --verify <ref-or-sha>^{commit}` validation, invalid/missing ref producing `node_retry_failed` with no dispatch, and `git reset --hard` failure tests in `packages/git/src/git.test.ts` and `packages/core/src/operations/workflow-retry.test.ts`
      Rationale: The finding is valid because `specs/001-manual-node-retry-decisions/spec.md:198-199` requires commit-resolution validation before reset and mandates `node_retry_failed` when that validation fails. Current tasks cover `git check-ref-format` in T047 and generic reset/failure work in T054-T056, but the only explicit test task at `specs/001-manual-node-retry-decisions/tasks.md:90-93` covers reset failure, not invalid or missing checkpoint refs resolving through `git rev-parse --verify <ref-or-sha>^{commit}`. Expanding T043 is the smallest sufficient fix: the git helper test pins commit-resolution behavior and the core operation test pins `node_retry_failed` plus no executor dispatch.
      Status: applied
      Applied-at: 2026-06-21T22:57:39+07:00
      Downstream-ref: specs/001-manual-node-retry-decisions/tasks.md

### V3

Category: spec-fix
Payload:
Target: specs/001-manual-node-retry-decisions/tasks.md
Before:

- [ ] T049 [US2] Create checkpoints after trigger/`when:` checks and before executable node start in `packages/workflows/src/dag-executor.ts`
      After:
- [ ] T049 [US2] Create checkpoints after trigger/`when:` checks and before executable node start only when `workflow.mutates_checkout !== false`; add explicit `mutates_checkout: false` no-checkpoint coverage and require retry setup to proceed without checkout reset and emit `node_retry_reset.reset_skipped = true` when no checkpoint exists in `packages/workflows/src/dag-executor.ts` and `packages/core/src/operations/workflow-retry.ts`
      Rationale: The finding is valid because `specs/001-manual-node-retry-decisions/spec.md:107` allows manual retry without checkout reset when `mutates_checkout: false` has no checkpoint, and `specs/001-manual-node-retry-decisions/spec.md:154-155` requires checkpointing enabled by default except skipped by default for `mutates_checkout: false`. The event contract also defines `reset_skipped` as true for allowed no-reset paths in `specs/001-manual-node-retry-decisions/contracts/events.md:58-63`. Local workflow semantics already make `mutates_checkout: false` a path-lock opt-out in `packages/workflows/src/schemas/workflow.ts:81-87` and `packages/workflows/src/executor.ts:587-598`, so the simplest task fix is to gate checkpointing and retry reset behavior on that existing workflow-level contract rather than add new configuration.
      Status: applied
      Applied-at: 2026-06-21T22:57:39+07:00
      Downstream-ref: specs/001-manual-node-retry-decisions/tasks.md

### V4

Category: spec-fix
Payload:
Target: specs/001-manual-node-retry-decisions/tasks.md
Before:

- [ ] T046 [US2] Implement tracked-only dirty detection and commit creation in `packages/git/src/retry-refs.ts`
      After:
- [ ] T046 [US2] Implement tracked-only dirty detection and commit creation in `packages/git/src/retry-refs.ts`, including immediate non-git repository rejection, missing `user.name`/`user.email` guidance, no stash fallback, and focused T003 coverage for those failures
      Rationale: The finding is valid because the spec names the edge cases directly: non-git retry setup errors immediately in `specs/001-manual-node-retry-decisions/spec.md:108` and `specs/001-manual-node-retry-decisions/spec.md:207`, while missing git identity must fail with `git config user.name` / `git config user.email` guidance and no stash fallback in `specs/001-manual-node-retry-decisions/spec.md:109` and `specs/001-manual-node-retry-decisions/spec.md:201`. The plan already warns that existing `commitAllChanges()` uses `git add -A` and must not be reused for checkpoint/safety commits in `specs/001-manual-node-retry-decisions/plan.md:130-137`, which is corroborated by `packages/git/src/branch.ts:148-177`. Updating T046 keeps the behavior in the new retry git helper, where the edge cases are actually observable, and ties it to the existing T003 helper coverage instead of adding a broad separate error-handling project.
      Status: applied
      Applied-at: 2026-06-21T22:57:39+07:00
      Downstream-ref: specs/001-manual-node-retry-decisions/tasks.md

---

## 5. Session Metadata

```yaml
session:
  generated_at: 2026-06-21T22:50:30+07:00
  feature_dir: specs/001-manual-node-retry-decisions
  artifacts_analyzed:
    - spec.md
    - plan.md
    - tasks.md
    - .specify/memory/constitution.md
  findings:
    total: 5
    by_severity:
      critical: 0
      high: 4
      medium: 1
      low: 0
    by_category:
      duplication: 0
      ambiguity: 0
      underspecification: 1
      constitution: 0
      coverage: 4
      inconsistency: 0
    overflow_dropped: 0
apply:
  applied_at: 2026-06-21T22:57:39+07:00
  applied_by: Codex
  resolutions:
    spec_fix: 5
    new_OQ: 0
    accepted_risk: 0
    out_of_scope: 0
    skipped: 0
  unresolved: 0
  allow_historical_edits: true
  historical_edits_applied:
    - U1:specs/001-manual-node-retry-decisions/tasks.md
    - V1:specs/001-manual-node-retry-decisions/tasks.md
    - V2:specs/001-manual-node-retry-decisions/tasks.md
    - V3:specs/001-manual-node-retry-decisions/tasks.md
    - V4:specs/001-manual-node-retry-decisions/tasks.md
```
