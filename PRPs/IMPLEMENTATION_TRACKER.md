# Agent Work Orders - Implementation Tracker

**Purpose**: Master tracking document for the AWO Template & Orchestration System implementation.

**Status Legend**:
- 🔴 Not Started
- 🟡 In Progress
- 🟢 Complete
- ⚪ Blocked

---

## Project Overview

This implementation adds a sophisticated template and orchestration system to Agent Work Orders, enabling:
- Custom agent definitions with specialized prompts
- Multi-agent sub-workflows within core steps
- Configurable workflow templates per repository
- Human-in-the-loop review checkpoints
- Multi-provider CLI support (Claude, Gemini, Codex)
- Conversational orchestrator for natural language work order management

**Total Phases**: 6 (5 immediate + 1 future)
**Estimated Duration**: 8-12 weeks for Phases 1-5

---

## Phase Dependency Flow

```
Phase 1 (Backend Templates)
    ↓
Phase 2 (Frontend UI)
    ↓
Phase 3A (Template Execution + Sub-Workflows) ← CRITICAL PATH
    ↓
Phase 3B (Orchestrator Agent)
    ↓
Phase 4 (Human-in-the-Loop)
    ↓
Phase 5 (Multi-CLI Support)
    ↓
Phase 6 (Parallel Execution - Future)
```

---

## Phase 1: Template Storage System (Backend)

**Status**: 🔴 Not Started
**PRP**: `story_awo_template_system_backend.md`
**Estimated Time**: 1.5 weeks
**Dependencies**: None
**Breaking Changes**: ❌ None (additive only)

### Objectives
- Store agent templates in database
- Store step templates with sub-workflow support
- Store workflow templates
- Version control for safe updates
- Seed default templates mirroring hardcoded commands

### Implementation Checklist

#### Database Migrations
- [ ] Create `archon_agent_templates` table
- [ ] Create `archon_step_templates` table (with sub_steps JSONB support)
- [ ] Create `archon_workflow_templates` table
- [ ] Create `archon_repository_agent_configs` table
- [ ] Alter `archon_configured_repositories` for workflow templates
- [ ] Run all migrations in Supabase SQL Editor
- [ ] Verify tables created: `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'archon_%template%';`

#### Backend Models
- [ ] Create `AgentTemplate` Pydantic model
- [ ] Create `StepTemplate` Pydantic model with `sub_steps: list[SubStepConfig]`
- [ ] Create `WorkflowTemplate` Pydantic model
- [ ] Create `RepositoryAgentConfig` Pydantic model
- [ ] Create `SubStepConfig` model (order, agent_slug, prompt_template, required)
- [ ] Validate imports: `uv run python -c "from src.agent_work_orders.models import AgentTemplate, StepTemplate, WorkflowTemplate; print('✓')"`

#### Services
- [ ] Implement `TemplateService` class
- [ ] Methods: list_agent_templates(), get_agent_template(slug), create, update
- [ ] Implement version control (increment version, set parent_template_id)
- [ ] Implement `WorkflowService` class
- [ ] Validate step JSONB structure in workflow templates
- [ ] Test versioning creates new rows (not updates)

#### API Routes
- [ ] Create `template_routes.py` with agent template endpoints
- [ ] Create `workflow_routes.py` with workflow template endpoints
- [ ] Register routers in main routes.py
- [ ] Test GET /api/agent-work-orders/templates/agents
- [ ] Test POST /api/agent-work-orders/templates/agents
- [ ] Test PUT (creates version 2)
- [ ] Test GET /api/agent-work-orders/templates/agents/{slug}/versions

#### Seed Data
- [ ] Create seed migration: `seed_default_templates.sql`
- [ ] Seed agent: `python-backend-expert`
- [ ] Seed agent: `react-ui-specialist`
- [ ] Seed agent: `code-reviewer`
- [ ] Seed step: `standard-planning` (matches planning.md)
- [ ] Seed step: `standard-execute` (matches execute.md)
- [ ] Seed step: `standard-review` (matches prp-review.md)
- [ ] Seed workflow: `standard-dev` (create-branch → planning → execute → review → commit → create-pr)
- [ ] Verify: `SELECT COUNT(*) FROM archon_agent_templates;` returns 3+

#### Testing
- [ ] Unit tests: `test_template_service.py`
- [ ] Unit tests: `test_workflow_service.py`
- [ ] API tests: `test_template_routes.py`
- [ ] API tests: `test_workflow_routes.py`
- [ ] All tests pass: `uv run pytest python/tests/agent_work_orders/services/ -v`
- [ ] No ruff errors: `uv run ruff check python/src/agent_work_orders/`
- [ ] No mypy errors: `uv run mypy python/src/agent_work_orders/`

### Validation Gates

#### Gate 1: Syntax & Linting
```bash
uv run ruff check python/src/agent_work_orders/ --fix
uv run mypy python/src/agent_work_orders/
uv run ruff format python/src/agent_work_orders/
```
- [ ] Zero ruff errors
- [ ] Zero mypy errors
- [ ] All files formatted

#### Gate 2: Unit Tests
```bash
uv run pytest python/tests/agent_work_orders/services/ -v
uv run pytest python/tests/agent_work_orders/api/ -v
```
- [ ] All tests pass
- [ ] Code coverage > 80%

#### Gate 3: Integration Test
```bash
# Template creation
curl -X POST http://localhost:8053/api/agent-work-orders/templates/agents \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Agent", "slug": "test-agent", "system_prompt": "Test"}' | jq .

# List templates
curl http://localhost:8053/api/agent-work-orders/templates/agents | jq .

# Update (create version 2)
curl -X PUT http://localhost:8053/api/agent-work-orders/templates/agents/test-agent \
  -d '{"description": "Updated"}' | jq .

# Verify version 2 exists
curl http://localhost:8053/api/agent-work-orders/templates/agents/test-agent/versions | jq .
```
- [ ] Create works
- [ ] List returns seeded templates
- [ ] Update creates version 2
- [ ] Version history shows 2 entries

#### Gate 4: Backward Compatibility (CRITICAL)
```bash
# Create work order using existing flow
curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -d '{"repository_url": "https://github.com/test/repo", "user_request": "Test"}' | jq .

# Monitor logs
curl http://localhost:8053/api/agent-work-orders/{id}/logs/stream

# Verify logs show hardcoded commands being used:
# - "Loading command from: .claude/commands/agent-work-orders/planning.md"
# - NOT "Using template: standard-planning"
```
- [ ] Work order created successfully
- [ ] Logs show hardcoded command files being read
- [ ] No errors about missing templates
- [ ] Workflow executes to completion

---

## Phase 2: Context Hub Frontend

**Status**: 🔴 Not Started
**PRP**: `story_awo_context_hub_frontend.md`
**Estimated Time**: 2 weeks
**Dependencies**: Phase 1
**Breaking Changes**: ❌ None (UI only)

### Objectives
- UI for browsing/creating/editing templates
- Template versioning UI
- Workflow builder with sub-step support
- Repository configuration page

### Implementation Checklist

#### TypeScript Types
- [ ] Create `archon-ui-main/src/features/context-hub/types/index.ts`
- [ ] Define `AgentTemplate` interface
- [ ] Define `StepTemplate` interface (with `subSteps: SubStepConfig[]`)
- [ ] Define `WorkflowTemplate` interface
- [ ] Define `SubStepConfig` interface
- [ ] Mirror backend models exactly
- [ ] Validate: `npx tsc --noEmit`

#### Services
- [ ] Create `templateService.ts` with API methods
- [ ] Create `workflowService.ts` with API methods
- [ ] Methods: list, get, create, update, getVersions
- [ ] Use `apiClient` from shared utilities
- [ ] Validate: `npx tsc --noEmit`

#### Query Hooks
- [ ] Create `useTemplateQueries.ts` with query key factory
- [ ] Hooks: useAgentTemplates(), useAgentTemplate(slug), useCreateAgentTemplate(), useUpdateAgentTemplate()
- [ ] Create `useWorkflowQueries.ts` with query key factory
- [ ] Use STALE_TIMES.normal for templates
- [ ] Implement optimistic updates
- [ ] Validate: `npx tsc --noEmit`

#### Components
- [ ] `AgentTemplateCard.tsx` - Display agent summary
- [ ] `AgentTemplateEditor.tsx` - Create/edit form
- [ ] `StepTemplateCard.tsx` - Display step summary
- [ ] `StepTemplateEditor.tsx` - Create/edit form with sub-step builder
- [ ] `SubStepBuilder.tsx` - Add/remove/reorder sub-steps
- [ ] `WorkflowStepCard.tsx` - Workflow builder step item
- [ ] `TagInput.tsx` - Multi-tag input
- [ ] `FilterButton.tsx` - Category filters
- [ ] All follow Tron glassmorphism styling
- [ ] All use Radix UI primitives

#### Views
- [ ] `AgentTemplateLibrary.tsx` - Grid view with filters
- [ ] `StepTemplateLibrary.tsx` - Grid view with filters
- [ ] `WorkflowBuilder.tsx` - Visual workflow composer
- [ ] `RepositoryConfiguration.tsx` - Repository settings
- [ ] Responsive design (mobile/tablet/desktop)
- [ ] Validate: `npx tsc --noEmit`

#### Pages & Routing
- [ ] Create `ContextHubPage.tsx` with tab navigation
- [ ] Add route in `App.tsx`: `/context-hub`
- [ ] Add route: `/context-hub/:tab`
- [ ] Add navigation link in `Sidebar.tsx`
- [ ] Icon: Layers or Settings from lucide-react
- [ ] Validate: Navigate to http://localhost:3737/context-hub

#### Testing
- [ ] Unit tests: `AgentTemplateLibrary.test.tsx`
- [ ] Unit tests: `AgentTemplateEditor.test.tsx`
- [ ] Unit tests: `useTemplateQueries.test.ts`
- [ ] Mock templateService and query patterns
- [ ] All tests pass: `npm run test src/features/context-hub/`

### Validation Gates

#### Gate 1: Syntax & Style
```bash
npx tsc --noEmit 2>&1 | grep "src/features/context-hub"
npm run biome:fix
npx tsc --noEmit
```
- [ ] Zero TypeScript errors
- [ ] Biome formatting passes
- [ ] No warnings

#### Gate 2: Unit Tests
```bash
npm run test src/features/context-hub/
```
- [ ] All tests pass
- [ ] Components render without errors

#### Gate 3: Integration Test - Browse Templates
```
1. Start frontend: cd archon-ui-main && npm run dev
2. Navigate to http://localhost:3737/context-hub
3. Agent Templates tab loads
4. See 3+ seeded templates (Python Expert, React Specialist, Code Reviewer)
5. Click template card → View details
6. See system prompt, model, tools, version badge
```
- [ ] Tab navigation works
- [ ] Template list renders
- [ ] Seeded templates visible
- [ ] Details view works

#### Gate 4: Create & Edit Template
```
1. Click "Create Agent Template" button
2. Fill form: Name, Description, System Prompt, Model (select)
3. Add tags: "python", "backend"
4. Click Save
5. Template appears in list
6. Click Edit
7. Modify description
8. Click Save
9. Version badge shows "v2"
10. Click "Versions" → See version history
```
- [ ] Create modal opens
- [ ] Form validation works
- [ ] Save creates template
- [ ] Edit creates version 2
- [ ] Version history displays

#### Gate 5: Workflow Builder
```
1. Navigate to Workflows tab
2. Click "Create Workflow"
3. Add step: Planning
4. Click "Add Sub-Step" within Planning
5. Configure sub-step: Agent (select), Prompt template
6. Add another sub-step
7. Reorder sub-steps with up/down buttons
8. Add step: Execute
9. Add step: Review
10. Save workflow
```
- [ ] Workflow builder renders
- [ ] Can add steps
- [ ] Can add sub-steps within steps
- [ ] Can reorder sub-steps
- [ ] Save creates workflow template

#### Gate 6: Backward Compatibility (CRITICAL)
```
After Context Hub is fully implemented:
1. Go to Agent Work Orders page
2. Create work order via existing modal
3. Monitor execution logs
4. Verify logs show hardcoded commands (planning.md, execute.md, etc.)
5. Verify NO errors about missing templates
6. Verify workflow completes successfully
```
- [ ] Existing work order flow unchanged
- [ ] No template-related errors
- [ ] Hardcoded commands still used
- [ ] No UI claiming templates are active

---

## Phase 3A: Template Execution System + Sub-Workflows

**Status**: 🔴 Not Started
**PRP**: `story_awo_template_execution_system.md` (NEW)
**Estimated Time**: 2.5 weeks
**Dependencies**: Phase 1, Phase 2
**Breaking Changes**: ⚠️ Flag-gated per repository

### Objectives
- Migrate workflow orchestrator to use templates
- Support multi-agent sub-workflows within core steps
- Flag-gated: repositories opt-in to template execution
- Core steps: planning, execute, review (configurable)
- Setup/teardown steps: create-branch, commit, create-pr (hardcoded, not templates)

### Implementation Checklist

#### Backend Models
- [ ] Add `use_template_execution: bool = False` to ConfiguredRepository
- [ ] Create `SubStepExecutionResult` model
- [ ] Update `StepExecutionResult` to include `sub_step_results: list[SubStepExecutionResult]`
- [ ] Create `StepContext` dataclass (user_request, previous_outputs, agent_overrides)
- [ ] Validate: `uv run python -c "from src.agent_work_orders.models import SubStepExecutionResult; print('✓')"`

#### Template Resolution Engine
- [ ] Create `template_resolver.py`
- [ ] Function: `async resolve_workflow_for_repository(repository_id) -> WorkflowTemplate`
- [ ] Function: `async resolve_step_prompt(step_type, context, workflow_template) -> StepPromptConfig`
- [ ] Handle sub-steps: Load agent templates for each sub-step
- [ ] Render prompt templates with context variables
- [ ] Validate: `uv run python -c "from src.agent_work_orders.services.template_resolver import resolve_workflow_for_repository; print('✓')"`

#### Sub-Workflow Orchestrator
- [ ] Create `sub_workflow_orchestrator.py`
- [ ] Function: `async execute_step_with_sub_workflow(step_config, context) -> StepExecutionResult`
- [ ] Iterate through sub-steps in order
- [ ] Execute each sub-step with assigned agent
- [ ] Aggregate results into parent step result
- [ ] Handle sub-step failures (continue vs stop)
- [ ] Validate: Unit tests for sub-workflow execution

#### Workflow Orchestrator Refactor
- [ ] Update `workflow_orchestrator.py`
- [ ] Add template resolver dependency injection
- [ ] Add flag check: `if repository.use_template_execution`
- [ ] New path: `prompt = await resolve_step_prompt(step_type, context, workflow_template)`
- [ ] Old path: `prompt = read_hardcoded_command(f".claude/commands/{step_type}.md")`
- [ ] Update step execution to use sub-workflow orchestrator
- [ ] Maintain backward compatibility for hardcoded mode

#### GitHub Operations (Non-Configurable)
- [ ] Keep `create-branch` hardcoded (not a template)
- [ ] Keep `commit` hardcoded (git operations)
- [ ] Keep `create-pr` hardcoded (GitHub API calls)
- [ ] These are setup/teardown, not AI agent steps
- [ ] Validate: GitHub operations still work in both modes

#### Configuration Management
- [ ] Add API endpoint: `PUT /api/agent-work-orders/repositories/{id}/template-execution`
- [ ] Request body: `{"use_template_execution": true}`
- [ ] Add UI toggle in Repository Configuration page
- [ ] Default: false (use hardcoded commands)
- [ ] Validate: Can toggle per repository

#### Testing
- [ ] Unit tests: `test_template_resolver.py`
- [ ] Unit tests: `test_sub_workflow_orchestrator.py`
- [ ] Integration tests: `test_template_execution_mode.py`
- [ ] Test: Hardcoded mode still works (default)
- [ ] Test: Template mode produces same output structure
- [ ] Test: Sub-workflows execute in correct order
- [ ] Test: Sub-step failures handled correctly

### Validation Gates

#### Gate 1: Unit Tests
```bash
uv run pytest python/tests/agent_work_orders/services/test_template_resolver.py -v
uv run pytest python/tests/agent_work_orders/services/test_sub_workflow_orchestrator.py -v
```
- [ ] Template resolution works
- [ ] Sub-workflow execution works
- [ ] Agent assignment correct
- [ ] Prompt rendering correct

#### Gate 2: Hardcoded Mode (Backward Compatibility)
```bash
# Create work order with default repository (use_template_execution=false)
curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -d '{"repository_url": "https://github.com/test/repo", "user_request": "Test"}' | jq .

# Monitor logs
curl http://localhost:8053/api/agent-work-orders/{id}/logs/stream | grep "command file"

# Expected: Logs show "Loading command from: .claude/commands/agent-work-orders/planning.md"
```
- [ ] Work order executes successfully
- [ ] Hardcoded commands used
- [ ] No template resolution errors
- [ ] Identical behavior to pre-Phase 3A

#### Gate 3: Enable Template Mode
```bash
# Enable template execution for test repository
curl -X PUT http://localhost:8053/api/agent-work-orders/repositories/{repo_id}/template-execution \
  -d '{"use_template_execution": true}' | jq .

# Create work order
curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -d '{"repository_url": "https://github.com/test/repo", "user_request": "Test"}' | jq .

# Monitor logs
curl http://localhost:8053/api/agent-work-orders/{id}/logs/stream | grep "template"

# Expected: Logs show "Using template: standard-planning"
```
- [ ] Template mode enables successfully
- [ ] Work order uses templates
- [ ] Logs show template resolution
- [ ] Workflow executes to completion

#### Gate 4: Sub-Workflow Execution
```bash
# Create step template with sub-steps
curl -X POST http://localhost:8053/api/agent-work-orders/templates/steps \
  -d '{
    "name": "Multi-Agent Planning",
    "slug": "multi-agent-planning",
    "step_type": "planning",
    "sub_steps": [
      {"order": 1, "agent_slug": "python-backend-expert", "prompt_template": "Analyze requirements"},
      {"order": 2, "agent_slug": "security-reviewer", "prompt_template": "Review security implications"},
      {"order": 3, "agent_slug": "code-reviewer", "prompt_template": "Synthesize plan"}
    ]
  }' | jq .

# Update workflow to use multi-agent planning
curl -X PUT http://localhost:8053/api/agent-work-orders/templates/workflows/standard-dev \
  -d '{"steps": [{"step_type": "planning", "step_template_slug": "multi-agent-planning"}]}' | jq .

# Create work order
curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -d '{"repository_url": "https://github.com/test/repo", "user_request": "Add auth"}' | jq .

# Monitor logs - should see 3 sub-steps executing
curl http://localhost:8053/api/agent-work-orders/{id}/logs/stream | grep "sub_step"
```
- [ ] Sub-steps execute in order
- [ ] Each sub-step uses correct agent
- [ ] Outputs aggregate correctly
- [ ] Final plan includes all sub-step results

#### Gate 5: Output Equivalence Test
```bash
# Test 1: Hardcoded mode
curl -X POST ... (create work order in hardcoded mode)
# Capture: git diff, file changes, commit message

# Test 2: Template mode (standard-planning/execute/review)
curl -X POST ... (create work order in template mode)
# Capture: git diff, file changes, commit message

# Compare outputs
diff hardcoded_output.txt template_output.txt

# Expected: Outputs should be functionally equivalent
```
- [ ] Both modes produce similar quality code
- [ ] File changes are appropriate
- [ ] Commit messages are meaningful
- [ ] No regressions in output quality

#### Gate 6: Error Handling
```bash
# Test 1: Missing template
curl -X POST ... (use workflow with non-existent template slug)
# Expected: Clear error message, workflow fails gracefully

# Test 2: Sub-step failure
# Configure sub-step to fail
# Expected: Workflow stops, error logged, work order marked failed

# Test 3: Invalid agent slug
curl -X POST ... (use agent_slug that doesn't exist)
# Expected: Clear error message, workflow fails
```
- [ ] Missing templates handled
- [ ] Sub-step failures handled
- [ ] Invalid agents handled
- [ ] Clear error messages

---

## Phase 3B: Orchestrator Agent

**Status**: 🔴 Not Started
**PRP**: `story_awo_orchestrator_agent.md`
**Estimated Time**: 2 weeks
**Dependencies**: Phase 1, Phase 2, Phase 3A
**Breaking Changes**: ❌ None (new feature)

### Objectives
- PydanticAI conversational agent
- Intelligent agent selection based on task
- Natural language work order creation
- Work order monitoring and status reporting

### Implementation Checklist

#### Backend Agent Implementation
- [ ] Create `python/src/agents/orchestrator/__init__.py`
- [ ] Create `dependencies.py` with OrchestratorDependencies dataclass
- [ ] Create `prompts.py` with system prompt
- [ ] Create `tools.py` with 7 orchestrator tools
- [ ] Tool: create_work_order (with template selection)
- [ ] Tool: check_work_order_status
- [ ] Tool: list_repositories
- [ ] Tool: list_agent_templates
- [ ] Tool: pause_workflow (requires Phase 4)
- [ ] Tool: resume_workflow (requires Phase 4)
- [ ] Tool: get_work_order_logs
- [ ] Validate: `uv run python -c "from src.agents.orchestrator.tools import create_work_order; print('✓')"`

#### Agent Service
- [ ] Create `agent.py` with create_orchestrator_agent()
- [ ] Create `service.py` with OrchestratorService singleton
- [ ] Implement session management
- [ ] Implement message history
- [ ] Create `model_config.py` for provider configuration
- [ ] Integration: Get model from Archon settings
- [ ] Support: OpenAI, Gemini, Ollama
- [ ] Validate: `uv run python -c "from src.agents.orchestrator.service import OrchestratorService; print('✓')"`

#### Intelligent Agent Selection
- [ ] Implement `select_agents_for_task(user_request: str)`
- [ ] Analyze task type (backend, frontend, security, etc.)
- [ ] Recommend agent templates
- [ ] Return: dict[step_type, agent_slug]
- [ ] Example: "Add authentication" → python-backend-expert + security-reviewer
- [ ] Validate: Unit tests for various task types

#### API Endpoints
- [ ] Create `orchestrator_api.py`
- [ ] POST /api/orchestrator/chat
- [ ] Request: ChatRequest (message, session_id)
- [ ] Response: ChatResponse (response, session_id, tool_calls, work_orders)
- [ ] Register router in server/main.py
- [ ] Validate: `curl -X POST http://localhost:8181/api/orchestrator/chat -d '{"message": "List repos"}' | jq`

#### Frontend Implementation
- [ ] Create `features/orchestrator-chat/types/index.ts`
- [ ] Create `services/orchestratorService.ts`
- [ ] Create `hooks/useOrchestratorChat.ts`
- [ ] Create `components/ChatPanel.tsx`
- [ ] Create `components/ChatMessage.tsx`
- [ ] Create `components/ChatInput.tsx`
- [ ] Create `components/WorkOrderCard.tsx`
- [ ] Integrate into AgentWorkOrdersView with toggle button
- [ ] Validate: `npx tsc --noEmit`

#### Testing
- [ ] Backend: `test_tools.py` - Test each tool
- [ ] Backend: `test_agent.py` - Test agent execution
- [ ] Backend: `test_service.py` - Test session management
- [ ] Backend: `test_intelligent_selection.py` - Test agent selection
- [ ] Frontend: `ChatPanel.test.tsx`
- [ ] Frontend: `useOrchestratorChat.test.ts`
- [ ] Mock dependencies and services

### Validation Gates

#### Gate 1: Unit Tests
```bash
uv run pytest python/tests/agents/orchestrator/ -v
npm run test src/features/orchestrator-chat/
```
- [ ] All backend tests pass
- [ ] All frontend tests pass
- [ ] Agent selection logic correct

#### Gate 2: API Integration
```bash
# List repositories via chat
curl -X POST http://localhost:8181/api/orchestrator/chat \
  -d '{"message": "What repositories do I have?", "session_id": null}' | jq .

# Expected: Response lists repositories, tool_calls shows list_repositories
```
- [ ] Chat endpoint works
- [ ] Session ID returned
- [ ] Tool execution works
- [ ] Response formatted correctly

#### Gate 3: Intelligent Agent Selection
```bash
# Backend test
curl -X POST http://localhost:8181/api/orchestrator/chat \
  -d '{"message": "I need to add user authentication to my API"}' | jq .

# Expected: Orchestrator recommends:
# - Planning: python-backend-expert
# - Execute: python-backend-expert
# - Review: security-reviewer
```
- [ ] Task type identified
- [ ] Appropriate agents recommended
- [ ] Explanation provided

#### Gate 4: Work Order Creation via Chat
```bash
curl -X POST http://localhost:8181/api/orchestrator/chat \
  -d '{"message": "Create a work order to add authentication to github.com/test/api"}' | jq .

# Expected:
# - tool_calls includes create_work_order
# - work_orders array includes new work order
# - response includes work order ID and status
```
- [ ] Work order created
- [ ] Correct repository
- [ ] Template-based execution used
- [ ] Work order ID returned

#### Gate 5: UI Integration
```
1. Navigate to http://localhost:3737/agent-work-orders
2. Click chat panel toggle (top right)
3. Chat panel slides in (400px sidebar on desktop)
4. Send message: "List my repositories"
5. See response with repository list
6. Send: "Create work order for authentication in github.com/test/api"
7. See work order created
8. Work order appears in main table
9. Click work order card in chat → Navigate to detail page
```
- [ ] Chat panel toggle works
- [ ] Messages send and receive
- [ ] Tool calls visible
- [ ] Work order cards render
- [ ] Navigation works

#### Gate 6: Multi-Turn Conversation
```
User: "I need to add authentication"
Orchestrator: "Which repository would you like to add authentication to?"
User: "github.com/user/backend-api"
Orchestrator: "I recommend using Python Backend Expert agent with Security Reviewer. Should I proceed?"
User: "Yes"
Orchestrator: "Work order created. ID: {id}. Status: running."
```
- [ ] Context maintained across turns
- [ ] Clarifying questions asked
- [ ] Recommendations provided
- [ ] User confirmation handled

---

## Phase 4: Human-in-the-Loop Pause/Resume

**Status**: 🔴 Not Started
**PRP**: `story_awo_hitl_pause_resume.md`
**Estimated Time**: 2 weeks
**Dependencies**: Phase 1, Phase 2, Phase 3A
**Breaking Changes**: ⚠️ Changes workflow timing

### Objectives
- Workflow pauses at configurable checkpoints
- User reviews and approves/revises/cancels
- Pause checkpoints configured in workflow templates
- Polling-based initially (WebSocket future)

### Implementation Checklist

#### Database Migrations
- [ ] Create `archon_workflow_pause_states` table
- [ ] Columns: id, agent_work_order_id FK, pause_phase, pause_content, user_decision, user_feedback, status
- [ ] Add to `archon_agent_work_orders`: checkpoint_data JSONB, last_checkpoint TEXT
- [ ] Run migrations in Supabase SQL Editor
- [ ] Verify: `SELECT column_name FROM information_schema.columns WHERE table_name = 'archon_workflow_pause_states';`

#### Backend Models
- [ ] Update `AgentWorkflowPhase` enum
- [ ] Add: AWAITING_PLAN_APPROVAL
- [ ] Add: AWAITING_IMPLEMENTATION_REVIEW
- [ ] Add: AWAITING_REVIEW_DECISION
- [ ] Create `WorkflowPauseState` Pydantic model
- [ ] Validate: `uv run python -c "from src.agent_work_orders.models import WorkflowPauseState; print('✓')"`

#### Pause Service
- [ ] Create `services/pause_service.py`
- [ ] Method: create_pause_state(work_order_id, phase, content)
- [ ] Method: get_active_pause_state(work_order_id)
- [ ] Method: resume_with_decision(work_order_id, decision, feedback)
- [ ] Database: Insert/update archon_workflow_pause_states
- [ ] Validate: Unit tests

#### Workflow Orchestrator Updates
- [ ] Add pause_service dependency
- [ ] Add resume_events: Dict[str, asyncio.Event]
- [ ] Method: `async _pause_for_approval(work_order_id, phase, content)`
- [ ] Checkpoint logic: Check workflow template for pause_after flags
- [ ] Pause at configured checkpoints
- [ ] Resume on user decision
- [ ] Inject feedback into next step
- [ ] Validate: Workflow pauses and resumes correctly

#### API Endpoints (Polling-Based)
- [ ] POST /{id}/resume - Resume with decision
- [ ] GET /{id}/pause-state - Get current pause state
- [ ] POST /{id}/feedback - Submit revision feedback
- [ ] Register routes in main router
- [ ] Validate: `curl http://localhost:8053/api/agent-work-orders/{id}/pause-state | jq`

#### Frontend Components
- [ ] Create `components/PauseStateCard.tsx`
- [ ] Display: Pause phase, pause content (plan/output)
- [ ] Actions: Approve, Revise (with feedback textarea), Cancel
- [ ] Create `hooks/usePauseQueries.ts`
- [ ] Query: usePauseState(workOrderId)
- [ ] Mutation: useResumeWorkflow()
- [ ] Update `AgentWorkOrderDetailView.tsx`
- [ ] Conditional render: Show PauseStateCard when paused
- [ ] Polling: Poll pause state every 2 seconds when work order running
- [ ] Validate: `npx tsc --noEmit`

#### Template Integration
- [ ] Update `WorkflowStepConfig` in templates
- [ ] Add: pause_after: bool
- [ ] Add: pause_phase: str (planning_approval, implementation_review, review_decision)
- [ ] Seed template update: Add pause_after=true for planning step
- [ ] Validate: Workflow respects template pause configuration

#### Testing
- [ ] Unit tests: `test_pause_service.py`
- [ ] API tests: `test_pause_routes.py`
- [ ] Integration: `test_pause_resume_cycle.py`
- [ ] Test: Workflow pauses at checkpoint
- [ ] Test: User can approve/revise/cancel
- [ ] Test: Feedback injection works
- [ ] Test: Works with both hardcoded and template modes

### Validation Gates

#### Gate 1: Unit Tests
```bash
uv run pytest python/tests/agent_work_orders/services/test_pause_service.py -v
uv run pytest python/tests/agent_work_orders/api/test_pause_routes.py -v
```
- [ ] Pause state CRUD works
- [ ] Resume logic works
- [ ] Feedback handling works

#### Gate 2: Pause at Planning Checkpoint
```bash
# Create work order (will pause after planning)
curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -d '{"repository_url": "https://github.com/test/repo", "user_request": "Test"}' | jq .

# Monitor logs - workflow should pause
curl http://localhost:8053/api/agent-work-orders/{id}/logs/stream | grep "pause"

# Get pause state
curl http://localhost:8053/api/agent-work-orders/{id}/pause-state | jq .

# Expected: Returns pause state with phase "awaiting_plan_approval"
```
- [ ] Workflow pauses after planning
- [ ] Pause state stored in database
- [ ] Status changes to AWAITING_PLAN_APPROVAL
- [ ] No further execution

#### Gate 3: Approve and Continue
```bash
# Resume with approval
curl -X POST http://localhost:8053/api/agent-work-orders/{id}/resume \
  -d '{"decision": "approve"}' | jq .

# Monitor logs - workflow should continue
curl http://localhost:8053/api/agent-work-orders/{id}/logs/stream | grep "resume"

# Expected: Workflow continues to execute step
```
- [ ] Resume accepted
- [ ] Workflow continues
- [ ] Execute step starts
- [ ] No errors

#### Gate 4: Revise with Feedback
```bash
# Create work order
curl -X POST ...

# Wait for pause after planning

# Resume with revision feedback
curl -X POST http://localhost:8053/api/agent-work-orders/{id}/resume \
  -d '{"decision": "revise", "feedback": "Add security considerations to plan"}' | jq .

# Monitor logs - should see feedback injected
curl http://localhost:8053/api/agent-work-orders/{id}/logs/stream | grep "feedback"

# Expected: Planning step re-runs with feedback
```
- [ ] Revise accepted
- [ ] Planning step re-runs
- [ ] Feedback visible in prompt
- [ ] Updated plan generated

#### Gate 5: UI Integration
```
1. Create work order via UI
2. Work order detail page shows "Running"
3. After ~30 seconds, planning step completes
4. PauseStateCard appears with plan content
5. Buttons: Approve, Revise, Cancel
6. Click "Revise"
7. Feedback textarea appears
8. Enter: "Add error handling"
9. Click Submit
10. PauseStateCard disappears
11. Logs show planning re-running with feedback
```
- [ ] PauseStateCard renders
- [ ] Plan content visible
- [ ] Approve button works
- [ ] Revise textarea works
- [ ] Cancel button works
- [ ] Polling updates state

#### Gate 6: Multiple Checkpoints
```bash
# Enable pause_after for all steps in workflow template
curl -X PUT .../templates/workflows/standard-dev \
  -d '{
    "steps": [
      {"step_type": "planning", "pause_after": true},
      {"step_type": "execute", "pause_after": true},
      {"step_type": "review", "pause_after": true}
    ]
  }'

# Create work order
# Should pause 3 times: after planning, after execute, after review
# Approve each time
# Verify workflow completes after 3 approvals
```
- [ ] Pauses at planning checkpoint
- [ ] Pauses at execute checkpoint
- [ ] Pauses at review checkpoint
- [ ] Workflow completes after all approvals

---

## Phase 5: Multi-CLI Adapter System

**Status**: 🔴 Not Started
**PRP**: `story_awo_cli_adapter_system.md`
**Estimated Time**: 1.5 weeks
**Dependencies**: Phase 1, Phase 2, Phase 3A
**Breaking Changes**: ❌ None (backward compatible)

### Objectives
- Generic CLI adapter architecture
- Support Claude, Gemini, Codex CLIs
- Provider switching per repository
- Normalized event format

### Implementation Checklist

#### CLI Adapter Base
- [ ] Create `cli_adapters/__init__.py`
- [ ] Create `base.py` with CLIAdapter abstract class
- [ ] Define CLIEvent dataclass (work_order_id, event_type, step, file_path, error, metadata)
- [ ] Event types: step_started, step_completed, file_changed, error_occurred
- [ ] Validate: `uv run python -c "from src.agent_work_orders.cli_adapters.base import CLIAdapter, CLIEvent; print('✓')"`

#### CLI Adapters
- [ ] Create `claude_adapter.py` with ClaudeCLIAdapter
- [ ] Command: ["claude", "--output-format=stream-json", "--print", "--verbose"]
- [ ] Parse JSONL output
- [ ] Normalize to CLIEvent
- [ ] Create `gemini_adapter.py` with GeminiCLIAdapter
- [ ] Command: ["gemini", "-p", prompt, "--output-format", "stream-json"]
- [ ] Parse JSONL output
- [ ] Normalize to CLIEvent
- [ ] Validate: Both adapters can be instantiated

#### Adapter Factory
- [ ] Create `factory.py` with get_cli_adapter(provider, work_order_id)
- [ ] Registry: {"claude": ClaudeCLIAdapter, "gemini": GeminiCLIAdapter}
- [ ] Error handling for unsupported providers
- [ ] Validate: `uv run python -c "from src.agent_work_orders.cli_adapters.factory import get_cli_adapter; adapter = get_cli_adapter('claude', 'test'); print('✓')"`

#### Event Parser
- [ ] Create `event_parser.py` with parse_cli_output_stream()
- [ ] Async iteration over process stdout
- [ ] JSON parsing with error handling
- [ ] Event callback for log buffer integration
- [ ] Validate: Unit tests

#### Executor Integration
- [ ] Update `agent_cli_executor.py` to use adapters
- [ ] Method: execute_command(provider="claude")
- [ ] Replace direct subprocess calls
- [ ] Maintain backward compatibility
- [ ] Validate: Existing workflows still work

#### Orchestrator Integration
- [ ] Update `workflow_orchestrator.py`
- [ ] Get provider from repository config or agent template
- [ ] Pass provider to executor
- [ ] Default: "claude" (backward compatible)
- [ ] Validate: Can specify provider per step

#### Repository Configuration
- [ ] Add `preferred_cli: str = "claude"` to ConfiguredRepository
- [ ] Add `preferred_cli: str = "claude"` to AgentTemplate
- [ ] Priority: Agent template overrides repository default
- [ ] Validate: Configuration persists

#### Testing
- [ ] Unit tests: `test_claude_adapter.py`
- [ ] Unit tests: `test_gemini_adapter.py` (with mocks)
- [ ] Unit tests: `test_factory.py`
- [ ] Unit tests: `test_event_parser.py`
- [ ] Integration: `test_adapter_switching.py`
- [ ] Mock subprocess for CLI simulation

### Validation Gates

#### Gate 1: Unit Tests
```bash
uv run pytest python/tests/agent_work_orders/cli_adapters/ -v
```
- [ ] All adapter tests pass
- [ ] Factory tests pass
- [ ] Event parser tests pass

#### Gate 2: Claude Adapter (Backward Compatibility)
```bash
# Create work order (should use Claude by default)
curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -d '{"repository_url": "https://github.com/test/repo", "user_request": "Test"}' | jq .

# Monitor logs - should see Claude CLI being used
curl http://localhost:8053/api/agent-work-orders/{id}/logs/stream | grep "claude"

# Expected: Logs show claude command execution
```
- [ ] Work order executes with Claude
- [ ] No errors
- [ ] Backward compatible

#### Gate 3: Switch to Gemini
```bash
# Update repository configuration
curl -X PUT http://localhost:8053/api/agent-work-orders/repositories/{repo_id} \
  -d '{"preferred_cli": "gemini"}' | jq .

# Create work order
curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -d '{"repository_url": "https://github.com/test/repo", "user_request": "Test"}' | jq .

# Monitor logs - should see Gemini CLI being used
curl http://localhost:8053/api/agent-work-orders/{id}/logs/stream | grep "gemini"

# Expected: Logs show gemini command execution
```
- [ ] Repository configuration updates
- [ ] Work order uses Gemini CLI
- [ ] Event normalization works
- [ ] Workflow completes successfully

#### Gate 4: Event Normalization
```bash
# Test 1: Claude CLI execution
# Capture CLIEvents emitted

# Test 2: Gemini CLI execution
# Capture CLIEvents emitted

# Compare event structures
# Expected: Both produce same event types and format
```
- [ ] Both CLIs produce CLIEvents
- [ ] Event types match
- [ ] Metadata fields populated
- [ ] Log buffer receives events

#### Gate 5: Agent Template CLI Preference
```bash
# Update agent template to prefer Gemini
curl -X PUT .../templates/agents/python-backend-expert \
  -d '{"preferred_cli": "gemini"}' | jq .

# Create work order with this agent
# Expected: Uses Gemini even if repository prefers Claude

# Verify: Agent template overrides repository default
```
- [ ] Agent template CLI preference saved
- [ ] Overrides repository default
- [ ] Workflow uses correct CLI
- [ ] Priority: Agent > Repository > Default

#### Gate 6: Error Handling
```bash
# Test 1: Unsupported provider
curl -X POST ... -d '{"preferred_cli": "codex"}' | jq .
# Expected: Clear error message

# Test 2: CLI not installed
# Configure to use Gemini when gemini CLI not installed
# Expected: Fallback to Claude or clear error

# Test 3: Malformed CLI output
# Simulate corrupted JSONL
# Expected: Skip malformed lines, continue processing
```
- [ ] Unsupported providers handled
- [ ] Missing CLI binaries handled
- [ ] Malformed output handled
- [ ] Clear error messages

---

## Phase 6: Parallel CLI Execution (Future)

**Status**: 🔴 Not Started (Deferred)
**PRP**: Not yet created
**Estimated Time**: 3-4 weeks
**Dependencies**: Phase 5
**Breaking Changes**: ⚠️ Complex - requires careful design

### Objectives (High-Level)
- Execute multiple CLIs simultaneously
- Compare outputs from different providers
- Merge results or let user choose
- Parallel worktree management

### Future Design Considerations
- Parallel git worktrees per provider
- Result comparison algorithms
- Conflict resolution strategies
- User choice interface
- Resource management (concurrent CLI processes)
- Cost management (multiple API calls)

**Decision**: Defer until Phases 1-5 are stable and proven in production

---

## Overall Validation Checklist

### Pre-Implementation
- [ ] All PRPs reviewed and approved
- [ ] Dependencies understood
- [ ] Development environment set up
- [ ] Supabase project ready
- [ ] All CLI tools installed (Claude CLI, Gemini CLI optional, gh CLI)

### During Implementation
- [ ] Follow phase order strictly (1 → 2 → 3A → 3B → 4 → 5)
- [ ] Complete all validation gates before moving to next phase
- [ ] Document blockers immediately
- [ ] Update this tracker after each task completion
- [ ] Run regression tests after each phase

### Post-Implementation (After Each Phase)
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] No ruff/mypy/TypeScript errors
- [ ] Backward compatibility verified
- [ ] Documentation updated
- [ ] Git commit with clear message
- [ ] Notify team of phase completion

### Final Validation (After Phase 5)
- [ ] Full end-to-end test: Create template → Configure repository → Create work order via orchestrator → Monitor execution → HITL approval → Workflow completion
- [ ] Performance test: 10 concurrent work orders
- [ ] Provider switching test: Claude, Gemini, back to Claude
- [ ] Sub-workflow test: Multi-agent planning with 3 sub-steps
- [ ] Error handling test: All failure scenarios
- [ ] User acceptance testing
- [ ] Production readiness review

---

## Risk Register

| Phase | Risk | Impact | Mitigation | Status |
|-------|------|--------|------------|--------|
| 3A | Template execution breaks existing workflows | High | Flag-gated rollout, extensive testing | 🔴 Monitoring |
| 3A | Sub-workflow complexity causes performance issues | Medium | Limit sub-steps to 5 max, parallel execution future | 🔴 Monitoring |
| 4 | Pause/resume causes workflow hangs | High | Timeout after 24 hours, admin override | 🔴 Monitoring |
| 5 | Gemini CLI not widely available | Low | Make optional, Claude remains default | 🟢 Accepted |
| 5 | CLI output format changes | Medium | Version pin CLI tools, adapter versioning | 🔴 Monitoring |
| All | Breaking changes to existing work orders | High | Backward compatibility tests in every phase | 🔴 Monitoring |

---

## Performance Benchmarks

Track these metrics after each phase:

| Metric | Baseline (Current) | Phase 3A | Phase 4 | Phase 5 | Target |
|--------|-------------------|----------|---------|---------|--------|
| Work order creation time | ~500ms | | | | < 1s |
| Workflow execution time (simple) | ~2 min | | | | < 3 min |
| Workflow execution time (complex) | ~5 min | | | | < 8 min |
| Template resolution time | N/A | | | | < 100ms |
| Sub-workflow overhead | N/A | | | | < 30s per sub-step |
| Database query time (templates) | N/A | | | | < 50ms |
| API response time (chat) | N/A | | | | < 2s |

---

## Support & Escalation

**Blockers**:
- If blocked > 4 hours, document in tracker
- If blocked > 24 hours, escalate to team

**Questions**:
- Technical questions: Check PRP → Check analysis docs → Ask team
- Design questions: Refer to orchestrator_analysis docs
- Priority questions: This tracker is source of truth

**Changes**:
- Any scope changes must update both PRP and this tracker
- Any dependency changes require re-validation of dependent phases

---

## Completion Criteria

### Phase 1-5 Complete When:
- [ ] All validation gates passed
- [ ] All tests passing (unit, integration, E2E)
- [ ] Zero critical bugs
- [ ] Performance benchmarks met
- [ ] Documentation complete
- [ ] User acceptance testing passed
- [ ] Production deployment successful

### Project Success Metrics:
- [ ] Users can create custom agent templates
- [ ] Users can build custom workflows with sub-steps
- [ ] Work orders execute using templates
- [ ] HITL checkpoints work smoothly
- [ ] Multiple CLI providers supported
- [ ] Orchestrator provides intelligent recommendations
- [ ] Zero regressions in existing functionality
- [ ] < 5% failure rate in template-based executions

---

**Last Updated**: 2025-01-05
**Current Phase**: Phase 1 (Not Started)
**Next Milestone**: Phase 1 Database Migrations Complete
**Estimated Completion**: Phase 5 - Q1 2025
