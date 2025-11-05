# Agent Work Orders - Phase Summary & Quick Reference

**Last Updated**: 2025-01-05
**Status**: Planning Complete, Ready for Implementation
**Total Phases**: 6 (5 immediate + 1 deferred)
**Estimated Timeline**: 11.5-14.5 weeks

---

## Quick Reference

| Phase | Name | Duration | Risk | Breaking | Status | PRP File |
|-------|------|----------|------|----------|--------|----------|
| **1** | Template Storage | 1.5w | 🟢 Low | ❌ None | 🔴 Not Started | `story_phase1_template_system_backend.md` |
| **2** | Context Hub UI | 2w | 🟢 Low | ❌ None | 🔴 Not Started | `story_phase2_context_hub_frontend.md` |
| **3A** | Template Execution | 2.5w | 🟡 Med | ⚠️ Flag | 🔴 Not Started | `story_awo_template_execution_system.md` |
| **3B** | Orchestrator Agent | 2w | 🟢 Low | ❌ None | 🔴 Not Started | `story_phase3b_orchestrator_agent.md` |
| **4** | Human-in-Loop | 2w | 🟡 Med | ⚠️ Timing | 🔴 Not Started | `story_phase4_hitl_pause_resume.md` |
| **5** | CLI Adapters | 1.5w | 🟢 Low | ❌ None | 🔴 Not Started | `story_phase5_cli_adapter_system.md` |
| **6** | Parallel Execution | 3-4w | 🔴 High | ⚠️ Complex | ⚪ Deferred | *(Not yet created)* |

**Total**: 11.5 weeks (optimistic) | 14.5 weeks (conservative with buffer)

---

## Phase Dependency Chain

```
Phase 1 → Phase 2 → Phase 3A → Phase 3B → Phase 4 → Phase 5 → Phase 6
   ↓         ↓          ↓          ↓          ↓         ↓         ↓
Storage → UI → Execution → Chat → Pause → Multi-CLI → Parallel
```

**Critical Path**: Phase 3A (everything else depends on it)

**Parallelization Opportunities**:
- Phase 3B and Phase 4 can start simultaneously after Phase 3A
- Phase 5 only needs Phase 3A (independent of 3B and 4)

---

## One-Sentence Descriptions

### Phase 1: Template Storage
**What**: Store agent/step/workflow templates in database with versioning, sub-workflow support, and CRUD APIs.
**Why**: Foundation for all customization - must exist before UI or execution can use templates.
**Critical Validation**: Existing work orders MUST still use hardcoded .md files (templates are storage only).

### Phase 2: Context Hub UI
**What**: Build web interface for browsing, creating, editing templates with sub-workflow builder.
**Why**: Users need UI to manage templates before they can be executed in Phase 3A.
**Critical Validation**: Creating work orders via UI MUST still use hardcoded commands (UI is display only).

### Phase 3A: Template Execution System
**What**: Refactor orchestrator to execute workflows using templates with multi-agent sub-workflow support, flag-gated per repository.
**Why**: This is where templates become REAL - workflows actually use custom agents and sub-workflows instead of hardcoded .md files.
**Critical Validation**: Flag toggle works - default repositories use hardcoded, opt-in repositories use templates.

### Phase 3B: Orchestrator Agent
**What**: PydanticAI conversational agent with intelligent task analysis and template selection via natural language chat.
**Why**: Makes template system accessible - users can create work orders by chatting instead of filling forms.
**Critical Validation**: Orchestrator creates work orders that use template execution (not hardcoded).

### Phase 4: Human-in-the-Loop
**What**: Configurable pause checkpoints (pause_after flag in templates) with approve/revise/cancel decisions.
**Why**: Users need to review plans/code before proceeding - critical for production use.
**Critical Validation**: Workflows with pause_after=false still run end-to-end (backward compat with Phase 3A).

### Phase 5: CLI Adapter System
**What**: Generic adapter architecture supporting Claude, Gemini, Codex CLIs with provider switching per repository/agent.
**Why**: Flexibility - use best CLI for each task type, not locked into Claude.
**Critical Validation**: Default provider (Claude) works identically to pre-Phase 5 behavior.

### Phase 6: Parallel CLI Execution (Deferred)
**What**: Run multiple CLIs simultaneously (Claude AND Gemini), compare outputs, merge results or let user choose.
**Why**: Compare AI providers side-by-side, select best implementation, A/B testing.
**Decision**: Defer until Phases 1-5 stable - high complexity, resource intensive.

---

## Key Innovations

### 1. Multi-Agent Sub-Workflows
**Enabled By**: Phase 1 (storage), Phase 2 (builder), Phase 3A (execution)

```yaml
Planning Step:
  Sub-Step 1: Requirements Analyst analyzes user request
  Sub-Step 2: Security Expert reviews for vulnerabilities
  Sub-Step 3: Architect synthesizes implementation plan
Result: Comprehensive plan from 3 specialized perspectives
```

**Use Cases**:
- Complex features requiring multiple expertise areas
- Security-critical implementations (always include security expert)
- Full-stack features (frontend + backend + infrastructure experts)
- Code reviews (multiple reviewers with different focuses)

### 2. Template-Based Execution
**Enabled By**: Phase 3A

**Before (Hardcoded)**:
```python
# Reads: .claude/commands/agent-work-orders/planning.md
prompt = read_file(".claude/commands/planning.md")
```

**After (Template-Based)**:
```python
# Reads from database, resolves agents, renders with context
workflow = resolve_workflow_for_repository(repo_id)
step_config = workflow.steps.find(s => s.step_type == "planning")
prompt = render_prompt(step_config.prompt_template, context)
agents = resolve_agents_for_sub_steps(step_config.sub_steps)
```

**Benefits**:
- Customizable per repository
- Version-controlled changes
- Multi-agent collaboration
- No code changes to update prompts

### 3. Intelligent Orchestration
**Enabled By**: Phase 3B

**User**: "Add authentication to my API"

**Orchestrator**:
1. Analyzes task (backend, security-critical)
2. Recommends agents (Python Expert + Security Expert)
3. Suggests multi-agent planning workflow
4. Creates work order with recommended templates
5. Monitors progress
6. Notifies at checkpoints

**Benefits**:
- No manual template selection
- Task-appropriate agent recommendations
- Conversational UX (no forms)
- Intelligent defaults

### 4. Configurable HITL Checkpoints
**Enabled By**: Phase 4

**Workflow Template A** (High Oversight):
```yaml
Planning: pause_after=true
Execute: pause_after=true
Review: pause_after=true
Result: User approves at every step
```

**Workflow Template B** (Quick Fixes):
```yaml
Planning: pause_after=false
Execute: pause_after=false
Result: Runs end-to-end without pausing
```

**Benefits**:
- Flexible oversight (high for critical work, low for minor fixes)
- User controls when to review
- Prevents wasted work (catch issues early)

### 5. Provider Flexibility
**Enabled By**: Phase 5

**Repository Defaults**:
- Repo A (Python project): Claude CLI (best for Python)
- Repo B (Frontend project): Gemini CLI (test alternative)

**Agent Overrides**:
- Security Expert agent: Always uses Codex (specialized security analysis)

**Benefits**:
- Use best CLI for each task
- Easy to switch providers
- Compare providers over time
- Not locked into single vendor

---

## Critical Success Factors

### 1. Backward Compatibility (Every Phase)
**Rule**: Existing work orders MUST continue to work with hardcoded .md files until Phase 3A + flag enabled.

**Test (Run After Every Phase)**:
```bash
curl -X POST .../agent-work-orders/ -d '{"repository_url": "...", "user_request": "..."}'
curl -N .../logs/stream | grep "\.md"
# MUST see: "Loading command from: .claude/commands/agent-work-orders/planning.md"
```

### 2. Incremental Rollout (Phase 3A)
**Rule**: Template execution flag-gated per repository (use_template_execution).

**Test**:
```bash
# Default: use_template_execution=false → hardcoded
# Opt-in: use_template_execution=true → templates
```

### 3. No Breaking Changes (Phases 1, 2, 3B, 5)
**Rule**: These phases are additive only - zero impact on existing functionality.

**Test**: Create work order before phase → Create work order after phase → Identical behavior.

### 4. Controlled Breaking Changes (Phases 3A, 4)
**Rule**: Changes allowed but gated by configuration.

**Phase 3A**: Flag-gated per repository
**Phase 4**: Workflows without pause_after=true unaffected

---

## Testing Strategy

### Unit Tests (Every Phase)
- 80%+ code coverage
- Mock external dependencies
- Test edge cases and error handling
- Fast (< 5 seconds total)

### Integration Tests (Every Phase)
- API endpoints functional
- Services communicate correctly
- Database operations work
- Medium speed (< 30 seconds total)

### E2E Tests (After Each Phase)
- Full user journeys
- Real CLI execution (in test mode)
- Git operations
- Slow (2-5 minutes total)

### Backward Compatibility Tests (Every Phase - MANDATORY)
- Create work order via existing flow
- Verify hardcoded commands used
- Verify no template errors
- Verify workflow completes
- **If this fails, phase implementation has failed**

---

## Common Patterns

### Database Migration Pattern
```sql
-- Prefix: archon_
-- Indexes: Always add for foreign keys and frequently queried columns
-- Constraints: UNIQUE, NOT NULL, CHECK, FK with ON DELETE CASCADE
-- Comments: Document purpose of tables and complex columns
```

### Pydantic Model Pattern
```python
class EntityTemplate(BaseModel):
    id: str
    slug: str  # Unique, URL-safe identifier
    name: str
    description: str
    is_active: bool = True
    version: int = 1
    parent_template_id: str | None = None  # For versioning
    created_at: datetime
    updated_at: datetime
```

### Service Pattern
```python
class TemplateService:
    async def list_templates(self, filter_by=None) -> list[Template]:
        """List templates with optional filtering"""

    async def get_template(self, slug: str) -> Template:
        """Get single template by slug"""

    async def create_template(self, data: CreateRequest) -> Template:
        """Create new template (version 1)"""

    async def update_template(self, slug: str, updates: UpdateRequest) -> Template:
        """Update template (creates new version)"""
```

### API Route Pattern
```python
router = APIRouter()

@router.get("/templates/agents")
async def list_agent_templates() -> list[AgentTemplate]:
    service = TemplateService()
    return await service.list_templates()

@router.post("/templates/agents")
async def create_agent_template(data: CreateRequest) -> AgentTemplate:
    service = TemplateService()
    return await service.create_template(data)
```

### TanStack Query Hook Pattern
```typescript
export const templateKeys = {
  all: ["templates"] as const,
  agents: () => [...templateKeys.all, "agents"] as const,
  agentDetail: (slug: string) => [...templateKeys.agents(), slug] as const,
}

export function useAgentTemplates() {
  return useQuery({
    queryKey: templateKeys.agents(),
    queryFn: () => templateService.listAgentTemplates(),
    staleTime: STALE_TIMES.normal,
  })
}
```

---

## Validation Checklist (Copy for Each Phase)

```markdown
## Phase X Validation Checklist

### Pre-Implementation
- [ ] PRP reviewed and understood
- [ ] Dependencies confirmed (previous phases complete)
- [ ] Development environment ready

### During Implementation
- [ ] Following PRP tasks in order
- [ ] Running validation commands after each task
- [ ] Documenting blockers immediately
- [ ] Writing tests alongside implementation

### Syntax & Linting
- [ ] `uv run ruff check --fix` (backend)
- [ ] `uv run mypy` (backend)
- [ ] `npx tsc --noEmit` (frontend)
- [ ] `npm run biome:fix` (frontend)
- [ ] Zero errors

### Unit Tests
- [ ] All unit tests written
- [ ] All unit tests pass
- [ ] Code coverage > 80%

### Integration Tests
- [ ] All integration tests written
- [ ] All API endpoints working
- [ ] All integration tests pass

### Backward Compatibility (CRITICAL)
- [ ] Create work order via existing flow
- [ ] Logs show hardcoded .md files used
- [ ] No template errors in logs
- [ ] Workflow completes successfully
- [ ] Zero breaking changes

### Phase-Specific Validation
- [ ] (See individual PRP for specific tests)

### Post-Implementation
- [ ] All tasks complete
- [ ] All validation gates passed
- [ ] Documentation updated
- [ ] Git commit created
- [ ] Update IMPLEMENTATION_TRACKER.md status
- [ ] Ready for next phase
```

---

## Command Reference

### Start Services

```bash
# Backend services
docker compose --profile backend up -d

# Agent Work Orders service
cd python
uv run python -m uvicorn src.agent_work_orders.server:app --port 8053 --reload

# Frontend
cd archon-ui-main
npm run dev
```

### Run Tests

```bash
# Backend unit tests
uv run pytest python/tests/agent_work_orders/ -v

# Backend specific test file
uv run pytest python/tests/agent_work_orders/services/test_template_service.py -v

# Frontend unit tests
npm run test src/features/context-hub/

# Integration tests
uv run pytest python/tests/agent_work_orders/integration/ -v
```

### Linting & Type Checking

```bash
# Backend
uv run ruff check python/src/agent_work_orders/ --fix
uv run mypy python/src/agent_work_orders/
uv run ruff format python/src/agent_work_orders/

# Frontend
npx tsc --noEmit
npm run biome:fix
npx tsc --noEmit 2>&1 | grep "src/features/context-hub"
```

### Database Operations

```bash
# Run migration in Supabase SQL Editor
# Copy contents of migration/add_*.sql
# Paste in SQL Editor
# Execute

# Verify table created
SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'archon_%template%';

# Check data
SELECT COUNT(*) FROM archon_agent_templates;
SELECT * FROM archon_agent_templates LIMIT 5;
```

### API Testing

```bash
# List templates
curl http://localhost:8053/api/agent-work-orders/templates/agents | jq .

# Create template
curl -X POST http://localhost:8053/api/agent-work-orders/templates/agents \
  -H "Content-Type: application/json" \
  -d '{...}' | jq .

# Update template (creates version 2)
curl -X PUT http://localhost:8053/api/agent-work-orders/templates/agents/{slug} \
  -d '{...}' | jq .

# Get versions
curl http://localhost:8053/api/agent-work-orders/templates/agents/{slug}/versions | jq .
```

---

## Phase Milestones

### Phase 1 Complete When:
- [ ] Templates stored in database
- [ ] APIs return seeded templates
- [ ] Versioning creates version 2 on update
- [ ] **Work orders still use hardcoded .md files**

### Phase 2 Complete When:
- [ ] Can browse templates in Context Hub UI
- [ ] Can create agent templates via form
- [ ] Can build sub-workflows with SubStepBuilder
- [ ] Can configure repository preferences
- [ ] **Work orders still use hardcoded .md files**

### Phase 3A Complete When:
- [ ] Flag toggle per repository works
- [ ] Template execution produces successful work orders
- [ ] Sub-workflows execute with multiple agents
- [ ] **Hardcoded mode still works (default)**
- [ ] **Template mode works (opt-in)**

### Phase 3B Complete When:
- [ ] Can chat with orchestrator
- [ ] Task analysis recommends correct agents
- [ ] Work orders created via chat use templates
- [ ] Multi-turn conversations work

### Phase 4 Complete When:
- [ ] Workflows pause at configured checkpoints
- [ ] User can approve/revise/cancel
- [ ] Revise re-runs step with feedback
- [ ] **Workflows without pause_after=true still run end-to-end**

### Phase 5 Complete When:
- [ ] Can switch between Claude/Gemini per repository
- [ ] Both CLIs produce normalized events
- [ ] Agent template preferences override repository defaults
- [ ] **Claude (default) works identically to pre-Phase 5**

---

## Core Architectural Concepts

### Template Hierarchy

```
WorkflowTemplate (e.g., "Advanced Backend Workflow")
    ↓
StepConfig (e.g., Planning step with multi-agent flag)
    ↓
StepTemplate (e.g., "Multi-Agent Planning")
    ↓
SubStepConfig[] (e.g., 3 sub-steps)
    ↓
AgentTemplate (e.g., "Python Expert", "Security Expert", "Architect")
```

### Core Steps vs Setup Steps

**Core Steps** (Configurable with templates):
- **Planning**: Requirements → Design → Plan
- **Execute**: Implementation → Testing → Documentation
- **Review**: Code review → Security audit → Approval

**Setup Steps** (Always hardcoded):
- **create-branch**: Git branch/worktree creation
- **commit**: Git staging and commit
- **create-pr**: GitHub PR creation

**Rationale**: Core steps need AI intelligence and customization. Setup steps are mechanical git/GitHub operations.

### Sub-Workflow Execution Flow

```
1. Template Resolution
   ↓
2. Check sub_steps array
   ↓
3. If empty → Single-agent execution
   ↓
4. If populated → Multi-agent sub-workflow:
   ↓
   a. Execute sub-step 1 (agent A)
   b. Pass output to sub-step 2 (agent B)
   c. Pass outputs 1+2 to sub-step 3 (agent C)
   d. Aggregate all outputs
   ↓
5. Return combined result
```

### CLI Adapter Flow

```
1. Get provider preference (Agent > Repository > Default)
   ↓
2. Adapter factory creates adapter instance
   ↓
3. Adapter executes CLI command
   ↓
4. Adapter parses stream-json output
   ↓
5. Adapter normalizes to CLIEvent
   ↓
6. Events consumed by orchestrator
```

---

## Decision Log

### Why Phase 3A is Critical Path?
All subsequent phases depend on template execution working:
- Phase 3B orchestrator needs templates to be used
- Phase 4 HITL needs template-based checkpoints
- Phase 5 CLI adapters work with template execution

### Why CLI Adapters are Last (Phase 5)?
- Least critical for core functionality
- No dependencies from other phases
- Adds flexibility but doesn't enable new features
- Can be skipped if only using Claude

### Why Defer Parallel Execution (Phase 6)?
- High complexity (parallel worktrees, result comparison, merging)
- Resource intensive (2x API calls, 2x execution time)
- Unclear user demand (prove value with Phase 5 first)
- Phases 1-5 provide 90% of value

### Why Polling for HITL Instead of WebSocket?
- Simpler implementation (REST vs WebSocket)
- Faster to market (Phase 4A)
- Proven pattern (existing SSE logs use polling)
- Can upgrade to WebSocket later (Phase 4B) without breaking changes

### Why Separate Phase 3A from Phase 2?
- Phase 2 is UI-heavy (frontend work)
- Phase 3A is orchestrator-heavy (backend work)
- Different skill sets required
- Can be developed by different team members simultaneously

---

## Migration from Hardcoded to Templates

### Current State (Before Phase 1)
```
Work Order Created
    ↓
Read: .claude/commands/agent-work-orders/planning.md
    ↓
Execute: Claude CLI with hardcoded prompt
    ↓
Read: .claude/commands/agent-work-orders/execute.md
    ↓
Execute: Claude CLI with hardcoded prompt
    ↓
Complete
```

### After Phase 1-2 (Templates Stored, UI Built)
```
Work Order Created
    ↓
Still reads: .claude/commands/agent-work-orders/planning.md
    ↓
Still executes: Claude CLI with hardcoded prompt
    ↓
Complete

(Templates exist in DB but not used)
```

### After Phase 3A (Template Execution - Flag Disabled)
```
Work Order Created (repository.use_template_execution=false)
    ↓
Read: .claude/commands/agent-work-orders/planning.md
    ↓
Execute: Claude CLI with hardcoded prompt
    ↓
Complete

(Same as before - backward compatible)
```

### After Phase 3A (Template Execution - Flag Enabled)
```
Work Order Created (repository.use_template_execution=true)
    ↓
Resolve: workflow_template = "advanced-dev"
    ↓
Resolve: step_template = "multi-agent-planning"
    ↓
Resolve: sub_steps = [Requirements Analyst, Security Expert, Architect]
    ↓
Execute: Sub-step 1 with agent A
Execute: Sub-step 2 with agent B
Execute: Sub-step 3 with agent C
    ↓
Aggregate: Combined plan from all 3 agents
    ↓
Continue workflow...
    ↓
Complete

(NEW behavior - templates used)
```

### After Phase 5 (CLI Adapters)
```
Work Order Created (repository.use_template_execution=true, repository.preferred_cli="gemini")
    ↓
Resolve: workflow_template
    ↓
Resolve: sub_steps with different CLI per agent
    ↓
Execute: Sub-step 1 with Gemini CLI (agent prefers Gemini)
Execute: Sub-step 2 with Claude CLI (agent prefers Claude)
Execute: Sub-step 3 with Gemini CLI (repository default)
    ↓
Aggregate: Results (CLI-independent)
    ↓
Complete
```

---

## Risk Mitigation Strategies

### Phase 1 Risk: Template Storage Complexity
**Mitigation**:
- Follow existing patterns (project_service.py)
- Comprehensive unit tests for versioning
- Seed templates before testing APIs

### Phase 2 Risk: UI Complexity (Sub-Workflow Builder)
**Mitigation**:
- Start with simple up/down buttons (defer drag-drop)
- Limit to 5 sub-steps max (show warning if exceeded)
- Extensive form validation
- Mock backend services in tests

### Phase 3A Risk: Breaking Existing Workflows
**Mitigation**:
- Flag-gated rollout (default: false)
- Extensive backward compatibility testing
- Keep hardcoded mode as permanent fallback
- Gradual migration (one repository at a time)

### Phase 4 Risk: Workflow Hangs on Pause
**Mitigation**:
- Timeout after 24 hours (auto-cancel)
- Admin override API endpoint
- Clear UI indicators (user knows workflow is paused)
- Resume events properly cleaned up

### Phase 5 Risk: CLI Output Format Changes
**Mitigation**:
- Version pin CLI tools in documentation
- Adapter versioning (ClaudeAdapterV1, ClaudeAdapterV2)
- Graceful degradation (fallback to Claude if other CLI fails)
- Extensive error handling in parsers

---

## Success Metrics

### Quantitative Metrics
- [ ] 100% of existing work orders still work after each phase
- [ ] < 5% failure rate in template-based work orders
- [ ] Template resolution time < 100ms
- [ ] Sub-workflow overhead < 30s per sub-step
- [ ] API response time < 500ms for template CRUD
- [ ] UI load time < 2 seconds for Context Hub

### Qualitative Metrics
- [ ] Users can create custom agents without code changes
- [ ] Multi-agent workflows produce higher quality output than single-agent
- [ ] Orchestrator recommendations are helpful and accurate
- [ ] HITL checkpoints prevent wasted work (catch issues early)
- [ ] CLI switching works seamlessly (no user-visible differences)

### User Acceptance Criteria
- [ ] Non-technical users can build workflows via UI
- [ ] Developers can create specialized agents for their tech stack
- [ ] Chat interface reduces time to create work orders (< 1 minute)
- [ ] Pause/resume gives confidence in AI work (review before proceeding)
- [ ] Zero confusion about which templates are active

---

## Phase Readiness Checklist

### Ready to Start Phase 1 When:
- [x] All PRPs reviewed and approved
- [x] Implementation tracker created
- [x] Development environment set up
- [x] Supabase project ready

### Ready to Start Phase 2 When:
- [ ] Phase 1 complete (all validation gates passed)
- [ ] Template APIs functional
- [ ] Seed data loaded

### Ready to Start Phase 3A When:
- [ ] Phase 1 complete
- [ ] Phase 2 complete (UI to configure templates)
- [ ] Team understands sub-workflow design

### Ready to Start Phase 3B When:
- [ ] Phase 3A complete (template execution working)
- [ ] PydanticAI library understood
- [ ] Model configuration working

### Ready to Start Phase 4 When:
- [ ] Phase 3A complete (checkpoint configuration in templates)
- [ ] asyncio.Event pattern understood

### Ready to Start Phase 5 When:
- [ ] Phase 3A complete (template execution stable)
- [ ] Multiple CLI tools installed and tested

### Ready to Consider Phase 6 When:
- [ ] Phase 5 stable for 4+ weeks
- [ ] User demand for parallel execution validated
- [ ] Resource/cost implications understood

---

## Quick Reference: File Locations

### Phase 1 (Backend)
- Migrations: `migration/add_*_template*.sql`
- Models: `python/src/agent_work_orders/models.py`
- Services: `python/src/agent_work_orders/services/template_service.py`
- API: `python/src/agent_work_orders/api/template_routes.py`
- Tests: `python/tests/agent_work_orders/services/test_template_service.py`

### Phase 2 (Frontend)
- Types: `archon-ui-main/src/features/context-hub/types/index.ts`
- Services: `archon-ui-main/src/features/context-hub/services/`
- Components: `archon-ui-main/src/features/context-hub/components/`
- Views: `archon-ui-main/src/features/context-hub/views/`
- Page: `archon-ui-main/src/pages/ContextHubPage.tsx`

### Phase 3A (Template Execution)
- Resolver: `python/src/agent_work_orders/services/template_resolver.py`
- Sub-workflow: `python/src/agent_work_orders/services/sub_workflow_orchestrator.py`
- Orchestrator: `python/src/agent_work_orders/workflow_engine/workflow_orchestrator.py`
- Tests: `python/tests/agent_work_orders/integration/test_template_execution_mode.py`

### Phase 3B (Orchestrator)
- Agent: `python/src/agents/orchestrator/agent.py`
- Tools: `python/src/agents/orchestrator/tools.py`
- Service: `python/src/agents/orchestrator/service.py`
- API: `python/src/server/api_routes/orchestrator_api.py`
- Frontend: `archon-ui-main/src/features/orchestrator-chat/`

### Phase 4 (HITL)
- Service: `python/src/agent_work_orders/services/pause_service.py`
- API: `python/src/agent_work_orders/api/pause_routes.py`
- Component: `archon-ui-main/src/features/agent-work-orders/components/PauseStateCard.tsx`
- Hook: `archon-ui-main/src/features/agent-work-orders/hooks/usePauseQueries.ts`

### Phase 5 (CLI Adapters)
- Base: `python/src/agent_work_orders/cli_adapters/base.py`
- Claude: `python/src/agent_work_orders/cli_adapters/claude_adapter.py`
- Gemini: `python/src/agent_work_orders/cli_adapters/gemini_adapter.py`
- Factory: `python/src/agent_work_orders/cli_adapters/factory.py`
- Tests: `python/tests/agent_work_orders/cli_adapters/`

---

## Troubleshooting

### "Templates stored but work orders still use .md files"
**Expected in**: Phase 1, Phase 2
**Resolution**: This is correct! Templates not used until Phase 3A + flag enabled.

### "Template execution errors after Phase 3A"
**Check**:
1. Is use_template_execution flag enabled for repository?
2. Does workflow template exist in database?
3. Do all step templates referenced exist?
4. Do all agent templates referenced exist?
5. Check logs for specific error

### "Sub-workflow not executing"
**Check**:
1. Is use_template_execution=true?
2. Does step template have sub_steps array populated?
3. Are all agent_template_slugs valid?
4. Check sub_workflow_orchestrator logs

### "Orchestrator not responding"
**Check**:
1. Is Phase 3A complete (template execution working)?
2. Is model configured in Archon settings?
3. Is API key valid?
4. Check orchestrator service logs

### "Workflow not pausing"
**Check**:
1. Is Phase 4 implemented?
2. Does workflow template have pause_after=true?
3. Is pause_service initialized in orchestrator?
4. Check pause state table

### "CLI adapter not found"
**Check**:
1. Is CLI installed? `which claude` or `which gemini`
2. Is CLAUDE_CLI_PATH or GEMINI_CLI_PATH set?
3. Check adapter factory registry
4. Fallback should use Claude

---

## Next Steps

1. **Review All Documents**:
   - Read `IMPLEMENTATION_TRACKER.md` in full
   - Review `PHASE_DEPENDENCY_DIAGRAM.md` for visual understanding
   - Skim all 6 PRP files to understand scope

2. **Prepare Development Environment**:
   - Ensure Supabase project is ready
   - Install all CLI tools (Claude CLI required, Gemini CLI optional)
   - Set up test repository for validation

3. **Begin Phase 1**:
   - Start with database migrations
   - Follow PRP task list in order
   - Run validation commands after each task
   - Update IMPLEMENTATION_TRACKER.md after each completed task

4. **Maintain Discipline**:
   - Do not skip validation gates
   - Do not move to next phase until current phase 100% complete
   - Do not skip backward compatibility tests
   - Do not merge breaking changes

---

**Ready to begin implementation?** Start with Phase 1: `story_phase1_template_system_backend.md`

**Questions?** Refer to `IMPLEMENTATION_TRACKER.md` for detailed checklists and validation criteria.

**Track Progress**: Update `IMPLEMENTATION_TRACKER.md` after each task completion.

<!-- EOF -->
