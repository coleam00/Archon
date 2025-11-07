# Agent Work Orders - Phase Summary & Quick Reference

**Last Updated**: 2025-01-05
**Status**: Architecture Finalized, Ready for Implementation
**Total Phases**: 7 (6 implementation + 1 deferred)

---

## Quick Reference

| Phase | Name | Risk | Breaking | Status | PRP File |
|-------|------|------|----------|--------|----------|
| **0** | Database Setup | 🟢 Low | ❌ None | 🟢 Complete | `story_phase0_database_setup.md` |
| **1** | Context Hub | 🟢 Low | ❌ None | 🟢 Complete | `story_phase1_context_hub.md` |
| **2** | AWO Foundation | 🟢 Low | ❌ None | 🔴 Not Started | `story_phase2_awo_foundation.md` |
| **3** | AWO Execution | 🟡 Med | ⚠️ Flag | 🔴 Not Started | `story_phase3_awo_execution.md` |
| **4** | Orchestrator | 🟢 Low | ❌ None | 🔴 Not Started | `story_phase4_orchestrator.md` |
| **5** | HITL | 🟡 Med | ⚠️ Timing | 🔴 Not Started | `story_phase5_hitl.md` |
| **6** | CLI Adapters | 🟢 Low | ❌ None | 🔴 Not Started | `story_phase6_cli_adapters.md` |
| **7** | Parallel Exec | 🔴 High | ⚠️ Complex | ⚪ Deferred | *(Not yet created)* |

---

## Phase Dependency Chain

```
Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7
   ↓         ↓          ↓          ↓          ↓         ↓         ↓         ↓
 Setup → Context → AWO Link → Execution → Chat → Pause → Multi-CLI → Parallel
```

**Critical Path**: Phase 3 (all automation depends on it)

**Parallelization Opportunities**:
- Phase 4 and Phase 5 can start after Phase 3 (independent)
- Phase 6 only needs Phase 3 (independent of 4 and 5)

---

## One-Sentence Descriptions

### Phase 0: Database Setup
**What**: SQL migrations for Context Hub (core) and AWO (optional) with seed data.
**Why**: Foundation for all data storage - templates, workflows, coding standards, repositories, work orders.
**Critical Validation**: Migrations run successfully, seed data loads, all tables indexed correctly.

### Phase 1: Context Hub
**What**: Backend APIs + Frontend UI for managing templates, workflows, agents, and coding standards.
**Why**: Users need UI to create/edit templates before they can be used by AWO or MCP server.
**Critical Validation**: Workflow validation enforces required step types (planning, implement, validate).

### Phase 2: AWO Foundation
**What**: Link repositories to Context Hub templates with customizations (priming context, coding standards, agent overrides).
**Why**: Repository-specific configurations without modifying generic templates.
**Critical Validation**: Template → repository linking works, overrides don't affect templates, step selection documented.

### Phase 3: AWO Execution
**What**: Execute workflows using Context Hub templates + repository overrides, with sub-workflow support, flag-gated per repo.
**Why**: This is where templates become REAL - workflows execute using custom agents and sub-workflows.
**Critical Validation**: Hardcoded mode (default) still works, template mode executes correctly, sub-workflows work.

### Phase 4: Orchestrator Agent
**What**: PydanticAI conversational agent with intelligent workflow/agent selection via natural language chat.
**Why**: Makes template system accessible - users create work orders by chatting instead of filling forms.
**Critical Validation**: Task analysis recommends correct agents, work orders created via chat execute successfully.

### Phase 5: Human-in-the-Loop
**What**: Configurable pause checkpoints (`pause_after` flag in templates) with approve/revise/cancel decisions.
**Why**: Users need to review plans/code before proceeding - critical for production use.
**Critical Validation**: Workflows without pause_after still run end-to-end (backward compat).

### Phase 6: Multi-CLI Support
**What**: Generic adapter architecture supporting Claude, Gemini, Codex CLIs with provider switching.
**Why**: Flexibility - use best CLI for each task type, not locked into Claude.
**Critical Validation**: Default provider (Claude) works identically to pre-Phase 6 behavior.

### Phase 7: Parallel Execution (Deferred)
**What**: Run multiple CLIs simultaneously, compare outputs, merge results or let user choose.
**Why**: Compare AI providers side-by-side, A/B testing, select best implementation.
**Decision**: Defer until Phases 0-6 stable - high complexity, resource intensive.

---

## Key Architectural Concepts

### Context Hub vs Agent Work Orders

**Context Hub** (Core Archon Feature):
- **Storage:** `complete_setup.sql` (core database)
- **Purpose:** Template library accessible by MCP server
- **Usage:** Manual (IDE agents query MCP → download → create `.claude/commands/`)
- **Tables:** agent_templates, step_templates, workflow_templates, coding_standards

**Agent Work Orders** (Optional Automation):
- **Storage:** `agent_work_orders_complete.sql` (optional database)
- **Purpose:** Automated workflow execution using Context Hub templates
- **Usage:** Autonomous (git ops, commits, PRs, template execution)
- **Tables:** configured_repositories, repository_agent_overrides, agent_work_orders

### Template → Instance Pattern

**Templates** (Context Hub):
- Generic, reusable definitions
- Shared across all repositories
- Updated via Context Hub UI

**Instances** (Repository-Specific):
- Based on templates with customizations
- Priming context (file paths, architecture)
- Coding standards (TypeScript, Ruff, pytest)
- Agent tool overrides
- Changes don't affect templates

**Example:**
```
Template: "Python Backend Expert" (generic)
    ↓ Apply to Repository
Instance: "Python Backend Expert" (my-nextjs-app)
  + Priming: "Backend is in /services/api/src"
  + Coding Standards: [TypeScript, Ruff]
  + Tool Override: Add "Bash" to tools list
```

### Step Type System

**Step Types** (Enum):
- `'planning'` - Requirements analysis, design (≥1 required)
- `'implement'` - Code changes, features (≥1 required)
- `'validate'` - Testing, review, verification (≥1 required)
- `'prime'` - Context loading, repo priming (optional)
- `'git'` - Git operations: create-branch, commit, create-pr (optional)

**Workflow Validation:**
- Every workflow MUST have ≥1 planning, implement, validate step
- Can have multiple of each type
- Can have optional prime/git steps

### Sub-Workflow Architecture

**Single-Agent Step:**
```
Step: "Planning"
Agent: Python Backend Expert
Prompt: "Create implementation plan..."
```

**Multi-Agent Sub-Workflow:**
```
Step: "Planning"
  Sub-Step 1 (order: 1):
    Agent: Requirements Analyst
    Prompt: "Analyze requirements for: {{user_request}}"
  Sub-Step 2 (order: 2):
    Agent: Security Expert
    Prompt: "Review security of: {{sub_steps.0.output}}"
  Sub-Step 3 (order: 3):
    Agent: Architect
    Prompt: "Synthesize plan from: {{sub_steps.0.output}}, {{sub_steps.1.output}}"
```

**Result:** Comprehensive plan from multiple specialized perspectives.

### Coding Standards System

**Coding Standards Library** (Context Hub):
- Reusable standards for different languages/tools
- Examples: "TypeScript Strict", "Python Ruff", "React Best Practices"
- Stored as JSONB: linter config, rules, min coverage, etc.

**Assignment to Repositories:**
- Repository can have multiple coding standards
- Standards applied during validation steps
- Repository-specific, not per-workflow

**Example:**
```sql
-- Create coding standard
INSERT INTO archon_coding_standards (
  slug = 'typescript-strict',
  language = 'typescript',
  standards = {
    "linter": "tsc",
    "strict": true,
    "rules": ["no-any", "no-implicit-any"]
  }
);

-- Assign to repository
UPDATE archon_configured_repositories
SET coding_standard_ids = ['typescript-strict-uuid', 'ruff-uuid']
WHERE id = 'my-repo-uuid';
```

---

## Critical Success Factors

### 1. Backward Compatibility (Every Phase)
**Rule**: Existing work orders MUST continue working with hardcoded .md files until Phase 3 + flag enabled.

**Test (Run After Every Phase):**
```bash
curl -X POST .../agent-work-orders/ -d '{"repository_url": "...", "user_request": "..."}'
curl -N .../logs/stream | grep "\.md"
# MUST see: "Loading command from: .claude/commands/agent-work-orders/planning.md"
```

### 2. Incremental Rollout (Phase 3)
**Rule**: Template execution flag-gated per repository (`use_template_execution`).

**Test:**
```bash
# Default: use_template_execution=false → hardcoded
# Opt-in: use_template_execution=true → templates
```

### 3. No Breaking Changes (Phases 0, 1, 2, 4, 6)
**Rule**: These phases are additive only - zero impact on existing functionality.

**Test:** Create work order before phase → Create work order after phase → Identical behavior.

### 4. Controlled Breaking Changes (Phases 3, 5)
**Rule**: Changes allowed but gated by configuration.

**Phase 3**: Flag-gated per repository
**Phase 5**: Workflows without pause_after unaffected

---

## Common Patterns

### Database Migration Pattern
```sql
-- Core Archon (complete_setup.sql)
CREATE TABLE archon_agent_templates (...);
CREATE TABLE archon_step_templates (
  ...,
  step_type workflow_step_type NOT NULL -- Enum
);

-- Agent Work Orders (agent_work_orders_complete.sql)
CREATE TABLE archon_configured_repositories (
  ...,
  workflow_template_id UUID FK NULL,
  coding_standard_ids UUID[] DEFAULT '{}',
  priming_context JSONB DEFAULT '{}'
);
```

### Pydantic Model Pattern
```python
class AgentTemplate(BaseModel):
    id: str
    slug: str  # Unique identifier
    name: str
    system_prompt: str
    tools: list[str] = []  # Default tools
    standards: dict[str, Any] = {}  # Default standards
    is_active: bool = True
```

### Service Pattern
```python
class TemplateService:
    async def list_templates(self, filter_by=None) -> list[Template]:
        """List templates with optional filtering"""

    async def get_template(self, slug: str) -> Template | None:
        """Get single template by slug"""

    async def create_template(self, data: CreateRequest) -> Template:
        """Create new template"""

    async def update_template(self, slug: str, updates: UpdateRequest) -> Template:
        """Update template"""
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

## Example User Flow

### Scenario A: Manual IDE Agent Usage (Context Hub Only)
1. User creates "Fullstack Dev Workflow" in Context Hub
2. Template defines: Plan → Backend Implement → Frontend Implement → Validate
3. User's Claude Code queries MCP server: "Give me Fullstack Dev Workflow"
4. MCP returns template definitions
5. Claude Code creates `.claude/commands/planning.md`, etc.
6. User manually runs commands in IDE

### Scenario B: Automated Agent Work Orders
1. User creates "Fullstack Dev Workflow" in Context Hub (same as above)
2. User goes to AWO page → "Apply template to repository"
3. User customizes:
   - Priming: "Frontend: apps/web/src, Backend: services/api/src"
   - Coding Standards: [TypeScript Strict, Ruff]
   - Agent Override: Add "Bash" to Python Expert tools
4. User creates work order: "Add authentication feature"
5. AWO automatically:
   - Creates branch
   - Runs Plan (uses repo-specific priming)
   - Runs Backend Implement (knows backend is in /services/api)
   - Runs Frontend Implement (knows frontend is in /apps/web)
   - Runs Validate (applies TypeScript + Ruff standards)
   - Creates commit + PR

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
- [ ] Logs show hardcoded .md files used (if applicable)
- [ ] No template errors
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
uv run python -m uvicorn src.agent_work_orders.server:app --port 8053 --reload

# Frontend
cd archon-ui-main && npm run dev
```

### Run Tests
```bash
# Backend
uv run pytest tests/agent_work_orders/ -v

# Frontend
npm run test src/features/context-hub/
```

### Linting
```bash
# Backend
uv run ruff check src/agent_work_orders/ --fix
uv run mypy src/agent_work_orders/

# Frontend
npx tsc --noEmit
npm run biome:fix
```

### Database
```bash
# Run migrations in Supabase SQL Editor
# 1. Run complete_setup.sql
# 2. Run agent_work_orders_complete.sql

# Verify tables
SELECT table_name FROM information_schema.tables
WHERE table_name LIKE 'archon_%template%' OR table_name LIKE 'archon_%work%order%';

# Check seed data
SELECT COUNT(*) FROM archon_agent_templates;
SELECT COUNT(*) FROM archon_step_templates;
SELECT COUNT(*) FROM archon_workflow_templates;
SELECT COUNT(*) FROM archon_coding_standards;
```

---

## Phase Milestones

### Phase 0 Complete When:
- [ ] All migration files created
- [ ] Migrations run successfully in Supabase
- [ ] Seed data loaded
- [ ] All tables verified

### Phase 1 Complete When:
- [ ] Can create templates in Context Hub UI
- [ ] Workflow validation enforces required step types
- [ ] APIs return created templates
- [ ] TypeScript compiles with zero errors

### Phase 2 Complete When:
- [ ] Can apply template to repository
- [ ] Can customize priming context
- [ ] Can assign coding standards
- [ ] Can override agent tools per repo
- [ ] Step selection documented

### Phase 3 Complete When:
- [ ] Hardcoded mode still works (default)
- [ ] Template mode works (opt-in)
- [ ] Sub-workflows execute correctly
- [ ] Repository overrides applied

### Phase 4 Complete When:
- [ ] Can chat with orchestrator
- [ ] Task analysis recommends correct agents
- [ ] Work orders created via chat execute

### Phase 5 Complete When:
- [ ] Workflows pause at configured checkpoints
- [ ] User can approve/revise/cancel
- [ ] Workflows without pause_after run end-to-end

### Phase 6 Complete When:
- [ ] Can switch between Claude/Gemini
- [ ] Event normalization works
- [ ] Claude (default) works identically to pre-Phase 6

---

## Decision Log

### Why Phase 0 is Setup Only?
**Reason:** Separates pure database work from code implementation, allows user to verify schema before coding.

### Why Combine Backend + Frontend in Phase 1?
**Reason:** Context Hub is not complex enough to split, and UI depends on backend APIs immediately.

### Why Coding Standards Separate from Workflows?
**Reason:** More flexible - can mix and match standards without duplicating workflow definitions.

### Why Agent Overrides at Repository Level, Not Work Order Level?
**Reason:** Overrides are repository characteristics (tools needed for this codebase), not work order characteristics.

### Why Defer MCP Server Until After Phase 6?
**Reason:** Templates must exist and be stable before exposing via MCP. Focus on core functionality first.

### Why Defer Parallel Execution (Phase 7)?
**Reason:** High complexity, resource intensive, unclear user demand. Prove value with Phases 0-6 first.

---

## Success Metrics

### Quantitative
- [ ] 100% of existing work orders still work after each phase
- [ ] Template resolution time < 100ms
- [ ] Sub-workflow overhead < 30s per sub-step
- [ ] API response time < 500ms for template CRUD
- [ ] UI load time < 2 seconds for Context Hub

### Qualitative
- [ ] Users can create custom templates without code changes
- [ ] Multi-agent workflows produce higher quality output
- [ ] Orchestrator recommendations are helpful
- [ ] HITL checkpoints prevent wasted work
- [ ] CLI switching works seamlessly

---

## Next Steps

**Ready to Begin Phase 0:**
1. Review database schema in `story_phase0_database_setup.md`
2. Create migration files
3. Run migrations in Supabase
4. Verify seed data
5. Update IMPLEMENTATION_TRACKER.md

**Track Progress:** Update `IMPLEMENTATION_TRACKER.md` after each task completion.

**Questions?** Refer to individual phase PRPs for detailed implementation guides.

<!-- EOF -->
