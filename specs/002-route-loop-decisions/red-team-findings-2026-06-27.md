# Red Team Findings: Route Loop Decisions

**Session ID**: `RT-002-route-loop-decisions-2026-06-27`
**Target**: `specs/002-route-loop-decisions/spec.md`
**Feature directory**: `specs/002-route-loop-decisions`
**Date**: 2026-06-27
**Maintainer**: Kevin Le
**Lenses**: Trust-Boundary Adversary
**Selection method**: auto with `--yes`
**Supporting context offered**: `plans/grill-me/260625-2337-route-loop-decisions.md`, `packages/workflows/src/dag-executor.test.ts`, `specs/002-route-loop-decisions/checklists/requirements.md`
**Wall-clock**: Not precisely instrumented by the host session.

## 1. Session Summary

Pending maintainer review.
The catalog selected only one matching lens because the current red-team catalog covers `contracts` and `multi_party`, but does not define lenses for `ai_llm` or `immutability_audit`.
Lens diversity is weak relative to the recommended three to five lens range.
The constitution does not declare `## Red Team Trigger Criteria`, so trigger matching ran in bootstrap mode.

## 2. Findings Table

| ID                                           | Lens                     | Severity | Location                              | Description                                                                                                                                                                                                                                                        | Suggested Resolution                                                                                                                                                                                 | Status   |
| -------------------------------------------- | ------------------------ | -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| F-RT-002-route-loop-decisions-2026-06-27-001 | Trust-Boundary Adversary | CRITICAL | FR-071 through FR-080, FR-103         | The spec makes workflow run metadata authoritative but does not require schema validation, atomic compare-and-set updates, or stale-write protection, so resume, retry, nested route loops, or concurrent route activation could corrupt counters and audit order. | Require typed metadata validation and transactional route-decision updates so counter increment, execution sequence increment, route output, and `node_routed` audit write succeed or fail together. | spec-fix |
| F-RT-002-route-loop-decisions-2026-06-27-002 | Trust-Boundary Adversary | HIGH     | FR-018, FR-071                        | Route targets and route-loop ids are short strings, while counters are keyed by node id, so unsafe ids such as reserved object keys or visually confusable strings can poison metadata or make runtime and UI disagree.                                            | Define and enforce a safe node id grammar for all workflow node ids and route targets, and reject reserved JavaScript object keys before execution and builder save.                                 | spec-fix |
| F-RT-002-route-loop-decisions-2026-06-27-003 | Trust-Boundary Adversary | HIGH     | FR-102 through FR-106, FR-122, CR-001 | The lifecycle requirements preserve resume, cancel, approve, reject, and retry behavior but do not state who may perform route-loop-affecting mutations in web or header-auth deployments.                                                                         | Specify authorization rules for every route-loop-affecting mutation surface, record the authorization basis in audit events, and fail closed when web auth is enabled.                               | skipped  |
| F-RT-002-route-loop-decisions-2026-06-27-004 | Trust-Boundary Adversary | HIGH     | FR-045 through FR-048, CR-004         | The route decision trusts the latest `from` node output, but the spec only requires referenced fields to be declared and does not require the actual structured output to validate before routing.                                                                 | Require runtime validation of the `from` node structured output against `output_format` before evaluating `route_loop.condition`, including required fields, enum values, and field types.           | spec-fix |
| F-RT-002-route-loop-decisions-2026-06-27-005 | Trust-Boundary Adversary | MEDIUM   | FR-090, FR-095, CR-006                | `node_routed` events must include the full condition string and route-loop output mirrors that metadata, which conflicts with the requirement not to expose secrets, PII, prompts, raw user content, or unsafe raw errors.                                         | Define a redacted condition representation for persisted events and outputs, or ban sensitive literals in `route_loop.condition` and enforce that rule.                                              | spec-fix |

## 3. Resolutions Log

### F-RT-002-route-loop-decisions-2026-06-27-001

- Category: spec-fix
- Reasoning:
  Verification: The finding's premise holds because the spec says "System MUST store route-loop negative counters in `workflow_run.metadata.loopCounters`, keyed by route-loop node id" and "Resume MUST preserve route activation state, loop counters, and attempt counters", but it does not state how those metadata updates are validated or committed.
  Evidence: `specs/002-route-loop-decisions/spec.md:232` establishes metadata as the storage location, `specs/002-route-loop-decisions/spec.md:267` establishes resume preservation, `packages/workflows/src/schemas/workflow-run.ts:114` currently types run metadata as `z.record(z.string(), z.unknown())`, and `packages/core/src/db/workflows.ts:731-734` updates workflow metadata with a plain `UPDATE` by id.
  Why this category over alternatives: This is not `new-OQ` because the required behavior follows from the existing route-loop invariants and local storage contract, and it is not `accepted-risk` because corrupt counters would break the core bounded-loop guarantee in this milestone.
  Long-term vs band-aid: A band-aid would add defensive reads around each counter access while still allowing partial metadata and event writes, but the durable fix is a typed route-decision state transition that validates metadata and commits the counter, activation state, output, attempt data, execution sequence, and audit event together.
- Target: specs/002-route-loop-decisions/spec.md
- Before:

```markdown
- **FR-080**: Events for executed nodes and route decisions MUST include both the per-node `attempt` and global `execution_seq` where applicable.
```

- After:

```markdown
- **FR-080**: Events for executed nodes and route decisions MUST include both the per-node `attempt` and global `execution_seq` where applicable.
- **FR-080A**: Route-loop counter increments, counter resets, per-node attempt increments, execution sequence increments, route activation state changes, route-loop output writes, and the corresponding `node_routed` event write MUST be performed through one typed, schema-validated workflow-run state transition that commits atomically or fails without partial state.
- **FR-080B**: Before applying a route-loop state transition, system MUST validate existing `workflow_run.metadata` route-loop fields against runtime schemas and fail fast on malformed loop counters, activation state, attempt counters, or execution sequence data.
- **FR-080C**: Route-loop state transitions MUST protect against stale writes by using the existing workflow-run lock and transaction boundary or an equivalent compare-and-set claim so resume, retry, and concurrent dispatch cannot overwrite a newer route decision.
```

### F-RT-002-route-loop-decisions-2026-06-27-002

- Category: spec-fix
- Reasoning:
  Verification: The finding's premise holds because the spec only says "Each route-loop route target MUST be a short string node id and MUST target exactly one node", while counters are explicitly keyed by route-loop node id.
  Evidence: `specs/002-route-loop-decisions/spec.md:167` defines route targets as short strings, `specs/002-route-loop-decisions/spec.md:232` keys counters by node id, `packages/workflows/src/schemas/dag-node.ts:140-142` currently accepts node ids as plain strings, and `packages/workflows/src/loader.ts:140-147` checks uniqueness without enforcing a safe grammar.
  Why this category over alternatives: This is not `skipped` because the local schema really lacks the grammar the finding asks about, and it is not `new-OQ` because the existing condition parser already constrains node references to a simple ASCII id shape.
  Long-term vs band-aid: A band-aid would sanitize only route target keys at metadata-write time, but the durable fix is one shared node-id grammar enforced by loader validation and the Web builder before a workflow can execute.
- Target: specs/002-route-loop-decisions/spec.md
- Before:

```markdown
- **FR-018**: Each route-loop route target MUST be a short string node id and MUST target exactly one node.
```

- After:

```markdown
- **FR-018**: Each route-loop route target MUST be a short string node id and MUST target exactly one node. Workflow node ids, `route_loop.from`, route-loop route targets, and node references parsed from `route_loop.condition` MUST share the same safe node-id grammar: `[A-Za-z_][A-Za-z0-9_-]{0,63}`. Loader validation and the Web builder MUST reject ids outside that grammar and MUST reject reserved JavaScript object keys `__proto__`, `prototype`, and `constructor`.
```

### F-RT-002-route-loop-decisions-2026-06-27-003

- Category: skipped
- Reasoning:
  Verification: The finding correctly observes that FR-102 through FR-106 preserve lifecycle behavior, but its proposed resolution expands into role and resource policy that the spec explicitly excludes.
  Evidence: `specs/002-route-loop-decisions/spec.md:301` says "This feature preserves Archon's single-developer default and does not add tenancy, resource visibility, or role policy", while `packages/server/src/auth/config.ts:87-95` shows the existing API gate is a deployment-level auth boundary and `packages/server/src/routes/api.ts:2274-2294` shows manual retry already has owner/admin handling for the existing retry surface.
  Why this category over alternatives: This is not `spec-fix` because adding authorization rules for every lifecycle mutation would contradict CR-001 and broaden the feature beyond route-loop semantics, and it is not `new-OQ` because the spec already answers the scope question.
  Long-term vs band-aid: A band-aid would add route-loop-only permission checks around individual buttons, but the durable fix for multi-user resource policy belongs to a separate authorization feature that can define ownership, visibility, and admin semantics across all workflow lifecycle actions.
- Reason: Skipped because the requested authorization redesign conflicts with the verified scope boundary in `specs/002-route-loop-decisions/spec.md:301`, which states "This feature preserves Archon's single-developer default and does not add tenancy, resource visibility, or role policy."

### F-RT-002-route-loop-decisions-2026-06-27-004

- Category: spec-fix
- Reasoning:
  Verification: The finding's premise holds because the spec requires referenced fields to be declared and unresolvable fields to fail fast, but it does not explicitly require the route-loop evaluator to use the existing validated `NodeOutput` field-resolution contract.
  Evidence: `specs/002-route-loop-decisions/spec.md:200-203` covers declared fields and fail-fast missing fields, `packages/workflows/src/output-ref.ts:8-19` defines the existing no-silent-drop field-resolution table, and `packages/workflows/src/dag-executor.ts:1308-1358` validates structured output against `output_format` before a node completes.
  Why this category over alternatives: This is not `skipped` because an implementation could satisfy the current wording by checking only declared property names at load time and then reading raw JSON at route time, and it is not `new-OQ` because the local `NodeOutput` contract already gives the intended answer.
  Long-term vs band-aid: A band-aid would add a route-loop-specific JSON parse before evaluating conditions, but the durable fix is to require route-loop condition evaluation to reuse the same validated `NodeOutput` resolution path already used by `when` and node-output substitution.
- Target: specs/002-route-loop-decisions/spec.md
- Before:

```markdown
- **FR-045**: If `route_loop.condition` reads a field from the `from` node output, that field MUST be declared in the `from` node's `output_format.properties`.
```

- After:

```markdown
- **FR-045**: If `route_loop.condition` reads a field from the `from` node output, that field MUST be declared in the `from` node's `output_format.properties`.
- **FR-045A**: Before evaluating `route_loop.condition`, runtime MUST resolve field references through the same validated `NodeOutput` contract used by existing `when` evaluation and node-output substitution. Producer `output_format` schema validation MUST have succeeded before a field reference can route, declared fields MUST be enforced, undeclared or unresolvable fields MUST fail the route-loop node, and whole-output references remain allowed without `output_format`.
```

### F-RT-002-route-loop-decisions-2026-06-27-005

- Category: spec-fix
- Reasoning:
  Verification: The finding's premise holds because the spec says "`node_routed` event data MUST include `from`, `outcome`, `to`, `condition`, `condition_result`, `negative_count`, and `max_iterations`" while CR-006 says `node_routed` must not expose prompts, secrets, PII, raw user message content, git remotes, or unsafe raw errors.
  Evidence: `specs/002-route-loop-decisions/spec.md:251` requires the condition field, `specs/002-route-loop-decisions/spec.md:256` makes route-loop output mirror event metadata, `specs/002-route-loop-decisions/spec.md:306` forbids exposing sensitive material, and `plans/grill-me/260625-2337-route-loop-decisions.md:1215-1218` explains that the condition is included for debugging.
  Why this category over alternatives: This is not `skipped` because the current text can require persisting raw condition literals, and it is not `new-OQ` because CR-006 already decides that persisted and rendered event data must be safe.
  Long-term vs band-aid: A band-aid would hide the condition only in one UI surface or rely on authors not to place sensitive literals in conditions, but the durable fix is to define the persisted condition field itself as a safe redacted representation that every downstream surface mirrors.
- Target: specs/002-route-loop-decisions/spec.md
- Before:

```markdown
- **FR-090**: `node_routed` event data MUST include `from`, `outcome`, `to`, `condition`, `condition_result`, `negative_count`, and `max_iterations`.
```

- After:

```markdown
- **FR-090**: `node_routed` event data MUST include `from`, `outcome`, `to`, `condition`, `condition_result`, `negative_count`, and `max_iterations`, where `condition` is the persisted safe condition representation rather than the raw author expression.
- **FR-090A**: The persisted safe condition representation MUST preserve node references, field names, operators, and boolean structure while redacting non-structural literal comparison values and any future grammar token class that can carry secrets, prompts, PII, raw user content, git remotes, or unsafe raw errors.
```

## 5. Session Metadata

```yaml
session_id: RT-002-route-loop-decisions-2026-06-27
target: specs/002-route-loop-decisions/spec.md
feature_id: 002-route-loop-decisions
date: 2026-06-27
maintainer: Kevin Le
selection_method: auto
yes_flag_used: true
matched_triggers:
  - contracts
  - multi_party
  - immutability_audit
  - ai_llm
selected_lenses:
  - Trust-Boundary Adversary
uncovered_triggers:
  - immutability_audit
  - ai_llm
warnings:
  - constitution_missing_red_team_trigger_criteria
  - selected_lens_count_below_recommended_range
  - lens_catalog_does_not_cover_all_matched_triggers
lens_failures: []
dropped_findings: {}
counts_by_lens:
  Trust-Boundary Adversary: 5
counts_by_severity:
  CRITICAL: 1
  HIGH: 3
  MEDIUM: 1
  LOW: 0
resolution_counts:
  spec-fix: 0
  new-OQ: 0
  accepted-risk: 0
  out-of-scope: 0
unresolved: 5
```
