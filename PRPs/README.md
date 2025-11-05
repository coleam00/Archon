# Agent Work Orders - PRPs Directory

**Last Updated**: 2025-01-05
**Status**: Planning Complete, Ready for Phase 1 Implementation

---

## Directory Structure

```
PRPs/
├── README.md (this file)
├── IMPLEMENTATION_TRACKER.md       ← 📋 PRIMARY WORKING DOCUMENT
├── PHASE_DEPENDENCY_DIAGRAM.md     ← 📊 VISUAL REFERENCE
├── PHASE_SUMMARY.md                ← 📖 QUICK REFERENCE
├── story_phase1_template_system_backend.md
├── story_phase2_context_hub_frontend.md
├── story_awo_template_execution_system.md (Phase 3A)
├── story_phase3b_orchestrator_agent.md
├── story_phase4_hitl_pause_resume.md
├── story_phase5_cli_adapter_system.md
```

---

## Start Here

### 🚀 Ready to Begin Implementation?

**Step 1**: Read these in order:
1. `IMPLEMENTATION_TRACKER.md` - Complete checklist for all phases
2. `PHASE_DEPENDENCY_DIAGRAM.md` - Visual dependency flow
3. `PHASE_SUMMARY.md` - Quick reference and commands

**Step 2**: Execute phases sequentially:
```bash
# Execute Phase 1
/prp-story-phase-execute Phase 1

# After Phase 1 complete, execute Phase 2
/prp-story-phase-execute Phase 2

# Continue through all phases...
```

---

## File Guide

### Master Documents (Read These First)

**`IMPLEMENTATION_TRACKER.md`** - Your primary working document
- Comprehensive checklist for all 6 phases
- Validation gates for each phase
- Risk register and performance benchmarks
- **Update this as you complete tasks**

**`PHASE_DEPENDENCY_DIAGRAM.md`** - Visual understanding
- Mermaid flowcharts showing phase dependencies
- Critical path analysis (Phase 3A is bottleneck)
- Timeline estimates: 11.5-14.5 weeks
- Risk heatmap and validation strategy

**`PHASE_SUMMARY.md`** - Quick reference
- One-sentence descriptions per phase
- Command reference (testing, linting, API)
- Phase milestones and completion criteria
- Troubleshooting guide

---

## Phase PRPs (Implementation Guides)

Execute these in order - **DO NOT SKIP PHASES**:

### Phase 1: Template Storage System (Backend)
**File**: `story_phase1_template_system_backend.md`
**Duration**: 1.5 weeks
**Dependencies**: None
**Breaking**: ❌ None

Store agent/step/workflow templates in database with sub-workflow support and CRUD APIs.

**Critical**: Existing work orders MUST still use hardcoded .md files after this phase.

---

### Phase 2: Context Hub UI (Frontend)
**File**: `story_phase2_context_hub_frontend.md`
**Duration**: 2 weeks
**Dependencies**: Phase 1
**Breaking**: ❌ None

Build web interface for managing templates with sub-workflow builder.

**Critical**: Creating work orders via UI MUST still use hardcoded commands.

---

### Phase 3A: Template Execution System (CRITICAL PATH)
**File**: `story_awo_template_execution_system.md`
**Duration**: 2.5 weeks
**Dependencies**: Phase 1, Phase 2
**Breaking**: ⚠️ Flag-gated

Refactor orchestrator to execute workflows using templates with multi-agent sub-workflows.

**Critical**: Both modes must work - hardcoded (default) and template-based (opt-in).

---

### Phase 3B: Orchestrator Agent
**File**: `story_phase3b_orchestrator_agent.md`
**Duration**: 2 weeks
**Dependencies**: Phase 1, Phase 2, Phase 3A
**Breaking**: ❌ None

PydanticAI conversational agent with intelligent task analysis and template selection.

**Critical**: Work orders created via chat must use template execution.

---

### Phase 4: Human-in-the-Loop
**File**: `story_phase4_hitl_pause_resume.md`
**Duration**: 2 weeks
**Dependencies**: Phase 1, Phase 2, Phase 3A
**Breaking**: ⚠️ Changes timing

Configurable pause checkpoints with approve/revise/cancel decisions.

**Critical**: Workflows without checkpoints must still run end-to-end.

---

### Phase 5: CLI Adapter System
**File**: `story_phase5_cli_adapter_system.md`
**Duration**: 1.5 weeks
**Dependencies**: Phase 1, Phase 2, Phase 3A
**Breaking**: ❌ None

Generic adapter architecture supporting Claude, Gemini, Codex with provider switching.

**Critical**: Claude (default) must work identically to pre-Phase 5.

---

### Phase 6: Parallel CLI Execution (Deferred)
**Status**: Future work - not yet prioritized
**Complexity**: Very High

Run multiple CLIs simultaneously, compare outputs, merge results.

**Decision**: Defer until Phases 1-5 proven stable in production.

---

## Analysis Documents

### `ai_docs/orchestrator_analysis/`

Supporting analysis created during planning:

- `ArchitectureAnalysis.md` - System architecture and design patterns
- `AgentAnalysis.md` - Orchestrator agent design with tool specifications
- `BackendAnalysis.md` - Backend implementation patterns
- `DataModelAnalysis.md` - Database schema design
- `FrontendAnalysis.md` - UI component designs

**Purpose**: Reference during implementation for detailed context.

---

## Archived Files

### `archive/`

Original PRP files before phase-based reorganization:

- `story_awo_template_system_backend.md` → Now `story_phase1_template_system_backend.md`
- `story_awo_context_hub_frontend.md` → Now `story_phase2_context_hub_frontend.md`
- `story_awo_template_execution_system.md` → Now Phase 3A (created new)
- `story_awo_orchestrator_agent.md` → Now `story_phase3b_orchestrator_agent.md`
- `story_awo_hitl_pause_resume.md` → Now `story_phase4_hitl_pause_resume.md`
- `story_awo_cli_adapter_system.md` → Now `story_phase5_cli_adapter_system.md`

**Purpose**: Historical reference only. Use phase-numbered files for implementation.

---

## Execution Workflow

### Command-Driven Execution

Use the custom slash command to execute phases:

```bash
# Start with Phase 1
/prp-story-phase-execute Phase 1

# Wait for sub-agent to complete
# Review results, verify validation
# Tracker automatically updated

# Proceed to Phase 2
/prp-story-phase-execute Phase 2

# Repeat for each phase...
```

### What Happens When You Run the Command?

1. **Main agent (Claude)** reads context:
   - Implementation tracker
   - Phase dependency diagram
   - Specific phase PRP file

2. **Launches sub-agent** with full context and mission

3. **Sub-agent implements** the entire phase:
   - All tasks in PRP
   - All validation gates
   - Backward compatibility test
   - Completion checklist

4. **Sub-agent reports back** with comprehensive results

5. **Main agent verifies**:
   - Reviews sub-agent report
   - Runs independent validation
   - Runs backward compatibility test personally
   - Updates tracking documents if all pass
   - Reports to user with next steps

---

## Critical Validation: Backward Compatibility

**EVERY PHASE** must pass this test:

```bash
# Create work order
WO_ID=$(curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -H "Content-Type: application/json" \
  -d '{"repository_url": "https://github.com/coleam00/Archon", "user_request": "Test", "sandbox_type": "git_worktree"}' \
  | jq -r '.agent_work_order_id')

# Check logs
timeout 30 curl -N http://localhost:8053/api/agent-work-orders/$WO_ID/logs/stream 2>/dev/null \
  | grep -E "command|\.md|template" | head -10
```

**Expected Behavior**:
- **Phases 1-2**: MUST see "Loading command from: .claude/commands/agent-work-orders/planning.md"
- **Phase 3A (default)**: MUST see hardcoded .md files (flag disabled)
- **Phase 3A (enabled)**: MUST see "Using template: standard-planning" (flag enabled)
- **Phases 3B-5**: Same as Phase 3A (depends on repository flag)

**If test fails**: Phase implementation has failed. Do NOT proceed to next phase.

---

## Progress Tracking

### How to Track Progress

1. **Before Starting**: All phases show 🔴 Not Started in IMPLEMENTATION_TRACKER.md

2. **During Phase**: Update individual task checkboxes as you complete them

3. **After Phase**: Main agent automatically updates:
   - Status: 🔴 → 🟢 Complete
   - Completion date added
   - All checkboxes marked
   - Phase summary table updated

4. **View Progress**:
   ```bash
   # Quick status check
   grep -E "Phase [0-9].*Status" PRPs/IMPLEMENTATION_TRACKER.md

   # Or open in editor
   ```

---

## Timeline Estimate

**Conservative** (with buffer): 14.5 weeks (~3.5 months)
- Phase 1: 2 weeks
- Phase 2: 2.5 weeks
- Phase 3A: 3 weeks ← CRITICAL PATH
- Phase 3B: 2.5 weeks
- Phase 4: 2.5 weeks
- Phase 5: 2 weeks

**Optimistic** (smooth execution): 11.5 weeks (~2.75 months)

**With Parallelization**: 9-10 weeks (~2.5 months)
- Phase 3B, 4, 5 can start after Phase 3A completes

---

## Common Questions

### Q: Can I skip a phase?
**A**: No. Dependencies must be satisfied. Phase 3A requires Phase 1 and 2.

### Q: Can I implement multiple phases at once?
**A**: Not recommended. Sequential execution ensures stability. Phase 3A is complex enough without juggling multiple phases.

### Q: What if a validation gate fails?
**A**: Fix and re-run. Do NOT update tracker until ALL gates pass. Sub-agent will iterate until fixed.

### Q: When can I start using templates?
**A**: After Phase 3A + enabling the flag (use_template_execution=true) for your repository.

### Q: Do I need all 5 phases?
**A**: Phases 1-3A are core functionality. Phases 3B-5 add convenience features (chat, HITL, multi-CLI) but aren't strictly required.

### Q: What about Phase 6?
**A**: Deferred to future. Focus on Phases 1-5 first. Assess need after Phase 5 is stable.

---

## Getting Help

### Implementation Questions
- Check specific phase PRP file
- Review analysis documents in `ai_docs/orchestrator_analysis/`
- Check `PHASE_SUMMARY.md` troubleshooting section

### Validation Failures
- Review `IMPLEMENTATION_TRACKER.md` for specific validation gate
- Check PRP file for validation command details
- Examine sub-agent error report

### Architectural Questions
- Review `PHASE_DEPENDENCY_DIAGRAM.md` for high-level flow
- Check analysis documents for detailed designs
- Review existing code patterns referenced in PRPs

---

## Success Checklist

### Planning Complete When:
- [x] All 6 phase PRPs created
- [x] Implementation tracker created
- [x] Phase dependency diagram created
- [x] Phase summary created
- [x] Execution command updated
- [x] Old PRPs archived
- [x] README created (this file)

### Ready to Begin When:
- [ ] All planning documents reviewed
- [ ] Development environment set up
- [ ] Supabase project ready
- [ ] Team understands phase approach
- [ ] `/prp-story-phase-execute` command tested

### All Phases Complete When:
- [ ] Phases 1-5 marked 🟢 Complete in tracker
- [ ] All validation gates passed
- [ ] Zero regressions
- [ ] User acceptance testing passed
- [ ] Production deployment successful

---

## Next Action

**Ready to start?**

```bash
/prp-story-phase-execute Phase 1
```

This will:
1. Launch sub-agent to implement Phase 1
2. Sub-agent creates database schema and APIs
3. Sub-agent validates all gates
4. Main agent verifies and updates tracking
5. You review and decide when to proceed to Phase 2

---

**Questions or need clarification?** Check `PHASE_SUMMARY.md` or ask!

<!-- EOF -->
