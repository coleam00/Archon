# Red Team Findings: Manual Failed-Node Retry Decisions

Session ID: `RT-001-manual-node-retry-decisions-2026-06-21`  
Target: `specs/001-manual-node-retry-decisions/spec.md`  
Date: 2026-06-21  
Maintainer: dale  
Lenses: Trust-Boundary Adversary  
Selection method: auto (`--yes`; only one catalog lens matched)  
Supporting context: `plans/grill-me/260621-1239-manual-node-retry-decisions.md`  
Wall-clock: not recorded by host command runner
Status: ARCHIVED
**Applied:** 2026-06-21-222808

## 1. Session Summary

Maintainer summary pending. The run selected the only catalog lens covering the matched trigger categories. Lens diversity is weak because the catalog does not currently define lenses for the matched `ai_llm` and `immutability_audit` triggers.

## 2. Findings

| ID                                                  | Lens                     | Severity | Location                                     | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                      | Suggested Resolution                                                                                                                                                                                                                                                                                                        | Status        |
| --------------------------------------------------- | ------------------------ | -------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| F-RT-001-manual-node-retry-decisions-2026-06-21-001 | Trust-Boundary Adversary | HIGH     | FR-078, FR-084, FR-086, FR-094               | The spec requires validating run existence, node status, run status, and web eligibility, but does not require authorizing that the caller is allowed to mutate that run, conversation, codebase, or checkout. A low-privilege or cross-user web caller who can guess or obtain a runId could trigger git commits/resets and re-execution for another user's web-created run.                                                                | Add an explicit requester authorization requirement before any CAS or git mutation: bind retry permission to the run's user_id, parent conversation user, codebase access rules, or admin role. Require the API and UI eligibility checks to use the authenticated requester, not only the run's origin surface.            | spec-fix      |
| F-RT-001-manual-node-retry-decisions-2026-06-21-002 | Trust-Boundary Adversary | HIGH     | Assumptions; FR-006, FR-010, FR-011, FR-080  | The current workflow definition is trusted as the v1 source of truth for target existence, descendant calculation, and retry execution. If that file changed after the original run, a lower-privilege actor with repo write access, a stale checkout, or a compromised branch could alter node behavior or descendants and use retry to execute a different graph under the authority of the original run.                                  | Persist and validate the original workflow identity at run creation, such as workflow file path plus content hash or commit SHA. On retry, either use the recorded definition or require an explicit trusted confirmation when the current definition differs, with the diff surfaced before mutation.                      | accepted-risk |
| F-RT-001-manual-node-retry-decisions-2026-06-21-003 | Trust-Boundary Adversary | HIGH     | FR-090, FR-080, FR-044-FR-058                | CLI retry is required to reuse the run's recorded working path, and retry setup performs destructive branch reset behavior, but the spec only says to fail if the path no longer exists. It does not require verifying that the path still resolves to the intended codebase/worktree, is not a symlink swap, and still matches the run's repository identity before creating commits or resetting.                                          | Require canonical path resolution and repository identity checks before git operations: verify the path is the recorded worktree/codebase, matches expected remote/root metadata, and is not redirected through symlinks to an unrelated repository. Perform these checks immediately before safety-ref creation and reset. | spec-fix      |
| F-RT-001-manual-node-retry-decisions-2026-06-21-004 | Trust-Boundary Adversary | MEDIUM   | FR-027, FR-038, FR-044, FR-046; Key Entities | Git ref names are built directly from runId, retryEpoch, and nodeId, while commit messages include workflowName and nodeId. The spec does not require validating or encoding node IDs and workflow names before embedding them in git refs and audit commits, creating room for malformed refs, misleading audit records, or namespace confusion if workflow-controlled identifiers contain slashes, control characters, or ref-like syntax. | Define a canonical encoding or strict allowlist for nodeId and workflowName when used in ref paths and commit messages. Require `git check-ref-format` validation for generated refs and sanitize control characters/newlines in audit text.                                                                                | spec-fix      |
| F-RT-001-manual-node-retry-decisions-2026-06-21-005 | Trust-Boundary Adversary | MEDIUM   | FR-016, FR-078, FR-083; Key Entities         | The retry request event records requester surface only "where available", but does not require recording authenticated requester identity or authorization decision details. This weakens forensic traceability for a high-impact operation that mutates local git state and re-executes workflow nodes.                                                                                                                                     | Require retry events and API responses/logs to include the authenticated requester user id, source surface, and authorization context where available. If identity is unavailable, make that an explicit unsupported path for Web/API retry rather than silently recording only the surface.                                | spec-fix      |

## 3. Resolutions Log

### F-RT-001-manual-node-retry-decisions-2026-06-21-001

Category: spec-fix

Payload:
Reasoning:
Verification: the cited API requirement says "API retry MUST validate run existence, target node existence, latest effective node status, run status, and web retry eligibility before mutating state" (`specs/001-manual-node-retry-decisions/spec.md:232`), and web retry is scoped to "web-created runs with a parent web conversation" (`specs/001-manual-node-retry-decisions/spec.md:238`). That verifies the finding's premise: the spec validates run shape and origin surface, but not the caller's permission to mutate that run. Evidence from local code shows this is not unknowable: the server has a request auth context where every gated `/api/*` request must resolve an identity (`packages/server/src/routes/api.ts:1347`) and `resolveAuthContext` returns `{ userId, role }` (`packages/server/src/routes/api.ts:1373`), while workflow runs already store `user_id` (`packages/workflows/src/schemas/workflow-run.ts:119`). This is `spec-fix`, not `new-OQ`, because the existing identity/role/run-owner contracts provide the shape; it is not `skipped` because relying only on web eligibility would leave a real server-side mutation gap. The band-aid would be hiding the retry button or trusting unguessable run IDs, but that only protects one UI path; the durable fix is a server-side authorization check before CAS or git mutation.

Target: specs/001-manual-node-retry-decisions/spec.md

Before:

- **FR-078**: API retry MUST validate run existence, target node existence, latest effective node status, run status, and web retry eligibility before mutating state.

After:

- **FR-078**: API retry MUST validate run existence, target node existence, latest effective node status, run status, web retry eligibility, and requester authorization before mutating state. Authorization MUST resolve the authenticated web requester using the existing API auth context; when a run has `user_id`, the requester MUST match that user or have `admin` role. Runs without `user_id` remain retryable only in unauthenticated solo/local mode. This check MUST occur before the status CAS, retry epoch increment, safety ref/commit, checkout reset, session deletion, or executor dispatch.

Downstream Ref: specs/001-manual-node-retry-decisions/spec.md:233
Status: applied
Applied-at: 2026-06-21T15:28:08Z
Downstream-ref: specs/001-manual-node-retry-decisions/spec.md:233

### F-RT-001-manual-node-retry-decisions-2026-06-21-002

Category: accepted-risk

Payload:
Reasoning:
Verification: the spec does say the current definition drives retry, including "System MUST compute invalidated nodes as the retry target plus all descendants in the current workflow DAG" (`specs/001-manual-node-retry-decisions/spec.md:124`) and "MUST still use the current DAG as v1 source of truth" (`specs/001-manual-node-retry-decisions/spec.md:129`). The Assumptions section repeats that "The workflow file available at retry time is the current source of truth for v1 DAG shape" (`specs/001-manual-node-retry-decisions/spec.md:309`), and the origin decision likewise says "Workflow definition used for descendant calculation is the current workflow definition in v1" (`plans/grill-me/260621-1239-manual-node-retry-decisions.md:76`). The finding's premise is real, but its suggested persisted-definition/hash gate conflicts with the verified v1 tradeoff rather than repairing an accidental omission. This is `accepted-risk`, not `spec-fix`, because replacing current-DAG behavior would broaden the feature beyond its stated v1 scope; it is not `new-OQ` because the feature artifacts already answer the policy. The band-aid would be a warning or best-effort diff before retry, but that would not create a reliable execution contract; the durable fix is immutable workflow identity/replay semantics, deferred until that becomes a product requirement.

Rationale: Manual retry v1 accepts the current workflow definition as the source of truth for retry DAG calculation. The structural fix is to persist workflow file identity/content hash or commit SHA at run creation and define whether retry replays that recorded definition or blocks on mismatch, but that changes the v1 execution contract documented in `specs/001-manual-node-retry-decisions/spec.md:289` and `plans/grill-me/260621-1239-manual-node-retry-decisions.md:142`. Re-open this when Archon supports retry across untrusted repo writers or non-admin members, when product requires immutable replay of the original graph, or when current-DAG retry causes a confirmed integrity incident.

Downstream Ref: AR-001
Status: applied
Applied-at: 2026-06-21T15:28:08Z
Downstream-ref: AR-001

### F-RT-001-manual-node-retry-decisions-2026-06-21-003

Category: spec-fix

Payload:
Reasoning:
Verification: the cited CLI requirement currently says only "CLI retry-node MUST reuse the run's recorded working path and fail clearly if the path no longer exists" (`specs/001-manual-node-retry-decisions/spec.md:247`), while retry setup creates safety refs and can reset tracked files (`specs/001-manual-node-retry-decisions/spec.md:180`, `specs/001-manual-node-retry-decisions/spec.md:203`). That supports the finding's premise: existence alone does not prove the path still points at the intended repository or worktree before destructive git operations. Local contracts give a bounded durable check: workflow runs store `working_path` and `codebase_id` (`packages/workflows/src/schemas/workflow-run.ts:111`, `packages/workflows/src/schemas/workflow-run.ts:118`), codebases store `repository_url` and `default_cwd` (`packages/core/src/db/codebases.ts:15`), isolation rows store `codebase_id` and `working_path` (`packages/isolation/src/types.ts:243`), and `@archon/git` already exposes repo root and origin URL helpers (`packages/git/src/repo.ts:25`, `packages/git/src/repo.ts:52`). This is `spec-fix`, not `new-OQ`, because those existing contracts answer how to verify identity; it is not `accepted-risk` because the incremental check is small relative to the reset blast radius. The band-aid would be another path-exists guard or avoiding symlink mention in UI copy; the durable fix is canonical path and repository/worktree identity validation immediately before mutation.

Target: specs/001-manual-node-retry-decisions/spec.md

Before:

- **FR-090**: CLI retry-node MUST reuse the run's recorded working path and fail clearly if the path no longer exists.

After:

- **FR-090**: CLI retry-node MUST reuse the run's recorded working path, resolve it to a canonical real path, verify it still exists, and verify it still identifies the run's intended repository or Archon-managed worktree before any safety ref, commit, reset, session deletion, or dispatch. Verification MUST use available local contracts: the run's `codebase_id`, the registered codebase `default_cwd` and `repository_url` when present, and any matching isolation environment `working_path` for Archon-managed worktrees. If the path cannot be verified, CLI retry-node MUST fail clearly and MUST NOT mutate git state.

Downstream Ref: specs/001-manual-node-retry-decisions/spec.md:248
Status: applied
Applied-at: 2026-06-21T15:28:08Z
Downstream-ref: specs/001-manual-node-retry-decisions/spec.md:248

### F-RT-001-manual-node-retry-decisions-2026-06-21-004

Category: spec-fix

Payload:
Reasoning:
Verification: the spec requires checkpoint refs under `refs/archon/checkpoints/<runId>/<retryEpoch>/<nodeId>` (`specs/001-manual-node-retry-decisions/spec.md:151`) and retry safety refs under `refs/archon/retry-safety/<runId>/<retryEpoch>` (`specs/001-manual-node-retry-decisions/spec.md:180`), and its commit-message formats embed `<workflowName>` and `<nodeId>` (`specs/001-manual-node-retry-decisions/spec.md:162`, `specs/001-manual-node-retry-decisions/spec.md:182`). Local schemas do not currently prove those values are git-ref-safe or audit-text-safe: node ids are plain strings (`packages/workflows/src/schemas/dag-node.ts:141`) trimmed but not allowlisted (`packages/workflows/src/schemas/dag-node.ts:438`, `packages/workflows/src/schemas/dag-node.ts:569`), and workflow names are only `z.string().min(1)` (`packages/workflows/src/schemas/workflow.ts:67`). The finding's premise therefore holds. This is `spec-fix`, not `new-OQ`, because the durable behavior is a local validation/normalization contract; it is not `skipped` because malformed refs and multiline audit text are real integration hazards. The band-aid would be ad hoc escaping at whichever call site first fails; the durable fix is a single requirement to validate generated refs before git mutation and normalize only audit-message text without changing logical workflow or node ids.

Target: specs/001-manual-node-retry-decisions/spec.md

Before:

- **FR-047**: Retry reset MUST use the latest prior checkpoint for the target node when present.

After:

- **FR-046A**: Every generated checkpoint or retry safety ref MUST be validated with `git check-ref-format` before create, update, validation, or reset operations. `runId` and `retryEpoch` MUST come from canonical persisted values, and workflow-controlled values such as node ids MUST NOT be allowed to produce invalid refs; if a generated ref is invalid, checkpoint/retry setup MUST fail before git mutation. Workflow names and node ids embedded in checkpoint or retry-safety commit messages MUST be normalized to single-line audit text by replacing control characters and newlines with spaces, without changing the stored logical workflow name or node id.
- **FR-047**: Retry reset MUST use the latest prior checkpoint for the target node when present.

Downstream Ref: specs/001-manual-node-retry-decisions/spec.md:192
Status: applied
Applied-at: 2026-06-21T15:28:08Z
Downstream-ref: specs/001-manual-node-retry-decisions/spec.md:192

### F-RT-001-manual-node-retry-decisions-2026-06-21-005

Category: spec-fix

Payload:
Reasoning:
Verification: FR-016 currently says `node_retry_requested` records "`runId`, target node id, next retry epoch, invalidated node ids, and requester surface where available" (`specs/001-manual-node-retry-decisions/spec.md:137`), while the Key Entities section says the event records "who/what requested retry" (`specs/001-manual-node-retry-decisions/spec.md:277`). That verifies the finding's premise: the spec gestures at requester traceability but only makes the surface explicit. Local code can provide the missing identity context because `resolveAuthContext` returns user id and role (`packages/server/src/routes/api.ts:1373`) and workflow runs store `user_id` (`packages/workflows/src/schemas/workflow-run.ts:119`). This is `spec-fix`, not `new-OQ`, because F-001's authorization shape plus the existing auth/run fields answer what to record; it is not `accepted-risk` because durable audit fields are low-cost and tied to a high-impact git mutation. The band-aid would be server logs or API response echoing details only to the caller; the durable fix is to persist the requester identity availability and authorization basis in the workflow event history.

Target: specs/001-manual-node-retry-decisions/spec.md

Before:

- **FR-016**: `node_retry_requested` MUST record `runId`, target node id, next retry epoch, invalidated node ids, and requester surface where available.

After:

- **FR-016**: `node_retry_requested` MUST record `runId`, target node id, next retry epoch, invalidated node ids, requester surface, authenticated requester user id when available, and the authorization basis used for the accepted retry (for example owner, admin, CLI/solo). If Web/API retry requires an authenticated requester and none can be resolved, the request MUST fail before writing `node_retry_requested` or mutating state; unauthenticated solo/local mode MUST record requester identity explicitly as unavailable.

Downstream Ref: specs/001-manual-node-retry-decisions/spec.md:137
Status: applied
Applied-at: 2026-06-21T15:28:08Z
Downstream-ref: specs/001-manual-node-retry-decisions/spec.md:137

## 5. Session Metadata

```yaml
session_id: RT-001-manual-node-retry-decisions-2026-06-21
target: specs/001-manual-node-retry-decisions/spec.md
feature_directory: specs/001-manual-node-retry-decisions
date: 2026-06-21
created_at_utc: 2026-06-21T15:17:21Z
maintainer: dale
command_arguments:
  requested: 'specs/001-manual-node-retry-decisions --yes'
  executed_target: 'specs/001-manual-node-retry-decisions/spec.md --yes'
selection:
  method: auto
  yes_flag_used: true
  matched_triggers:
    - contracts
    - multi_party
    - ai_llm
    - immutability_audit
  selected_lenses:
    - Trust-Boundary Adversary
  weak_lens_diversity: true
  uncovered_matched_triggers:
    - ai_llm
    - immutability_audit
lens_catalog: .specify/extensions/red-team/red-team-lenses.yml
supporting_context:
  - plans/grill-me/260621-1239-manual-node-retry-decisions.md
findings:
  total: 5
  by_severity:
    CRITICAL: 0
    HIGH: 3
    MEDIUM: 2
    LOW: 0
  by_lens:
    Trust-Boundary Adversary: 5
  dropped_by_bound: 0
  lens_failures: []
resolution_counts:
  spec-fix: 4
  new-OQ: 0
  accepted-risk: 1
  out-of-scope: 0
unresolved: 0
notes:
  - 'No before_speckit_red_team_run hook was registered in .specify/extensions.yml.'
  - 'The catalog contains only two example lenses; only Trust-Boundary Adversary matched this spec.'
  - 'Historical SpecKit working record modified with explicit --allow-historical-edits consent.'
apply:
  applied_at: 2026-06-21T15:28:08Z
  applied_by: dale
  resolutions:
    spec_fix: 4
    new_OQ: 0
    accepted_risk: 1
    out_of_scope: 0
    skipped: 0
  unresolved: 0
  allow_historical_edits: true
  historical_edits_applied:
    - 'F-RT-001-manual-node-retry-decisions-2026-06-21-001:specs/001-manual-node-retry-decisions/spec.md'
    - 'F-RT-001-manual-node-retry-decisions-2026-06-21-002:specs/001-manual-node-retry-decisions/spec.md'
    - 'F-RT-001-manual-node-retry-decisions-2026-06-21-003:specs/001-manual-node-retry-decisions/spec.md'
    - 'F-RT-001-manual-node-retry-decisions-2026-06-21-004:specs/001-manual-node-retry-decisions/spec.md'
    - 'F-RT-001-manual-node-retry-decisions-2026-06-21-005:specs/001-manual-node-retry-decisions/spec.md'
```
