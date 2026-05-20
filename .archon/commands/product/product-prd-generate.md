---
description: Generate a PRD artifact from product research and stakeholder input
argument-hint: <request or path to product research>
---

# Product PRD Generate

**Input**: $ARGUMENTS

---

## Mission

Generate a concrete PRD that downstream design, development, QA, security, docs, DevOps, and services workflows can consume.

## Phase 1: Load

- Read `$ARTIFACTS_DIR/product/requirements.md` if present.
- Read any captured approval response from upstream workflow nodes.
- Inspect existing docs and code when making technical claims.

**PHASE_1_CHECKPOINT:**

- [ ] Product context loaded
- [ ] Human answers incorporated
- [ ] Existing related behavior verified where possible

## Phase 2: Generate

Write `$ARTIFACTS_DIR/product/prd.md` with:

```markdown
# Product Requirements Document

## Problem Statement

## Target Users

## Goals

## Non-Goals

## Success Metrics

## User Stories

## Functional Requirements

## Acceptance Criteria

## Design Considerations

## Security And Privacy Considerations

## QA Considerations

## Documentation And Enablement Impact

## Operational And Rollback Considerations

## Open Questions

## Decision Log
```

Rules:

- Use specific acceptance criteria.
- Mark missing information as `TBD - needs product answer`.
- Reference exact repo paths for technical claims.
- Keep v1 scope explicit.

**PHASE_2_CHECKPOINT:**

- [ ] PRD written
- [ ] Scope boundaries explicit
- [ ] Cross-functional impacts included

## Output

Return the PRD artifact path and a short readiness summary.
