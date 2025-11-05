---
name: "Phase 1: AWO Template System - Database & Backend"
description: "Agent and step template storage system with backend APIs for template management (STORAGE ONLY - not execution)"
phase: 1
dependencies: []
breaking_changes: false
---

## Original Story

```
Implement a template library system for Agent Work Orders that enables:
1. Storing reusable agent definitions (prompts) in the database
2. Storing customizable workflow step templates with sub-step support
3. Storing pre-configured workflow sequences
4. Repository-specific agent and workflow configurations
5. Template versioning for safe updates

Current limitation: Prompts are hardcoded in Python files, cannot be customized per repository or task type.

Goal: Enable users to define specialized agents (Python Expert, React Specialist, Security Reviewer) and custom workflow steps with multi-agent sub-workflows, stored in database, assignable per repository, with version control for safe iteration.
```

## Story Metadata

**Story Type**: Feature
**Estimated Complexity**: High
**Primary Systems Affected**:
- Database: New tables (agent_templates, step_templates, workflow_templates, repository_agent_configs)
- Backend: New services and API routes for template CRUD
- Backend: Updated ConfiguredRepository model

**Phase Number**: 1
**Dependencies**: None
**Breaking Changes**: ❌ None (additive only - templates stored but NOT executed)

---

## CRITICAL: This Phase is Storage Only

**What This Phase Does**:
- Creates database tables for templates
- Implements CRUD APIs for templates
- Seeds default templates that **mirror hardcoded commands**
- Enables UI to browse/edit templates

**What This Phase Does NOT Do**:
- Execute workflows using templates (that's Phase 3A)
- Change existing work order behavior
- Replace hardcoded .md files
- Break any existing functionality

**Validation**: After this phase, creating a work order **must still** use hardcoded commands from `.claude/commands/agent-work-orders/`. Templates are for storage and UI display only.

---

## CONTEXT REFERENCES

### Analysis Documents

- `PRPs/ai_docs/orchestrator_analysis/DataModelAnalysis.md` - Complete schema design with examples
- `PRPs/ai_docs/orchestrator_analysis/ArchitectureAnalysis.md` - Section 6: Data Structure Improvements
- `PRPs/IMPLEMENTATION_TRACKER.md` - Master tracking document for all phases

### Database Patterns

- `migration/complete_setup.sql` - Migration pattern for Archon tables
- `migration/add_source_url_display_name.sql` - Example of ALTER TABLE migration
- Pattern: All Archon tables prefixed with `archon_`

### Backend Service Patterns

- `python/src/server/services/project_service.py` - CRUD service pattern
- `python/src/server/api_routes/projects_api.py` - API route pattern with FastAPI
- `python/src/server/models/project_models.py` - Pydantic model pattern
- `python/src/agent_work_orders/state_manager/repository_config_repository.py` - Repository config CRUD

### Existing AWO Models

- `python/src/agent_work_orders/models.py` - ConfiguredRepository, WorkflowStep enum
- Database: `archon_configured_repositories` table exists

---

## Sub-Workflow Support in Templates

Templates support two modes for core steps (planning, execute, review):

### Single-Agent Mode (Simple)
```python
{
  "step_type": "planning",
  "agent_template_id": "uuid-of-python-expert",
  "prompt_template": "Create implementation plan for: {{user_request}}",
  "sub_steps": []  # Empty array = single agent
}
```

### Multi-Agent Mode (Advanced)
```python
{
  "step_type": "planning",
  "agent_template_id": null,  # Not used when sub_steps exist
  "sub_steps": [
    {
      "order": 1,
      "name": "Requirements Analysis",
      "agent_template_slug": "product-analyst",
      "prompt_template": "Analyze: {{user_request}}",
      "required": true
    },
    {
      "order": 2,
      "name": "Security Review",
      "agent_template_slug": "security-expert",
      "prompt_template": "Review security of: {{sub_steps.0.output}}",
      "required": true
    }
  ]
}
```

**Note**: Sub-workflows are STORED in this phase but NOT EXECUTED until Phase 3A.

---

## IMPLEMENTATION TASKS

### UPDATE migration/complete_setup.sql:

- FIND: Section after existing Archon tables
- ADD: Comment header: `-- Agent Work Orders Template System Tables`
- ADD_TABLE: archon_agent_templates
  - COLUMNS: id UUID PK DEFAULT gen_random_uuid(), name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, description TEXT, system_prompt TEXT NOT NULL, model TEXT DEFAULT 'sonnet', temperature REAL DEFAULT 0.0, tools JSONB DEFAULT '[]', metadata JSONB DEFAULT '{}', is_active BOOLEAN DEFAULT TRUE, version INTEGER DEFAULT 1, parent_template_id UUID REFERENCES archon_agent_templates(id), created_by TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
  - INDEXES: idx_agent_templates_slug ON slug, idx_agent_templates_active ON is_active WHERE is_active=true
  - CONSTRAINT: UNIQUE (slug, version)
- **VALIDATE**: User will drop AWO tables and re-run complete_setup.sql

### UPDATE migration/agent_work_orders_state.sql:

- CREATE_TABLE: archon_step_templates
- COLUMNS: id UUID PK, step_type TEXT, name TEXT, slug TEXT UNIQUE, description TEXT, prompt_template TEXT, agent_template_id UUID FK NULLABLE, **sub_steps JSONB DEFAULT '[]'**, metadata JSONB DEFAULT '{}', is_active BOOLEAN DEFAULT TRUE, version INTEGER DEFAULT 1, parent_template_id UUID FK, created_by TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
  - INDEXES: idx_step_templates_type ON step_type, idx_step_templates_slug ON slug, idx_step_templates_active ON is_active WHERE is_active=true
  - CONSTRAINT: UNIQUE (slug, version)
  - COMMENT: 'Array of sub-step configs for multi-agent workflows. Each: order, name, agent_template_slug, prompt_template, required'
- ADD_TABLE: archon_workflow_templates
  - COLUMNS: id UUID PK DEFAULT gen_random_uuid(), name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, description TEXT, steps JSONB NOT NULL, metadata JSONB DEFAULT '{}', is_active BOOLEAN DEFAULT TRUE, created_by TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
  - INDEXES: idx_workflow_templates_slug ON slug, idx_workflow_templates_active ON is_active WHERE is_active=true
  - COMMENT: 'Steps array contains planning/execute/review only. GitHub ops (create-branch, commit, create-pr) are hardcoded'
- ADD_TABLE: archon_repository_agent_configs
  - COLUMNS: id UUID PK DEFAULT gen_random_uuid(), configured_repository_id UUID FK REFERENCES archon_configured_repositories(id) ON DELETE CASCADE, agent_template_id UUID FK REFERENCES archon_agent_templates(id), role TEXT, priority INTEGER DEFAULT 0, is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
  - CONSTRAINT: UNIQUE (configured_repository_id, agent_template_id, role)
  - INDEXES: idx_repo_agent_configs_repo ON configured_repository_id, idx_repo_agent_configs_agent ON agent_template_id
- ALTER_TABLE: archon_configured_repositories
  - ADD_COLUMN: default_workflow_template_id UUID REFERENCES archon_workflow_templates(id)
  - ADD_COLUMN: workflow_settings JSONB DEFAULT '{}'
  - ADD_COLUMN: agent_settings JSONB DEFAULT '{}'
  - INDEX: idx_configured_repos_workflow ON default_workflow_template_id
- ADD: Seed data (3 agents, 3 steps, 1 workflow) - See seed section below
- **VALIDATE**: User runs DROP commands then complete_setup.sql in Supabase SQL Editor

### PROVIDE DROP COMMANDS for user:

Create a code block with SQL DROP commands user will run before re-running complete_setup.sql:

```sql
-- Drop Agent Work Orders tables in correct order (reverse of creation)
DROP TABLE IF EXISTS archon_workflow_pause_states CASCADE;
DROP TABLE IF EXISTS archon_agent_work_order_steps CASCADE;
DROP TABLE IF EXISTS archon_agent_work_orders CASCADE;
DROP TABLE IF EXISTS archon_repository_agent_configs CASCADE;
DROP TABLE IF EXISTS archon_workflow_templates CASCADE;
DROP TABLE IF EXISTS archon_step_templates CASCADE;
DROP TABLE IF EXISTS archon_agent_templates CASCADE;
DROP TABLE IF EXISTS archon_configured_repositories CASCADE;
```

**User will**:
1. Run DROP commands in Supabase SQL Editor
2. Run `migration/complete_setup.sql`
3. Run `migration/agent_work_orders_state.sql`
4. Run `migration/agent_work_orders_repositories.sql`

### SEED DATA (Add to agent_work_orders_state.sql):

**CRITICAL**: Seed templates mirror existing hardcoded commands from `.claude/commands/agent-work-orders/`

- INSERT: Agent template "Python Backend Expert"
  - system_prompt: Similar to what's implied in planning.md/execute.md
  - model: sonnet
  - tools: ["Read", "Write", "Edit", "Grep", "Bash"]

- INSERT: Agent template "Code Reviewer"
  - system_prompt: Code review focused
  - model: sonnet
  - tools: ["Read", "Grep"]

- INSERT: Agent template "React UI Specialist"
  - system_prompt: Frontend/React focused
  - model: sonnet
  - tools: ["Read", "Write", "Edit", "Grep"]

- INSERT: Step template "Standard Planning"
  - step_type: "planning"
  - prompt_template: Copy content from `.claude/commands/agent-work-orders/planning.md`
  - agent_template_id: python-backend-expert UUID
  - sub_steps: [] (empty)

- INSERT: Step template "Standard Execute"
  - step_type: "execute"
  - prompt_template: Copy content from `.claude/commands/agent-work-orders/execute.md`
  - agent_template_id: python-backend-expert UUID
  - sub_steps: [] (empty)

- INSERT: Step template "Standard Review"
  - step_type: "review"
  - prompt_template: Copy content from `.claude/commands/agent-work-orders/prp-review.md`
  - agent_template_id: code-reviewer UUID
  - sub_steps: [] (empty)

- INSERT: Workflow template "Standard Dev"
  - slug: "standard-dev"
  - steps: [
      {"step_type": "planning", "order": 1, "step_template_slug": "standard-planning"},
      {"step_type": "execute", "order": 2, "step_template_slug": "standard-execute"},
      {"step_type": "review", "order": 3, "step_template_slug": "standard-review"}
    ]
  - Note: create-branch, commit, create-pr NOT in steps (hardcoded operations)

- **VALIDATE**: `SELECT COUNT(*) FROM archon_agent_templates;` returns 3
- **VALIDATE**: `SELECT COUNT(*) FROM archon_step_templates;` returns 3
- **VALIDATE**: `SELECT COUNT(*) FROM archon_workflow_templates;` returns 1

### CREATE python/src/agent_work_orders/models.py additions:

- ADD: AgentTemplate Pydantic model
- ADD: StepTemplate Pydantic model (with sub_steps: list[dict])
- ADD: WorkflowTemplate Pydantic model
- ADD: RepositoryAgentConfig Pydantic model
- FIELDS: Mirror database schema exactly
- PATTERN: Follow existing ConfiguredRepository model pattern
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.models import AgentTemplate, StepTemplate, WorkflowTemplate; print('✓')"`

### CREATE python/src/agent_work_orders/services/__init__.py:

- CREATE: Empty init file for services module
- **VALIDATE**: `test -f python/src/agent_work_orders/services/__init__.py && echo "✓"`

### CREATE python/src/agent_work_orders/services/template_service.py:

- IMPLEMENT: TemplateService class
- METHODS: list_agent_templates(), get_agent_template(slug), create_agent_template(data), update_agent_template(slug, updates)
- VERSIONING: update creates new version (increment version, set parent_template_id)
- SUPABASE_CLIENT: Use get_supabase_client() from state_manager/repository_config_repository.py pattern
- ERROR_HANDLING: Raise specific exceptions for not found, duplicate slug
- PATTERN: Follow python/src/server/services/project_service.py structure
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.services.template_service import TemplateService; print('✓')"`

### CREATE python/src/agent_work_orders/services/workflow_service.py:

- IMPLEMENT: WorkflowService class
- METHODS: list_workflow_templates(), get_workflow_template(slug), create_workflow_template(data), update_workflow_template(slug, updates)
- STEP_VALIDATION: Validate steps JSONB structure matches schema
- SUB_STEP_VALIDATION: Validate sub_steps in step templates (order, agent_template_slug, required fields present)
- PATTERN: Follow TemplateService structure
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.services.workflow_service import WorkflowService; print('✓')"`

### CREATE python/src/agent_work_orders/api/template_routes.py:

- IMPLEMENT: FastAPI router for template endpoints
- GET: /api/agent-work-orders/templates/agents - List agent templates
- GET: /api/agent-work-orders/templates/agents/{slug} - Get specific agent template
- POST: /api/agent-work-orders/templates/agents - Create agent template
- PUT: /api/agent-work-orders/templates/agents/{slug} - Update agent template (creates new version)
- GET: /api/agent-work-orders/templates/agents/{slug}/versions - Get version history
- PATTERN: Follow api/routes.py structure with router = APIRouter()
- DEPENDENCY: Inject TemplateService()
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.api.template_routes import router; print('✓')"`

### CREATE python/src/agent_work_orders/api/workflow_routes.py:

- IMPLEMENT: FastAPI router for workflow template endpoints
- GET: /api/agent-work-orders/templates/workflows - List workflow templates
- GET: /api/agent-work-orders/templates/workflows/{slug} - Get specific workflow
- POST: /api/agent-work-orders/templates/workflows - Create workflow template
- PUT: /api/agent-work-orders/templates/workflows/{slug} - Update workflow template
- GET: /api/agent-work-orders/templates/steps - List step templates
- GET: /api/agent-work-orders/templates/steps/{slug} - Get specific step template
- POST: /api/agent-work-orders/templates/steps - Create step template (with sub_steps support)
- PUT: /api/agent-work-orders/templates/steps/{slug} - Update step template
- PATTERN: Follow template_routes.py structure
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.api.workflow_routes import router; print('✓')"`

### UPDATE python/src/agent_work_orders/api/routes.py:

- IMPORT: from .template_routes import router as template_router
- IMPORT: from .workflow_routes import router as workflow_router
- FIND: Existing router includes
- ADD: After existing includes, add template and workflow routers
- **VALIDATE**: `grep -q "template_router\|workflow_router" python/src/agent_work_orders/api/routes.py && echo "✓"`

### UPDATE python/src/agent_work_orders/state_manager/repository_config_repository.py:

- ADD_METHOD: get_repository_agents(repository_id) -> list[RepositoryAgentConfig]
- ADD_METHOD: assign_agent_to_repository(repository_id, agent_template_id, role, priority)
- ADD_METHOD: remove_agent_from_repository(config_id)
- PATTERN: Follow existing list_repositories(), create_repository() pattern
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.state_manager.repository_config_repository import RepositoryConfigRepository; print('✓')"`

### ADD python/tests/agent_work_orders/services/:

- CREATE: test_template_service.py - Test agent template CRUD and versioning
- CREATE: test_workflow_service.py - Test workflow template CRUD
- MOCK: Mock Supabase client responses
- TEST_VERSIONING: Verify version increment on update
- TEST_QUERIES: Verify slug-based lookups work
- TEST_SUB_STEPS: Verify sub_steps validation in step templates
- **VALIDATE**: `uv run pytest python/tests/agent_work_orders/services/ -v`

### ADD python/tests/agent_work_orders/api/:

- CREATE: test_template_routes.py - Test template API endpoints
- CREATE: test_workflow_routes.py - Test workflow API endpoints
- PATTERN: Follow python/tests/server/api_routes/ test patterns
- USE: FastAPI TestClient for endpoint testing
- **VALIDATE**: `uv run pytest python/tests/agent_work_orders/api/ -v`

---

## Validation Loop

### Level 1: Syntax & Style

```bash
uv run ruff check python/src/agent_work_orders/services/ --fix
uv run ruff check python/src/agent_work_orders/api/ --fix
uv run mypy python/src/agent_work_orders/services/
uv run mypy python/src/agent_work_orders/api/
uv run ruff format python/src/agent_work_orders/
```

### Level 2: Unit Tests

```bash
uv run pytest python/tests/agent_work_orders/services/ -v
uv run pytest python/tests/agent_work_orders/api/ -v
```

### Level 3: Integration Testing

```bash
# Start AWO service
uv run python -m uvicorn src.agent_work_orders.server:app --port 8053 --reload &

# Test agent template creation
curl -X POST http://localhost:8053/api/agent-work-orders/templates/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Python Backend Expert",
    "slug": "python-backend-expert",
    "description": "Expert in FastAPI and async Python",
    "system_prompt": "You are a Python backend expert...",
    "model": "sonnet",
    "tools": ["Read", "Write", "Edit"],
    "metadata": {"tags": ["python", "backend"]}
  }' | jq .

# List templates
curl http://localhost:8053/api/agent-work-orders/templates/agents | jq .

# Get specific template
curl http://localhost:8053/api/agent-work-orders/templates/agents/python-backend-expert | jq .

# Update template (creates new version)
curl -X PUT http://localhost:8053/api/agent-work-orders/templates/agents/python-backend-expert \
  -H "Content-Type: application/json" \
  -d '{"description": "Updated description"}' | jq .

# Verify version incremented
curl http://localhost:8053/api/agent-work-orders/templates/agents/python-backend-expert/versions | jq .

# Create step template with sub-steps
curl -X POST http://localhost:8053/api/agent-work-orders/templates/steps \
  -d '{
    "name": "Multi-Agent Planning",
    "slug": "multi-agent-planning",
    "step_type": "planning",
    "sub_steps": [
      {"order": 1, "name": "Requirements", "agent_template_slug": "python-backend-expert", "prompt_template": "Analyze requirements"},
      {"order": 2, "name": "Security", "agent_template_slug": "code-reviewer", "prompt_template": "Review security"}
    ]
  }' | jq .
```

### Level 4: Database Validation

```bash
# In Supabase SQL Editor, verify:
# 1. Tables exist
SELECT table_name FROM information_schema.tables
WHERE table_name LIKE 'archon_%template%';

# 2. Seed data loaded
SELECT COUNT(*) FROM archon_agent_templates;
SELECT COUNT(*) FROM archon_step_templates;
SELECT COUNT(*) FROM archon_workflow_templates;

# 3. Foreign keys work
SELECT
  at.name as agent_name,
  st.name as step_name
FROM archon_step_templates st
LEFT JOIN archon_agent_templates at ON st.agent_template_id = at.id;

# 4. Version control works
SELECT slug, version, created_at
FROM archon_agent_templates
WHERE slug = 'python-backend-expert'
ORDER BY version DESC;

# 5. Sub-steps stored correctly
SELECT slug, jsonb_array_length(sub_steps) as sub_step_count
FROM archon_step_templates
WHERE jsonb_array_length(sub_steps) > 0;
```

### Level 5: Backward Compatibility (CRITICAL - MUST PASS)

```bash
# CRITICAL TEST: Verify existing work orders still work with hardcoded commands

# Create work order using existing flow
WO_ID=$(curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -H "Content-Type: application/json" \
  -d '{
    "repository_url": "https://github.com/test/repo",
    "user_request": "Add authentication feature",
    "sandbox_type": "git_worktree"
  }' | jq -r '.agent_work_order_id')

echo "Work Order ID: $WO_ID"

# Monitor logs in real-time
curl -N http://localhost:8053/api/agent-work-orders/$WO_ID/logs/stream | grep -E "command|template|\.md"

# EXPECTED OUTPUT:
# ✅ "Loading command from: .claude/commands/agent-work-orders/planning.md"
# ✅ "Loading command from: .claude/commands/agent-work-orders/execute.md"
# ✅ "Loading command from: .claude/commands/agent-work-orders/prp-review.md"
# ❌ NO lines with "Using template: standard-planning"
# ❌ NO lines with "Template resolver"
# ❌ NO template-related errors

# Wait for completion
sleep 180

# Verify status
curl http://localhost:8053/api/agent-work-orders/$WO_ID | jq '.status, .git_commit_count, .git_files_changed, .error_message'

# EXPECTED:
# - status: "completed" or "failed" (workflow executed)
# - NOT "pending" (would indicate stuck due to template errors)
# - error_message: null or Claude CLI issues (not template errors)
```

**VALIDATION MUST PASS**: If work orders use templates or show template errors, Phase 1 has FAILED. Templates are storage only in this phase.

---

## COMPLETION CHECKLIST

- [ ] All database migrations created and run successfully
- [ ] All template tables created with proper indexes and constraints
- [ ] sub_steps column added to archon_step_templates
- [ ] Default templates seeded (3 agents, 3 steps, 1 workflow minimum)
- [ ] Seed templates mirror hardcoded .md files
- [ ] Pydantic models created for all template types
- [ ] TemplateService and WorkflowService implemented
- [ ] Sub-step validation in WorkflowService
- [ ] Template API routes created and registered
- [ ] Repository agent config methods added
- [ ] All unit tests pass
- [ ] All integration tests pass (API endpoints work)
- [ ] Sub-step templates can be created via API
- [ ] No ruff/mypy errors
- [ ] Database queries return expected data
- [ ] Version control works (update creates new version)
- [ ] **Backward compatibility validated: Work orders still use hardcoded commands**
- [ ] **No template execution errors in logs**
- [ ] **Zero breaking changes to existing functionality**

---

## Notes

**Phase 1 Scope:**
- **IN SCOPE**: Database schema, API endpoints, template storage, seeding
- **OUT OF SCOPE**: Template execution, workflow changes, CLI integration
- **CRITICAL**: Existing work orders MUST continue using hardcoded .md files

**Database Migration Order:**
1. agent_templates (no dependencies)
2. step_templates (FK to agent_templates)
3. workflow_templates (no FK dependencies)
4. repository_agent_configs (FK to configured_repositories and agent_templates)
5. alter_configured_repositories (FK to workflow_templates)
6. seed_default_templates (inserts data)

**Backwards Compatibility:**
- Existing work orders continue to use hardcoded prompts from `.claude/commands/agent-work-orders/`
- Templates are for storage and UI display only
- No changes to workflow execution logic
- No impact on running or future work orders

**Sub-Workflow Design:**
- Single-agent mode: agent_template_id set, sub_steps empty
- Multi-agent mode: agent_template_id null, sub_steps populated
- Sub-steps stored as JSONB array: `[{order, name, agent_template_slug, prompt_template, required}, ...]`
- Validation: sub_steps must have unique order values, required fields present

**Dependencies for Next Phases:**
- Phase 2 (Frontend): Can now query template APIs to display in UI
- Phase 3A (Execution): Will implement template resolution and sub-workflow orchestration
- Phase 3B (Orchestrator): Can use templates for intelligent agent selection
- Phase 4 (HITL): Can reference templates in pause checkpoints
- Phase 5 (CLI Adapters): Works with both hardcoded and template modes

**Testing Requirements:**
- Unit tests: 80%+ coverage for services
- Integration tests: All API endpoints functional
- Database tests: Foreign keys, indexes, constraints work
- **Backward compatibility test: MUST PASS - work orders use hardcoded commands**

<!-- EOF -->
