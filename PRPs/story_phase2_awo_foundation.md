---
name: "Phase 2: AWO Foundation - Repository Template Linking"
description: "Link repositories to Context Hub templates with customizations (priming context, coding standards, agent overrides)"
phase: 2
dependencies: [0, 1]
breaking_changes: false
---

## Original Story

```
Implement repository-to-template linking foundation for Agent Work Orders:
1. Link repositories to Context Hub workflow templates
2. Repository-specific priming context (file paths, architecture notes)
3. Assign coding standards to repositories
4. Agent tool overrides per repository
5. Document existing step selection feature (already implemented)

Purpose: Enable repository-specific configurations without modifying generic templates.
Template → Instance pattern where templates remain generic and repositories apply customizations.
```

## Story Metadata

**Story Type**: Feature (Backend + Frontend)
**Estimated Complexity**: Medium
**Primary Systems Affected**:
- Backend: Agent Work Orders service models and API
- Frontend: Repository configuration UI
- Database: archon_configured_repositories table (Phase 0) + archon_repository_agent_overrides table

**Phase Number**: 2
**Dependencies**: Phase 0 (database), Phase 1 (Context Hub templates exist)
**Breaking Changes**: ❌ None (optional feature, additive only)

---

## CRITICAL: Template → Instance Architecture

**Key Concept**: Templates are generic, Instances are repository-specific

**Templates** (from Context Hub - Phase 1):
- Generic workflow definitions
- Shared across all repositories
- Modified via Context Hub UI
- Examples: "Standard Dev Workflow", "Fullstack Workflow"

**Instances** (Phase 2):
- Repository-specific application of a template
- Priming context: "Frontend is in /apps/web/src"
- Coding standards: [TypeScript Strict, Python Ruff]
- Agent overrides: Add "Bash" tool to Python Expert
- Changes don't affect the template itself

**Example**:
```
Template: "Python Backend Expert" (generic)
    ↓ Apply to Repository: github.com/user/my-app
Instance: "Python Backend Expert" for my-app
  + Priming: "Backend is in /services/api/src"
  + Coding Standards: [Python Ruff, MyPy Strict]
  + Tool Override: Add ["Bash", "WebFetch"] to default tools
```

---

## CONTEXT REFERENCES

### Database Schema
- Phase 0 PRP: `story_phase0_database_setup.md` - Tables created
- Migration: `migration/agent_work_orders_complete.sql` (lines 1-100) - Repository tables
- Tables needed:
  - `archon_configured_repositories` - Add: workflow_template_id, coding_standard_ids, priming_context, use_template_execution
  - `archon_repository_agent_overrides` - Agent tool/standard overrides per repo

### Backend Patterns
- Models: `python/src/agent_work_orders/models.py` - ConfiguredRepository exists, needs fields added
- Repository: `python/src/agent_work_orders/state_manager/repository_config_repository.py` - CRUD exists
- API: `python/src/agent_work_orders/api/routes.py` - Repository endpoints exist

### Frontend Patterns
- Feature: `archon-ui-main/src/features/agent-work-orders/` - AWO vertical slice
- Components: `AddRepositoryModal.tsx`, `EditRepositoryModal.tsx` - Existing modals to extend
- Services: `archon-ui-main/src/features/agent-work-orders/services/` - API client patterns

### Context Hub Integration
- Templates: Phase 1 templates from `archon_agent_templates`, `archon_workflow_templates`
- Coding Standards: Phase 1 standards from `archon_coding_standards`
- Services: `python/src/server/services/template_service.py`, `workflow_service.py`, `coding_standard_service.py`

---

## Backend Implementation

### TASK 1: Update ConfiguredRepository Model

**File**: `python/src/agent_work_orders/models.py`

**ADD** fields to `ConfiguredRepository` model (after line 208):
```python
# Phase 2: Template linking fields
workflow_template_id: str | None = Field(
    None,
    description="UUID of workflow template from Context Hub (archon_workflow_templates)"
)
coding_standard_ids: list[str] = Field(
    default_factory=list,
    description="List of coding standard UUIDs from Context Hub (archon_coding_standards)"
)
priming_context: dict[str, Any] = Field(
    default_factory=dict,
    description="Repository-specific priming context (paths, architecture, conventions)"
)
use_template_execution: bool = Field(
    default=False,
    description="Flag to enable template-based execution (Phase 3). Default: false (hardcoded .md files)"
)
```

**VALIDATE**: `uv run python -c "from src.agent_work_orders.models import ConfiguredRepository; import inspect; sig = inspect.signature(ConfiguredRepository); assert 'workflow_template_id' in sig.parameters; print('✓ Model updated')"`

---

### TASK 2: Create RepositoryAgentOverride Model

**File**: `python/src/agent_work_orders/models.py`

**ADD** new model after ConfiguredRepository:
```python
class RepositoryAgentOverride(BaseModel):
    """Agent tool/standard overrides for a specific repository

    Allows repository-specific customizations of agent templates without
    modifying the template itself. NULL values mean "use template default".
    """

    id: str = Field(..., description="Unique UUID for this override")
    repository_id: str = Field(..., description="FK to archon_configured_repositories")
    agent_template_id: str = Field(..., description="FK to archon_agent_templates")
    override_tools: list[str] | None = Field(
        None,
        description="Override tools list (NULL = use template default)"
    )
    override_standards: dict[str, Any] | None = Field(
        None,
        description="Override standards dict (NULL = use template default)"
    )
    created_at: datetime = Field(..., description="Creation timestamp")
    updated_at: datetime = Field(..., description="Last update timestamp")


class CreateRepositoryAgentOverrideRequest(BaseModel):
    """Request to create agent override for repository"""

    repository_id: str
    agent_template_id: str
    override_tools: list[str] | None = None
    override_standards: dict[str, Any] | None = None


class UpdateRepositoryAgentOverrideRequest(BaseModel):
    """Request to update agent override"""

    override_tools: list[str] | None = None
    override_standards: dict[str, Any] | None = None
```

**VALIDATE**: `uv run python -c "from src.agent_work_orders.models import RepositoryAgentOverride; print('✓ Override model created')"`

---

### TASK 3: Update RepositoryConfigRepository - Template Linking

**File**: `python/src/agent_work_orders/state_manager/repository_config_repository.py`

**UPDATE** `_row_to_model` method to include Phase 2 fields (around line 112):
```python
# After existing field mapping, add:
workflow_template_id=row.get("workflow_template_id"),
coding_standard_ids=row.get("coding_standard_ids", []),
priming_context=row.get("priming_context", {}),
use_template_execution=row.get("use_template_execution", False),
```

**ADD** new methods to class:
```python
async def apply_workflow_template(
    self,
    repository_id: str,
    workflow_template_id: str
) -> ConfiguredRepository | None:
    """Apply a workflow template to a repository

    Args:
        repository_id: Repository UUID
        workflow_template_id: Workflow template UUID from Context Hub

    Returns:
        Updated ConfiguredRepository or None if not found
    """
    return await self.update_repository(
        repository_id,
        workflow_template_id=workflow_template_id
    )


async def update_priming_context(
    self,
    repository_id: str,
    priming_context: dict[str, Any]
) -> ConfiguredRepository | None:
    """Update repository priming context

    Args:
        repository_id: Repository UUID
        priming_context: Priming context dict (paths, architecture, etc.)

    Returns:
        Updated ConfiguredRepository or None if not found
    """
    return await self.update_repository(
        repository_id,
        priming_context=priming_context
    )


async def assign_coding_standards(
    self,
    repository_id: str,
    coding_standard_ids: list[str]
) -> ConfiguredRepository | None:
    """Assign coding standards to repository

    Args:
        repository_id: Repository UUID
        coding_standard_ids: List of coding standard UUIDs from Context Hub

    Returns:
        Updated ConfiguredRepository or None if not found
    """
    return await self.update_repository(
        repository_id,
        coding_standard_ids=coding_standard_ids
    )


async def toggle_template_execution(
    self,
    repository_id: str,
    enabled: bool
) -> ConfiguredRepository | None:
    """Toggle template execution mode for repository

    Args:
        repository_id: Repository UUID
        enabled: True to use templates (Phase 3+), False for hardcoded .md files

    Returns:
        Updated ConfiguredRepository or None if not found
    """
    return await self.update_repository(
        repository_id,
        use_template_execution=enabled
    )
```

**VALIDATE**: `uv run python -c "from src.agent_work_orders.state_manager.repository_config_repository import RepositoryConfigRepository; import inspect; assert hasattr(RepositoryConfigRepository, 'apply_workflow_template'); print('✓ Repository methods added')"`

---

### TASK 4: Create RepositoryAgentOverrideRepository

**File**: `python/src/agent_work_orders/state_manager/repository_agent_override_repository.py` (NEW)

**CREATE** new repository following `repository_config_repository.py` pattern:
```python
"""Repository Agent Override Repository

Manages agent tool/standard overrides for specific repositories.
"""

import os
from datetime import UTC, datetime
from typing import Any

from supabase import Client, create_client

from ..models import RepositoryAgentOverride
from ..utils.structured_logger import get_logger

logger = get_logger(__name__)


def get_supabase_client() -> Client:
    """Get Supabase client (reuse from repository_config_repository)"""
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_KEY")

    if not url or not key:
        raise ValueError(
            "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set"
        )

    return create_client(url, key)


class RepositoryAgentOverrideRepository:
    """Repository for managing agent overrides per repository"""

    def __init__(self) -> None:
        self.client: Client = get_supabase_client()
        self.table_name: str = "archon_repository_agent_overrides"
        self._logger = logger.bind(table=self.table_name)
        self._logger.info("repository_agent_override_repository_initialized")

    def _row_to_model(self, row: dict[str, Any]) -> RepositoryAgentOverride:
        """Convert database row to model"""
        return RepositoryAgentOverride(
            id=row["id"],
            repository_id=row["repository_id"],
            agent_template_id=row["agent_template_id"],
            override_tools=row.get("override_tools"),
            override_standards=row.get("override_standards"),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    async def list_by_repository(
        self,
        repository_id: str
    ) -> list[RepositoryAgentOverride]:
        """List all agent overrides for a repository"""
        try:
            response = (
                self.client.table(self.table_name)
                .select("*")
                .eq("repository_id", repository_id)
                .execute()
            )

            overrides = [self._row_to_model(row) for row in response.data]

            self._logger.info(
                "agent_overrides_listed",
                repository_id=repository_id,
                count=len(overrides)
            )

            return overrides

        except Exception as e:
            self._logger.exception(
                "list_agent_overrides_failed",
                repository_id=repository_id,
                error=str(e)
            )
            raise

    async def get_override(
        self,
        repository_id: str,
        agent_template_id: str
    ) -> RepositoryAgentOverride | None:
        """Get specific agent override for repository"""
        try:
            response = (
                self.client.table(self.table_name)
                .select("*")
                .eq("repository_id", repository_id)
                .eq("agent_template_id", agent_template_id)
                .execute()
            )

            if not response.data:
                return None

            return self._row_to_model(response.data[0])

        except Exception as e:
            self._logger.exception(
                "get_agent_override_failed",
                repository_id=repository_id,
                agent_template_id=agent_template_id,
                error=str(e)
            )
            raise

    async def create_override(
        self,
        repository_id: str,
        agent_template_id: str,
        override_tools: list[str] | None = None,
        override_standards: dict[str, Any] | None = None,
    ) -> RepositoryAgentOverride:
        """Create agent override for repository"""
        try:
            data: dict[str, Any] = {
                "repository_id": repository_id,
                "agent_template_id": agent_template_id,
                "override_tools": override_tools,
                "override_standards": override_standards,
            }

            response = self.client.table(self.table_name).insert(data).execute()

            override = self._row_to_model(response.data[0])

            self._logger.info(
                "agent_override_created",
                override_id=override.id,
                repository_id=repository_id,
                agent_template_id=agent_template_id
            )

            return override

        except Exception as e:
            self._logger.exception(
                "create_agent_override_failed",
                repository_id=repository_id,
                agent_template_id=agent_template_id,
                error=str(e)
            )
            raise

    async def update_override(
        self,
        repository_id: str,
        agent_template_id: str,
        **updates: Any
    ) -> RepositoryAgentOverride | None:
        """Update agent override"""
        try:
            updates["updated_at"] = datetime.now(UTC).isoformat()

            response = (
                self.client.table(self.table_name)
                .update(updates)
                .eq("repository_id", repository_id)
                .eq("agent_template_id", agent_template_id)
                .execute()
            )

            if not response.data:
                return None

            override = self._row_to_model(response.data[0])

            self._logger.info(
                "agent_override_updated",
                repository_id=repository_id,
                agent_template_id=agent_template_id,
                updated_fields=list(updates.keys())
            )

            return override

        except Exception as e:
            self._logger.exception(
                "update_agent_override_failed",
                repository_id=repository_id,
                agent_template_id=agent_template_id,
                error=str(e)
            )
            raise

    async def delete_override(
        self,
        repository_id: str,
        agent_template_id: str
    ) -> bool:
        """Delete agent override"""
        try:
            response = (
                self.client.table(self.table_name)
                .delete()
                .eq("repository_id", repository_id)
                .eq("agent_template_id", agent_template_id)
                .execute()
            )

            deleted = len(response.data) > 0

            if deleted:
                self._logger.info(
                    "agent_override_deleted",
                    repository_id=repository_id,
                    agent_template_id=agent_template_id
                )

            return deleted

        except Exception as e:
            self._logger.exception(
                "delete_agent_override_failed",
                repository_id=repository_id,
                agent_template_id=agent_template_id,
                error=str(e)
            )
            raise
```

**VALIDATE**: `uv run python -c "from src.agent_work_orders.state_manager.repository_agent_override_repository import RepositoryAgentOverrideRepository; print('✓ Override repository created')"`

---

### TASK 5: Add API Routes

**File**: `python/src/agent_work_orders/api/routes.py`

**ADD** routes after existing repository endpoints (around line 400):
```python
# Phase 2: Repository Template Linking


@router.put(
    "/repositories/{repository_id}/workflow-template",
    response_model=ConfiguredRepository,
    summary="Apply workflow template to repository"
)
async def apply_workflow_template_to_repository(
    repository_id: str,
    request: dict[str, str]  # {"workflow_template_id": "uuid"}
) -> ConfiguredRepository:
    """Apply a Context Hub workflow template to a repository"""
    try:
        workflow_template_id = request.get("workflow_template_id")
        if not workflow_template_id:
            raise HTTPException(400, "workflow_template_id required")

        repo_repository = RepositoryConfigRepository()
        repository = await repo_repository.apply_workflow_template(
            repository_id,
            workflow_template_id
        )

        if not repository:
            raise HTTPException(404, f"Repository {repository_id} not found")

        logger.info(
            "workflow_template_applied",
            repository_id=repository_id,
            workflow_template_id=workflow_template_id
        )

        return repository

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(
            "apply_workflow_template_failed",
            repository_id=repository_id,
            error=str(e)
        )
        raise HTTPException(500, f"Failed to apply template: {str(e)}")


@router.put(
    "/repositories/{repository_id}/priming-context",
    response_model=ConfiguredRepository,
    summary="Update repository priming context"
)
async def update_repository_priming_context(
    repository_id: str,
    priming_context: dict[str, Any]
) -> ConfiguredRepository:
    """Update repository-specific priming context"""
    try:
        repo_repository = RepositoryConfigRepository()
        repository = await repo_repository.update_priming_context(
            repository_id,
            priming_context
        )

        if not repository:
            raise HTTPException(404, f"Repository {repository_id} not found")

        logger.info(
            "priming_context_updated",
            repository_id=repository_id,
            context_keys=list(priming_context.keys())
        )

        return repository

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(
            "update_priming_context_failed",
            repository_id=repository_id,
            error=str(e)
        )
        raise HTTPException(500, f"Failed to update priming context: {str(e)}")


@router.put(
    "/repositories/{repository_id}/coding-standards",
    response_model=ConfiguredRepository,
    summary="Assign coding standards to repository"
)
async def assign_coding_standards_to_repository(
    repository_id: str,
    request: dict[str, list[str]]  # {"coding_standard_ids": ["uuid1", "uuid2"]}
) -> ConfiguredRepository:
    """Assign coding standards from Context Hub to repository"""
    try:
        coding_standard_ids = request.get("coding_standard_ids", [])

        repo_repository = RepositoryConfigRepository()
        repository = await repo_repository.assign_coding_standards(
            repository_id,
            coding_standard_ids
        )

        if not repository:
            raise HTTPException(404, f"Repository {repository_id} not found")

        logger.info(
            "coding_standards_assigned",
            repository_id=repository_id,
            standard_count=len(coding_standard_ids)
        )

        return repository

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(
            "assign_coding_standards_failed",
            repository_id=repository_id,
            error=str(e)
        )
        raise HTTPException(500, f"Failed to assign coding standards: {str(e)}")


@router.get(
    "/repositories/{repository_id}/agent-overrides",
    response_model=list[RepositoryAgentOverride],
    summary="List agent overrides for repository"
)
async def list_repository_agent_overrides(
    repository_id: str
) -> list[RepositoryAgentOverride]:
    """List all agent overrides for a repository"""
    try:
        override_repository = RepositoryAgentOverrideRepository()
        return await override_repository.list_by_repository(repository_id)

    except Exception as e:
        logger.exception(
            "list_agent_overrides_failed",
            repository_id=repository_id,
            error=str(e)
        )
        raise HTTPException(500, f"Failed to list agent overrides: {str(e)}")


@router.put(
    "/repositories/{repository_id}/agent-overrides/{agent_template_id}",
    response_model=RepositoryAgentOverride,
    summary="Create or update agent override"
)
async def upsert_agent_override(
    repository_id: str,
    agent_template_id: str,
    request: CreateRepositoryAgentOverrideRequest | UpdateRepositoryAgentOverrideRequest
) -> RepositoryAgentOverride:
    """Create or update agent tool/standard override for repository"""
    try:
        override_repository = RepositoryAgentOverrideRepository()

        # Check if override exists
        existing = await override_repository.get_override(
            repository_id,
            agent_template_id
        )

        if existing:
            # Update existing
            updated = await override_repository.update_override(
                repository_id,
                agent_template_id,
                override_tools=request.override_tools,
                override_standards=request.override_standards
            )
            if not updated:
                raise HTTPException(404, "Override not found")
            return updated
        else:
            # Create new
            return await override_repository.create_override(
                repository_id=repository_id,
                agent_template_id=agent_template_id,
                override_tools=request.override_tools,
                override_standards=request.override_standards
            )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(
            "upsert_agent_override_failed",
            repository_id=repository_id,
            agent_template_id=agent_template_id,
            error=str(e)
        )
        raise HTTPException(500, f"Failed to upsert agent override: {str(e)}")


@router.delete(
    "/repositories/{repository_id}/agent-overrides/{agent_template_id}",
    summary="Delete agent override"
)
async def delete_agent_override(
    repository_id: str,
    agent_template_id: str
) -> dict[str, str]:
    """Delete agent override for repository"""
    try:
        override_repository = RepositoryAgentOverrideRepository()
        deleted = await override_repository.delete_override(
            repository_id,
            agent_template_id
        )

        if not deleted:
            raise HTTPException(404, "Override not found")

        return {"message": "Agent override deleted successfully"}

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(
            "delete_agent_override_failed",
            repository_id=repository_id,
            agent_template_id=agent_template_id,
            error=str(e)
        )
        raise HTTPException(500, f"Failed to delete agent override: {str(e)}")
```

**IMPORTS** to add at top of file:
```python
from ..state_manager.repository_agent_override_repository import RepositoryAgentOverrideRepository
```

**VALIDATE**: `uv run ruff check src/agent_work_orders/api/routes.py && echo "✓ API routes added"`

---

## Frontend Implementation

### TASK 6: Update Repository Types

**File**: `archon-ui-main/src/features/agent-work-orders/types/repository.ts`

**UPDATE** ConfiguredRepository type to match backend:
```typescript
export interface ConfiguredRepository {
  id: string;
  repository_url: string;
  display_name: string | null;
  owner: string | null;
  default_branch: string | null;
  is_verified: boolean;
  last_verified_at: string | null;
  default_sandbox_type: SandboxType;
  default_commands: WorkflowStep[];

  // Phase 2: Template linking fields
  workflow_template_id: string | null;
  coding_standard_ids: string[];
  priming_context: Record<string, any>;
  use_template_execution: boolean;

  created_at: string;
  updated_at: string;
}

export interface RepositoryAgentOverride {
  id: string;
  repository_id: string;
  agent_template_id: string;
  override_tools: string[] | null;
  override_standards: Record<string, any> | null;
  created_at: string;
  updated_at: string;
}

export interface ApplyWorkflowTemplateRequest {
  workflow_template_id: string;
}

export interface UpdatePrimingContextRequest {
  priming_context: Record<string, any>;
}

export interface AssignCodingStandardsRequest {
  coding_standard_ids: string[];
}

export interface UpsertAgentOverrideRequest {
  override_tools?: string[] | null;
  override_standards?: Record<string, any> | null;
}
```

**VALIDATE**: `npx tsc --noEmit 2>&1 | grep "src/features/agent-work-orders/types" || echo "✓ Types updated"`

---

### TASK 7: Extend Repository Service

**File**: `archon-ui-main/src/features/agent-work-orders/services/repositoryService.ts`

**ADD** methods after existing repository methods:
```typescript
// Phase 2: Template Linking

async applyWorkflowTemplate(
  repositoryId: string,
  workflowTemplateId: string
): Promise<ConfiguredRepository> {
  const response = await apiClient.put<ConfiguredRepository>(
    `/agent-work-orders/repositories/${repositoryId}/workflow-template`,
    { workflow_template_id: workflowTemplateId }
  );
  return response.data;
},

async updatePrimingContext(
  repositoryId: string,
  primingContext: Record<string, any>
): Promise<ConfiguredRepository> {
  const response = await apiClient.put<ConfiguredRepository>(
    `/agent-work-orders/repositories/${repositoryId}/priming-context`,
    primingContext
  );
  return response.data;
},

async assignCodingStandards(
  repositoryId: string,
  codingStandardIds: string[]
): Promise<ConfiguredRepository> {
  const response = await apiClient.put<ConfiguredRepository>(
    `/agent-work-orders/repositories/${repositoryId}/coding-standards`,
    { coding_standard_ids: codingStandardIds }
  );
  return response.data;
},

async listAgentOverrides(
  repositoryId: string
): Promise<RepositoryAgentOverride[]> {
  const response = await apiClient.get<RepositoryAgentOverride[]>(
    `/agent-work-orders/repositories/${repositoryId}/agent-overrides`
  );
  return response.data;
},

async upsertAgentOverride(
  repositoryId: string,
  agentTemplateId: string,
  request: UpsertAgentOverrideRequest
): Promise<RepositoryAgentOverride> {
  const response = await apiClient.put<RepositoryAgentOverride>(
    `/agent-work-orders/repositories/${repositoryId}/agent-overrides/${agentTemplateId}`,
    request
  );
  return response.data;
},

async deleteAgentOverride(
  repositoryId: string,
  agentTemplateId: string
): Promise<void> {
  await apiClient.delete(
    `/agent-work-orders/repositories/${repositoryId}/agent-overrides/${agentTemplateId}`
  );
},
```

**VALIDATE**: `npx tsc --noEmit 2>&1 | grep "repositoryService" || echo "✓ Service methods added"`

---

### TASK 8: Extend EditRepositoryModal - Add Template Configuration Tab

**File**: `archon-ui-main/src/features/agent-work-orders/components/EditRepositoryModal.tsx`

**PATTERN**: Follow `EditWorkflowModal.tsx` from Phase 1 which uses tabs

**ADD** imports:
```typescript
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/features/ui/primitives/tabs";
import { useWorkflowTemplates } from "@/features/context-hub/hooks/useWorkflowTemplates";
import { useCodingStandards } from "@/features/context-hub/hooks/useCodingStandards";
```

**UPDATE** modal to include tabs:
```typescript
// Tab 1: Basic Info (existing content)
// Tab 2: Template Configuration (new)
// Tab 3: Priming Context (new)
// Tab 4: Agent Overrides (new)

<Tabs defaultValue="basic">
  <TabsList>
    <TabsTrigger value="basic">Basic Info</TabsTrigger>
    <TabsTrigger value="template">Template</TabsTrigger>
    <TabsTrigger value="priming">Priming Context</TabsTrigger>
    <TabsTrigger value="agents">Agent Overrides</TabsTrigger>
  </TabsList>

  <TabsContent value="basic">
    {/* Existing repository edit fields */}
  </TabsContent>

  <TabsContent value="template">
    <TemplateConfigTab
      repository={repository}
      onUpdate={handleTemplateUpdate}
    />
  </TabsContent>

  <TabsContent value="priming">
    <PrimingContextTab
      repository={repository}
      onUpdate={handlePrimingUpdate}
    />
  </TabsContent>

  <TabsContent value="agents">
    <AgentOverridesTab
      repository={repository}
    />
  </TabsContent>
</Tabs>
```

**CREATE** tab components inline or as separate files:
- `TemplateConfigTab` - Select workflow template, assign coding standards
- `PrimingContextTab` - JSON editor for priming_context
- `AgentOverridesTab` - List/edit agent overrides

**VALIDATE**: `npm run biome:fix && npx tsc --noEmit 2>&1 | grep "EditRepositoryModal" || echo "✓ Modal extended"`

---

### TASK 9: Document Existing Step Selection Feature

**File**: `PRPs/FEATURE_DOCS.md` (NEW)

**CREATE** documentation file:
```markdown
# Agent Work Orders - Feature Documentation

## Step Selection (Existing Feature - Phase 0)

### Overview
Users can select which workflow steps to execute when creating a work order.
This feature already exists in the UI and backend - Phase 2 documents it.

### UI Location
- **Component**: `CreateWorkOrderModal.tsx`
- **Field**: "Selected Commands" checkboxes
- **Default**: All steps enabled (create-branch, planning, execute, commit, create-pr)

### Backend Implementation
- **Model**: `CreateAgentWorkOrderRequest.selected_commands`
- **Type**: `list[WorkflowStep]`
- **Validation**: Only valid WorkflowStep enum values allowed
- **Execution**: WorkflowOrchestrator executes only selected steps

### Usage Example
```typescript
// User unchecks "planning" and "execute" steps
// Only creates branch, commits, and creates PR
selected_commands: [
  "create-branch",
  "commit",
  "create-pr"
]
```

### Integration with Phase 2
- Phase 2: Repository has default_commands field
- These defaults populate the checkbox UI
- User can override per work order
- Phase 3: Template execution will respect selected_commands

### Testing
```bash
# Create work order with only planning step
curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -d '{
    "repository_url": "...",
    "user_request": "...",
    "selected_commands": ["planning"]
  }'

# Verify: Only planning step executes
curl -N http://localhost:8053/api/agent-work-orders/{id}/logs/stream | grep "command"
# Should only see: planning.md
```

---

## Phase 2: Priming Context Examples

Priming context is repository-specific information injected into agent prompts.

### Example 1: Monorepo Paths
```json
{
  "paths": {
    "frontend": "apps/web/src",
    "backend": "services/api/src",
    "shared": "packages/shared/src"
  },
  "architecture": "Turborepo monorepo with Next.js frontend and FastAPI backend"
}
```

### Example 2: Microservices
```json
{
  "services": {
    "auth": "services/auth-service",
    "api": "services/api-gateway",
    "worker": "services/background-worker"
  },
  "database": "PostgreSQL with Prisma ORM",
  "message_queue": "RabbitMQ for async jobs"
}
```

### Example 3: Testing Patterns
```json
{
  "test_framework": "pytest",
  "test_location": "tests/ directory (mirrors src/)",
  "conventions": {
    "unit_tests": "tests/unit/test_{module}.py",
    "integration_tests": "tests/integration/test_{feature}.py",
    "fixtures": "tests/conftest.py"
  }
}
```

### How Priming Context is Used

**Phase 2**: Stored in database, editable via UI
**Phase 3**: Injected into agent prompts as `{{priming_context}}` variable
**Example Prompt Template**:
```
You are working on: {{repository.display_name}}

Architecture:
{{priming_context.architecture}}

Key Paths:
{{priming_context.paths}}

User Request: {{user_request}}
```
```

**VALIDATE**: `ls -l PRPs/FEATURE_DOCS.md && echo "✓ Documentation created"`

---

## Validation Loop

### Level 1: Syntax & Style

```bash
# Backend
uv run ruff check src/agent_work_orders/models.py src/agent_work_orders/state_manager/repository_agent_override_repository.py src/agent_work_orders/api/routes.py --fix
uv run mypy src/agent_work_orders/

# Frontend
npx tsc --noEmit 2>&1 | grep "src/features/agent-work-orders"
npm run biome:fix

# Expected: Zero errors
```

### Level 2: Unit Tests

```bash
# Backend - Repository tests
uv run pytest python/tests/agent_work_orders/state_manager/test_repository_config_repository.py -v
uv run pytest python/tests/agent_work_orders/state_manager/test_repository_agent_override_repository.py -v

# Frontend - Service tests
npm run test src/features/agent-work-orders/services/repositoryService.test.ts
```

### Level 3: Integration Testing

```bash
# Start services
docker compose --profile backend up -d
uv run python -m uvicorn src.agent_work_orders.server:app --port 8053 --reload &

# Test template application
curl -X PUT http://localhost:8053/api/agent-work-orders/repositories/{repo_id}/workflow-template \
  -H "Content-Type: application/json" \
  -d '{"workflow_template_id": "workflow-uuid"}' | jq

# Expected: Returns repository with workflow_template_id populated

# Test priming context
curl -X PUT http://localhost:8053/api/agent-work-orders/repositories/{repo_id}/priming-context \
  -H "Content-Type: application/json" \
  -d '{"paths": {"frontend": "apps/web"}}' | jq

# Expected: Returns repository with priming_context populated

# Test coding standards assignment
curl -X PUT http://localhost:8053/api/agent-work-orders/repositories/{repo_id}/coding-standards \
  -H "Content-Type: application/json" \
  -d '{"coding_standard_ids": ["standard-uuid-1", "standard-uuid-2"]}' | jq

# Expected: Returns repository with coding_standard_ids array populated

# Test agent override
curl -X PUT http://localhost:8053/api/agent-work-orders/repositories/{repo_id}/agent-overrides/agent-uuid \
  -H "Content-Type: application/json" \
  -d '{"override_tools": ["Read", "Write", "Bash"]}' | jq

# Expected: Returns RepositoryAgentOverride with override_tools populated
```

### Level 4: UI Manual Testing

```
1. Navigate to Agent Work Orders page
2. Edit a repository (opens modal)
3. Switch to "Template" tab
   - Select a workflow template from Context Hub
   - Assign coding standards
   - Save
4. Switch to "Priming Context" tab
   - Edit JSON context (paths, architecture)
   - Save
5. Switch to "Agent Overrides" tab
   - Override tools for an agent
   - Save
6. Verify all changes persist after page refresh
7. Verify repository card displays template name
```

---

## COMPLETION CHECKLIST

- [ ] ConfiguredRepository model updated with Phase 2 fields
- [ ] RepositoryAgentOverride model created
- [ ] RepositoryConfigRepository extended with template methods
- [ ] RepositoryAgentOverrideRepository created
- [ ] API routes added for template linking
- [ ] Frontend types updated
- [ ] Repository service extended
- [ ] EditRepositoryModal extended with tabs
- [ ] Step selection feature documented
- [ ] All syntax/type checks pass
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] UI manual testing complete

---

## Notes

### Phase 2 Delivers
1. ✅ Repository-to-template linking (workflow_template_id)
2. ✅ Priming context storage and editing
3. ✅ Coding standards assignment
4. ✅ Agent tool/standard overrides
5. ✅ Documentation of existing step selection feature

### Phase 2 Does NOT Execute Templates
- Templates are linked but NOT executed
- `use_template_execution` flag added but defaults to `false`
- Phase 3 will implement template execution engine
- Phase 2 is pure storage and UI for configuration

### Ready for Phase 3 When
- [ ] All Phase 2 validation gates passed
- [ ] Repository configurations created via UI
- [ ] Templates, coding standards, priming context stored
- [ ] Agent overrides working
- [ ] Ready to build TemplateResolver (Phase 3)

<!-- EOF -->
