# Agent Work Orders - Implementation Tracker

**Purpose**: Master tracking document for the AWO Template & Orchestration System implementation.

**Status Legend**:
- 🔴 Not Started
- 🟡 In Progress
- 🟢 Complete
- ⚪ Blocked

---

## Project Overview

This implementation adds a Context Engineering Hub and automated Agent Work Orders system to Archon, enabling:

### Context Engineering Hub (Core Archon Feature)
- Template library for workflows, agents, steps, and coding standards
- Reusable definitions accessible via MCP server
- Manual usage: IDE agents query MCP → download templates → create command files
- Storage in `complete_setup.sql` (core Archon database)

### Agent Work Orders (Optional Automation Feature)
- Applies Context Hub templates to repositories with customizations
- Repository-specific overrides: priming context, coding standards, agent tools
- Automated workflow execution: git operations, commits, pull requests
- Storage in `agent_work_orders_complete.sql` (optional feature)

**Total Phases**: 7 (6 implementation + 1 future)

---

## Phase Dependency Flow

```
Phase 0 (Database Setup)
    ↓
Phase 1 (Context Hub: Backend + Frontend)
    ↓
Phase 2 (AWO Foundation: Repository Linking)
    ↓
Phase 3 (AWO Execution: Template-Based Workflows) ← CRITICAL PATH
    ↓
Phase 4 (Orchestrator Agent)
    ↓
Phase 5 (Human-in-the-Loop)
    ↓
Phase 6 (Multi-CLI Support)
    ↓
Phase 7 (Parallel Execution - Future)
```

---

## Phase 0: Database Setup

**Status**: 🟢 Complete
**Completed**: 2025-01-05
**PRP**: `story_phase0_database_setup.md`
**Dependencies**: None
**Breaking Changes**: ❌ None

### Objectives
- Create database schema for Context Hub (core Archon)
- Create database schema for Agent Work Orders (optional)
- Seed default templates and coding standards
- Migration instructions and SQL commands

### Migration Files

#### `migration/complete_setup.sql` (Core Archon)
- [x] `archon_agent_templates` - Agent definitions with tools/standards
- [x] `archon_step_templates` - Workflow steps with type enum
- [x] `archon_workflow_templates` - Workflow sequences
- [x] `archon_coding_standards` - Reusable coding standards library
- [x] Seed data: 3 agents, 5 steps, 2 workflows, 3 coding standards
- [x] Step type enum: 'planning', 'implement', 'validate', 'prime', 'git'

#### `migration/agent_work_orders_complete.sql` (Optional Feature)
- [x] `archon_configured_repositories` - Repositories using AWO
- [x] `archon_repository_agent_overrides` - Agent tool/standard overrides per repo
- [x] `archon_agent_work_orders` - Work orders with selected_steps
- [x] `archon_agent_work_order_steps` - Execution history
- [x] Foreign keys to Context Hub tables
- [x] Indexes for performance

### Validation

```sql
-- Verify Context Hub tables
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('archon_agent_templates', 'archon_step_templates',
                     'archon_workflow_templates', 'archon_coding_standards');
-- Should return 4 rows

-- Verify seed data
SELECT COUNT(*) FROM archon_agent_templates; -- Should return 3
SELECT COUNT(*) FROM archon_step_templates; -- Should return 5
SELECT COUNT(*) FROM archon_workflow_templates; -- Should return 2
SELECT COUNT(*) FROM archon_coding_standards; -- Should return 3

-- Verify AWO tables
SELECT table_name FROM information_schema.tables
WHERE table_name LIKE 'archon_%work%order%';
-- Should return 2 rows (work_orders, work_order_steps)
```

### Documentation
- [x] Migration files created
- [x] `migration/AWO.md` exists with setup instructions
- [x] `migration/0.1.0/DB_UPGRADE_INSTRUCTIONS.md` updated
- [x] Rollback procedures documented in Phase 0 PRP
- [x] Verification queries in Phase 0 PRP

---

## Phase 1: Context Engineering Hub

**Status**: 🔴 Not Started
**PRP**: `story_phase1_context_hub.md`
**Dependencies**: Phase 0
**Breaking Changes**: ❌ None (core feature)

### Objectives
- Backend APIs for template CRUD operations
- Frontend UI for creating/editing templates, workflows, agents
- Workflow validation: Must have ≥1 planning, implement, validate step
- Coding standards library management

### Backend Implementation

#### Pydantic Models (`python/src/agent_work_orders/models.py`)
- [ ] `AgentTemplate` - Agent definitions with tools/standards JSONB
- [ ] `StepTemplate` - Steps with step_type enum
- [ ] `WorkflowTemplate` - Workflow sequences
- [ ] `CodingStandard` - Coding standards with language field
- [ ] Request/Response models for all CRUD operations

#### Services
- [ ] `TemplateService` - Agent template CRUD
- [ ] `WorkflowService` - Workflow + step template CRUD with validation
- [ ] `CodingStandardService` - Coding standards CRUD
- [ ] Workflow validation: Check for required step types

#### API Routes (`python/src/agent_work_orders/api/`)
- [ ] `template_routes.py` - Agent template endpoints
- [ ] `workflow_routes.py` - Workflow + step endpoints
- [ ] `coding_standards_routes.py` - Coding standards endpoints
- [ ] Register all routers in main routes.py

### Frontend Implementation

#### Types (`archon-ui-main/src/features/context-hub/types/`)
- [ ] Mirror all backend Pydantic models
- [ ] Step type enum
- [ ] Request/Response types

#### Services (`archon-ui-main/src/features/context-hub/services/`)
- [ ] `templateService.ts` - Agent template API calls
- [ ] `workflowService.ts` - Workflow/step API calls
- [ ] `codingStandardService.ts` - Coding standards API calls

#### Query Hooks (`archon-ui-main/src/features/context-hub/hooks/`)
- [ ] `useAgentTemplates()` - List/create/update agents
- [ ] `useWorkflowTemplates()` - List/create/update workflows
- [ ] `useStepTemplates()` - List/create/update steps
- [ ] `useCodingStandards()` - List/create/update standards
- [ ] Query key factories for each resource

#### Components (`archon-ui-main/src/features/context-hub/components/`)
- [ ] `AgentTemplateCard.tsx` - Display agent summary
- [ ] `AgentTemplateEditor.tsx` - Create/edit agent form
- [ ] `StepTemplateCard.tsx` - Display step summary
- [ ] `StepTemplateEditor.tsx` - Create/edit step (with sub-step builder)
- [ ] `SubStepBuilder.tsx` - Add/remove/reorder sub-steps
- [ ] `WorkflowBuilder.tsx` - Visual workflow composer
- [ ] `CodingStandardEditor.tsx` - Create/edit coding standards
- [ ] `StepTypeSelector.tsx` - Select step type (enum)

#### Views (`archon-ui-main/src/features/context-hub/views/`)
- [ ] `AgentLibraryView.tsx` - Grid view of agents with filters
- [ ] `StepLibraryView.tsx` - Grid view of steps with filters
- [ ] `WorkflowLibraryView.tsx` - List of workflows
- [ ] `CodingStandardsView.tsx` - List of coding standards

#### Pages & Routing
- [ ] `ContextHubPage.tsx` - Tab navigation (Agents, Steps, Workflows, Standards)
- [ ] Add route in `App.tsx`: `/context-hub/:tab?`
- [ ] Add navigation link in sidebar

### Validation Gates

#### Gate 1: Syntax & Style
```bash
# Backend
uv run ruff check src/agent_work_orders/ --fix
uv run mypy src/agent_work_orders/

# Frontend
npx tsc --noEmit
npm run biome:fix
```
- [ ] Zero ruff/mypy errors
- [ ] Zero TypeScript errors

#### Gate 2: Unit Tests
```bash
uv run pytest tests/agent_work_orders/services/
npm run test src/features/context-hub/
```
- [ ] All backend tests pass
- [ ] All frontend tests pass
- [ ] >80% code coverage

#### Gate 3: Integration Tests
```bash
# Create agent template
curl -X POST http://localhost:8053/api/agent-work-orders/templates/agents \
  -d '{"name": "Python Expert", "slug": "python-expert", "system_prompt": "...", "tools": ["Read", "Write"]}' | jq

# Create workflow with validation
curl -X POST http://localhost:8053/api/agent-work-orders/templates/workflows \
  -d '{"slug": "test", "steps": [{"step_type": "planning", "order": 1}]}' | jq
# Should fail: Missing implement and validate steps

# Create valid workflow
curl -X POST http://localhost:8053/api/agent-work-orders/templates/workflows \
  -d '{"slug": "valid", "steps": [
    {"step_type": "planning", "order": 1},
    {"step_type": "implement", "order": 2},
    {"step_type": "validate", "order": 3}
  ]}' | jq
# Should succeed
```
- [ ] All API endpoints work
- [ ] Workflow validation enforces required step types
- [ ] UI can create/edit templates

#### Gate 4: UI Manual Testing
```
1. Navigate to /context-hub
2. Create agent template with tools
3. Create step template with step_type
4. Create workflow with all step types
5. Try to create workflow missing validate step → Should show error
6. Create coding standard for TypeScript
7. Verify all data persists after refresh
```
- [ ] All UI operations work
- [ ] Validation messages clear
- [ ] Data persists correctly

---

## Phase 2: AWO Foundation

**Status**: 🔴 Not Started
**PRP**: `story_phase2_awo_foundation.md`
**Dependencies**: Phase 0, Phase 1
**Breaking Changes**: ❌ None (optional feature)

### Objectives
- Link repositories to Context Hub templates
- Repository-specific overrides: priming context, coding standards, agent tools
- Template → Instance architecture
- Work order step selection (already exists, document it)

### Backend Implementation

#### Models
- [ ] Update `ConfiguredRepository` - Add workflow_template_id, coding_standard_ids, priming_context
- [ ] `RepositoryAgentOverride` - Agent tool/standard overrides per repo
- [ ] Update `AgentWorkOrder` - Document selected_steps field

#### Services
- [ ] Update `RepositoryConfigRepository` - Methods for workflow/standards assignment
- [ ] `RepositoryAgentOverrideService` - Manage agent overrides
- [ ] Methods: apply_template_to_repo(), customize_agent(), update_priming()

#### API Routes
- [ ] `POST /repositories/{id}/apply-template` - Apply workflow template
- [ ] `PUT /repositories/{id}/priming-context` - Update priming context
- [ ] `POST /repositories/{id}/coding-standards` - Assign coding standards
- [ ] `PUT /repositories/{id}/agent-overrides/{agent_id}` - Override agent tools/standards

### Frontend Implementation

#### Repository Configuration Page
- [ ] `RepositoryConfigView.tsx` - Repository settings
- [ ] `TemplateSelector.tsx` - Select workflow template to apply
- [ ] `PrimingContextEditor.tsx` - Edit priming context (paths, architecture)
- [ ] `CodingStandardsSelector.tsx` - Multi-select coding standards
- [ ] `AgentOverridesPanel.tsx` - Override agent tools/standards per repo

#### Work Order Creation
- [ ] Document existing step selection UI
- [ ] Ensure step selection loads from repository's workflow template
- [ ] Allow toggling steps on/off

### Validation Gates

#### Gate 1: Repository Template Application
```bash
# Apply workflow template to repository
curl -X POST http://localhost:8053/api/agent-work-orders/repositories/{repo_id}/apply-template \
  -d '{"workflow_template_id": "fullstack-workflow-uuid"}' | jq

# Verify template applied
curl http://localhost:8053/api/agent-work-orders/repositories/{repo_id} | jq .workflow_template_id
# Should return workflow template UUID
```
- [ ] Template application works
- [ ] Repository links to template

#### Gate 2: Priming Context & Coding Standards
```bash
# Update priming context
curl -X PUT http://localhost:8053/api/agent-work-orders/repositories/{repo_id}/priming-context \
  -d '{"paths": {"frontend": "apps/web/src", "backend": "services/api"}}' | jq

# Assign coding standards
curl -X POST http://localhost:8053/api/agent-work-orders/repositories/{repo_id}/coding-standards \
  -d '{"coding_standard_ids": ["typescript-uuid", "ruff-uuid"]}' | jq
```
- [ ] Priming context saved
- [ ] Coding standards assigned
- [ ] Data persists

#### Gate 3: Agent Overrides
```bash
# Override agent tools for repository
curl -X PUT http://localhost:8053/api/agent-work-orders/repositories/{repo_id}/agent-overrides/python-expert-uuid \
  -d '{"override_tools": ["Read", "Write", "Edit", "Bash"]}' | jq
```
- [ ] Agent overrides saved
- [ ] Overrides are repository-specific
- [ ] Template agent unchanged

#### Gate 4: Work Order Step Selection (Existing Feature)
```bash
# Create work order with selected steps
curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -d '{"repository_url": "...", "user_request": "...", "selected_steps": [1,2,3,5,6]}' | jq
```
- [ ] selected_steps field works
- [ ] Only selected steps execute
- [ ] Document in PRP

---

## Phase 3: AWO Template Execution

**Status**: 🔴 Not Started
**PRP**: `story_phase3_awo_execution.md`
**Dependencies**: Phase 0, Phase 1, Phase 2
**Breaking Changes**: ⚠️ Flag-gated per repository

### Objectives
- Execute workflows using Context Hub templates
- Apply repository overrides (priming, coding standards, agent tools)
- Sub-workflow orchestration (multi-agent steps)
- Flag-gated: `use_template_execution` per repository

### Backend Implementation

#### Template Resolution
- [ ] `TemplateResolver` - Resolve workflow for repository
- [ ] Apply repository priming context
- [ ] Apply coding standards
- [ ] Apply agent tool overrides
- [ ] Render prompt templates with context variables

#### Sub-Workflow Orchestrator
- [ ] `SubWorkflowOrchestrator` - Execute steps with sub-steps
- [ ] Iterate through sub-steps in order
- [ ] Execute each sub-step with assigned agent
- [ ] Aggregate results into parent step result
- [ ] Handle sub-step failures

#### Workflow Orchestrator Updates
- [ ] Add `use_template_execution` flag check
- [ ] Branch: Template mode vs Hardcoded mode
- [ ] Template mode: Use TemplateResolver + SubWorkflowOrchestrator
- [ ] Hardcoded mode: Use existing .md file loading
- [ ] Maintain backward compatibility

### Validation Gates

#### Gate 1: Hardcoded Mode (Backward Compatibility - CRITICAL)
```bash
# Create work order with use_template_execution=false (default)
curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -d '{"repository_url": "https://github.com/test/repo", "user_request": "Test"}' | jq

# Monitor logs
curl -N http://localhost:8053/api/agent-work-orders/{id}/logs/stream | grep "\.md"

# MUST see: "Loading command from: .claude/commands/agent-work-orders/planning.md"
# MUST NOT see: Template resolution or template errors
```
- [ ] Hardcoded mode works
- [ ] No template errors
- [ ] Identical to pre-Phase 3 behavior

#### Gate 2: Enable Template Mode
```bash
# Enable template execution
curl -X PUT http://localhost:8053/api/agent-work-orders/repositories/{repo_id} \
  -d '{"use_template_execution": true}' | jq

# Create work order
curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -d '{"repository_url": "...", "user_request": "Test"}' | jq

# Monitor logs
curl -N http://localhost:8053/api/agent-work-orders/{id}/logs/stream | grep "template"

# MUST see: Template resolution messages
# MUST see: Priming context applied
```
- [ ] Template mode enabled
- [ ] Templates resolved correctly
- [ ] Workflow executes to completion

#### Gate 3: Sub-Workflow Execution
```bash
# Create step template with sub-steps
curl -X POST http://localhost:8053/api/agent-work-orders/templates/steps \
  -d '{
    "slug": "multi-agent-planning",
    "step_type": "planning",
    "sub_steps": [
      {"order": 1, "agent_template_slug": "python-expert", "prompt_template": "..."},
      {"order": 2, "agent_template_slug": "security-expert", "prompt_template": "..."}
    ]
  }' | jq

# Create work order using workflow with multi-agent step
# Verify logs show both sub-steps executing in order
```
- [ ] Sub-steps execute sequentially
- [ ] Each sub-step uses correct agent
- [ ] Outputs aggregate correctly

---

## Phase 4: Orchestrator Agent

**Status**: 🔴 Not Started
**PRP**: `story_phase4_orchestrator.md`
**Dependencies**: Phase 1, Phase 2, Phase 3
**Breaking Changes**: ❌ None (new feature)

### Objectives
- PydanticAI conversational agent
- Intelligent workflow/agent selection based on task
- Natural language work order creation
- Work order monitoring

### Implementation Checklist
- [ ] PydanticAI agent with system prompt
- [ ] 7 orchestrator tools
- [ ] Intelligent task analysis
- [ ] Chat API endpoint
- [ ] Chat UI component
- [ ] Multi-turn conversation support

### Validation Gates
- [ ] Chat API works
- [ ] Task analysis recommends correct agents
- [ ] Work orders created via chat execute successfully

---

## Phase 5: Human-in-the-Loop

**Status**: 🔴 Not Started
**PRP**: `story_phase5_hitl.md`
**Dependencies**: Phase 1, Phase 2, Phase 3
**Breaking Changes**: ⚠️ Changes workflow timing

### Objectives
- Configurable pause checkpoints in workflow templates
- User approve/revise/cancel decisions
- Pause after specific steps
- Polling-based (WebSocket future)

### Implementation Checklist
- [ ] `pause_after` flag in step templates
- [ ] Pause service with database state
- [ ] Pause API endpoints
- [ ] PauseStateCard UI component
- [ ] Resume workflow with feedback injection

### Validation Gates
- [ ] Workflows pause at configured checkpoints
- [ ] User can approve/revise/cancel
- [ ] Workflows without pause_after run end-to-end

---

## Phase 6: Multi-CLI Support

**Status**: 🔴 Not Started
**PRP**: `story_phase6_cli_adapters.md`
**Dependencies**: Phase 1, Phase 2, Phase 3
**Breaking Changes**: ❌ None (backward compatible)

### Objectives
- Generic CLI adapter architecture
- Support Claude, Gemini, Codex CLIs
- Provider switching per repository/agent
- Normalized event format

### Implementation Checklist
- [ ] CLIAdapter base class
- [ ] Claude adapter
- [ ] Gemini adapter
- [ ] Adapter factory
- [ ] Event parser
- [ ] Provider preference (Agent > Repository > Default)

### Validation Gates
- [ ] Claude adapter works (backward compatible)
- [ ] Gemini adapter works
- [ ] Provider switching works
- [ ] Event normalization works

---

## Phase 7: Parallel Execution (Future)

**Status**: 🔴 Not Started (Deferred)
**PRP**: Not yet created
**Dependencies**: Phase 6
**Breaking Changes**: ⚠️ Complex

### Objectives (High-Level)
- Execute multiple CLIs simultaneously
- Compare outputs
- Merge results or let user choose
- Parallel worktree management

**Decision**: Defer until Phases 0-6 are stable and proven

---

## Overall Validation Checklist

### Pre-Implementation
- [ ] All PRPs reviewed and understood
- [ ] Dependencies confirmed
- [ ] Development environment ready

### During Implementation
- [ ] Follow phase order strictly
- [ ] Complete all validation gates before next phase
- [ ] Document blockers immediately
- [ ] Update tracker after each task

### Post-Implementation (After Each Phase)
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] No syntax/type errors
- [ ] Backward compatibility verified
- [ ] Documentation updated
- [ ] Git commit created

### Final Validation (After Phase 6)
- [ ] Full end-to-end test
- [ ] Performance test: 10 concurrent work orders
- [ ] Provider switching test
- [ ] Sub-workflow test
- [ ] Error handling test
- [ ] User acceptance testing

---

## Risk Register

| Phase | Risk | Impact | Mitigation | Status |
|-------|------|--------|------------|--------|
| 0 | Schema design flaws | High | Review with user before implementation | 🟡 In Review |
| 1 | Workflow validation complexity | Medium | Start with simple validation, iterate | 🔴 Monitoring |
| 3 | Template execution breaks workflows | High | Flag-gated rollout, extensive testing | 🔴 Monitoring |
| 3 | Sub-workflow complexity | Medium | Limit sub-steps to 5 max | 🔴 Monitoring |
| 5 | Pause/resume causes hangs | High | Timeout after 24 hours, admin override | 🔴 Monitoring |
| 6 | CLI output format changes | Medium | Version pin CLI tools, adapter versioning | 🔴 Monitoring |

---

## Completion Criteria

### Phases 0-6 Complete When:
- [ ] All validation gates passed
- [ ] All tests passing (unit, integration, E2E)
- [ ] Zero critical bugs
- [ ] Documentation complete
- [ ] User acceptance testing passed

### Project Success Metrics:
- [ ] Users can create custom templates in Context Hub
- [ ] Templates accessible via MCP server
- [ ] Users can apply templates to repositories
- [ ] Work orders execute using templates
- [ ] Repository overrides work correctly
- [ ] HITL checkpoints work smoothly
- [ ] Multiple CLI providers supported
- [ ] Zero regressions in existing functionality

---

**Last Updated**: 2025-01-05
**Current Phase**: Phase 0 (Not Started)
**Next Milestone**: Phase 0 Database Schema Complete
