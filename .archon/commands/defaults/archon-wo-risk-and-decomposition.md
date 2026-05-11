---
description: Break approved scope into ordered phases with risk assessment for Work Order creation
---

# Risk & Decomposition — Work Order Planning

**Original idea**: $ARGUMENTS

**Foundation answers**: $foundation-gate.output

**Approach approval**: $approach-gate.output

---

## Your Role

You are breaking the approved scope into concrete, ordered Work Order candidates.
Each WO must be completable autonomously in one implementation session.

---

## Phase 1: DEPENDENCY ORDERING

Read the codebase with fresh eyes — verify the approach from the prior phase is still valid.

**Use CGC/Neo4j** (if available) to:
- Map the dependency graph for files identified in the scope phase
- Identify execution order based on import/call relationships
- Find hidden coupling between components that might affect ordering

**Also check git state:**
```bash
git log --oneline -10
git status
```

Map execution order — what must be done first?

| Order | Unit of Work | Depends On | Why This Order |
|-------|-------------|------------|----------------|
| 1 | {e.g., extend schema} | — | Foundation for all others |
| 2 | {e.g., add service method} | 1 | Requires schema |
| 3 | {e.g., add API route} | 2 | Requires service |
| N | {e.g., update UI} | N-1 | Requires API |

---

## Phase 2: WORK ORDER SIZING

**Right-sized (one autonomous session):**
- Add one type/interface + update callers
- Extend one API endpoint
- Add one UI component
- Write tests for one module

**Too big (split it):**
- "Build entire feature" → split by layer
- "Add tests everywhere" → split by module

---

## Phase 3: RISK ASSESSMENT

For each work order candidate:

| WO | Risk | Likelihood | Impact | Mitigation |
|----|------|-----------|--------|------------|
| WO-1 | {risk} | LOW/MED/HIGH | LOW/MED/HIGH | {specific action} |

**Cross-cutting risks:**
- Breaking changes to public interfaces
- Test coverage gaps
- Type safety regressions
- Backwards compatibility concerns

---

## Phase 4: DECOMPOSITION SUMMARY

Present to the user:

```
## Work Breakdown

**Total Work Orders**: {N}

| WO | Title | Effort | Depends On | Risk |
|----|-------|--------|-----------|------|
| WO-001 | {title} | S/M/L | — | LOW |
| WO-002 | {title} | S/M/L | WO-001 | MED |
...

**Dependency Graph:**
WO-001 → WO-002 → WO-003
              ↓
           WO-004 (can parallel with WO-003)

**Risks to Watch:**
1. {primary risk and mitigation}
2. {secondary risk and mitigation}

**What We're NOT Building:**
- {explicit exclusion}
```

Ask: "Does this breakdown look right? Any adjustments before I generate the Work Orders?"
