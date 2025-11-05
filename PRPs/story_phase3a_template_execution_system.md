---
name: "AWO Template Execution System + Sub-Workflows"
description: "Migrate workflow orchestrator from hardcoded commands to template-based execution with multi-agent sub-workflow support"
---

## Original Story

```
Bridge the gap between template storage (Phase 1) and actual workflow execution by refactoring the orchestrator to:
1. Resolve workflow templates for repositories
2. Execute workflows using agent and step templates instead of hardcoded .md files
3. Support multi-agent sub-workflows within core steps (planning, execute, review)
4. Keep GitHub operations hardcoded (create-branch, commit, create-pr)
5. Enable flag-gated rollout (use_template_execution per repository)

Current limitation: Templates are stored in database (Phase 1) but workflows still execute hardcoded commands from .claude/commands/agent-work-orders/. No way to use custom agents or sub-workflows.

Goal: Enable users to execute work orders using their configured templates, with support for sophisticated multi-agent workflows where multiple specialized agents collaborate on a single step (e.g., Requirements Analyst + Security Expert + Architect all contributing to planning).
```

## Story Metadata

**Story Type**: Feature (Critical Path)
**Estimated Complexity**: High
**Primary Systems Affected**:
- Backend: Workflow orchestrator refactor
- Backend: New template resolution engine
- Backend: Sub-workflow orchestrator
- Database: Add use_template_execution flag

---

## CONTEXT REFERENCES

### Analysis Documents

- `PRPs/ai_docs/orchestrator_analysis/ArchitectureAnalysis.md` - Sub-workflow design patterns
- `PRPs/ai_docs/orchestrator_analysis/DataModelAnalysis.md` - Template structure with sub-steps

### Existing Patterns

- `python/src/agent_work_orders/workflow_engine/workflow_orchestrator.py` - Current hardcoded execution
- `python/src/agent_work_orders/models.py` - WorkflowTemplate, StepTemplate models (Phase 1)
- `python/src/agent_work_orders/services/template_service.py` - Template CRUD (Phase 1)
- `.claude/commands/agent-work-orders/` - Hardcoded command files to replace

### Template Structure (Phase 1)

```python
class StepTemplate:
    id: str
    step_type: str  # "planning", "execute", "review"
    prompt_template: str
    agent_template_id: str | None  # Single agent (simple)
    sub_steps: list[SubStepConfig] = []  # Multi-agent (advanced)

class SubStepConfig:
    order: int
    name: str
    agent_template_slug: str
    prompt_template: str
    required: bool = True
    timeout_seconds: int = 3600
```

---

## IMPLEMENTATION TASKS

### UPDATE python/src/agent_work_orders/models.py:

- ADD: `SubStepConfig` Pydantic model
- FIELDS: order, name, agent_template_slug, prompt_template, required, timeout_seconds
- ADD: `SubStepExecutionResult` Pydantic model
- FIELDS: sub_step_name, agent_slug, success, output, error_message, duration_seconds, timestamp
- UPDATE: `StepExecutionResult` - Add `sub_step_results: list[SubStepExecutionResult] = []`
- ADD: `StepContext` dataclass for template resolution
- FIELDS: work_order_id, user_request, github_issue_number, previous_step_outputs: dict[str, str], agent_overrides: dict[str, str]
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.models import SubStepConfig, SubStepExecutionResult, StepContext; print('✓')"`

### UPDATE migration/alter_configured_repositories_for_template_execution.sql:

- ALTER_TABLE: archon_configured_repositories
- ADD_COLUMN: use_template_execution BOOLEAN DEFAULT FALSE
- COMMENT: "When true, workflows use templates. When false, use hardcoded .md files"
- INDEX: idx_configured_repos_template_execution ON use_template_execution
- **VALIDATE**: Run in Supabase SQL Editor, verify column added

### CREATE python/src/agent_work_orders/services/__init__.py:

- UPDATE: Export template resolver and sub-workflow orchestrator
- **VALIDATE**: `test -f python/src/agent_work_orders/services/__init__.py && echo "✓"`

### CREATE python/src/agent_work_orders/services/template_resolver.py:

- IMPLEMENT: TemplateResolver class
- METHOD: `async resolve_workflow_for_repository(repository_id: str) -> WorkflowTemplate`
  - Get repository from database
  - Load default_workflow_template_id
  - If null, return "standard-dev" workflow (seed data)
  - Return WorkflowTemplate object
- METHOD: `async resolve_step_config(step_type: str, workflow: WorkflowTemplate) -> StepConfig`
  - Find step in workflow.steps matching step_type
  - Load step_template by slug
  - Load agent_template (if single agent mode)
  - Load agent_templates for sub-steps (if multi-agent mode)
  - Return complete StepConfig with agents and prompts
- METHOD: `async render_prompt(template: str, context: StepContext) -> str`
  - Jinja2 template rendering
  - Variables: {{user_request}}, {{github_issue_number}}, {{previous_outputs.planning}}
  - Error handling for missing variables
- IMPORTS: from .template_service import TemplateService; import jinja2
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.services.template_resolver import TemplateResolver; print('✓')"`

### CREATE python/src/agent_work_orders/services/sub_workflow_orchestrator.py:

- IMPLEMENT: SubWorkflowOrchestrator class
- METHOD: `async execute_step_with_sub_workflow(step_config, context, working_dir) -> StepExecutionResult`
  - If step_config.sub_steps is empty: Execute as single-agent step
  - If step_config.sub_steps exists: Execute multi-agent sub-workflow
  - Return aggregated StepExecutionResult
- METHOD: `async _execute_single_agent_step(step_config, context, working_dir) -> StepExecutionResult`
  - Render prompt from step_config.prompt_template
  - Get agent CLI from agent_template.preferred_cli (or default "claude")
  - Execute via agent_cli_executor
  - Return StepExecutionResult
- METHOD: `async _execute_multi_agent_step(sub_steps, context, working_dir) -> StepExecutionResult`
  - Initialize sub_step_results: list[SubStepExecutionResult] = []
  - FOR EACH sub_step in sorted(sub_steps, key=lambda x: x.order):
    - Render sub_step.prompt_template with context
    - Load agent for this sub-step
    - Execute via agent_cli_executor
    - Collect SubStepExecutionResult
    - Add output to context for next sub-step
  - Aggregate all sub_step results into parent output
  - Return StepExecutionResult with sub_step_results
- METHOD: `async _aggregate_sub_step_outputs(results: list[SubStepExecutionResult]) -> str`
  - Concatenate all outputs with headers
  - Format: "## Sub-Step 1: Requirements Analysis\n{output}\n\n## Sub-Step 2: Security Review\n{output}"
  - Return combined output
- ERROR_HANDLING: If required sub-step fails, stop and fail parent step
- ERROR_HANDLING: If optional sub-step fails, log warning and continue
- IMPORTS: from ..agent_executor.agent_cli_executor import AgentCLIExecutor; import asyncio
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.services.sub_workflow_orchestrator import SubWorkflowOrchestrator; print('✓')"`

### UPDATE python/src/agent_work_orders/workflow_engine/workflow_orchestrator.py:

- ADD_IMPORT: from ..services.template_resolver import TemplateResolver
- ADD_IMPORT: from ..services.sub_workflow_orchestrator import SubWorkflowOrchestrator
- ADD_PARAM: WorkflowOrchestrator.__init__ accepts template_resolver, sub_workflow_orchestrator
- UPDATE: execute_workflow() method
- ADD: Check repository.use_template_execution flag at start
- ADD: Branch logic:
  ```python
  if repository.use_template_execution:
      # Template-based execution (NEW)
      workflow_template = await self.template_resolver.resolve_workflow_for_repository(repository_id)
      # Execute using templates
  else:
      # Hardcoded execution (EXISTING)
      # Use .claude/commands/agent-work-orders/{step}.md files
  ```
- UPDATE: Step execution loop
- TEMPLATE_MODE: Call sub_workflow_orchestrator.execute_step_with_sub_workflow()
- HARDCODED_MODE: Call existing workflow_operations.run_{step}_step() functions
- KEEP_UNCHANGED: create-branch, commit, create-pr steps (always hardcoded, never templates)
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.workflow_engine.workflow_orchestrator import WorkflowOrchestrator; print('✓')"`

### UPDATE python/src/agent_work_orders/api/routes.py:

- ADD: Dependency injection for TemplateResolver and SubWorkflowOrchestrator
- UPDATE: Orchestrator instantiation
  ```python
  template_resolver = TemplateResolver()
  sub_workflow_orchestrator = SubWorkflowOrchestrator(agent_executor)
  orchestrator = WorkflowOrchestrator(
      agent_executor=agent_executor,
      sandbox_factory=sandbox_factory,
      github_client=github_client,
      command_loader=command_loader,
      state_repository=state_repository,
      template_resolver=template_resolver,
      sub_workflow_orchestrator=sub_workflow_orchestrator,
  )
  ```
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.api.routes import router; print('✓')"`

### CREATE python/src/agent_work_orders/api/repository_config_routes.py:

- IMPLEMENT: FastAPI router for repository configuration
- PUT: `/api/agent-work-orders/repositories/{repository_id}/template-execution`
- REQUEST: `{"use_template_execution": true}`
- RESPONSE: Updated ConfiguredRepository
- UPDATE: repository.use_template_execution in database
- **VALIDATE**: `curl -X PUT http://localhost:8053/api/agent-work-orders/repositories/{id}/template-execution -d '{"use_template_execution": true}' | jq`

### UPDATE python/src/agent_work_orders/api/routes.py (include repository config router):

- IMPORT: from .repository_config_routes import router as repo_config_router
- ADD: Include repo_config_router in main router
- **VALIDATE**: `grep -q "repo_config_router" python/src/agent_work_orders/api/routes.py && echo "✓"`

### ADD python/tests/agent_work_orders/services/:

- CREATE: test_template_resolver.py
  - Test: resolve_workflow_for_repository() loads correct workflow
  - Test: resolve_step_config() loads agent and prompt templates
  - Test: render_prompt() replaces Jinja2 variables correctly
  - Mock: TemplateService methods
- CREATE: test_sub_workflow_orchestrator.py
  - Test: Single-agent step execution
  - Test: Multi-agent step execution (3 sub-steps)
  - Test: Sub-step output aggregation
  - Test: Required sub-step failure stops workflow
  - Test: Optional sub-step failure continues workflow
  - Mock: AgentCLIExecutor
- **VALIDATE**: `uv run pytest python/tests/agent_work_orders/services/test_template_resolver.py -v`
- **VALIDATE**: `uv run pytest python/tests/agent_work_orders/services/test_sub_workflow_orchestrator.py -v`

### ADD python/tests/agent_work_orders/integration/:

- CREATE: test_template_execution_mode.py
  - Test: Hardcoded mode still works (use_template_execution=false)
  - Test: Template mode executes workflow (use_template_execution=true)
  - Test: Toggle between modes works
  - Test: GitHub operations always hardcoded (create-branch, commit, create-pr)
  - Test: Sub-workflow with 2+ agents produces aggregated output
- **VALIDATE**: `uv run pytest python/tests/agent_work_orders/integration/test_template_execution_mode.py -v`

### UPDATE archon-ui-main/src/features/context-hub/views/RepositoryConfiguration.tsx:

- ADD: Toggle switch for "Use Template Execution"
- STATE: useRepositoryConfig(repositoryId)
- MUTATION: useUpdateTemplateExecution()
- TOGGLE: Updates use_template_execution via API
- WARNING: Show banner: "Existing work orders unaffected. Only new work orders will use templates."
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/context-hub/views/RepositoryConfiguration.tsx`

---

## Core Step Definitions

### Configurable Steps (Use Templates)

These are the AI agent steps that can be customized with templates:

1. **Planning** (`step_type: "planning"`)
   - Can have sub-steps: Requirements analysis, Architecture design, Security review
   - Multiple agents can collaborate
   - Output: Comprehensive plan document

2. **Execute** (`step_type: "execute"`)
   - Can have sub-steps: Implementation, Testing, Documentation
   - Multiple agents can contribute code
   - Output: Code changes in git branch

3. **Review** (`step_type: "review"`)
   - Can have sub-steps: Code review, Security audit, Performance analysis
   - Multiple reviewers provide feedback
   - Output: Review report with findings

### Non-Configurable Steps (Always Hardcoded)

These are GitHub/git operations that don't need AI customization:

1. **Create Branch** (`create-branch`)
   - Creates git branch or worktree
   - Uses hardcoded logic
   - Not a template step

2. **Commit** (`commit`)
   - Stages changes and creates commit
   - Uses hardcoded git commands
   - Not a template step

3. **Create PR** (`create-pr`)
   - Creates GitHub pull request
   - Uses hardcoded gh CLI commands
   - Not a template step

---

## Sub-Workflow Example

### Single-Agent Step (Simple)

```yaml
step_type: planning
step_template_slug: standard-planning
agent_template_slug: python-backend-expert
sub_steps: []  # Empty = single agent
```

**Execution**: One agent reads prompt, generates plan

### Multi-Agent Step (Advanced)

```yaml
step_type: planning
step_template_slug: multi-agent-planning
agent_template_slug: null  # Not used when sub_steps exist
sub_steps:
  - order: 1
    name: "Requirements Analysis"
    agent_template_slug: product-analyst
    prompt_template: "Analyze requirements: {{user_request}}"
    required: true

  - order: 2
    name: "Security Review"
    agent_template_slug: security-expert
    prompt_template: "Review security implications of: {{sub_steps.0.output}}"
    required: true

  - order: 3
    name: "Plan Synthesis"
    agent_template_slug: python-backend-expert
    prompt_template: "Create implementation plan from:\n\nRequirements:\n{{sub_steps.0.output}}\n\nSecurity:\n{{sub_steps.1.output}}"
    required: true
```

**Execution**:
1. Product Analyst analyzes requirements
2. Security Expert reviews output from step 1
3. Python Expert synthesizes final plan from steps 1+2

**Output Aggregation**:
```markdown
## Sub-Step 1: Requirements Analysis
[Product Analyst output]

## Sub-Step 2: Security Review
[Security Expert output]

## Sub-Step 3: Plan Synthesis
[Python Expert final plan]
```

---

## Validation Loop

### Level 1: Syntax & Style

```bash
uv run ruff check python/src/agent_work_orders/services/ --fix
uv run mypy python/src/agent_work_orders/services/
uv run ruff format python/src/agent_work_orders/
```

### Level 2: Unit Tests

```bash
# Template resolver tests
uv run pytest python/tests/agent_work_orders/services/test_template_resolver.py -v

# Sub-workflow orchestrator tests
uv run pytest python/tests/agent_work_orders/services/test_sub_workflow_orchestrator.py -v

# Integration tests
uv run pytest python/tests/agent_work_orders/integration/test_template_execution_mode.py -v
```

### Level 3: Backward Compatibility Test (CRITICAL)

```bash
# Start AWO service
uv run python -m uvicorn src.agent_work_orders.server:app --port 8053 --reload &

# Test 1: Create work order with default repository (use_template_execution=false)
WO_ID=$(curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -H "Content-Type: application/json" \
  -d '{
    "repository_url": "https://github.com/test/repo",
    "user_request": "Add authentication",
    "sandbox_type": "git_worktree"
  }' | jq -r '.agent_work_order_id')

echo "Work Order ID: $WO_ID"

# Monitor logs
curl -N http://localhost:8053/api/agent-work-orders/$WO_ID/logs/stream | grep "command\|template"

# EXPECTED OUTPUT:
# - "Loading command from: .claude/commands/agent-work-orders/planning.md"
# - "Loading command from: .claude/commands/agent-work-orders/execute.md"
# - NO lines with "Using template: standard-planning"

# Test 2: Verify workflow completes successfully
sleep 180  # Wait for workflow to complete
curl http://localhost:8053/api/agent-work-orders/$WO_ID | jq '.status'

# EXPECTED: status = "completed" or "failed" (if Claude CLI has issue)
# NOT: status = "pending" (stuck due to template errors)
```

- [ ] Logs show hardcoded .md files being loaded
- [ ] NO template resolution errors
- [ ] Workflow executes to completion
- [ ] No breaking changes

### Level 4: Enable Template Execution

```bash
# Get repository ID
REPO_ID=$(curl http://localhost:8053/api/agent-work-orders/repositories | jq -r '.[0].id')

# Enable template execution
curl -X PUT http://localhost:8053/api/agent-work-orders/repositories/$REPO_ID/template-execution \
  -H "Content-Type: application/json" \
  -d '{"use_template_execution": true}' | jq .

# Expected: Repository updated with use_template_execution=true

# Create new work order
WO_ID=$(curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -H "Content-Type: application/json" \
  -d '{
    "repository_url": "https://github.com/test/repo",
    "user_request": "Add authentication",
    "sandbox_type": "git_worktree"
  }' | jq -r '.agent_work_order_id')

# Monitor logs
curl -N http://localhost:8053/api/agent-work-orders/$WO_ID/logs/stream | grep "template"

# EXPECTED OUTPUT:
# - "Resolved workflow: standard-dev"
# - "Using step template: standard-planning"
# - "Using agent: python-backend-expert"
# - NO lines with "Loading command from: .claude/commands"
```

- [ ] Template execution enabled
- [ ] Logs show template resolution
- [ ] Workflow uses templates (not .md files)
- [ ] Workflow completes successfully

### Level 5: Sub-Workflow Test

```bash
# Create multi-agent planning template
curl -X POST http://localhost:8053/api/agent-work-orders/templates/steps \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Multi-Agent Planning",
    "slug": "multi-agent-planning",
    "step_type": "planning",
    "sub_steps": [
      {
        "order": 1,
        "name": "Requirements Analysis",
        "agent_template_slug": "python-backend-expert",
        "prompt_template": "Analyze the requirements for: {{user_request}}",
        "required": true
      },
      {
        "order": 2,
        "name": "Security Review",
        "agent_template_slug": "code-reviewer",
        "prompt_template": "Review security implications of the requirements",
        "required": true
      },
      {
        "order": 3,
        "name": "Plan Synthesis",
        "agent_template_slug": "python-backend-expert",
        "prompt_template": "Create implementation plan from requirements and security review",
        "required": true
      }
    ]
  }' | jq .

# Update workflow to use multi-agent planning
curl -X PUT http://localhost:8053/api/agent-work-orders/templates/workflows/standard-dev \
  -H "Content-Type: application/json" \
  -d '{
    "steps": [
      {
        "step_type": "planning",
        "step_template_slug": "multi-agent-planning",
        "order": 1,
        "required": true
      }
    ]
  }' | jq .

# Create work order
WO_ID=$(curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -d '{"repository_url": "https://github.com/test/repo", "user_request": "Add auth"}' | jq -r '.agent_work_order_id')

# Monitor logs - should see 3 sub-steps
curl -N http://localhost:8053/api/agent-work-orders/$WO_ID/logs/stream | grep "sub_step"

# EXPECTED OUTPUT:
# - "Executing sub-step 1/3: Requirements Analysis"
# - "Sub-step 1 completed in 45.2s"
# - "Executing sub-step 2/3: Security Review"
# - "Sub-step 2 completed in 38.7s"
# - "Executing sub-step 3/3: Plan Synthesis"
# - "Sub-step 3 completed in 52.1s"
# - "All sub-steps completed. Aggregating outputs."
```

- [ ] Sub-steps execute in order (1, 2, 3)
- [ ] Each sub-step uses correct agent
- [ ] Outputs aggregate correctly
- [ ] Final step result includes all sub-step outputs

### Level 6: Output Equivalence Test

```bash
# Test 1: Hardcoded mode
# Disable template execution
curl -X PUT .../repositories/$REPO_ID/template-execution -d '{"use_template_execution": false}'
# Create work order
WO1=$(curl -X POST ... | jq -r '.agent_work_order_id')
# Wait for completion
sleep 180
# Get git diff
curl http://localhost:8053/api/agent-work-orders/$WO1 | jq '.git_commit_count, .git_files_changed'

# Test 2: Template mode (single agent)
# Enable template execution
curl -X PUT .../repositories/$REPO_ID/template-execution -d '{"use_template_execution": true}'
# Create work order with same user_request
WO2=$(curl -X POST ... | jq -r '.agent_work_order_id')
# Wait for completion
sleep 180
# Get git diff
curl http://localhost:8053/api/agent-work-orders/$WO2 | jq '.git_commit_count, .git_files_changed'

# Compare
echo "Hardcoded: $(curl ... WO1 ...)"
echo "Template: $(curl ... WO2 ...)"

# Expected: Similar commit counts, file changes, quality
```

- [ ] Both modes produce code
- [ ] Quality is comparable
- [ ] No regressions
- [ ] Template mode does NOT produce worse results

---

## COMPLETION CHECKLIST

- [ ] SubStepConfig and SubStepExecutionResult models created
- [ ] StepContext dataclass created
- [ ] ConfiguredRepository has use_template_execution flag
- [ ] Database migration for use_template_execution run
- [ ] TemplateResolver service implemented
- [ ] SubWorkflowOrchestrator service implemented
- [ ] WorkflowOrchestrator refactored with template/hardcoded branching
- [ ] Repository config API endpoint created
- [ ] Template resolution works (workflow → steps → agents)
- [ ] Single-agent steps execute correctly
- [ ] Multi-agent sub-workflows execute in order
- [ ] Sub-step output aggregation works
- [ ] GitHub operations remain hardcoded (create-branch, commit, create-pr)
- [ ] Flag toggle per repository works
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] Backward compatibility validated (hardcoded mode still works)
- [ ] Template mode validated (uses templates successfully)
- [ ] Sub-workflow test passed (3 sub-steps execute correctly)
- [ ] No ruff/mypy errors
- [ ] UI toggle implemented and functional

---

## Notes

**Core vs Setup Steps:**
- **Core steps** (planning, execute, review): Configurable with templates, support sub-workflows
- **Setup steps** (create-branch, commit, create-pr): Always hardcoded, no templates

**Sub-Workflow Limits:**
- Recommended max: 5 sub-steps per step
- Each sub-step has own timeout (default 3600s)
- Required sub-steps: Failure stops workflow
- Optional sub-steps: Failure logged, workflow continues

**Context Flow:**
- Each sub-step can access previous sub-step outputs
- Template variables: `{{sub_steps.0.output}}` for first sub-step output
- Context accumulates throughout sub-workflow

**Migration Strategy:**
- Phase 3A: Add flag, both modes coexist
- Phase 4+: Encourage template adoption
- Future: Deprecate hardcoded mode (but keep as fallback)

**Dependencies:**
- Requires Phase 1 (templates in database)
- Requires Phase 2 (UI to configure templates)
- Enables Phase 3B (orchestrator can use templates)
- Enables Phase 4 (HITL with template-based checkpoints)
- Enables Phase 5 (CLI adapters work with both modes)

**Performance Considerations:**
- Template resolution: < 100ms overhead
- Sub-workflow overhead: ~30s per sub-step (due to agent startup)
- Multi-agent planning with 3 sub-steps: ~2-3 minutes total

<!-- EOF -->
