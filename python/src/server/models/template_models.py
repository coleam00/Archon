"""Context Engineering Hub - Template System Models

All models for the template library system accessible via MCP server.
These are core Archon models, not AWO-specific.
"""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

# =====================================================
# TEMPLATE SYSTEM MODELS (Context Engineering Hub)
# =====================================================


class AgentTemplate(BaseModel):
    """Agent template with prompts, tools, and standards

    Templates define reusable agent configurations that can be applied
    to repositories. Versioning is supported via parent_template_id.
    """

    id: str = Field(..., description="UUID identifier")
    slug: str = Field(..., description="Unique slug identifier")
    name: str = Field(..., description="Human-readable name")
    description: str | None = Field(None, description="Template description")
    system_prompt: str = Field(..., description="System prompt for the agent")
    model: str = Field(default="sonnet", description="Model name (e.g., 'sonnet', 'opus')")
    temperature: float = Field(default=0.0, description="Model temperature (0.0-1.0)")
    tools: list[str] = Field(default_factory=list, description="Tool names: ['Read', 'Write', 'Edit', 'Bash']")
    standards: dict[str, Any] = Field(default_factory=dict, description="Default coding standards")
    metadata: dict[str, Any] = Field(default_factory=dict, description="Additional metadata")
    is_active: bool = Field(default=True, description="Whether template is active")
    version: int = Field(default=1, description="Version number (increments on update)")
    parent_template_id: str | None = Field(None, description="Parent template UUID (for versioning)")
    created_by: str | None = Field(None, description="Creator identifier")
    created_at: datetime = Field(..., description="Creation timestamp")
    updated_at: datetime = Field(..., description="Last update timestamp")


class StepTemplate(BaseModel):
    """Step template with optional sub-workflow support

    Steps can be single-agent (agent_template_id set, sub_steps empty) or
    multi-agent (agent_template_id null, sub_steps populated).
    """

    id: str = Field(..., description="UUID identifier")
    step_type: str = Field(..., description="Step type: planning, implement, validate, prime, git")
    slug: str = Field(..., description="Unique slug identifier")
    name: str = Field(..., description="Human-readable name")
    description: str | None = Field(None, description="Template description")
    prompt_template: str = Field(..., description="Prompt template with {{variables}}")
    agent_template_id: str | None = Field(None, description="Agent template UUID (null for multi-agent)")
    sub_steps: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Sub-workflow steps: [{order, name, agent_template_slug, prompt_template, required}, ...]"
    )
    metadata: dict[str, Any] = Field(default_factory=dict, description="Additional metadata")
    is_active: bool = Field(default=True, description="Whether template is active")
    version: int = Field(default=1, description="Version number")
    parent_template_id: str | None = Field(None, description="Parent template UUID")
    created_by: str | None = Field(None, description="Creator identifier")
    created_at: datetime = Field(..., description="Creation timestamp")
    updated_at: datetime = Field(..., description="Last update timestamp")


class WorkflowTemplate(BaseModel):
    """Workflow template defining step sequence

    Workflows define the execution order of steps (planning, implement, validate).
    GitHub operations (create-branch, commit, create-pr) are hardcoded and not in templates.
    """

    id: str = Field(..., description="UUID identifier")
    slug: str = Field(..., description="Unique slug identifier")
    name: str = Field(..., description="Human-readable name")
    description: str | None = Field(None, description="Template description")
    steps: list[dict[str, Any]] = Field(
        ...,
        description="Step sequence: [{step_type, order, step_template_slug}, ...]"
    )
    metadata: dict[str, Any] = Field(default_factory=dict, description="Additional metadata")
    is_active: bool = Field(default=True, description="Whether template is active")
    created_by: str | None = Field(None, description="Creator identifier")
    created_at: datetime = Field(..., description="Creation timestamp")
    updated_at: datetime = Field(..., description="Last update timestamp")


class CodingStandard(BaseModel):
    """Coding standard with linter/formatter rules

    Reusable coding standards that can be assigned to repositories.
    """

    id: str = Field(..., description="UUID identifier")
    slug: str = Field(..., description="Unique slug identifier")
    name: str = Field(..., description="Human-readable name")
    description: str | None = Field(None, description="Standard description")
    language: str = Field(..., description="Programming language (e.g., 'python', 'typescript')")
    standards: dict[str, Any] = Field(
        default_factory=dict,
        description="Standard configuration: {linter, rules, min_coverage, etc.}"
    )
    metadata: dict[str, Any] = Field(default_factory=dict, description="Additional metadata")
    is_active: bool = Field(default=True, description="Whether standard is active")
    created_by: str | None = Field(None, description="Creator identifier")
    created_at: datetime = Field(..., description="Creation timestamp")
    updated_at: datetime = Field(..., description="Last update timestamp")


class RepositoryAgentOverride(BaseModel):
    """Repository-specific agent overrides

    Allows customizing agent tools/standards per repository without modifying templates.
    """

    id: str = Field(..., description="UUID identifier")
    configured_repository_id: str = Field(..., description="Repository UUID")
    agent_template_id: str = Field(..., description="Agent template UUID")
    override_tools: list[str] | None = Field(None, description="Override tool list")
    override_standards: dict[str, Any] | None = Field(None, description="Override coding standards")
    override_prompt_additions: str | None = Field(None, description="Additional prompt text")
    is_active: bool = Field(default=True, description="Whether override is active")
    created_at: datetime = Field(..., description="Creation timestamp")
    updated_at: datetime = Field(..., description="Last update timestamp")


# =====================================================
# REQUEST/RESPONSE MODELS
# =====================================================


class CreateAgentTemplateRequest(BaseModel):
    """Request to create a new agent template"""

    name: str
    slug: str
    description: str | None = None
    system_prompt: str
    model: str = "sonnet"
    temperature: float = 0.0
    tools: list[str] = []
    standards: dict[str, Any] = {}
    metadata: dict[str, Any] = {}


class UpdateAgentTemplateRequest(BaseModel):
    """Request to update an agent template (creates new version)"""

    name: str | None = None
    description: str | None = None
    system_prompt: str | None = None
    model: str | None = None
    temperature: float | None = None
    tools: list[str] | None = None
    standards: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None
    is_active: bool | None = None


class CreateStepTemplateRequest(BaseModel):
    """Request to create a new step template"""

    step_type: str
    name: str
    slug: str
    description: str | None = None
    prompt_template: str
    agent_template_id: str | None = None
    sub_steps: list[dict[str, Any]] = []
    metadata: dict[str, Any] = {}


class UpdateStepTemplateRequest(BaseModel):
    """Request to update a step template"""

    step_type: str | None = None
    name: str | None = None
    description: str | None = None
    prompt_template: str | None = None
    agent_template_id: str | None = None
    sub_steps: list[dict[str, Any]] | None = None
    metadata: dict[str, Any] | None = None
    is_active: bool | None = None


class CreateWorkflowTemplateRequest(BaseModel):
    """Request to create a new workflow template"""

    name: str
    slug: str
    description: str | None = None
    steps: list[dict[str, Any]]
    metadata: dict[str, Any] = {}


class UpdateWorkflowTemplateRequest(BaseModel):
    """Request to update a workflow template"""

    name: str | None = None
    description: str | None = None
    steps: list[dict[str, Any]] | None = None
    metadata: dict[str, Any] | None = None
    is_active: bool | None = None


class CreateCodingStandardRequest(BaseModel):
    """Request to create a new coding standard"""

    name: str
    slug: str
    description: str | None = None
    language: str
    standards: dict[str, Any]
    metadata: dict[str, Any] = {}


class UpdateCodingStandardRequest(BaseModel):
    """Request to update a coding standard"""

    name: str | None = None
    description: str | None = None
    language: str | None = None
    standards: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None
