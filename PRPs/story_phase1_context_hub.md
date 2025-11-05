---
name: "Phase 1: Context Engineering Hub"
description: "Backend APIs + Frontend UI for template management (agents, steps, workflows, coding standards)"
phase: 1
dependencies: [0]
breaking_changes: false
---

## Original Story

```
Implement Context Engineering Hub - a template library system enabling:
1. Create/edit agent templates with prompts, tools, and standards
2. Create/edit step templates with sub-workflow support
3. Create/edit workflow templates with validation (≥1 planning/implement/validate)
4. Create/edit coding standards library
5. Feature toggle with Brain icon navigation
6. Backend CRUD APIs + Frontend management UI

Purpose: Reusable template definitions for:
- Manual usage via MCP server (IDE agents query → download → create .claude/commands/)
- Automated usage via Agent Work Orders (Phases 2-6)
```

## Story Metadata

**Story Type**: Feature (Backend + Frontend)
**Estimated Complexity**: Medium
**Primary Systems Affected**:
- Backend: New services and API routes for template CRUD
- Frontend: New Context Hub feature with template management UI
- Navigation: Conditional Brain icon link based on feature toggle

**Phase Number**: 1
**Dependencies**: Phase 0 (database migrations must be run)
**Breaking Changes**: ❌ None (core feature, doesn't affect existing functionality)

---

## CRITICAL: Navigation Link Handling

**Feature Toggle Integration**:
- Navigation link to `/context-hub` appears ONLY when `contextHubEnabled` is TRUE
- Icon: **Brain** (from lucide-react) - represents "Context Engineering"
- When disabled: Link hidden from navigation sidebar
- When enabled: Link visible, navigates to Context Hub page

**Implementation Pattern** (follow existing Projects toggle):
- Read from `useSettings()` context
- Conditionally render navigation link
- Apply Brain icon with indigo color scheme

---

## CONTEXT REFERENCES

### Database Schema
- Phase 0 PRP: `story_phase0_database_setup.md` - Tables already created
- Migration: `migration/complete_setup.sql` (lines 1366-1551) - Context Hub tables
- Migration: `migration/0.1.0/012_add_context_hub_tables.sql` - Upgrade migration

### Backend Patterns
- Service: `python/src/server/services/project_service.py` - CRUD service pattern
- API: `python/src/server/api_routes/projects_api.py` - FastAPI route pattern
- Models: `python/src/server/models/project_models.py` - Pydantic model pattern

### Frontend Patterns
- Feature: `archon-ui-main/src/features/projects/` - Vertical slice structure
- Settings Toggle: `archon-ui-main/src/contexts/SettingsContext.tsx` - Feature toggle pattern
- Navigation: `archon-ui-main/src/components/layout/Navigation.tsx` - Conditional links

### UI Standards
- `PRPs/ai_docs/UI_STANDARDS.md` - Radix UI primitives, Tron glassmorphism, responsive design

---

## Backend Implementation

### TASK 1: Create Pydantic Models

**File**: `python/src/agent_work_orders/models.py`

**Models to Add**:
```python
# Agent Template
class AgentTemplate(BaseModel):
    id: str
    slug: str
    name: str
    description: str | None
    system_prompt: str
    model: str = "sonnet"
    temperature: float = 0.0
    tools: list[str] = []
    standards: dict[str, Any] = {}
    metadata: dict[str, Any] = {}
    is_active: bool = True
    version: int = 1
    parent_template_id: str | None = None
    created_by: str | None = None
    created_at: datetime
    updated_at: datetime

# Step Template
class StepTemplate(BaseModel):
    id: str
    step_type: str  # 'planning', 'implement', 'validate', 'prime', 'git'
    slug: str
    name: str
    description: str | None
    prompt_template: str
    agent_template_id: str | None
    sub_steps: list[dict[str, Any]] = []  # SubStep configs
    metadata: dict[str, Any] = {}
    is_active: bool = True
    version: int = 1
    parent_template_id: str | None = None
    created_by: str | None = None
    created_at: datetime
    updated_at: datetime

# Workflow Template
class WorkflowTemplate(BaseModel):
    id: str
    slug: str
    name: str
    description: str | None
    steps: list[dict[str, Any]]  # Workflow step configs
    metadata: dict[str, Any] = {}
    is_active: bool = True
    created_by: str | None = None
    created_at: datetime
    updated_at: datetime

# Coding Standard
class CodingStandard(BaseModel):
    id: str
    slug: str
    name: str
    language: str  # 'typescript', 'python', 'javascript', etc.
    description: str | None
    standards: dict[str, Any]  # Linter config, rules, etc.
    metadata: dict[str, Any] = {}
    is_active: bool = True
    created_at: datetime
    updated_at: datetime

# Request/Response models for CRUD operations
class CreateAgentTemplateRequest(BaseModel):
    slug: str
    name: str
    description: str | None = None
    system_prompt: str
    model: str = "sonnet"
    temperature: float = 0.0
    tools: list[str] = []
    standards: dict[str, Any] = {}
    metadata: dict[str, Any] = {}
    created_by: str | None = None

# ... similar for Update, Create/Update Step, Workflow, CodingStandard
```

**VALIDATE**: `uv run python -c "from src.agent_work_orders.models import AgentTemplate, StepTemplate, WorkflowTemplate, CodingStandard; print('✓')"`

---

### TASK 2: Create Template Service

**File**: `python/src/agent_work_orders/services/template_service.py`

**Methods**:
```python
class TemplateService:
    async def list_agent_templates(self, is_active: bool = True) -> list[AgentTemplate]
    async def get_agent_template(self, slug: str) -> AgentTemplate | None
    async def create_agent_template(self, data: CreateAgentTemplateRequest) -> AgentTemplate
    async def update_agent_template(self, slug: str, updates: UpdateAgentTemplateRequest) -> AgentTemplate
    async def get_agent_template_versions(self, slug: str) -> list[AgentTemplate]
```

**Pattern**: Follow `python/src/server/services/project_service.py`
- Use `get_supabase_client()` from state_manager
- Structured logging with event names
- Type-safe operations

**VALIDATE**: `uv run python -c "from src.agent_work_orders.services.template_service import TemplateService; print('✓')"`

---

### TASK 3: Create Workflow Service

**File**: `python/src/agent_work_orders/services/workflow_service.py`

**Methods**:
```python
class WorkflowService:
    # Workflow Templates
    async def list_workflow_templates(self, is_active: bool = True) -> list[WorkflowTemplate]
    async def get_workflow_template(self, slug: str) -> WorkflowTemplate | None
    async def create_workflow_template(self, data: CreateWorkflowTemplateRequest) -> WorkflowTemplate
    async def update_workflow_template(self, slug: str, updates: UpdateWorkflowTemplateRequest) -> WorkflowTemplate

    # Step Templates
    async def list_step_templates(self, step_type: str | None = None, is_active: bool = True) -> list[StepTemplate]
    async def get_step_template(self, slug: str) -> StepTemplate | None
    async def create_step_template(self, data: CreateStepTemplateRequest) -> StepTemplate
    async def update_step_template(self, slug: str, updates: UpdateStepTemplateRequest) -> StepTemplate

    # Validation
    def _validate_workflow_steps(self, steps: list[dict]) -> None:
        """Enforce: Workflow must have ≥1 planning, implement, validate step"""

    def _validate_sub_steps(self, sub_steps: list[dict]) -> None:
        """Validate sub-step structure and constraints"""
```

**Workflow Validation Logic**:
```python
step_types = [step['step_type'] for step in steps]
has_planning = any(t == 'planning' for t in step_types)
has_implement = any(t == 'implement' for t in step_types)
has_validate = any(t == 'validate' for t in step_types)

if not (has_planning and has_implement and has_validate):
    raise ValueError("Workflow must have at least one 'planning', 'implement', and 'validate' step")
```

**VALIDATE**: `uv run python -c "from src.agent_work_orders.services.workflow_service import WorkflowService; print('✓')"`

---

### TASK 4: Create Coding Standard Service

**File**: `python/src/agent_work_orders/services/coding_standard_service.py`

**Methods**:
```python
class CodingStandardService:
    async def list_coding_standards(self, language: str | None = None, is_active: bool = True) -> list[CodingStandard]
    async def get_coding_standard(self, slug: str) -> CodingStandard | None
    async def create_coding_standard(self, data: CreateCodingStandardRequest) -> CodingStandard
    async def update_coding_standard(self, slug: str, updates: UpdateCodingStandardRequest) -> CodingStandard
```

**VALIDATE**: `uv run python -c "from src.agent_work_orders.services.coding_standard_service import CodingStandardService; print('✓')"`

---

### TASK 5: Create API Routes

**Files**:
- `python/src/agent_work_orders/api/template_routes.py` - Agent template endpoints
- `python/src/agent_work_orders/api/workflow_routes.py` - Workflow + step endpoints
- `python/src/agent_work_orders/api/coding_standards_routes.py` - Coding standards endpoints

**Endpoints** (`template_routes.py`):
```python
GET    /api/agent-work-orders/templates/agents
GET    /api/agent-work-orders/templates/agents/{slug}
POST   /api/agent-work-orders/templates/agents
PUT    /api/agent-work-orders/templates/agents/{slug}
GET    /api/agent-work-orders/templates/agents/{slug}/versions
```

**Endpoints** (`workflow_routes.py`):
```python
# Workflows
GET    /api/agent-work-orders/templates/workflows
GET    /api/agent-work-orders/templates/workflows/{slug}
POST   /api/agent-work-orders/templates/workflows
PUT    /api/agent-work-orders/templates/workflows/{slug}

# Steps
GET    /api/agent-work-orders/templates/steps?step_type=planning
GET    /api/agent-work-orders/templates/steps/{slug}
POST   /api/agent-work-orders/templates/steps
PUT    /api/agent-work-orders/templates/steps/{slug}
```

**Endpoints** (`coding_standards_routes.py`):
```python
GET    /api/agent-work-orders/coding-standards?language=typescript
GET    /api/agent-work-orders/coding-standards/{slug}
POST   /api/agent-work-orders/coding-standards
PUT    /api/agent-work-orders/coding-standards/{slug}
```

**Register routers** in `python/src/agent_work_orders/api/routes.py`

**VALIDATE**: `curl http://localhost:8053/api/agent-work-orders/templates/agents | jq`

---

## Frontend Implementation

### TASK 6: Create TypeScript Types

**File**: `archon-ui-main/src/features/context-hub/types/index.ts`

Mirror all backend Pydantic models exactly:
```typescript
export interface AgentTemplate {
  id: string;
  slug: string;
  name: string;
  description?: string;
  system_prompt: string;
  model: string;
  temperature: number;
  tools: string[];
  standards: Record<string, unknown>;
  metadata: Record<string, unknown>;
  is_active: boolean;
  version: number;
  parent_template_id?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export type StepType = 'planning' | 'implement' | 'validate' | 'prime' | 'git';

export interface StepTemplate {
  id: string;
  step_type: StepType;
  slug: string;
  name: string;
  // ... mirror backend
}

// ... WorkflowTemplate, CodingStandard, Request types
```

**VALIDATE**: `npx tsc --noEmit`

---

### TASK 7: Create Services

**Files**:
- `archon-ui-main/src/features/context-hub/services/templateService.ts`
- `archon-ui-main/src/features/context-hub/services/workflowService.ts`
- `archon-ui-main/src/features/context-hub/services/codingStandardService.ts`

**Pattern**:
```typescript
export const templateService = {
  async listAgentTemplates(): Promise<AgentTemplate[]> {
    const response = await apiClient.get('/api/agent-work-orders/templates/agents');
    return response.data;
  },

  async getAgentTemplate(slug: string): Promise<AgentTemplate> {
    const response = await apiClient.get(`/api/agent-work-orders/templates/agents/${slug}`);
    return response.data;
  },

  async createAgentTemplate(data: CreateAgentTemplateRequest): Promise<AgentTemplate> {
    const response = await apiClient.post('/api/agent-work-orders/templates/agents', data);
    return response.data;
  },

  async updateAgentTemplate(slug: string, updates: UpdateAgentTemplateRequest): Promise<AgentTemplate> {
    const response = await apiClient.put(`/api/agent-work-orders/templates/agents/${slug}`, updates);
    return response.data;
  },
};
```

**VALIDATE**: `npx tsc --noEmit`

---

### TASK 8: Create Zustand Store (Client UI State)

**File**: `archon-ui-main/src/features/context-hub/state/contextHubStore.ts`

**Pattern** (follow `features/agent-work-orders/state/agentWorkOrdersStore.ts`):

```typescript
import { create } from "zustand";
import { devtools, persist, subscribeWithSelector } from "zustand/middleware";
import { createUISlice, type UISlice } from "./slices/uiSlice";
import { createModalsSlice, type ModalsSlice } from "./slices/modalsSlice";
import { createFiltersSlice, type FiltersSlice } from "./slices/filtersSlice";

export type ContextHubStore = UISlice & ModalsSlice & FiltersSlice;

/**
 * Context Hub global state store
 *
 * Manages:
 * - UI preferences (active tab, view mode) - PERSISTED
 * - Modal state (create/edit modals) - NOT persisted
 * - Filter state (search, tags) - PERSISTED
 *
 * Does NOT manage:
 * - Server data (TanStack Query handles this)
 * - Form data (local component state)
 */
export const useContextHubStore = create<ContextHubStore>()(
  devtools(
    subscribeWithSelector(
      persist(
        (...a) => ({
          ...createUISlice(...a),
          ...createModalsSlice(...a),
          ...createFiltersSlice(...a),
        }),
        {
          name: "context-hub-ui",
          version: 1,
          partialize: (state) => ({
            // Persist UI preferences
            activeTab: state.activeTab,
            viewMode: state.viewMode,
            searchQuery: state.searchQuery,
            selectedTags: state.selectedTags,
            // Do NOT persist:
            // - Modal state (ephemeral)
            // - Editing context (transient)
          }),
        },
      ),
    ),
    { name: "ContextHub" },
  ),
);
```

**Slices**:

**`slices/uiSlice.ts`**:
```typescript
export interface UISlice {
  activeTab: 'agents' | 'steps' | 'workflows' | 'standards';
  setActiveTab: (tab: UISlice['activeTab']) => void;
  viewMode: 'grid' | 'list';
  setViewMode: (mode: 'grid' | 'list') => void;
}

export const createUISlice: StateCreator<ContextHubStore, [], [], UISlice> = (set) => ({
  activeTab: 'agents',
  setActiveTab: (tab) => set({ activeTab: tab }),
  viewMode: 'grid',
  setViewMode: (mode) => set({ viewMode: mode }),
});
```

**`slices/modalsSlice.ts`**:
```typescript
export interface ModalsSlice {
  isCreateAgentModalOpen: boolean;
  openCreateAgentModal: () => void;
  closeCreateAgentModal: () => void;
  isEditAgentModalOpen: boolean;
  editingAgentSlug: string | null;
  openEditAgentModal: (slug: string) => void;
  closeEditAgentModal: () => void;
  // Similar for step, workflow, standards modals
}
```

**`slices/filtersSlice.ts`**:
```typescript
export interface FiltersSlice {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  selectedTags: string[];
  toggleTag: (tag: string) => void;
  clearFilters: () => void;
}
```

**VALIDATE**: `npx tsc --noEmit`

---

### TASK 9: Create TanStack Query Hooks (Server State)

**Files**:
- `archon-ui-main/src/features/context-hub/hooks/useAgentTemplates.ts`
- `archon-ui-main/src/features/context-hub/hooks/useWorkflowTemplates.ts`
- `archon-ui-main/src/features/context-hub/hooks/useStepTemplates.ts`
- `archon-ui-main/src/features/context-hub/hooks/useCodingStandards.ts`

**Pattern** (from `PRPs/ai_docs/QUERY_PATTERNS.md`):
```typescript
export const agentKeys = {
  all: ["context-hub", "agents"] as const,
  lists: () => [...agentKeys.all, "list"] as const,
  detail: (slug: string) => [...agentKeys.all, slug] as const,
  versions: (slug: string) => [...agentKeys.all, slug, "versions"] as const,
};

export function useAgentTemplates() {
  return useQuery({
    queryKey: agentKeys.lists(),
    queryFn: () => templateService.listAgentTemplates(),
    staleTime: STALE_TIMES.normal,
  });
}

export function useCreateAgentTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateAgentTemplateRequest) => templateService.createAgentTemplate(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
    },
  });
}
```

**VALIDATE**: `npx tsc --noEmit`

**State Management Architecture**:
- **Zustand**: Client UI state (tabs, modals, filters) - follows `PRPs/ai_docs/ZUSTAND_STATE_MANAGEMENT.md`
- **TanStack Query**: Server state (templates from API) - follows `PRPs/ai_docs/QUERY_PATTERNS.md`
- **Component State**: Ephemeral UI (form inputs, hover states) - use useState

**Selector Pattern**:
```typescript
// ✅ Single value - stable reference
const activeTab = useContextHubStore((s) => s.activeTab);

// ✅ Multiple values - use useShallow
import { useShallow } from 'zustand/react/shallow';
const { searchQuery, selectedTags } = useContextHubStore(
  useShallow((s) => ({ searchQuery: s.searchQuery, selectedTags: s.selectedTags }))
);

// ❌ Don't subscribe to entire store
const store = useContextHubStore(); // Causes unnecessary re-renders
```

---

### TASK 10: Create Components

**Files** (in `archon-ui-main/src/features/context-hub/components/`):

**AgentTemplateCard.tsx**:
- Display agent summary (name, description, tools, version badge)
- Click → Open detail modal
- Follow Radix UI primitives + Tron glassmorphism

**AgentTemplateEditor.tsx**:
- Form: name, slug, description, system_prompt (textarea), model (select)
- Tools: Multi-select (Read, Write, Edit, Grep, Bash)
- Save → Create or update agent template
- Validation: All required fields

**StepTemplateCard.tsx**:
- Display step summary (name, step_type badge, sub-step count)
- Color-coded by step_type (planning=blue, implement=green, validate=purple, prime=cyan, git=gray)

**StepTemplateEditor.tsx**:
- Form: name, slug, step_type (enum selector), prompt_template
- Agent selection (dropdown of agent templates)
- Sub-step builder (if sub_steps not empty)

**SubStepBuilder.tsx**:
- Add/remove sub-steps
- Each sub-step: order, name, agent_template_slug (dropdown), prompt_template
- Up/down buttons to reorder
- Max 5 sub-steps (show warning if limit reached)

**WorkflowBuilder.tsx**:
- Visual step sequence
- Add step button → Select step_type → Select step_template
- Drag-and-drop reorder (or up/down buttons)
- Validation warning if missing required step types

**CodingStandardEditor.tsx**:
- Form: name, slug, language (text), standards (JSON editor)
- JSON editor with syntax highlighting
- Validation: Must be valid JSON

**VALIDATE**: `npx tsc --noEmit 2>&1 | grep "src/features/context-hub"`

---

### TASK 10: Create Views

**Files** (in `archon-ui-main/src/features/context-hub/views/`):

**AgentLibraryView.tsx**:
- Grid layout of AgentTemplateCard components
- Filter by tags (from metadata.tags)
- Search by name/description
- "Create Agent Template" button

**StepLibraryView.tsx**:
- Grid layout of StepTemplateCard components
- Filter by step_type (tabs: All, Planning, Implement, Validate, Prime, Git)
- Search by name
- "Create Step Template" button

**WorkflowLibraryView.tsx**:
- List of workflow templates
- Show step count, step types summary
- Click → WorkflowBuilder in edit mode

**CodingStandardsView.tsx**:
- List grouped by language
- Filter by language
- "Create Coding Standard" button

**VALIDATE**: Components render without errors

---

### TASK 11: Create Context Hub Page

**File**: `archon-ui-main/src/pages/ContextHubPage.tsx`

**Structure**:
```typescript
export const ContextHubPage = () => {
  const [activeTab, setActiveTab] = useState<'agents' | 'steps' | 'workflows' | 'standards'>('agents');

  return (
    <div className="container mx-auto p-6">
      <h1>Context Engineering Hub</h1>
      <p>Template library for workflows, agents, and coding standards</p>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="steps">Steps</TabsTrigger>
          <TabsTrigger value="workflows">Workflows</TabsTrigger>
          <TabsTrigger value="standards">Coding Standards</TabsTrigger>
        </TabsList>

        <TabsContent value="agents"><AgentLibraryView /></TabsContent>
        <TabsContent value="steps"><StepLibraryView /></TabsContent>
        <TabsContent value="workflows"><WorkflowLibraryView /></TabsContent>
        <TabsContent value="standards"><CodingStandardsView /></TabsContent>
      </Tabs>
    </div>
  );
};
```

**VALIDATE**: Navigate to `http://localhost:3737/context-hub` (after routing added)

---

### TASK 12: Add Routing

**File**: `archon-ui-main/src/App.tsx`

Add route:
```typescript
<Route path="/context-hub/:tab?" element={<ContextHubPage />} />
```

**VALIDATE**: `npx tsc --noEmit`

---

### TASK 13: Add Feature Toggle to Settings Context

**File**: `archon-ui-main/src/contexts/SettingsContext.tsx`

**Add to interface**:
```typescript
interface SettingsContextType {
  // ... existing ...
  contextHubEnabled: boolean;
  setContextHubEnabled: (enabled: boolean) => Promise<void>;
}
```

**Add state and handlers** (follows Projects pattern):
```typescript
const [contextHubEnabled, setContextHubEnabledState] = useState(false); // Default: OFF

// Load setting
const contextHubResponse = await credentialsService.getCredential('CONTEXT_HUB_ENABLED');
if (contextHubResponse.value !== undefined) {
  setContextHubEnabledState(contextHubResponse.value === 'true');
} else {
  setContextHubEnabledState(false); // Default: OFF (no credential = disabled)
}

// Set handler - creates credential on first toggle
const setContextHubEnabled = async (enabled: boolean) => {
  setContextHubEnabledState(enabled);
  await credentialsService.createCredential({
    key: 'CONTEXT_HUB_ENABLED',
    value: enabled.toString(),
    is_encrypted: false,
    category: 'features',
    description: 'Enable Context Engineering Hub for template management'
  });
};
```

**Key Point**: Credential is created by application code when user first toggles, NOT in migration.

**Default**: `false` (disabled until user enables)

**VALIDATE**: Settings context compiles

---

### TASK 14: Add Feature Toggle Card to Settings UI

**File**: `archon-ui-main/src/components/settings/FeaturesSection.tsx`

**Add toggle card**:
```typescript
import { Brain } from 'lucide-react';

{/* Context Hub Toggle */}
<div className="flex items-center gap-4 p-4 rounded-xl bg-gradient-to-br from-indigo-500/10 to-indigo-600/5 backdrop-blur-sm border border-indigo-500/20 shadow-lg">
  <div className="flex-1 min-w-0">
    <p className="font-medium text-gray-800 dark:text-white">
      Context Hub
    </p>
    <p className="text-sm text-gray-500 dark:text-gray-400">
      Template library for workflows, agents, and coding standards
    </p>
  </div>
  <div className="flex-shrink-0">
    <Switch
      size="lg"
      checked={contextHubEnabledLocal}
      onCheckedChange={handleContextHubToggle}
      color="indigo"
      icon={<Brain className="w-5 h-5" />}
      disabled={loading}
    />
  </div>
</div>
```

**Handler**:
```typescript
const handleContextHubToggle = async (checked: boolean) => {
  setContextHubEnabledLocal(checked);
  await setContextHubContext(checked); // Calls SettingsContext.setContextHubEnabled
  showToast(
    checked ? 'Context Hub Enabled' : 'Context Hub Disabled',
    checked ? 'success' : 'warning'
  );
};
```

**Icon**: `Brain` from `lucide-react`
**Color**: `indigo`

**VALIDATE**: Toggle appears in Settings → Features

---

### TASK 15: Add Navigation Link with Conditional Rendering

**File**: `archon-ui-main/src/components/layout/Navigation.tsx`

**Add conditional link**:

```typescript
import { Brain } from 'lucide-react';
import { useSettings } from '@/contexts/SettingsContext';

export const Navigation = () => {
  const { projectsEnabled, contextHubEnabled } = useSettings();

  return (
    <nav>
      {/* ... existing links ... */}

      {contextHubEnabled && (
        <NavLink to="/context-hub" icon={Brain} label="Context Hub" color="indigo" />
      )}

      {/* ... other links ... */}
    </nav>
  );
};
```

**Pattern**: Follow existing Projects conditional rendering pattern

**Icon**: `<Brain />` from `lucide-react`
**Color**: `indigo` (matches feature toggle card color)

**VALIDATE**:
1. Context Hub enabled in Settings → Link visible
2. Context Hub disabled in Settings → Link hidden
3. Click link → Navigate to `/context-hub`

---

## Validation Loop

### Level 1: Syntax & Style

```bash
# Backend
uv run ruff check src/agent_work_orders/services/ --fix
uv run ruff check src/agent_work_orders/api/ --fix
uv run mypy src/agent_work_orders/

# Frontend
npx tsc --noEmit
npm run biome:fix
npx tsc --noEmit 2>&1 | grep "src/features/context-hub"
```

**PASS CRITERIA**: Zero errors

---

### Level 2: Unit Tests

```bash
# Backend services
uv run pytest tests/agent_work_orders/services/test_template_service.py -v
uv run pytest tests/agent_work_orders/services/test_workflow_service.py -v
uv run pytest tests/agent_work_orders/services/test_coding_standard_service.py -v

# Frontend hooks
npm run test src/features/context-hub/hooks/
npm run test src/features/context-hub/components/
```

**PASS CRITERIA**: All tests pass, >80% coverage

---

### Level 3: Integration Tests

```bash
# Test agent template creation
curl -X POST http://localhost:8053/api/agent-work-orders/templates/agents \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "test-agent",
    "name": "Test Agent",
    "system_prompt": "Test prompt",
    "tools": ["Read", "Write"]
  }' | jq

# Test workflow validation (should fail - missing validate step)
curl -X POST http://localhost:8053/api/agent-work-orders/templates/workflows \
  -d '{"slug": "invalid", "steps": [{"step_type": "planning", "order": 1}]}' | jq
# Expected: 400 error with validation message

# Test valid workflow
curl -X POST http://localhost:8053/api/agent-work-orders/templates/workflows \
  -d '{
    "slug": "valid",
    "steps": [
      {"step_type": "planning", "order": 1, "step_template_slug": "standard-planning"},
      {"step_type": "implement", "order": 2, "step_template_slug": "standard-implement"},
      {"step_type": "validate", "order": 3, "step_template_slug": "standard-review"}
    ]
  }' | jq
# Expected: 201 Created
```

**PASS CRITERIA**: All endpoints work, validation enforced

---

### Level 4: UI Manual Testing

**Test Flow**:
1. Start frontend: `cd archon-ui-main && npm run dev`
2. Navigate to Settings → Features
3. Toggle "Context Hub" OFF
4. Verify: Brain icon link disappears from navigation
5. Toggle "Context Hub" ON
6. Verify: Brain icon link appears in navigation (indigo color)
7. Click "Context Hub" link
8. Verify: Navigate to `/context-hub`, Agents tab loads
9. Click "Create Agent Template"
10. Fill form: Name, System Prompt, Tools (select multiple)
11. Click Save
12. Verify: Agent appears in library
13. Navigate to "Workflows" tab
14. Try to create workflow with only planning step
15. Verify: Error message "Must have at least one planning, implement, and validate step"
16. Add implement and validate steps
17. Click Save
18. Verify: Workflow created successfully

**PASS CRITERIA**: All UI operations work, feature toggle controls navigation, validation messages clear

---

## COMPLETION CHECKLIST

### Backend
- [ ] Pydantic models created for all template types
- [ ] TemplateService implemented with CRUD operations
- [ ] WorkflowService implemented with validation
- [ ] CodingStandardService implemented
- [ ] API routes created and registered
- [ ] All endpoints functional
- [ ] Workflow validation enforces required step types
- [ ] Zero ruff/mypy errors

### Frontend
- [ ] TypeScript types mirror backend models
- [ ] Services created for all API calls
- [ ] **Zustand store created with slices (UI, Modals, Filters)**
- [ ] **Zustand follows v4 curried syntax pattern**
- [ ] **Persistence configured (partialize: activeTab, viewMode, searchQuery)**
- [ ] TanStack Query hooks with key factories (server data)
- [ ] All components created (cards, editors, builders)
- [ ] All views created (library views)
- [ ] Context Hub page with tab navigation
- [ ] Routing added to App.tsx
- [ ] **Navigation link with Brain icon added**
- [ ] **Navigation link shows/hides based on contextHubEnabled**
- [ ] Zero TypeScript errors
- [ ] All unit tests pass

### Integration
- [ ] Can create templates via API
- [ ] Can create templates via UI
- [ ] Workflow validation works (backend + frontend)
- [ ] Feature toggle controls navigation visibility
- [ ] All data persists after refresh

---

## Notes

**Feature Toggle**:
- Key: `CONTEXT_HUB_ENABLED`
- Default: `true` (core feature)
- Controls: Navigation link visibility

**Navigation Icon**:
- Icon: `Brain` from `lucide-react`
- Label: "Context Hub"
- Color: `indigo`
- Position: After Agent Work Orders link (if enabled)

**Workflow Validation**:
- Enforced in backend (WorkflowService._validate_workflow_steps)
- Displayed in frontend (WorkflowBuilder validation messages)
- Required: ≥1 planning, ≥1 implement, ≥1 validate step

**No Breaking Changes**:
- Context Hub is storage only
- No changes to existing work order execution
- Work orders still use hardcoded .md files (until Phase 3)

**Dependencies for Phase 2**:
- Phase 2 (AWO Foundation) requires templates to exist
- Users must be able to create workflows before applying them to repositories

<!-- EOF -->
