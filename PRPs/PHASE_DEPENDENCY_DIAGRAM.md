# Agent Work Orders - Phase Dependency Diagram

**Last Updated**: 2025-01-05

---

## Linear Dependency Chain

```
Phase 0: Database Setup
   ↓
Phase 1: Context Hub (Backend + Frontend)
   ↓
Phase 2: AWO Foundation (Repository Linking)
   ↓
Phase 3: AWO Execution (Template-Based Workflows) ← CRITICAL PATH
   ↓
   ├─→ Phase 4: Orchestrator Agent (independent of 5 & 6)
   ├─→ Phase 5: Human-in-the-Loop (independent of 4 & 6)
   └─→ Phase 6: Multi-CLI Support (independent of 4 & 5)
   ↓
Phase 7: Parallel Execution (Deferred - requires Phase 6)
```

---

## Detailed Phase Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ Phase 0: Database Setup                                         │
│ • Migration files created (SQL only)                            │
│ • Context Hub tables (core Archon)                              │
│ • AWO tables (optional)                                         │
│ • Seed data: agents, steps, workflows, coding standards         │
│ • Duration: N/A (already complete)                              │
│ • Breaking: None                                                │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Phase 1: Context Engineering Hub                                │
│ • Backend APIs (template CRUD)                                  │
│ • Frontend UI (template management)                             │
│ • Workflow validation (≥1 planning/implement/validate)          │
│ • Feature toggle with Brain icon navigation                     │
│ • Breaking: None (core feature)                                 │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Phase 2: AWO Foundation                                         │
│ • Repository → template linking                                 │
│ • Priming context editor                                        │
│ • Coding standards assignment                                   │
│ • Agent tool overrides per repo                                 │
│ • Breaking: None (optional feature)                             │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Phase 3: AWO Template Execution ⭐ CRITICAL PATH                │
│ • TemplateResolver (workflow + overrides)                       │
│ • SubWorkflowOrchestrator (multi-agent steps)                   │
│ • Flag-gated: use_template_execution per repo                   │
│ • Backward compat: hardcoded mode (default)                     │
│ • Breaking: Flag-gated                                          │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                    ┌─────────┴─────────┐
                    ↓                   ↓                   ↓
┌──────────────────────────┐  ┌──────────────────────────┐  ┌──────────────────────────┐
│ Phase 4: Orchestrator    │  │ Phase 5: HITL            │  │ Phase 6: CLI Adapters    │
│ • PydanticAI chat agent  │  │ • Pause checkpoints      │  │ • Generic adapter base   │
│ • Task analysis          │  │ • Approve/revise/cancel  │  │ • Claude adapter         │
│ • Work order creation    │  │ • Feedback injection     │  │ • Gemini adapter         │
│ • Natural language UI    │  │ • pause_after flag       │  │ • Provider switching     │
│ • Breaking: None         │  │ • Breaking: Timing only  │  │ • Breaking: None         │
└──────────────────────────┘  └──────────────────────────┘  └──────────────────────────┘
                    ↓                   ↓                   ↓
                    └─────────┬─────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Phase 7: Parallel Execution (Deferred)                          │
│ • Run multiple CLIs simultaneously                              │
│ • Compare outputs                                               │
│ • Merge results or user choice                                  │
│ • Parallel worktree management                                  │
│ • Breaking: Complex, high risk                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Critical Path Analysis

**Phase 3 (AWO Execution) is the critical path** because:
- All automation depends on template execution working
- Phases 4, 5, 6 all require templates to be executed
- If Phase 3 fails, nothing else works

**Phases 4, 5, 6 are independent** after Phase 3:
- Can be developed in parallel
- No dependencies between them
- All depend only on Phase 3

---

## Dependency Matrix

| Phase | Requires | Blocks | Can Parallelize With |
|-------|----------|--------|---------------------|
| 0 | None | All | N/A |
| 1 | 0 | All | N/A |
| 2 | 0, 1 | 3, 4, 5, 6 | N/A |
| 3 | 0, 1, 2 | 4, 5, 6 | N/A |
| 4 | 0, 1, 2, 3 | 7 | 5, 6 |
| 5 | 0, 1, 2, 3 | 7 | 4, 6 |
| 6 | 0, 1, 2, 3 | 7 | 4, 5 |
| 7 | 6 | None | N/A |

---

## Phase Groupings

### Foundation Layer (Sequential)
- **Phase 0**: Database schema
- **Phase 1**: Template management UI
- **Phase 2**: Repository linking

**Must be completed in order** - each builds on previous.

### Execution Layer (Sequential Entry, Parallel Exit)
- **Phase 3**: Template execution (entry point)
- **Phases 4, 5, 6**: Can be done in parallel after Phase 3

**Phase 3 must be complete first**, then 4/5/6 can be parallelized.

### Future Layer
- **Phase 7**: Deferred until 0-6 complete and stable

---

## Milestone Dependencies

### Ready to Start Phase 1 When:
- [x] Phase 0 complete (migrations run, tables verified)
- [x] Seed data loaded (3 agents, 5 steps, 2 workflows, 3 standards)

### Ready to Start Phase 2 When:
- [ ] Phase 0 complete
- [ ] Phase 1 complete (can create templates via UI)
- [ ] Template APIs functional

### Ready to Start Phase 3 When:
- [ ] Phase 0 complete
- [ ] Phase 1 complete (templates exist)
- [ ] Phase 2 complete (repositories linked to templates)

### Ready to Start Phases 4, 5, 6 When:
- [ ] Phase 3 complete (template execution working)
- [ ] Can develop in parallel

### Ready to Consider Phase 7 When:
- [ ] Phases 0-6 complete
- [ ] Phase 6 stable for 4+ weeks
- [ ] User demand validated

---

## Data Flow Dependencies

### Context Hub → AWO Flow
```
Context Hub Tables (Phase 0)
    ↓
Context Hub UI (Phase 1)
    ↓
User creates: Agent templates, Step templates, Workflows
    ↓
Repository Linking (Phase 2)
    ↓
User applies: Template to repository + customizations
    ↓
Template Execution (Phase 3)
    ↓
Work order executes using: Templates + Repository overrides
```

### Phase 3 → Phases 4/5/6 Flow
```
Phase 3: Template execution working
    ↓
    ├─→ Phase 4: Chat creates work orders → Executes via Phase 3
    ├─→ Phase 5: Workflows pause → Resume → Execute via Phase 3
    └─→ Phase 6: Different CLIs → Execute via Phase 3
```

All three depend on Phase 3 but not on each other.

---

## Risk-Based Dependencies

### Low Risk (Can Start Anytime After Dependencies Met)
- Phase 0, 1, 2, 4, 6

### Medium Risk (Need Extra Testing)
- Phase 3 (template execution - flag-gated)
- Phase 5 (pause/resume - timing changes)

### High Risk (Deferred)
- Phase 7 (parallel execution - complex)

---

## Backward Compatibility Flow

```
Phase 0: No impact (database only)
    ↓
Phase 1: No impact (storage only, no execution changes)
    ↓
Phase 2: No impact (linking only, no execution changes)
    ↓
Phase 3: FLAG-GATED
    ├─→ use_template_execution=false → Hardcoded mode (backward compatible)
    └─→ use_template_execution=true → Template mode (new behavior)
    ↓
Phases 4-6: Build on Phase 3 (no additional breaking changes)
```

**Key Point**: Backward compatibility is maintained until Phase 3 + flag enabled.

---

## Summary

- **Sequential**: Phases 0 → 1 → 2 → 3
- **Parallel**: Phases 4, 5, 6 (after Phase 3)
- **Critical Path**: Phase 3
- **Deferred**: Phase 7

**Current Status**: Phase 0 complete ✓ → Ready to start Phase 1

<!-- EOF -->
