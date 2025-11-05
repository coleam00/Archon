---
name: "Phase 2: AWO Context Engineering Hub - Frontend"
description: "Template management UI for agent, step, and workflow template configuration with sub-workflow builder"
phase: 2
dependencies: ["Phase 1"]
breaking_changes: false
---

## Original Story

```
Build a Context Engineering Hub feature that provides a user interface for managing:
1. Agent Template Library - Browse, create, edit agent definitions
2. Step Template Library - Browse, create, edit workflow step prompts with sub-workflow builder
3. Workflow Builder - Visual workflow composition tool
4. Repository Configuration - Assign agents and workflows per repository

Current limitation: Templates stored in database (Phase 1) but no UI for template management. Users cannot view, customize, or configure agents/workflows.

Goal: Enable users to define and manage custom agent prompts, multi-agent sub-workflows, and repository-specific configurations through an intuitive web interface following Archon's UI standards (Tron glassmorphism, Radix UI, TanStack Query).
```

## Story Metadata

**Story Type**: Feature
**Estimated Complexity**: High
**Primary Systems Affected**:
- Frontend: New feature directory `src/features/context-hub/`
- Frontend: New pages and routes
- Frontend: Integration with template APIs from Phase 1

**Phase Number**: 2
**Dependencies**: Phase 1 (Template APIs must exist)
**Breaking Changes**: ❌ None (UI only - templates still not executed)

---

## CRITICAL: Templates Are Display Only

**What This Phase Does**:
- Creates UI for browsing agent/step/workflow templates
- Enables creating/editing templates via forms
- Shows template version history
- Builds sub-workflow configuration interface
- Configures repository preferences

**What This Phase Does NOT Do**:
- Execute workflows using templates (that's Phase 3A)
- Change work order execution behavior
- Replace hardcoded .md files
- Make templates "active" in workflow execution

**Validation**: After this phase, creating a work order **must still** use hardcoded commands. Context Hub is informational/configuration only.

---

## CONTEXT REFERENCES

### Analysis Documents

- `PRPs/ai_docs/orchestrator_analysis/FrontendAnalysis.md` - Section 2: "Context Engineering Hub" component designs
- `PRPs/ai_docs/UI_STANDARDS.md` - Tron glassmorphism, Radix UI requirements, responsive design patterns
- `PRPs/IMPLEMENTATION_TRACKER.md` - Phase 2 checklist and validation gates
- `PRPs/PHASE_DEPENDENCY_DIAGRAM.md` - Visual phase flow

### Frontend Patterns

- `archon-ui-main/src/features/projects/` - Feature structure (components, hooks, services, types, views)
- `archon-ui-main/src/features/projects/views/ProjectsView.tsx` - List/grid view pattern
- `archon-ui-main/src/features/projects/components/NewProjectModal.tsx` - Modal pattern with Radix Dialog
- `archon-ui-main/src/features/projects/hooks/useProjectQueries.ts` - TanStack Query hooks and keys pattern
- `archon-ui-main/src/features/projects/services/projectService.ts` - API service pattern

### UI Primitives

- `archon-ui-main/src/features/ui/primitives/dialog.tsx` - Radix Dialog for modals
- `archon-ui-main/src/features/ui/primitives/tabs.tsx` - Radix Tabs for navigation
- `archon-ui-main/src/features/ui/primitives/select.tsx` - Radix Select for dropdowns
- `archon-ui-main/src/features/ui/primitives/collapsible.tsx` - Radix Collapsible for expandable sections

### Shared Utilities

- `archon-ui-main/src/features/shared/config/queryPatterns.ts` - STALE_TIMES, DISABLED_QUERY_KEY
- `archon-ui-main/src/features/shared/api/apiClient.ts` - API client configuration
- `archon-ui-main/src/features/ui/components/ToastProvider.tsx` - Toast notifications

### Routing

- `archon-ui-main/src/App.tsx` - Route registration pattern
- `archon-ui-main/src/pages/` - Page component pattern

---

## Sub-Workflow Builder Design

The UI must support building sophisticated multi-agent sub-workflows:

### Single-Agent Step (Simple Mode)
```typescript
{
  stepType: "planning",
  agentTemplateSlug: "python-backend-expert",
  promptTemplate: "Create plan for: {{user_request}}",
  subSteps: []  // Empty = single agent
}
```

**UI**: Single agent selector, single prompt textarea

### Multi-Agent Step (Advanced Mode)
```typescript
{
  stepType: "planning",
  agentTemplateSlug: null,  // Not used in multi-agent mode
  subSteps: [
    {
      order: 1,
      name: "Requirements Analysis",
      agentTemplateSlug: "product-analyst",
      promptTemplate: "Analyze: {{user_request}}",
      required: true
    },
    {
      order: 2,
      name: "Security Review",
      agentTemplateSlug: "security-expert",
      promptTemplate: "Review: {{sub_steps.0.output}}",
      required: true
    }
  ]
}
```

**UI**: Sub-step builder with add/remove/reorder controls

---

## IMPLEMENTATION TASKS

### CREATE archon-ui-main/src/features/context-hub/types/index.ts:

- DEFINE: AgentTemplate interface (mirror Phase 1 backend)
- DEFINE: StepTemplate interface (with subSteps: SubStepConfig[])
- DEFINE: SubStepConfig interface (order, name, agentTemplateSlug, promptTemplate, required)
- DEFINE: WorkflowTemplate interface
- DEFINE: RepositoryAgentConfig interface
- MIRROR: Backend Pydantic models from python/src/agent_work_orders/models.py
- PATTERN: Follow src/features/projects/types/index.ts structure
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/context-hub/types/index.ts`

### CREATE archon-ui-main/src/features/context-hub/services/templateService.ts:

- IMPLEMENT: templateService object with async methods
- METHODS: listAgentTemplates(), getAgentTemplate(slug), createAgentTemplate(data), updateAgentTemplate(slug, updates), getTemplateVersions(slug)
- METHODS: listStepTemplates(), getStepTemplate(slug), createStepTemplate(data), updateStepTemplate(slug, updates)
- API_CALLS: Use apiClient from shared/api/apiClient.ts
- ENDPOINTS: Match backend routes from Phase 1
  - GET /api/agent-work-orders/templates/agents
  - GET /api/agent-work-orders/templates/steps
  - POST /api/agent-work-orders/templates/steps (with sub_steps support)
- PATTERN: Follow src/features/projects/services/projectService.ts
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/context-hub/services/templateService.ts`

### CREATE archon-ui-main/src/features/context-hub/services/workflowService.ts:

- IMPLEMENT: workflowService object with async methods
- METHODS: listWorkflowTemplates(), getWorkflowTemplate(slug), createWorkflowTemplate(data), updateWorkflowTemplate(slug, updates)
- PATTERN: Follow templateService.ts structure
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/context-hub/services/workflowService.ts`

### CREATE archon-ui-main/src/features/context-hub/hooks/useTemplateQueries.ts:

- DEFINE: templateKeys query key factory
- KEYS: templateKeys.all, templateKeys.agents(), templateKeys.steps(), templateKeys.agentDetail(slug), templateKeys.stepDetail(slug), templateKeys.versions(slug)
- IMPLEMENT: useAgentTemplates(), useAgentTemplate(slug), useCreateAgentTemplate(), useUpdateAgentTemplate(), useTemplateVersions(slug)
- IMPLEMENT: useStepTemplates(), useStepTemplate(slug), useCreateStepTemplate(), useUpdateStepTemplate()
- STALE_TIME: Use STALE_TIMES.normal for templates (30 seconds)
- PATTERN: Follow src/features/projects/hooks/useProjectQueries.ts
- OPTIMISTIC_UPDATES: Use createOptimisticEntity, replaceOptimisticEntity from shared/utils/optimistic.ts
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/context-hub/hooks/useTemplateQueries.ts`

### CREATE archon-ui-main/src/features/context-hub/hooks/useWorkflowQueries.ts:

- DEFINE: workflowKeys query key factory
- IMPLEMENT: useWorkflowTemplates(), useWorkflowTemplate(slug), useCreateWorkflowTemplate(), useUpdateWorkflowTemplate()
- PATTERN: Follow useTemplateQueries.ts structure
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/context-hub/hooks/useWorkflowQueries.ts`

### CREATE archon-ui-main/src/features/context-hub/components/AgentTemplateCard.tsx:

- IMPLEMENT: Card component displaying agent template summary
- PROPS: template: AgentTemplate
- DISPLAY: Name, description, tags, model, version badge, system_prompt preview (first 100 chars)
- ACTIONS: Edit link to /context-hub/agents/{slug}
- STYLING: Tron glassmorphism (bg-white/5 border border-white/10 rounded-lg)
- HOVER: Subtle glow effect
- PATTERN: Follow src/features/projects/components/ProjectCard.tsx
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/context-hub/components/AgentTemplateCard.tsx`

### CREATE archon-ui-main/src/features/context-hub/components/AgentTemplateEditor.tsx:

- IMPLEMENT: Form component for creating/editing agent templates
- FIELDS: name (input), description (textarea), system_prompt (textarea with mono font), model (select: sonnet/opus/haiku), tools (multi-select), tags (TagInput)
- VALIDATION: Required fields (name, system_prompt), slug auto-generated from name
- ACTIONS: Save (create or update), Cancel
- RADIX: Use Dialog primitive for modal
- VERSION_NOTICE: If editing, show "This will create version {n+1}"
- PATTERN: Follow src/features/projects/components/NewProjectModal.tsx
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/context-hub/components/AgentTemplateEditor.tsx`

### CREATE archon-ui-main/src/features/context-hub/components/StepTemplateCard.tsx:

- IMPLEMENT: Card component for step template
- PROPS: template: StepTemplate
- DISPLAY: Name, step_type badge, description, agent (if single-agent), sub-steps count (if multi-agent)
- INDICATOR: Show "Multi-Agent" badge if sub_steps.length > 0
- ACTIONS: Edit link
- STYLING: Tron glassmorphism
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/context-hub/components/StepTemplateCard.tsx`

### CREATE archon-ui-main/src/features/context-hub/components/StepTemplateEditor.tsx:

- IMPLEMENT: Form for creating/editing step templates
- FIELDS: name, step_type (select: planning/execute/review), description
- MODE_TOGGLE: Radio buttons - "Single Agent" vs "Multi-Agent Sub-Workflow"
- SINGLE_AGENT_MODE: Show agent selector, prompt textarea
- MULTI_AGENT_MODE: Show SubStepBuilder component
- VALIDATION: At least one agent (single) or one sub-step (multi)
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/context-hub/components/StepTemplateEditor.tsx`

### CREATE archon-ui-main/src/features/context-hub/components/SubStepBuilder.tsx:

- IMPLEMENT: Builder for multi-agent sub-workflows
- PROPS: subSteps: SubStepConfig[], onChange: (subSteps: SubStepConfig[]) => void
- DISPLAY: List of sub-steps with order, name, agent, prompt
- ACTIONS:
  - Add sub-step (opens inline form)
  - Remove sub-step (with confirmation)
  - Reorder sub-steps (up/down arrows)
  - Edit sub-step (inline edit)
- INLINE_FORM: order (auto), name (input), agentTemplateSlug (select), promptTemplate (textarea), required (checkbox)
- DRAG_DROP: Optional (Phase 2.1) - start with up/down buttons
- TEMPLATE_VARS: Show helper text: "Available: {{user_request}}, {{github_issue_number}}, {{sub_steps.N.output}}"
- VALIDATION: Unique order values, no gaps in order sequence
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/context-hub/components/SubStepBuilder.tsx`

### CREATE archon-ui-main/src/features/context-hub/views/AgentTemplateLibrary.tsx:

- IMPLEMENT: Page component listing all agent templates
- LAYOUT: Grid layout (3 columns on desktop, 2 on tablet, 1 on mobile)
- FILTER: Category filter buttons (All, Development, Review, Documentation, Testing, Security)
- SEARCH: Filter by name/description/tags (client-side filtering)
- CREATE_BUTTON: "Create Agent Template" - opens AgentTemplateEditor modal
- SORT: By name, created_at, version
- EMPTY_STATE: "No agent templates yet. Create your first one!"
- PATTERN: Follow src/features/projects/views/ProjectsView.tsx
- RESPONSIVE: Use Tailwind breakpoints (grid-cols-1 md:grid-cols-2 lg:grid-cols-3)
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/context-hub/views/AgentTemplateLibrary.tsx`

### CREATE archon-ui-main/src/features/context-hub/views/StepTemplateLibrary.tsx:

- IMPLEMENT: Page component listing step templates
- FILTER: By step_type (All, Planning, Execute, Review)
- FILTER: By mode (All, Single-Agent, Multi-Agent)
- DISPLAY: Template cards with name, description, agent/sub-steps indicator
- CREATE_BUTTON: "Create Step Template" - opens StepTemplateEditor modal
- PATTERN: Mirror AgentTemplateLibrary.tsx structure
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/context-hub/views/StepTemplateLibrary.tsx`

### CREATE archon-ui-main/src/features/context-hub/views/WorkflowBuilder.tsx:

- IMPLEMENT: Visual workflow builder page
- LAYOUT: Left panel (available steps), Center panel (workflow being built), Right panel (step config)
- CENTER_PANEL: Vertical list of steps in workflow order
- FEATURES:
  - Add step from available list (planning, execute, review)
  - Remove step
  - Reorder steps (drag-drop or up/down buttons)
  - Configure step: Select step template, assign agent overrides
- STATE: Use React useState for workflow being built
- SAVE: Create workflow template via useCreateWorkflowTemplate()
- VALIDATION: At least one step, valid step_template_slug for each
- PATTERN: Follow src/features/agent-work-orders/components/CreateWorkOrderModal.tsx for step selection
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/context-hub/views/WorkflowBuilder.tsx`

### CREATE archon-ui-main/src/features/context-hub/views/RepositoryConfiguration.tsx:

- IMPLEMENT: Repository settings page
- TABS: "Workflow Settings", "Agent Assignments", "Preferences"
- TAB_1 (Workflow):
  - Select default workflow template (dropdown)
  - Configure HITL checkpoints (Phase 4 integration)
- TAB_2 (Agents):
  - List assigned agents with roles (primary, reviewer, specialist)
  - Add agent assignment (select agent, select role, set priority)
  - Remove agent assignment
- TAB_3 (Preferences):
  - Preferred CLI (Phase 5 integration)
  - Timeout settings
  - Other metadata
- PATTERN: Follow src/pages/SettingsPage.tsx layout structure
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/context-hub/views/RepositoryConfiguration.tsx`

### CREATE archon-ui-main/src/pages/ContextHubPage.tsx:

- IMPLEMENT: Main Context Hub page with tab navigation
- TABS: "Agent Templates", "Step Templates", "Workflows", "Repository Config"
- RADIX: Use Tabs primitive from src/features/ui/primitives/tabs.tsx
- TAB_CONTENT:
  - Agent Templates → AgentTemplateLibrary
  - Step Templates → StepTemplateLibrary
  - Workflows → WorkflowBuilder (or list view)
  - Repository Config → RepositoryConfiguration
- PATTERN: Follow src/pages/ProjectPage.tsx tab structure
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/pages/ContextHubPage.tsx`

### UPDATE archon-ui-main/src/App.tsx:

- IMPORT: ContextHubPage component
- FIND: Route definitions in AppRoutes component
- ADD: `<Route path="/context-hub" element={<ContextHubPage />} />`
- ADD: `<Route path="/context-hub/:tab" element={<ContextHubPage />} />`
- **VALIDATE**: `grep -q "context-hub" archon-ui-main/src/App.tsx && echo "✓"`

### UPDATE archon-ui-main/src/components/layout/Sidebar.tsx:

- FIND: Navigation links section
- ADD: Context Hub nav link with icon (after Agent Work Orders)
- ICON: Layers or Settings icon from lucide-react
- TEXT: "Context Hub"
- PATTERN: Follow existing nav link structure
- **VALIDATE**: `grep -q "context-hub\|Context Hub" archon-ui-main/src/components/layout/Sidebar.tsx && echo "✓"`

### ADD archon-ui-main/src/features/context-hub/components/:

- CREATE: TagInput.tsx - Multi-tag input component (add/remove tags with chips)
- CREATE: FilterButton.tsx - Category filter button (active state highlighting)
- CREATE: TemplateVersionBadge.tsx - Version indicator (v1, v2, etc.)
- CREATE: PromptPreview.tsx - System prompt preview with expand/collapse
- PATTERN: Follow src/features/projects/components/ patterns
- RADIX: Use appropriate primitives (Badge, Button, Input)
- **VALIDATE**: `npx tsc --noEmit 2>&1 | grep "src/features/context-hub" || echo "✓ No errors"`

### ADD archon-ui-main/src/features/context-hub/tests/:

- CREATE: AgentTemplateLibrary.test.tsx - Test library view rendering
- CREATE: AgentTemplateEditor.test.tsx - Test editor form validation
- CREATE: SubStepBuilder.test.tsx - Test sub-step add/remove/reorder
- CREATE: useTemplateQueries.test.ts - Test query hooks
- PATTERN: Follow src/features/projects/tests/ test patterns
- MOCK: Mock templateService and query hooks
- LIBRARY: Use @testing-library/react and vitest
- **VALIDATE**: `npm run test archon-ui-main/src/features/context-hub/`

---

## Validation Loop

### Level 1: Syntax & Style

```bash
# TypeScript checking
npx tsc --noEmit 2>&1 | grep "src/features/context-hub"

# Biome for features directory
npm run biome:fix

# Ensure no errors
npx tsc --noEmit
```

### Level 2: Unit Tests

```bash
# Run context-hub tests
npm run test src/features/context-hub/

# Expected: All tests pass
```

### Level 3: Integration Testing - Browse Templates

```
1. Start frontend: cd archon-ui-main && npm run dev
2. Navigate to http://localhost:3737/context-hub
3. Verify sidebar shows "Context Hub" link
4. Click "Context Hub"
5. Agent Templates tab loads (default tab)
6. See 3+ seeded templates (Python Expert, React Specialist, Code Reviewer)
7. Template cards show: name, description, model badge, version badge
8. Click template card → View details modal/page
9. See: system prompt, tools list, tags, version history link
10. Close details
```

**Validation**:
- [ ] Navigation works
- [ ] Agent Templates tab loads
- [ ] Seeded templates visible
- [ ] Template details display correctly

### Level 4: Create Agent Template

```
1. Click "Create Agent Template" button
2. Modal opens with form
3. Fill name: "Test Security Expert"
4. Fill description: "Specialized security reviewer"
5. Fill system_prompt: "You are a security expert..."
6. Select model: "sonnet"
7. Add tags: "security", "review"
8. Click Save
9. Modal closes
10. New template appears in list
11. Click template → View details
12. All fields match input
13. Version badge shows "v1"
```

**Validation**:
- [ ] Create modal opens
- [ ] Form validation works (required fields)
- [ ] Save creates template
- [ ] Template appears in list
- [ ] Details match input

### Level 5: Edit Agent Template (Version Control)

```
1. Find existing template (e.g., "Test Security Expert")
2. Click Edit button
3. Modal opens with pre-filled data
4. Notice: "This will create version 2"
5. Modify description: "Updated description for v2"
6. Click Save
7. Template card updates
8. Version badge shows "v2"
9. Click "View Versions" link
10. See version history: v1 and v2 with timestamps
11. Can view v1 details (read-only)
```

**Validation**:
- [ ] Edit loads existing data
- [ ] Warns about version creation
- [ ] Save creates version 2
- [ ] Version badge updates
- [ ] Version history displays both versions

### Level 6: Create Step Template with Sub-Workflow

```
1. Navigate to "Step Templates" tab
2. Click "Create Step Template"
3. Fill name: "Multi-Agent Planning"
4. Select step_type: "planning"
5. Select mode: "Multi-Agent Sub-Workflow"
6. SubStepBuilder component appears
7. Click "Add Sub-Step"
8. Sub-step form appears:
   - Name: "Requirements Analysis"
   - Agent: "Python Backend Expert" (dropdown)
   - Prompt: "Analyze requirements for: {{user_request}}"
   - Required: ✓ checked
9. Click "Add Sub-Step" again
10. Add second sub-step:
    - Name: "Security Review"
    - Agent: "Code Reviewer"
    - Prompt: "Review security of: {{sub_steps.0.output}}"
    - Required: ✓ checked
11. Click "Add Sub-Step" again
12. Add third sub-step:
    - Name: "Plan Synthesis"
    - Agent: "Python Backend Expert"
    - Prompt: "Synthesize plan from requirements and security review"
    - Required: ✓ checked
13. Test reorder: Move sub-step 3 to position 2 (should re-number)
14. Click Save
15. Template appears in list with "Multi-Agent" badge
16. Click template → View details
17. See all 3 sub-steps listed in order
```

**Validation**:
- [ ] Mode toggle works (Single vs Multi-Agent)
- [ ] SubStepBuilder renders
- [ ] Can add multiple sub-steps
- [ ] Agent dropdown populated from agent templates
- [ ] Template variables helper text visible
- [ ] Reorder works (up/down buttons)
- [ ] Save creates step template
- [ ] Multi-Agent badge shows
- [ ] Sub-steps display in order

### Level 7: Build Workflow with Multi-Agent Step

```
1. Navigate to "Workflows" tab
2. Click "Create Workflow"
3. Name: "Advanced Dev Workflow"
4. Add steps:
   - Step 1: Planning → Select "Multi-Agent Planning" template
   - Step 2: Execute → Select "Standard Execute" template
   - Step 3: Review → Select "Standard Review" template
5. Verify step order: 1, 2, 3
6. Test reorder: Move step 3 above step 2 (should swap)
7. Click Save
8. Workflow appears in list
9. Click workflow → View details
10. See all 3 steps with selected templates
11. Planning step shows "(Multi-Agent)" indicator
```

**Validation**:
- [ ] Workflow builder renders
- [ ] Can add steps
- [ ] Step template dropdown populated
- [ ] Can reorder steps
- [ ] Save creates workflow
- [ ] Multi-agent steps indicated
- [ ] Workflow details correct

### Level 8: Repository Configuration

```
1. Navigate to "Repository Config" tab
2. Select repository from dropdown (if multiple)
3. Tab 1 (Workflow Settings):
   - Select "Advanced Dev Workflow" as default
   - See: "This workflow will be used for new work orders (Phase 3A)"
4. Tab 2 (Agent Assignments):
   - Click "Assign Agent"
   - Select "Python Backend Expert", role "primary"
   - Click "Assign Agent" again
   - Select "Code Reviewer", role "reviewer"
   - See both agents listed
5. Click Save
6. Success toast: "Repository configuration saved"
```

**Validation**:
- [ ] Repository selector works
- [ ] Workflow dropdown populated
- [ ] Agent assignment form works
- [ ] Multiple agents can be assigned
- [ ] Save persists configuration

### Level 9: Backward Compatibility (CRITICAL - MUST PASS)

```bash
# CRITICAL TEST: After Context Hub is fully implemented,
# verify existing work order flow is UNCHANGED

# Start services
cd archon-ui-main && npm run dev
# In another terminal: AWO service should be running

# Test 1: Create work order via existing UI
1. Navigate to http://localhost:3737/agent-work-orders
2. Click "Create Work Order" button
3. Fill form: repository, user request
4. Click Create
5. Work order detail page loads
6. Monitor logs

# Test 2: Verify logs show hardcoded commands
curl -N http://localhost:8053/api/agent-work-orders/{id}/logs/stream | grep -E "command|template|\.md"

# EXPECTED OUTPUT:
✅ "Loading command from: .claude/commands/agent-work-orders/planning.md"
✅ "Loading command from: .claude/commands/agent-work-orders/execute.md"
✅ "Loading command from: .claude/commands/agent-work-orders/prp-review.md"
❌ NO lines with "Using template: standard-planning"
❌ NO lines with "Template resolver"
❌ NO template execution errors

# Test 3: Verify workflow completes
# Wait 2-3 minutes
# Check status: "completed" or "failed" (not "pending" due to template errors)
```

**Validation**:
- [ ] Can create work order via existing UI
- [ ] Logs show hardcoded .md files being used
- [ ] NO template resolution in logs
- [ ] NO template errors
- [ ] Workflow executes to completion
- [ ] Context Hub has zero impact on execution

**CRITICAL**: If logs show template usage or template errors, Phase 2 has FAILED. Templates are display/configuration only until Phase 3A.

---

## COMPLETION CHECKLIST

- [ ] All Context Hub feature files created
- [ ] TypeScript types defined (with SubStepConfig)
- [ ] Template services implemented
- [ ] Workflow services implemented
- [ ] Query hooks with proper keys
- [ ] Agent Template Library view functional
- [ ] Agent Template Editor creates/updates templates
- [ ] Step Template Library view functional
- [ ] Step Template Editor creates/updates templates
- [ ] SubStepBuilder component functional (add/remove/reorder sub-steps)
- [ ] Workflow Builder can compose workflows
- [ ] Repository Configuration page functional
- [ ] Navigation link added to sidebar
- [ ] Routes registered in App.tsx
- [ ] TanStack Query hooks working
- [ ] All components follow UI_STANDARDS.md
- [ ] Radix UI primitives used correctly
- [ ] Responsive design works (mobile, tablet, desktop)
- [ ] No TypeScript errors
- [ ] Biome checks pass
- [ ] Unit tests pass
- [ ] Integration tests pass (UI renders, API calls work)
- [ ] Sub-workflow builder fully functional
- [ ] **Backward compatibility validated: Work orders still use hardcoded commands**
- [ ] **Zero impact on existing work order execution**

---

## Notes

**Phase 2 Scope:**
- **IN SCOPE**: UI for template management, sub-workflow builder, repository configuration
- **OUT OF SCOPE**: Template execution, workflow orchestrator changes, actual use of templates in work orders
- **CRITICAL**: Creating work orders MUST still use hardcoded .md files

**UI Standards Compliance:**
- Must use Radix UI primitives (no custom select/dialog/dropdown)
- Tron glassmorphism styling (bg-white/5, border border-white/10)
- No dynamic Tailwind classes (use cn() with conditionals)
- Mobile-first responsive design
- 120-char line length

**Sub-Workflow UI Features:**
- Toggle between Single-Agent and Multi-Agent modes
- Dynamic sub-step list with add/remove
- Reorder sub-steps with up/down buttons (drag-drop optional)
- Template variable helper text ({{user_request}}, {{sub_steps.0.output}}, etc.)
- Visual indicators for required vs optional sub-steps
- Agent dropdown populated from agent templates
- Order auto-numbered (1, 2, 3, ...)

**Dependencies:**
- Requires Phase 1 (backend APIs must exist)
- Enables Phase 3A (UI provides configuration for template execution)
- Enables Phase 3B (orchestrator can reference templates via UI)
- Enables Phase 4 (HITL checkpoints configured in UI)

**Feature Flag Consideration:**
- Consider adding ENABLE_CONTEXT_HUB setting (can default to true)
- If disabled, hide navigation link
- Keep feature toggleable for gradual rollout

**Testing Requirements:**
- Unit tests: 80%+ coverage for components and hooks
- Integration tests: All user journeys functional
- Visual regression tests: Screenshot comparisons
- **Backward compatibility test: MUST PASS - work orders unchanged**

**Performance Considerations:**
- Template list: Client-side filtering (server-side if > 100 templates)
- Sub-step builder: Limit to 5 sub-steps max (show warning if exceeded)
- Version history: Paginate if > 10 versions

<!-- EOF -->
