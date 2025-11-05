---
description: "Execute AWO Template System phases sequentially with sub-agents and automatic tracking"
---

# Execute AWO Phase Implementation

## Phase Identifier: $ARGUMENTS

**Example Usage**:
- `/prp-story-phase-execute Phase 1` - Execute Phase 1: Template Storage
- `/prp-story-phase-execute Phase 2` - Execute Phase 2: Context Hub UI
- `/prp-story-phase-execute Phase 3A` - Execute Phase 3A: Template Execution System

---

## Mission

Execute a single phase of the AWO Template System implementation through:
1. **Automated sub-agent execution** - Spin off dedicated agent for phase implementation
2. **Comprehensive validation** - All validation gates must pass
3. **Tracking updates** - Automatically update IMPLEMENTATION_TRACKER.md
4. **Backward compatibility** - Verify existing work orders still work
5. **Sequential discipline** - One phase at a time, complete before moving on

**Execution Philosophy**: Complete the entire phase, pass all validation gates, update tracking, then stop. User decides when to start next phase.

**Important**: This is a feature under active development. Focus on making each phase independently testable and not breaking existing or future functionality. No backward compatibility requirements - we're revamping the entire system.

---

## Pre-Execution Checklist

Before launching the sub-agent, verify:

### 1. Verify Dependencies

Check that all prerequisite phases are marked 🟢 Complete in IMPLEMENTATION_TRACKER.md:

```bash
# Phase 1: No dependencies
# Phase 2: Requires Phase 1
grep "Phase 1.*Status.*🟢 Complete" PRPs/IMPLEMENTATION_TRACKER.md || echo "❌ Phase 1 not complete"

# Phase 3A: Requires Phase 1, Phase 2
grep "Phase 1.*Status.*🟢 Complete" PRPs/IMPLEMENTATION_TRACKER.md || echo "❌ Phase 1 not complete"
grep "Phase 2.*Status.*🟢 Complete" PRPs/IMPLEMENTATION_TRACKER.md || echo "❌ Phase 2 not complete"

# Phase 3B: Requires Phase 1, Phase 2, Phase 3A
# Phase 4: Requires Phase 1, Phase 2, Phase 3A
# Phase 5: Requires Phase 1, Phase 2, Phase 3A
```

**IF DEPENDENCIES NOT MET**: Stop and inform user which phases must be completed first.

### 2. Check Services Running

```bash
# Archon server
curl -f http://localhost:8181/health || echo "❌ Start: docker compose --profile backend up -d"

# AWO service
curl -f http://localhost:8053/health || echo "❌ Start: cd python && uv run python -m uvicorn src.agent_work_orders.server:app --port 8053 --reload"

# Frontend (Phase 2+ only)
curl -f http://localhost:3737 || echo "❌ Start: cd archon-ui-main && npm run dev"

# Agents service (Phase 3B only - for PydanticAI)
curl -f http://localhost:8052/health || echo "ℹ️ Optional: docker compose --profile agents up -d"
```

**IF SERVICES DOWN**: Instruct user to start them, then re-run command.

### 3. Load Phase Context

- Read `PRPs/IMPLEMENTATION_TRACKER.md` - Find the phase section
- Read `PRPs/PHASE_DEPENDENCY_DIAGRAM.md` - Understand dependencies
- Read `PRPs/PHASE_SUMMARY.md` - Get quick context
- Read the specific phase PRP file:
  - Phase 1: `PRPs/story_phase1_template_system_backend.md`
  - Phase 2: `PRPs/story_phase2_context_hub_frontend.md`
  - Phase 3A: `PRPs/story_awo_template_execution_system.md`
  - Phase 3B: `PRPs/story_phase3b_orchestrator_agent.md`
  - Phase 4: `PRPs/story_phase4_hitl_pause_resume.md`
  - Phase 5: `PRPs/story_phase5_cli_adapter_system.md`

### 2. Verify Dependencies

Check that all prerequisite phases are marked 🟢 Complete in IMPLEMENTATION_TRACKER.md:

- **Phase 1**: No dependencies
- **Phase 2**: Requires Phase 1
- **Phase 3A**: Requires Phase 1, Phase 2
- **Phase 3B**: Requires Phase 1, Phase 2, Phase 3A
- **Phase 4**: Requires Phase 1, Phase 2, Phase 3A
- **Phase 5**: Requires Phase 1, Phase 2, Phase 3A

**IF DEPENDENCIES NOT MET**: Stop and inform user which phases must be completed first.

### 3. Check Environment

- Services running (if needed for testing):
  ```bash
  # Backend
  docker compose --profile backend up -d
  # OR
  curl http://localhost:8181/health

  # AWO service
  curl http://localhost:8053/health

  # Frontend (if Phase 2+)
  curl http://localhost:3737
  ```

- Development tools available:
  ```bash
  uv --version  # Backend
  npm --version  # Frontend
  claude --version  # Claude CLI (Phase 5)
  ```

### 4. Confirm Current State

Ask user to confirm:
- [ ] All previous phases marked complete in IMPLEMENTATION_TRACKER.md?
- [ ] No uncommitted changes that would conflict?
- [ ] Ready to execute Phase X?

---

## Sub-Agent Execution

### Launch Sub-Agent with Full Context

Use the Task tool to launch a general-purpose sub-agent with this prompt:

```
You are executing Phase X of the AWO Template System implementation.

PHASE: {phase_name}
PRP FILE: {prp_file_path}

Your mission: Implement this phase completely by following the PRP task list.

CONTEXT YOU HAVE ACCESS TO:
1. Phase PRP file (your primary guide)
2. Implementation tracker (validation checklists)
3. Analysis documents in PRPs/ai_docs/orchestrator_analysis/
4. Existing codebase patterns

EXECUTION REQUIREMENTS:

1. READ THE PRP FILE COMPLETELY
   - Understand the original story
   - Review all context references
   - Note all validation commands

2. IMPLEMENT TASKS SEQUENTIALLY
   - Follow task order in PRP
   - Complete each task fully before moving to next
   - Run validation command after each task
   - If validation fails, fix and re-validate before proceeding

3. FOLLOW VALIDATION LOOP
   - Level 1: Syntax & Style (ruff, mypy, tsc, biome)
   - Level 2: Unit Tests (pytest, npm test)
   - Level 3: Integration Tests (API endpoints, UI journeys)
   - Level 4+: Phase-specific validation (see PRP)

4. CRITICAL: PHASE VALIDATION TEST
   Test that this phase works and doesn't break existing functionality:

   **For Phases 1-2** (Storage/UI only):
   - Verify APIs work: `curl http://localhost:8053/api/agent-work-orders/templates/agents | jq`
   - Verify no errors in AWO service logs
   - Phase 1: Templates stored successfully
   - Phase 2: UI renders without errors, can create templates

   **For Phase 3A** (Template Execution):
   - Test flag toggle works
   - Test both modes: hardcoded (.md files) AND template-based
   - Verify sub-workflows execute correctly

   **For Phase 3B** (Orchestrator):
   - Test chat API: `curl .../orchestrator/chat -d '{"message": "List repos"}'`
   - Verify work orders created via chat work correctly
   - Note: Requires archon-agents service (PydanticAI): `docker compose --profile agents up -d`

   **For Phase 4** (HITL):
   - Test workflows pause at configured checkpoints
   - Test resume with approve/revise/cancel
   - Test workflows WITHOUT checkpoints run end-to-end

   **For Phase 5** (CLI Adapters):
   - Test Claude adapter works
   - Test provider switching
   - Test fallback if Gemini not installed

5. WORK THROUGH COMPLETION CHECKLIST
   - Mark each item as you complete it
   - Don't skip any items
   - Verify all checkboxes checked before finishing

6. REPORT BACK WITH:
   - Summary of implementation
   - All validation results (PASS/FAIL for each gate)
   - List of files created/modified
   - Backward compatibility test result
   - Any issues encountered and how they were resolved
   - Confirmation that completion checklist is 100% complete

IMPORTANT CONSTRAINTS:
- DO NOT skip validation commands
- DO NOT proceed if tests fail
- DO NOT mark phase complete unless ALL validation gates pass
- DO implement comprehensive error handling
- DO follow existing code patterns
- DO write tests for all new code (including UI unit tests)

MIGRATION APPROACH (Phase 1):
- UPDATE existing migration files: migration/complete_setup.sql and migration/agent_work_orders_state.sql
- ADD template tables to these files (don't create separate migration files)
- User will delete existing AWO tables and re-run complete migrations
- Provide clear instructions for user to run in Supabase SQL Editor

PYDANTICAI SETUP (Phase 3B):
- PydanticAI runs in archon-agents container (already configured)
- Start with: docker compose --profile agents up -d
- Container already has PydanticAI installed
- Make dependency on agents service explicit

UI TESTING (Phase 2):
- You CANNOT click through UI
- Focus on TypeScript compilation + unit tests
- Provide manual UI testing instructions for user
- All unit tests must pass

BEGIN IMPLEMENTATION NOW.
```

**Wait for sub-agent to complete and return results.**

---

## Post-Sub-Agent Validation

After the sub-agent returns, YOU (main agent) must:

### 1. Review Sub-Agent Report

- Read the sub-agent's final report carefully
- Check that all validation gates passed
- Verify backward compatibility test passed
- Confirm completion checklist is 100% complete

### 2. Verify Files Changed

```bash
# Show all files modified/created
git status

# Review changes
git diff --stat

# Ensure changes match PRP scope
```

**Critical Check**: Files should only be in areas mentioned in PRP. If files outside PRP scope were modified, investigate why.

### 3. Run Independent Validation

Don't just trust the sub-agent - run key validations yourself:

```bash
# Backend syntax check
cd python
uv run ruff check src/agent_work_orders/ --fix
uv run mypy src/agent_work_orders/

# Frontend syntax check (if Phase 2+)
cd archon-ui-main
npx tsc --noEmit

# Run tests
uv run pytest tests/agent_work_orders/ -v  # Backend
npm run test src/features/context-hub/  # Frontend (Phase 2+)
```

### 4. Critical: Backward Compatibility Test

**YOU MUST RUN THIS YOURSELF** - Don't rely on sub-agent report:

```bash
# Start services if not running
docker compose --profile backend up -d
# OR check if running: curl http://localhost:8053/health

# Create work order
WO_ID=$(curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -H "Content-Type: application/json" \
  -d '{
    "repository_url": "https://github.com/coleam00/Archon",
    "user_request": "Test backward compatibility after Phase X",
    "sandbox_type": "git_worktree"
  }' | jq -r '.agent_work_order_id')

echo "Work Order ID: $WO_ID"

# Monitor logs for 30 seconds
timeout 30 curl -N http://localhost:8053/api/agent-work-orders/$WO_ID/logs/stream | grep -E "command|\.md|template|error" | head -20

# Analysis:
# For Phases 1-2: MUST see "Loading command from: .claude/commands/agent-work-orders/planning.md"
# For Phases 1-2: MUST NOT see "Using template: ..." or template errors
# For Phase 3A (default): Same as above (hardcoded by default)
# For Phase 3A (flag enabled): MUST see "Using template: ..." (not .md files)
```

**Validation Decision**:
- ✅ PASS: Logs show expected behavior (see above)
- ❌ FAIL: Stop immediately, report issue to user, do NOT update tracker

### 5. Update Implementation Tracker

**IF AND ONLY IF** all validation gates passed, update `PRPs/IMPLEMENTATION_TRACKER.md`:

Find the phase section and update status from 🔴 Not Started to 🟢 Complete:

```markdown
## Phase X: [Name]

**Status**: 🟢 Complete  ← UPDATE THIS
**Completed**: 2025-01-05  ← ADD THIS
```

Check off all completed items in the phase checklist:

```markdown
### Implementation Checklist

#### Database Migrations
- [x] Create `archon_agent_templates` table  ← CHECK THESE
- [x] Create `archon_step_templates` table
- [x] Run all migrations in Supabase SQL Editor
...
```

### 6. Update Phase Summary Status

Update `PRPs/PHASE_SUMMARY.md` quick reference table:

```markdown
| Phase | Name | Duration | Risk | Breaking | Status | PRP File |
|-------|------|----------|------|----------|--------|----------|
| **1** | Template Storage | 1.5w | 🟢 Low | ❌ None | 🟢 Complete | ... |  ← UPDATE
```

### 7. Generate Completion Report

Report to user:

```markdown
# Phase X Implementation Complete ✅

## Summary
[Brief description of what was implemented]

## Files Changed
[List of files created/modified from git status]

## Validation Results
- ✅ Syntax & Linting: PASS (0 errors)
- ✅ Unit Tests: PASS (X tests passed)
- ✅ Integration Tests: PASS
- ✅ Backward Compatibility: PASS (work orders use hardcoded .md files)
- ✅ Phase-Specific Validation: PASS

## Backward Compatibility Test
Work Order ID: wo_xyz
Logs showed: "Loading command from: .claude/commands/agent-work-orders/planning.md"
Result: ✅ PASS - existing behavior preserved

## Updated Tracking
- Implementation Tracker: Phase X marked 🟢 Complete
- Phase Summary: Status updated

## Next Steps
Phase X is complete. Ready to proceed to Phase Y when you're ready.

Dependencies for Phase Y: [List dependencies]
Estimated time: [Duration]
Breaking changes: [Yes/No]

Would you like to:
1. Review the implementation before proceeding?
2. Run additional validation tests?
3. Proceed to Phase Y?
```

---

## Phase-Specific Guidance

### Phase 1: Template Storage (Backend)

**Sub-Agent Focus**:
- Update `migration/complete_setup.sql` - Add template tables
- Update `migration/agent_work_orders_state.sql` - Add template-related columns
- Pydantic models (AgentTemplate, StepTemplate, WorkflowTemplate with sub_steps)
- Services (TemplateService, WorkflowService)
- API routes (template_routes.py, workflow_routes.py)

**Migration Approach**:
- DO NOT create separate migration files
- UPDATE `migration/complete_setup.sql` to include new template tables
- UPDATE `migration/agent_work_orders_state.sql` to include new columns
- User will drop existing AWO tables and re-run complete_setup.sql
- Provide SQL DROP commands for user

**Critical Validation**:
- Templates can be stored via API
- Templates can be retrieved via API
- Version control works (update creates version 2)
- Seed data includes 3 agents, 3 steps, 1 workflow

**Common Issues**:
- Supabase connection errors (check SUPABASE_SERVICE_KEY)
- Foreign key violations (check table creation order)
- Slug uniqueness (ensure unique slugs in seed data)

### Phase 2: Context Hub UI (Frontend)

**Sub-Agent Focus**:
- TypeScript types (mirror backend models)
- TanStack Query hooks (query keys, mutations)
- Components (cards, editors, builders)
- Views (library views, builder UI)
- Routing (ContextHubPage, App.tsx updates)

**Critical Validation**:
- TypeScript compiles with zero errors
- All UI unit tests pass
- Can create templates via API (backend integration)
- SubStepBuilder component renders and state works
- Provide manual UI testing instructions for user

**UI Testing Approach**:
- Automated: TypeScript + unit tests (you can do this)
- Manual: User clicks through UI following your instructions
- Focus on unit test coverage for all components

**Common Issues**:
- TypeScript errors (missing imports, type mismatches)
- Radix UI prop errors (check primitives documentation)
- TanStack Query key conflicts (ensure unique keys)
- npm dependencies (run npm install if needed)

### Phase 3A: Template Execution System (CRITICAL PATH)

**Sub-Agent Focus**:
- TemplateResolver service
- SubWorkflowOrchestrator service
- WorkflowOrchestrator refactor (template vs hardcoded branching)
- Flag toggle (use_template_execution per repository)

**Critical Validation**:
- Flag disabled → Uses hardcoded .md files
- Flag enabled → Uses templates
- Sub-workflows execute with multiple agents
- **BOTH modes must work perfectly**

**Common Issues**:
- Template resolution errors (missing templates)
- Sub-step execution order wrong
- Context not passed between sub-steps
- Flag not respected

**Repository Setup for Testing**:
```bash
# List repositories, create one if needed
REPOS=$(curl http://localhost:8053/api/agent-work-orders/repositories)
if [ $(echo $REPOS | jq 'length') -eq 0 ]; then
  curl -X POST http://localhost:8053/api/agent-work-orders/repositories \
    -d '{"repository_url": "https://github.com/coleam00/Archon", "verify": false}'
fi
REPO_ID=$(curl .../repositories | jq -r '.[0].id')
```

**Sub-Agent Must Test BOTH Modes**:
```bash
# Mode 1: Hardcoded mode (use_template_execution=false)
curl -X PUT .../repositories/$REPO_ID/template-execution -d '{"use_template_execution": false}'
# Create work order, verify completes, check logs show .md files

# Mode 2: Template mode (use_template_execution=true)
curl -X PUT .../repositories/$REPO_ID/template-execution -d '{"use_template_execution": true}'
# Create work order, verify completes, check logs show templates being used
```

### Phase 3B: Orchestrator Agent

**Sub-Agent Focus**:
- PydanticAI agent setup (python/src/agents/orchestrator/)
- Orchestrator tools (7 total)
- TaskAnalyzer (intelligent agent selection)
- Chat UI (ChatPanel, ChatMessage, ChatInput)

**PydanticAI Service Setup**:
- Orchestrator runs in archon-agents container (port 8052)
- Start with: `docker compose --profile agents up -d`
- Container already has PydanticAI installed
- Verify: `curl http://localhost:8052/health`
- Orchestrator API endpoint goes in main server (port 8181), calls agents service

**Critical Validation**:
- Agents service running and healthy
- Chat API endpoint works: `curl http://localhost:8181/api/orchestrator/chat -d '{"message": "test"}'`
- Task analysis recommends correct agents
- Work orders created via chat complete successfully
- Multi-turn conversations maintain context

**Common Issues**:
- Agents service not running (need --profile agents)
- Model configuration errors (API keys in settings)
- Tool registration errors (check @agent.tool decorator)
- Session management bugs (localStorage for session_id)

### Phase 4: Human-in-the-Loop

**Sub-Agent Focus**:
- PauseService (database-backed pause states)
- WorkflowOrchestrator pause logic (asyncio.Event)
- Pause API routes
- PauseStateCard UI component

**Critical Validation**:
- Workflow pauses at checkpoints
- User can approve/revise/cancel
- Revise re-runs step with feedback
- **Workflows with pause_after=false still run end-to-end**

**Common Issues**:
- asyncio.Event not set (workflow stuck)
- Pause state not cleaned up
- Polling not stopping when paused
- Feedback not injected correctly

### Phase 5: CLI Adapter System

**Sub-Agent Focus**:
- CLIAdapter base class
- Claude adapter (refactor existing)
- Gemini adapter (new)
- Adapter factory (provider selection)

**Critical Validation**:
- Claude adapter works (backward compatible)
- Gemini adapter works (if installed)
- Provider switching works
- Fallback chain works (unavailable → Claude)

**Common Issues**:
- CLI not found errors
- JSONL parsing errors (malformed output)
- Event normalization errors
- Provider priority logic wrong

---

## Sub-Agent Launch Template

Use the Task tool with subagent_type="general-purpose":

```
You are implementing Phase {X}: {Phase Name} for the AWO Template System.

CONTEXT DOCUMENTS (READ THESE FIRST):
1. PRP File: PRPs/{prp_file_name}
2. Implementation Tracker: PRPs/IMPLEMENTATION_TRACKER.md (Phase {X} section)
3. Phase Summary: PRPs/PHASE_SUMMARY.md
4. Analysis Docs: PRPs/ai_docs/orchestrator_analysis/*.md (as referenced in PRP)

YOUR MISSION:
Complete the entire phase by implementing every task in the PRP file.

EXECUTION PROCESS:

1. READ CONTEXT
   - Read PRP file completely
   - Understand original story intent
   - Review all context references in PRP
   - Check implementation tracker for this phase

2. IMPLEMENT TASKS SEQUENTIALLY
   - Follow task list in PRP "IMPLEMENTATION TASKS" section
   - For each task:
     a) Read task requirements
     b) Implement following specified patterns
     c) Run validation command immediately
     d) If validation fails, fix and re-validate
     e) Don't proceed until task passes

3. RUN ALL VALIDATION GATES
   Execute validation loop from PRP in order:
   - Level 1: Syntax & Style
   - Level 2: Unit Tests
   - Level 3: Integration Tests
   - Level 4+: Phase-specific validation

4. CRITICAL: BACKWARD COMPATIBILITY TEST
   {backward_compat_test_instructions_for_phase}

5. COMPLETE CHECKLIST
   Go through completion checklist in PRP
   Verify every item is complete

VALIDATION REQUIREMENTS:
- Every validation command must pass
- Zero ruff/mypy/TypeScript errors
- All tests pass (unit, integration)
- Backward compatibility test MUST PASS
- Completion checklist 100% complete

REPORTING REQUIREMENTS:
Provide a detailed final report with:

## Implementation Summary
[What was implemented in 2-3 sentences]

## Validation Results
- Syntax & Linting: PASS/FAIL (details)
- Unit Tests: PASS/FAIL (X tests passed, Y% coverage)
- Integration Tests: PASS/FAIL (details)
- Phase-Specific Tests: PASS/FAIL (see PRP validation loop)

## Files Created/Modified
[Full list from git status]

## Completion Checklist Status
[X/Y items complete - must be Y/Y]

## Issues Encountered
[Any blockers, how they were resolved]

## Ready for Production
YES/NO - Explain if NO

BEGIN IMPLEMENTATION NOW.
```

**Launch the sub-agent and wait for it to complete.**

---

## Post-Sub-Agent Actions

When the sub-agent returns:

### 1. Analyze Sub-Agent Report

Read the sub-agent's final report and verify:
- [ ] All validation gates marked PASS
- [ ] Backward compatibility test PASS
- [ ] Completion checklist 100% complete
- [ ] Ready for Production: YES

**IF ANY FAILURES**: Do NOT update tracker. Report to user and offer to fix.

### 2. Verify Files Independently

```bash
# Check git status
git status

# Review changes
git diff --stat
git diff  # Review actual changes

# Ensure files match PRP scope
```

### 3. Run Quick Smoke Test

```bash
# Backend
uv run python -c "import src.agent_work_orders; print('✓ Imports work')"

# Frontend (if Phase 2+)
npx tsc --noEmit && echo "✓ TypeScript clean"
```

### 4. Run Phase-Specific Validation

**Verify the phase works correctly** (see Phase-Specific Guidance section for what to test)

**Decision Point**:
- ✅ PASS: Phase features work, no critical errors
- ❌ FAIL: Report to user, do NOT update tracker

### 5. Update IMPLEMENTATION_TRACKER.md

**Only if all validation passed**, update the tracker:

```markdown
## Phase {X}: {Name}

**Status**: 🟢 Complete
**Completed**: {current_date}
**Duration**: {actual_time_taken}

### Implementation Checklist
[Check off all items]
```

### 6. Update PHASE_SUMMARY.md

Update the quick reference table:

```markdown
| **{X}** | {Name} | {duration} | ... | 🟢 Complete | ... |
```

### 7. Report to User

Provide comprehensive completion report:

```markdown
# ✅ Phase {X} Implementation Complete

## What Was Implemented
{summary_from_sub_agent}

## Validation Results Summary
All validation gates: ✅ PASS

Detailed results:
- Syntax & Linting: ✅ PASS (0 errors)
- Unit Tests: ✅ PASS ({X} tests, {Y}% coverage)
- Integration Tests: ✅ PASS (all functionality works)
- Phase-Specific Tests: ✅ PASS (see sub-agent report for details)

## Files Changed
{git_status_output}

Key files:
- Created: {list_of_created_files}
- Modified: {list_of_modified_files}

## Phase Validation
✅ VERIFIED - Phase works as designed, doesn't break existing/future functionality

## Tracking Updated
- ✅ IMPLEMENTATION_TRACKER.md: Phase {X} marked complete
- ✅ PHASE_SUMMARY.md: Status updated

## Next Phase Ready
Phase {X+1}: {Next_Phase_Name}
Dependencies: ✅ All met
Estimated time: {duration}
Breaking changes: {yes/no}

Would you like to:
1. Review implementation before proceeding?
2. Run additional validation tests?
3. Commit changes and proceed to Phase {X+1}?
4. Take a break and continue later?
```

---

## Failure Handling

### If Sub-Agent Reports Failures

**DO NOT UPDATE TRACKER**

Instead:
1. Review sub-agent's error report
2. Identify which validation gate failed
3. Offer to fix the issue:
   - "I can fix the {issue} and re-run validation"
   - "Would you like me to investigate {specific_failure}?"
4. After fix, re-run full validation loop
5. Only update tracker when ALL gates pass

### If Phase-Specific Validation Fails

Report to user:
```markdown
# ⚠️ Phase {X} Validation Failed

## Issue
{description_of_what_failed}

## Evidence
{relevant_logs_or_test_output}

## Root Cause
{analysis_of_why_this_happened}

## Recommended Fix
{specific_fix_needed}

## Status
Phase {X} is NOT complete. Do NOT proceed to next phase.
IMPLEMENTATION_TRACKER.md NOT updated (status remains 🔴 Not Started).

Would you like me to investigate and fix this issue?
```

### If Tests Fail

```markdown
# ⚠️ Phase {X} Validation Failed - Tests

## Failed Tests
{list_of_failed_tests}

## Error Messages
{test_error_output}

## Recommended Action
1. Review test failures
2. Fix implementation
3. Re-run tests
4. Re-run full validation loop

Phase {X} status: 🟡 In Progress (validation failed)
```

---

## Success Criteria

### Sub-Agent Success
- All tasks in PRP completed
- All validation gates PASS
- Completion checklist 100% complete
- Backward compatibility test PASS

### Main Agent Success (You)
- Sub-agent report verified
- Independent validation run
- Backward compatibility confirmed personally
- Tracking documents updated
- User notified with next steps

### Phase Success
- Functionality working as designed
- Zero regressions
- Tests comprehensive and passing
- Documentation accurate
- Ready for next phase

---

## Example Execution Flow

### User Runs Command
```
/prp-story-phase-execute Phase 1
```

### You (Main Agent) Do:
1. Read IMPLEMENTATION_TRACKER.md (Phase 1 section)
2. Read story_phase1_template_system_backend.md (full PRP)
3. Verify dependencies (none for Phase 1)
4. Launch sub-agent with context
5. Wait for sub-agent completion
6. Review sub-agent report
7. Run independent validation
8. **Run backward compatibility test yourself**
9. IF all pass → Update tracker, report success
10. IF any fail → Report failure, offer to fix

### Sub-Agent Does:
1. Read PRP file completely
2. Implement tasks sequentially (migrations, models, services, APIs)
3. Validate after each task
4. Run full validation loop (syntax, tests, integration)
5. Run backward compatibility test
6. Complete checklist
7. Report back with comprehensive results

### Result:
- Phase 1 complete and validated
- Tracker updated
- User notified
- Ready for Phase 2

---

## Important Notes

**One Phase at a Time**: Do not execute multiple phases. Each phase must be complete before starting the next.

**No Shortcuts**: Sub-agent must complete ALL tasks and ALL validation gates. No skipping.

**Feature Under Development**: This is a revamp of agent work orders. Focus on making each phase work correctly and not breaking future phases.

**Update Tracker Only on Success**: Do not mark phase complete unless ALL validation passes.

**User Control**: User decides when to proceed to next phase. Don't auto-continue.

**Git Commits**: Consider prompting user to commit after each phase completion.

---

## Quick Validation Commands

```bash
# Phase 1: Test template API
curl http://localhost:8053/api/agent-work-orders/templates/agents | jq

# Phase 2: Test TypeScript
npx tsc --noEmit

# Phase 3A: Test both execution modes
curl -X PUT .../repositories/{id}/template-execution -d '{"use_template_execution": true}'

# Phase 3B: Test chat
curl -X POST http://localhost:8181/api/orchestrator/chat -d '{"message": "List repos"}'

# Phase 4: Test pause
# Create work order with pause_after=true, verify it pauses

# Phase 5: Test CLI adapter
# Create work order, verify completes with Claude CLI
```

---

**Ready to execute a phase?** Ensure you specify which phase: `/prp-story-phase-execute Phase 1`

<!-- EOF -->
