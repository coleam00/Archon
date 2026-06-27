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

| ID                                           | Lens                     | Severity | Location                              | Description                                                                                                                                                                                                                                                        | Suggested Resolution                                                                                                                                                                                 | Status |
| -------------------------------------------- | ------------------------ | -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| F-RT-002-route-loop-decisions-2026-06-27-001 | Trust-Boundary Adversary | CRITICAL | FR-071 through FR-080, FR-103         | The spec makes workflow run metadata authoritative but does not require schema validation, atomic compare-and-set updates, or stale-write protection, so resume, retry, nested route loops, or concurrent route activation could corrupt counters and audit order. | Require typed metadata validation and transactional route-decision updates so counter increment, execution sequence increment, route output, and `node_routed` audit write succeed or fail together. |        |
| F-RT-002-route-loop-decisions-2026-06-27-002 | Trust-Boundary Adversary | HIGH     | FR-018, FR-071                        | Route targets and route-loop ids are short strings, while counters are keyed by node id, so unsafe ids such as reserved object keys or visually confusable strings can poison metadata or make runtime and UI disagree.                                            | Define and enforce a safe node id grammar for all workflow node ids and route targets, and reject reserved JavaScript object keys before execution and builder save.                                 |        |
| F-RT-002-route-loop-decisions-2026-06-27-003 | Trust-Boundary Adversary | HIGH     | FR-102 through FR-106, FR-122, CR-001 | The lifecycle requirements preserve resume, cancel, approve, reject, and retry behavior but do not state who may perform route-loop-affecting mutations in web or header-auth deployments.                                                                         | Specify authorization rules for every route-loop-affecting mutation surface, record the authorization basis in audit events, and fail closed when web auth is enabled.                               |        |
| F-RT-002-route-loop-decisions-2026-06-27-004 | Trust-Boundary Adversary | HIGH     | FR-045 through FR-048, CR-004         | The route decision trusts the latest `from` node output, but the spec only requires referenced fields to be declared and does not require the actual structured output to validate before routing.                                                                 | Require runtime validation of the `from` node structured output against `output_format` before evaluating `route_loop.condition`, including required fields, enum values, and field types.           |        |
| F-RT-002-route-loop-decisions-2026-06-27-005 | Trust-Boundary Adversary | MEDIUM   | FR-090, FR-095, CR-006                | `node_routed` events must include the full condition string and route-loop output mirrors that metadata, which conflicts with the requirement not to expose secrets, PII, prompts, raw user content, or unsafe raw errors.                                         | Define a redacted condition representation for persisted events and outputs, or ban sensitive literals in `route_loop.condition` and enforce that rule.                                              |        |

## 3. Resolutions Log

### F-RT-002-route-loop-decisions-2026-06-27-001

- Category:
- Downstream reference:
- Notes:

### F-RT-002-route-loop-decisions-2026-06-27-002

- Category:
- Downstream reference:
- Notes:

### F-RT-002-route-loop-decisions-2026-06-27-003

- Category:
- Downstream reference:
- Notes:

### F-RT-002-route-loop-decisions-2026-06-27-004

- Category:
- Downstream reference:
- Notes:

### F-RT-002-route-loop-decisions-2026-06-27-005

- Category:
- Downstream reference:
- Notes:

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
