"""
Pydantic Models for Archon Project Management

This module defines Pydantic models for:
- Project Requirements Document (PRD) structure
- General document schema for the docs table
- Project and task data models
"""

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, validator


class DocumentType(str, Enum):
    """Enumeration of supported document types"""

    PRD = "prd"
    FEATURE_PLAN = "feature_plan"
    ERD = "erd"
    TECHNICAL_SPEC = "technical_spec"
    USER_STORY = "user_story"
    API_SPEC = "api_spec"


class Priority(str, Enum):
    """Priority levels for goals and user stories"""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class UserStory(BaseModel):
    """Individual user story within a PRD"""

    id: str = Field(..., description="Unique identifier for the user story")
    title: str = Field(..., description="Brief title of the user story")
    description: str = Field(..., description="As a [user], I want [goal] so that [benefit]")
    acceptance_criteria: list[str] = Field(
        default_factory=list, description="List of acceptance criteria"
    )
    priority: Priority = Field(default=Priority.MEDIUM, description="Priority level")
    estimated_effort: str | None = Field(
        None, description="Effort estimate (e.g., 'Small', 'Medium', 'Large')"
    )
    status: str = Field(default="draft", description="Status of the user story")


class Goal(BaseModel):
    """Individual goal within a PRD"""

    id: str = Field(..., description="Unique identifier for the goal")
    title: str = Field(..., description="Brief title of the goal")
    description: str = Field(..., description="Detailed description of the goal")
    priority: Priority = Field(default=Priority.MEDIUM, description="Priority level")
    success_metrics: list[str] = Field(
        default_factory=list, description="How success will be measured"
    )


class TechnicalRequirement(BaseModel):
    """Technical requirements and constraints"""

    category: str = Field(
        ..., description="Category (e.g., 'Performance', 'Security', 'Scalability')"
    )
    description: str = Field(..., description="Detailed requirement description")
    priority: Priority = Field(default=Priority.MEDIUM, description="Priority level")


class ProjectRequirementsDocument(BaseModel):
    """
    Pydantic model for Project Requirements Document (PRD) structure.
    This model defines the schema for PRD documents stored as JSONB.
    """

    # Basic Information
    title: str = Field(..., description="Title of the project")
    description: str = Field(default="", description="Brief project description")
    version: str = Field(default="1.0", description="Document version")
    last_updated: datetime = Field(
        default_factory=datetime.now, description="Last update timestamp"
    )

    # Project Details
    goals: list[Goal] = Field(default_factory=list, description="List of project goals")
    user_stories: list[UserStory] = Field(default_factory=list, description="List of user stories")

    # Scope and Context
    scope: str = Field(default="", description="Project scope definition")
    out_of_scope: list[str] = Field(
        default_factory=list, description="What is explicitly out of scope"
    )
    assumptions: list[str] = Field(default_factory=list, description="Project assumptions")
    constraints: list[str] = Field(default_factory=list, description="Project constraints")

    # Technical Requirements
    technical_requirements: list[TechnicalRequirement] = Field(
        default_factory=list, description="Technical requirements and constraints"
    )

    # Stakeholders and Timeline
    stakeholders: list[str] = Field(default_factory=list, description="Key stakeholders")
    timeline: dict[str, Any] = Field(
        default_factory=dict, description="Project timeline and milestones"
    )

    # Success Criteria
    success_criteria: list[str] = Field(
        default_factory=list, description="Overall project success criteria"
    )

    @validator("last_updated", pre=True, always=True)
    def set_last_updated(cls, v):
        return v or datetime.now()


class GeneralDocument(BaseModel):
    """
    Pydantic model for general document structure in the docs table.
    This provides a flexible schema for various document types.
    """

    # Document Metadata
    id: str | None = Field(None, description="Document UUID (auto-generated)")
    project_id: str = Field(..., description="Associated project UUID")
    document_type: DocumentType = Field(..., description="Type of document")
    title: str = Field(..., description="Document title")

    # Content
    content: ProjectRequirementsDocument | dict[str, Any] = Field(
        ..., description="Document content (typed for PRD, flexible for others)"
    )

    # Metadata
    version: str = Field(default="1.0", description="Document version")
    status: str = Field(default="draft", description="Document status (draft, review, approved)")
    tags: list[str] = Field(default_factory=list, description="Document tags for categorization")
    author: str | None = Field(None, description="Document author")

    # Timestamps
    created_at: datetime | None = Field(None, description="Creation timestamp")
    updated_at: datetime | None = Field(None, description="Last update timestamp")

    @validator("created_at", "updated_at", pre=True, always=True)
    def set_timestamps(cls, v):
        return v or datetime.now()


class CreateDocumentRequest(BaseModel):
    """Request model for creating a new document"""

    project_id: str = Field(..., description="Associated project UUID")
    document_type: DocumentType = Field(..., description="Type of document")
    title: str = Field(..., description="Document title")
    content: dict[str, Any] = Field(default_factory=dict, description="Document content")
    tags: list[str] = Field(default_factory=list, description="Document tags")
    author: str | None = Field(None, description="Document author")


class UpdateDocumentRequest(BaseModel):
    """Request model for updating an existing document"""

    title: str | None = Field(None, description="Updated document title")
    content: dict[str, Any] | None = Field(None, description="Updated document content")
    status: str | None = Field(None, description="Updated document status")
    tags: list[str] | None = Field(None, description="Updated document tags")
    author: str | None = Field(None, description="Updated document author")
    version: str | None = Field(None, description="Updated document version")


# Helper functions for creating default documents


def create_default_prd(project_title: str) -> ProjectRequirementsDocument:
    """Create a default PRD structure for a new project"""
    return ProjectRequirementsDocument(
        title=f"{project_title} - Requirements",
        description=f"Product Requirements Document for {project_title}",
        goals=[
            Goal(
                id="goal-1",
                title="Define Project Objectives",
                description="Clearly outline what this project aims to achieve",
                priority=Priority.HIGH,
                success_metrics=["Clear problem statement", "Defined success criteria"],
            )
        ],
        user_stories=[
            UserStory(
                id="story-1",
                title="Project Initialization",
                description="As a project manager, I want to define the project scope so that the team understands the objectives",
                acceptance_criteria=["PRD is created", "Stakeholders review and approve"],
                priority=Priority.HIGH,
            )
        ],
        technical_requirements=[
            TechnicalRequirement(
                category="Architecture",
                description="Define the overall system architecture and technology stack",
                priority=Priority.HIGH,
            )
        ],
        success_criteria=[
            "Project delivers defined features on time",
            "Quality meets established standards",
            "Stakeholder satisfaction achieved",
        ],
    )


def create_default_document(
    project_id: str, document_type: DocumentType, title: str
) -> GeneralDocument:
    """Create a default document based on type"""
    content = {}

    if document_type == DocumentType.PRD:
        # Extract project title from the title (assuming format like "Project Name - Requirements")
        project_title = title.replace(" - Requirements", "").strip()
        content = create_default_prd(project_title).dict()

    return GeneralDocument(
        project_id=project_id,
        document_type=document_type,
        title=title,
        content=content,
        tags=["default", document_type.value],
    )
