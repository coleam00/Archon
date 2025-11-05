---
name: "Phase 4: AWO Human-in-the-Loop Pause/Resume"
description: "Workflow pause/resume at configurable checkpoints for plan review, implementation feedback, and correction decisions"
phase: 4
dependencies: ["Phase 1", "Phase 2", "Phase 3A"]
breaking_changes: true
breaking_changes_note: "Changes workflow timing - workflows pause at configured checkpoints instead of running end-to-end"
---

## Original Story

```
Implement human-in-the-loop (HITL) workflow management for Agent Work Orders with pause points configured in workflow templates:
1. After Planning - User reviews and approves/revises plan
2. After Implementation - User decides to run code review or skip
3. After Review - User approves or requests corrections
4. Configurable per workflow template (pause_after flag)

Current limitation: Workflows run end-to-end without pausing (Phase 3A behavior). Users cannot review or provide feedback mid-execution. No way to verify plan before implementation starts.

Goal: Enable users to review and control workflow execution at critical checkpoints, provide feedback for revisions, and approve before proceeding to next phase. Checkpoints configured in workflow templates created in Phase 2.
```

## Story Metadata

**Story Type**: Enhancement
**Estimated Complexity**: High
**Primary Systems Affected**:
- Backend: Workflow orchestrator pause/resume logic
- Backend: Pause state management service
- Database: Pause state table
- Frontend: Pause state UI components

**Phase Number**: 4
**Dependencies**:
- Phase 1 (Templates define checkpoints)
- Phase 2 (UI to configure pause_after flags)
- Phase 3A (Template execution system)
**Breaking Changes**: ⚠️ Yes - Workflows with pause_after=true will pause (changes timing)

---

## CRITICAL: Polling-Based Initially

**Implementation Strategy**:

**Phase 4A: Polling-Based HITL** (This Phase)
- Use existing SSE + REST endpoints (no WebSocket initially)
- Workflow pauses by storing pause state in database
- Frontend polls for pause state (every 2 seconds)
- User clicks "Approve" → REST call → workflow resumes
- Simpler, faster to implement, fewer moving parts

**Phase 4B: WebSocket HITL** (Future Enhancement)
- Add WebSocket for instant bidirectional communication
- Real-time notifications when pause occurs
- Deferred until Phase 4A proven stable

**Validation**: Phase 4A must work reliably with polling before considering WebSocket upgrade.

---

## CONTEXT REFERENCES

### Analysis Documents

- `PRPs/ai_docs/orchestrator_analysis/ArchitectureAnalysis.md` - Section 5: "Human-in-the-Loop Integration Points" with state machine diagram
- `PRPs/ai_docs/orchestrator_analysis/BackendAnalysis.md` - Pause service implementation patterns
- `PRPs/ai_docs/orchestrator_analysis/FrontendAnalysis.md` - PauseStateCard component design
- `PRPs/IMPLEMENTATION_TRACKER.md` - Phase 4 checklist and validation gates
- `PRPs/PHASE_DEPENDENCY_DIAGRAM.md` - Visual phase flow

### Existing Patterns

- `python/src/agent_work_orders/workflow_engine/workflow_orchestrator.py` - Workflow execution logic (Phase 3A)
- `python/src/agent_work_orders/models.py` - AgentWorkflowPhase enum
- `python/src/agent_work_orders/api/routes.py` - Background task management with asyncio.Task registry

### Frontend Patterns

- `archon-ui-main/src/features/agent-work-orders/` - Uses SSE for logs, add pause state polling
- `archon-ui-main/src/features/agent-work-orders/views/AgentWorkOrderDetailView.tsx` - Add PauseStateCard here

---

## Pause Checkpoint Configuration

Checkpoints are configured in workflow templates (Phase 1):

### Workflow Template with Checkpoints

```python
{
  "slug": "advanced-dev-workflow",
  "steps": [
    {
      "step_type": "planning",
      "step_template_slug": "multi-agent-planning",
      "pause_after": True,  # PAUSE after planning for approval
      "pause_phase": "awaiting_plan_approval"
    },
    {
      "step_type": "execute",
      "step_template_slug": "standard-execute",
      "pause_after": True,  # PAUSE after implementation for review decision
      "pause_phase": "awaiting_implementation_review"
    },
    {
      "step_type": "review",
      "step_template_slug": "standard-review",
      "pause_after": True,  # PAUSE after review for correction decision
      "pause_phase": "awaiting_review_decision"
    }
  ]
}
```

### Workflow Template Without Checkpoints

```python
{
  "slug": "quick-fix-workflow",
  "steps": [
    {
      "step_type": "planning",
      "step_template_slug": "simple-planning",
      "pause_after": False  # NO PAUSE - runs end-to-end
    },
    {
      "step_type": "execute",
      "step_template_slug": "simple-execute",
      "pause_after": False
    }
  ]
}
```

**Key Point**: Some workflows run end-to-end (pause_after=false), others pause at checkpoints. User controls this via Context Hub (Phase 2).

---

## IMPLEMENTATION TASKS

### CREATE migration/add_workflow_pause_states.sql:

- CREATE_TABLE: archon_workflow_pause_states
- COLUMNS: id UUID PK, agent_work_order_id UUID FK, pause_phase TEXT NOT NULL, pause_content TEXT, pause_timestamp TIMESTAMPTZ DEFAULT NOW(), resume_timestamp TIMESTAMPTZ, user_decision TEXT, user_feedback TEXT, status TEXT DEFAULT 'active', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
- INDEXES: idx_pause_states_work_order ON agent_work_order_id, idx_pause_states_status ON status, idx_pause_states_active ON (agent_work_order_id, status) WHERE status='active'
- FOREIGN_KEY: agent_work_order_id REFERENCES archon_agent_work_orders(id) ON DELETE CASCADE
- COMMENT: "Stores workflow pause states for human-in-the-loop review. One active pause per work order at a time."
- **VALIDATE**: Run in Supabase SQL Editor, verify table created

### CREATE migration/add_pause_phases_to_work_orders.sql:

- ALTER_TABLE: archon_agent_work_orders
- ADD_COLUMN: checkpoint_data JSONB DEFAULT '{}'
- ADD_COLUMN: last_checkpoint TEXT
- COMMENT ON COLUMN checkpoint_data: 'Stores pause-related metadata for resumption (e.g., step outputs, context)'
- COMMENT ON COLUMN last_checkpoint: 'Last pause phase encountered (for debugging)'
- **VALIDATE**: Run in Supabase SQL Editor, verify columns added

### UPDATE python/src/agent_work_orders/models.py:

- UPDATE: AgentWorkflowPhase enum - Add pause phases
  ```python
  class AgentWorkflowPhase(str, Enum):
      PLANNING = "planning"
      AWAITING_PLAN_APPROVAL = "awaiting_plan_approval"  # NEW
      EXECUTING = "executing"  # NEW
      AWAITING_IMPLEMENTATION_REVIEW = "awaiting_implementation_review"  # NEW
      REVIEWING = "reviewing"  # NEW
      AWAITING_REVIEW_DECISION = "awaiting_review_decision"  # NEW
      COMPLETED = "completed"
  ```
- ADD: WorkflowPauseState Pydantic model
  - FIELDS: id, agent_work_order_id, pause_phase, pause_content, pause_timestamp, resume_timestamp, user_decision, user_feedback, status, created_at, updated_at
  - MATCH: Database schema exactly
- ADD: PauseDecision enum
  ```python
  class PauseDecision(str, Enum):
      APPROVE = "approve"  # Continue to next step
      REVISE = "revise"   # Re-run current step with feedback
      CANCEL = "cancel"   # Cancel work order
  ```
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.models import AgentWorkflowPhase, WorkflowPauseState, PauseDecision; print('✓')"`

### CREATE python/src/agent_work_orders/services/pause_service.py:

- IMPLEMENT: PauseService class
- METHOD: `async create_pause_state(work_order_id: str, phase: str, content: str) -> WorkflowPauseState`
  - Insert into archon_workflow_pause_states
  - Set status='active'
  - Update work_order.current_phase to pause phase
  - Return WorkflowPauseState
- METHOD: `async get_active_pause_state(work_order_id: str) -> WorkflowPauseState | None`
  - Query WHERE agent_work_order_id=? AND status='active'
  - Return single active pause (should be max 1)
- METHOD: `async resume_with_decision(work_order_id: str, decision: PauseDecision, feedback: str | None = None) -> bool`
  - Update pause state: status='resolved', user_decision=decision, user_feedback=feedback, resume_timestamp=NOW()
  - Trigger resume event (set asyncio.Event)
  - Return success
- DATABASE: Use get_supabase_client() from state_manager
- PATTERN: Follow services pattern from Phase 1
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.services.pause_service import PauseService; print('✓')"`

### UPDATE python/src/agent_work_orders/workflow_engine/workflow_orchestrator.py:

- ADD_IMPORT: from ..services.pause_service import PauseService
- ADD_IMPORT: import asyncio
- ADD_PARAM: WorkflowOrchestrator.__init__ accepts pause_service: PauseService
- ADD_ATTRIBUTE: self.resume_events: dict[str, asyncio.Event] = {}
- ADD_METHOD: `async _pause_for_approval(work_order_id: str, phase: str, content: str) -> PauseDecision`
  ```python
  async def _pause_for_approval(self, work_order_id: str, phase: str, content: str) -> PauseDecision:
      """Pause workflow and wait for user decision"""
      # Create pause state
      pause_state = await self.pause_service.create_pause_state(work_order_id, phase, content)

      # Create resume event
      self.resume_events[work_order_id] = asyncio.Event()

      # Log pause
      logger.info("Workflow paused", work_order_id=work_order_id, phase=phase)

      # Wait for resume event (blocks execution)
      await self.resume_events[work_order_id].wait()

      # Get decision
      pause_state = await self.pause_service.get_active_pause_state(work_order_id)
      decision = PauseDecision(pause_state.user_decision)

      # Cleanup
      del self.resume_events[work_order_id]

      return decision
  ```
- UPDATE: execute_workflow() method
  - AFTER EACH STEP: Check if step.pause_after is True
  - IF pause_after:
    ```python
    if step_config.pause_after:
        decision = await self._pause_for_approval(
            work_order_id,
            step_config.pause_phase,
            step_result.output
        )

        if decision == PauseDecision.REVISE:
            # Re-run step with feedback
            feedback = pause_state.user_feedback
            context["revision_feedback"] = feedback
            step_result = await self.sub_workflow_orchestrator.execute_step_with_sub_workflow(...)
        elif decision == PauseDecision.CANCEL:
            # Cancel work order
            await self.state_repository.update_status(work_order_id, AgentWorkOrderStatus.FAILED, error_message="Cancelled by user")
            return
        # If APPROVE, continue to next step
    ```
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.workflow_engine.workflow_orchestrator import WorkflowOrchestrator; print('✓')"`

### UPDATE python/src/agent_work_orders/api/routes.py:

- ADD_IMPORT: from ..services.pause_service import PauseService
- CREATE_INSTANCE: `pause_service = PauseService()`
- UPDATE: orchestrator instantiation
  ```python
  orchestrator = WorkflowOrchestrator(
      agent_executor=agent_executor,
      sandbox_factory=sandbox_factory,
      github_client=github_client,
      command_loader=command_loader,
      state_repository=state_repository,
      template_resolver=template_resolver,
      sub_workflow_orchestrator=sub_workflow_orchestrator,
      pause_service=pause_service,  # NEW
  )
  ```
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.api.routes import pause_service; print('✓')"`

### CREATE python/src/agent_work_orders/api/pause_routes.py:

- IMPLEMENT: FastAPI router for pause endpoints
- POST: `/{agent_work_order_id}/resume` - Resume with decision
  - REQUEST: ResumeRequest(decision: PauseDecision, feedback: str | None)
  - LOGIC:
    - Validate work order is paused
    - Call pause_service.resume_with_decision()
    - Set resume event in orchestrator.resume_events
    - Return success
- GET: `/{agent_work_order_id}/pause-state` - Get current pause state
  - RESPONSE: WorkflowPauseState | null
  - Return active pause state or null if not paused
- PATTERN: Follow existing routes.py structure
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.api.pause_routes import router; print('✓')"`

### UPDATE python/src/agent_work_orders/api/routes.py (include pause router):

- IMPORT: from .pause_routes import router as pause_router
- ADD: `router.include_router(pause_router)` (include in main router)
- **VALIDATE**: `grep -q "pause_router" python/src/agent_work_orders/api/routes.py && echo "✓"`

### CREATE archon-ui-main/src/features/agent-work-orders/components/PauseStateCard.tsx:

- IMPLEMENT: Pause state display and action component
- PROPS: workOrder: AgentWorkOrder, pauseState: WorkflowPauseState
- DISPLAY:
  - Pause phase indicator (icon + text: "⏸️ Waiting for Plan Approval")
  - Pause content (plan/implementation/review output)
  - Collapsible content with "Show More" / "Show Less"
  - Timestamp: "Paused 5 minutes ago"
- ACTIONS:
  - Approve button (green, checkmark icon)
  - Revise button (yellow, edit icon) - Opens feedback textarea
  - Cancel button (red, x icon) - With confirmation dialog
- STATE: showFeedbackTextarea (local state, shows when Revise clicked)
- MUTATION: useResumeWorkflow() hook
- STYLING: bg-[#f59e0b]/10 border border-[#f59e0b] rounded-lg (amber/warning indicator)
- PATTERN: Follow FrontendAnalysis.md PauseStateCard example
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/agent-work-orders/components/PauseStateCard.tsx`

### CREATE archon-ui-main/src/features/agent-work-orders/hooks/usePauseQueries.ts:

- DEFINE: pauseKeys query key factory
  ```typescript
  export const pauseKeys = {
    all: ["pause-states"] as const,
    byWorkOrder: (workOrderId: string) => [...pauseKeys.all, workOrderId] as const,
  }
  ```
- IMPLEMENT: usePauseState(workOrderId: string)
  - Query: GET /api/agent-work-orders/{workOrderId}/pause-state
  - Polling: refetchInterval=2000 (2 seconds) when work order is running
  - Disable polling when work order is completed/failed
  - Return: WorkflowPauseState | null
- IMPLEMENT: useResumeWorkflow()
  - Mutation: POST /api/agent-work-orders/{workOrderId}/resume
  - Invalidate: pauseKeys.byWorkOrder(workOrderId), workOrderKeys.detail(workOrderId)
  - Return: Mutation function
- PATTERN: Follow useAgentWorkOrderQueries.ts structure
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/agent-work-orders/hooks/usePauseQueries.ts`

### UPDATE archon-ui-main/src/features/agent-work-orders/views/AgentWorkOrderDetailView.tsx:

- ADD: usePauseState(workOrderId) hook
- CONDITIONAL: Render PauseStateCard when work order.status === "running" AND pauseState !== null
- PLACEMENT: Above execution logs section, below work order details
- POLLING: Automatic via usePauseState hook (2-second interval)
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/agent-work-orders/views/AgentWorkOrderDetailView.tsx`

### ADD python/tests/agent_work_orders/services/:

- CREATE: test_pause_service.py
  - Test: create_pause_state() inserts into database
  - Test: get_active_pause_state() returns active pause
  - Test: resume_with_decision() updates pause state
  - Test: Only one active pause per work order
  - Mock: Supabase client
- **VALIDATE**: `uv run pytest python/tests/agent_work_orders/services/test_pause_service.py -v`

### ADD python/tests/agent_work_orders/api/:

- CREATE: test_pause_routes.py
  - Test: POST /resume with approve decision
  - Test: POST /resume with revise decision
  - Test: POST /resume with cancel decision
  - Test: GET /pause-state returns null when not paused
  - Test: GET /pause-state returns state when paused
  - Mock: PauseService, WorkflowOrchestrator
  - Use FastAPI TestClient
- **VALIDATE**: `uv run pytest python/tests/agent_work_orders/api/test_pause_routes.py -v`

### ADD python/tests/agent_work_orders/integration/:

- CREATE: test_pause_resume_cycle.py
  - Test: Full pause/resume cycle
  - Create work order with workflow that has pause_after=true
  - Wait for pause
  - Resume with approve
  - Verify workflow continues
  - Test: Revise decision re-runs step
  - Test: Cancel decision fails work order
- **VALIDATE**: `uv run pytest python/tests/agent_work_orders/integration/test_pause_resume_cycle.py -v`

---

## Validation Loop

### Level 1: Syntax & Style

```bash
# Backend
uv run ruff check python/src/agent_work_orders/services/pause_service.py --fix
uv run mypy python/src/agent_work_orders/
uv run ruff format python/src/agent_work_orders/

# Frontend
npx tsc --noEmit
npm run biome:fix
```

### Level 2: Unit Tests

```bash
# Backend tests
uv run pytest python/tests/agent_work_orders/services/test_pause_service.py -v
uv run pytest python/tests/agent_work_orders/api/test_pause_routes.py -v

# Frontend tests
npm run test src/features/agent-work-orders/hooks/usePauseQueries.test.ts
npm run test src/features/agent-work-orders/components/PauseStateCard.test.tsx
```

### Level 3: Pause at Planning Checkpoint

```bash
# Create workflow template with pause_after=true for planning
curl -X PUT http://localhost:8053/api/agent-work-orders/templates/workflows/standard-dev \
  -d '{
    "steps": [
      {"step_type": "planning", "step_template_slug": "standard-planning", "pause_after": true, "pause_phase": "awaiting_plan_approval"}
    ]
  }' | jq .

# Enable template execution for test repository
curl -X PUT http://localhost:8053/api/agent-work-orders/repositories/{repo_id}/template-execution \
  -d '{"use_template_execution": true}' | jq .

# Create work order (will pause after planning)
WO_ID=$(curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -d '{"repository_url": "https://github.com/test/repo", "user_request": "Add auth"}' | jq -r '.agent_work_order_id')

# Monitor logs - workflow should pause
curl -N http://localhost:8053/api/agent-work-orders/$WO_ID/logs/stream | grep "pause"

# Wait ~30 seconds for planning to complete

# Get pause state
curl http://localhost:8053/api/agent-work-orders/$WO_ID/pause-state | jq .

# EXPECTED:
{
  "id": "...",
  "agent_work_order_id": "wo_xyz",
  "pause_phase": "awaiting_plan_approval",
  "pause_content": "# Implementation Plan\n...",
  "status": "active",
  "pause_timestamp": "2025-01-05T..."
}
```

**Validation**:
- [ ] Workflow pauses after planning step
- [ ] Pause state stored in database
- [ ] Work order status: AWAITING_PLAN_APPROVAL
- [ ] No further execution (workflow blocked)

### Level 4: Resume with Approval

```bash
# Resume with approval
curl -X POST http://localhost:8053/api/agent-work-orders/$WO_ID/resume \
  -H "Content-Type: application/json" \
  -d '{"decision": "approve"}' | jq .

# EXPECTED: {"success": true}

# Monitor logs - workflow should continue
curl -N http://localhost:8053/api/agent-work-orders/$WO_ID/logs/stream | grep "resume\|execute"

# Expected logs:
# "Workflow resumed with decision: approve"
# "Executing step: execute"

# Check status after ~60 seconds
curl http://localhost:8053/api/agent-work-orders/$WO_ID | jq '.status, .current_phase'

# EXPECTED: status="running", current_phase="executing"
```

**Validation**:
- [ ] Resume accepted
- [ ] Pause state updated (status='resolved')
- [ ] Workflow continues to execute step
- [ ] No errors

### Level 5: Resume with Revision Feedback

```bash
# Create new work order
WO_ID=$(curl -X POST ... | jq -r '.agent_work_order_id')

# Wait for pause after planning (~30 seconds)
sleep 30

# Resume with revision feedback
curl -X POST http://localhost:8053/api/agent-work-orders/$WO_ID/resume \
  -d '{
    "decision": "revise",
    "feedback": "Add security considerations to the plan. Include authentication flow diagram."
  }' | jq .

# Monitor logs - planning should re-run with feedback
curl -N http://localhost:8053/api/agent-work-orders/$WO_ID/logs/stream | grep "feedback\|revision"

# Expected logs:
# "Workflow resumed with decision: revise"
# "Re-running step: planning with feedback"
# "Revision feedback: Add security considerations..."
# "Executing step: planning"

# Wait for planning to complete again (~30 seconds)
sleep 30

# Check pause state - should be paused again
curl http://localhost:8053/api/agent-work-orders/$WO_ID/pause-state | jq .

# EXPECTED: New pause state with updated plan content
```

**Validation**:
- [ ] Revise decision accepted
- [ ] Feedback stored in pause state
- [ ] Planning step re-runs with feedback injected
- [ ] Updated plan generated
- [ ] Workflow pauses again after re-run

### Level 6: UI Integration - Pause State Card

```
1. Create work order via UI (with workflow that has pause_after=true)
2. Work order detail page shows "Running"
3. Status: "Planning"
4. Wait ~30 seconds
5. PauseStateCard appears with amber border
6. Card shows:
   - Header: "⏸️ Waiting for Plan Approval"
   - Plan content (collapsible)
   - Timestamp: "Paused 1 minute ago"
   - Buttons: Approve, Revise, Cancel
7. Click "Approve"
8. Button shows loading spinner
9. PauseStateCard disappears
10. Status changes to "Executing"
11. Logs show "Workflow resumed"
```

**Validation**:
- [ ] PauseStateCard renders when paused
- [ ] Plan content visible and formatted
- [ ] Timestamp updates (relative time)
- [ ] Approve button works
- [ ] Card disappears after approval
- [ ] Workflow continues

### Level 7: Revise with Feedback Textarea

```
1. Work order paused (PauseStateCard visible)
2. Click "Revise" button
3. Feedback textarea appears below buttons
4. Placeholder: "Provide feedback for revision..."
5. Type: "Add error handling section"
6. Click "Submit Revision" (or Revise button again)
7. Loading spinner
8. PauseStateCard updates: "Re-running planning with feedback..."
9. Wait ~30 seconds
10. New PauseStateCard appears with updated plan
11. Plan now includes error handling section
```

**Validation**:
- [ ] Revise button shows feedback textarea
- [ ] Can type feedback
- [ ] Submit sends revise request
- [ ] Planning re-runs with feedback
- [ ] Updated plan visible in new pause

### Level 8: Cancel Workflow

```
1. Work order paused
2. Click "Cancel" button
3. Confirmation dialog: "Are you sure you want to cancel this work order?"
4. Click "Yes, Cancel"
5. Loading spinner
6. PauseStateCard disappears
7. Work order status: "Failed"
8. Error message: "Cancelled by user at planning phase"
9. No further execution
```

**Validation**:
- [ ] Cancel shows confirmation
- [ ] Confirmation prevents accidental cancellation
- [ ] Work order marked as failed
- [ ] Error message explains cancellation
- [ ] Workflow stops (no further steps)

### Level 9: Multiple Checkpoints

```bash
# Configure workflow with 3 pause points
curl -X PUT .../templates/workflows/advanced-dev \
  -d '{
    "steps": [
      {"step_type": "planning", "pause_after": true, "pause_phase": "awaiting_plan_approval"},
      {"step_type": "execute", "pause_after": true, "pause_phase": "awaiting_implementation_review"},
      {"step_type": "review", "pause_after": true, "pause_phase": "awaiting_review_decision"}
    ]
  }'

# Create work order
WO_ID=$(curl -X POST ...)

# Checkpoint 1: After planning
# Wait ~30 seconds, approve
curl -X POST .../$WO_ID/resume -d '{"decision": "approve"}'

# Checkpoint 2: After execute
# Wait ~120 seconds (implementation takes longer), approve
curl -X POST .../$WO_ID/resume -d '{"decision": "approve"}'

# Checkpoint 3: After review
# Wait ~30 seconds, approve
curl -X POST .../$WO_ID/resume -d '{"decision": "approve"}'

# Verify workflow completes
curl .../$WO_ID | jq '.status, .git_commit_count, .github_pull_request_url'

# EXPECTED: status="completed", commits>0, PR URL present
```

**Validation**:
- [ ] Pauses at planning checkpoint
- [ ] Pauses at execute checkpoint
- [ ] Pauses at review checkpoint
- [ ] Workflow completes after 3 approvals
- [ ] All steps executed successfully

### Level 10: No-Pause Workflow (Backward Compat)

```bash
# Configure workflow WITHOUT pause checkpoints
curl -X PUT .../templates/workflows/quick-fix \
  -d '{
    "steps": [
      {"step_type": "planning", "pause_after": false},
      {"step_type": "execute", "pause_after": false}
    ]
  }'

# Create work order
WO_ID=$(curl -X POST ...)

# Monitor - should run end-to-end without pausing
curl -N .../$WO_ID/logs/stream | grep "pause"

# EXPECTED: NO "Workflow paused" logs

# Wait ~3 minutes
sleep 180

# Check status
curl .../$WO_ID | jq '.status'

# EXPECTED: status="completed" (no pauses occurred)
```

**Validation**:
- [ ] Workflow runs end-to-end
- [ ] No pauses occur
- [ ] No pause states created
- [ ] Backward compatible with Phase 3A behavior
- [ ] Completes in normal time (no blocking)

---

## COMPLETION CHECKLIST

- [ ] Database migration for pause states created and run
- [ ] Work order checkpoint columns added
- [ ] Pause phases added to AgentWorkflowPhase enum
- [ ] WorkflowPauseState model created
- [ ] PauseDecision enum created
- [ ] PauseService implemented (create, get, resume methods)
- [ ] Workflow orchestrator pause logic added (_pause_for_approval method)
- [ ] Resume events (asyncio.Event) working
- [ ] Three checkpoint integrations (after planning, execute, review)
- [ ] Revision logic works (re-run step with feedback)
- [ ] Cancellation logic works (fail work order)
- [ ] Pause API routes created (resume, get pause state)
- [ ] PauseStateCard component created
- [ ] usePauseQueries hook created (with polling)
- [ ] Detail view shows pause state
- [ ] All backend tests pass
- [ ] All frontend tests pass
- [ ] No ruff/mypy/TypeScript errors
- [ ] Integration test completes full pause/resume cycle
- [ ] Multiple checkpoints work
- [ ] Workflows without checkpoints still work (backward compat)

---

## Notes

**Phase 4 Scope:**
- **IN SCOPE**: Polling-based pause/resume, configurable checkpoints, revise/approve/cancel decisions
- **OUT OF SCOPE**: WebSocket (Phase 4B future), real-time notifications
- **CRITICAL**: Workflows with pause_after=false must run end-to-end (backward compat with Phase 3A)

**Pause Phases:**
- `awaiting_plan_approval` - After planning step, user reviews plan
- `awaiting_implementation_review` - After execute step, user reviews code changes
- `awaiting_review_decision` - After review step, user approves or requests corrections

**User Decisions:**
- `approve` - Continue to next step
- `revise` - Re-run current step with feedback injected
- `cancel` - Cancel work order (mark as failed)

**Resume Logic:**
- Workflow pauses by waiting on asyncio.Event
- Resume endpoint sets event → workflow continues
- Feedback from revise decision injected into step context as {{revision_feedback}}

**Polling Strategy:**
- Frontend polls GET /pause-state every 2 seconds when work order is running
- Stops polling when work order completes/fails
- Efficient: Only polls active work orders, 304 Not Modified responses reduce bandwidth

**Template Integration:**
- Checkpoints configured in workflow templates (pause_after, pause_phase)
- Created in Phase 2 Context Hub UI
- Stored in Phase 1 database schema
- Executed in Phase 3A template execution system
- Pausing happens in Phase 4

**Dependencies:**
- Requires Phase 1 (templates define pause_after flag)
- Requires Phase 2 (UI to configure checkpoints)
- Requires Phase 3A (template execution for workflows)
- Enables Phase 3B orchestrator pause/resume tools to work
- Works with Phase 5 CLI adapters (pausing independent of CLI choice)

**Performance Considerations:**
- Pause overhead: < 100ms (database insert)
- Resume overhead: < 100ms (event.set())
- Polling overhead: 2-second intervals, only when running
- asyncio.Event blocks workflow thread (non-blocking I/O)

**Future Enhancements (Phase 4B - WebSocket):**
- Real-time notifications when pause occurs
- Instant status updates (no polling)
- Bidirectional communication (pause/resume via WebSocket)
- More complex HITL scenarios (multi-step reviews, consensus-based approvals)

<!-- EOF -->
