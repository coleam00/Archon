"""
DocumentAgent - Conversational Document Management with PydanticAI

This agent enables users to create, update, and modify project documents through
natural conversation. It uses the established Pydantic AI patterns and integrates
with our existing MCP project management tools.
"""

import json
import logging
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from pydantic import BaseModel, Field
from pydantic_ai import Agent, RunContext

from .base_agent import ArchonDependencies, BaseAgent
from .mcp_client import get_mcp_client

logger = logging.getLogger(__name__)


@dataclass
class DocumentDependencies(ArchonDependencies):
    """Dependencies for document operations."""

    project_id: str = ""  # Required but needs default value due to parent class having defaults
    current_document_id: str | None = None
    progress_callback: Any | None = None  # Callback for progress updates


class DocumentOperation(BaseModel):
    """Structured output for document operations."""

    operation_type: str = Field(description="Type of operation: create, update, delete, query")
    document_id: str | None = Field(description="ID of the document affected")
    document_type: str | None = Field(
        description="Type of document: prd, technical_spec, meeting_notes, etc."
    )
    title: str | None = Field(description="Document title")
    changes_made: list[str] = Field(description="List of specific changes made")
    success: bool = Field(description="Whether the operation was successful")
    message: str = Field(description="Human-readable message about the operation")
    content_preview: str | None = Field(
        description="Preview of the document content (first 200 chars)"
    )


class DocumentAgent(BaseAgent[DocumentDependencies, DocumentOperation]):
    """
    Conversational agent for document management.

    Capabilities:
    - Create new documents through conversation
    - Update existing document content
    - Modify document structure and metadata
    - Query document information
    - Version control tracking
    """

    def __init__(self, model: str = None, **kwargs):
        # Use provided model or fall back to default
        if model is None:
            model = os.getenv("DOCUMENT_AGENT_MODEL", "openai:gpt-4o")

        super().__init__(
            model=model, name="DocumentAgent", retries=3, enable_rate_limiting=True, **kwargs
        )

    def _create_agent(self, **kwargs) -> Agent:
        """Create the PydanticAI agent with tools and prompts."""

        agent = Agent(
            model=self.model,
            deps_type=DocumentDependencies,
            system_prompt="""You are a Document Management Assistant that helps users create, update, and modify project documents through conversation.

**Your Capabilities:**
- Create new documents (PRDs, technical specs, meeting notes, API docs, etc.)
- Update existing document content based on user requests
- Modify document structure and metadata
- Query and retrieve document information
- Track changes and maintain version history

**Available Document Types:**
- prd: Product Requirements Document
- technical_spec: Technical Specification
- meeting_notes: Meeting Notes
- api_docs: API Documentation
- feature_plan: Feature Planning Document
- erd: Entity Relationship Diagram description

**Your Approach:**
1. **Listen carefully** to what the user wants to do with documents
2. **Use your tools** to check existing documents, create new ones, or update content
3. **Be specific** about what changes you're making
4. **Confirm actions** before making destructive changes
5. **Provide clear feedback** about what was accomplished

**Examples of what you can do:**

**📄 Document Operations:**
- "Create a PRD for user authentication" → Use create_document tool
- "Add OAuth section to the auth PRD" → Use update_document tool
- "What documents do we have?" → Use list_documents tool
- "Show me the technical spec" → Use get_document tool
- "Update the API docs with new endpoints" → Use update_document tool

**🎨 Feature Planning:**
- "Create a React Flow for user registration" → Use create_feature_plan tool
- "Design the checkout process flow" → Use create_feature_plan tool
- "Plan the dashboard feature with user stories" → Use create_feature_plan tool

**🗄️ Database Design:**
- "Create an ERD for the e-commerce system" → Use create_erd tool
- "Design database schema for user management" → Use create_erd tool
- "Generate SQL tables for the blog system" → Use create_erd tool

**✅ Change Management:**
- "Request approval for the API changes" → Use request_approval tool
- "Submit PRD updates for review" → Use request_approval tool
- "Create approval workflow for database changes" → Use request_approval tool""",
            **kwargs,
        )

        # Register dynamic system prompt for project context
        @agent.system_prompt
        async def add_project_context(ctx: RunContext[DocumentDependencies]) -> str:
            return f"""
**Current Project Context:**
- Project ID: {ctx.deps.project_id}
- User ID: {ctx.deps.user_id or "Unknown"}
- Current Document: {ctx.deps.current_document_id or "None"}
- Timestamp: {datetime.now().isoformat()}
"""

        # Register tools for document operations
        @agent.tool
        async def list_documents(ctx: RunContext[DocumentDependencies]) -> str:
            """List all documents in the current project."""
            try:
                # Handle case where no project_id is provided
                if not ctx.deps.project_id:
                    return "No project is currently selected. Please specify a project or create one first to manage documents."

                supabase = get_supabase_client()
                response = (
                    supabase.table("archon_projects")
                    .select("docs")
                    .eq("id", ctx.deps.project_id)
                    .execute()
                )

                if not response.data:
                    return "No project found with the given ID."

                docs = response.data[0].get("docs", [])
                if not docs:
                    return "No documents found in this project."

                doc_list = []
                for doc in docs:
                    doc_type = doc.get("document_type", "unknown")
                    title = doc.get("title", "Untitled")
                    doc_list.append(f"- {title} ({doc_type})")

                return f"Found {len(docs)} documents:\n" + "\n".join(doc_list)

            except Exception as e:
                logger.error(f"Error listing documents: {e}")
                return f"Error retrieving documents: {str(e)}"

        @agent.tool
        async def get_document(ctx: RunContext[DocumentDependencies], document_title: str) -> str:
            """Get the content of a specific document by title."""
            try:
                supabase = get_supabase_client()
                response = (
                    supabase.table("archon_projects")
                    .select("docs")
                    .eq("id", ctx.deps.project_id)
                    .execute()
                )

                if not response.data:
                    return "No project found."

                docs = response.data[0].get("docs", [])
                matching_docs = [
                    doc for doc in docs if document_title.lower() in doc.get("title", "").lower()
                ]

                if not matching_docs:
                    available_docs = [doc.get("title", "Untitled") for doc in docs[:5]]
                    return f"No document found matching '{document_title}'. Available documents: {', '.join(available_docs)}"

                doc = matching_docs[0]
                content = doc.get("content", {})

                # Format content for display
                content_str = ""
                if isinstance(content, dict):
                    for key, value in content.items():
                        if isinstance(value, list):
                            content_str += f"\n**{key.replace('_', ' ').title()}:**\n" + "\n".join([
                                f"- {item}" for item in value
                            ])
                        elif isinstance(value, dict):
                            content_str += f"\n**{key.replace('_', ' ').title()}:**\n"
                            for subkey, subvalue in value.items():
                                content_str += f"  - {subkey}: {subvalue}\n"
                        else:
                            content_str += f"\n**{key.replace('_', ' ').title()}:** {value}"
                else:
                    content_str = str(content)

                return f"**Document: {doc.get('title', 'Untitled')}**\nType: {doc.get('document_type', 'unknown')}\nStatus: {doc.get('status', 'draft')}\nVersion: {doc.get('version', '1.0')}\n{content_str}"

            except Exception as e:
                logger.error(f"Error getting document: {e}")
                return f"Error retrieving document: {str(e)}"

        @agent.tool
        async def create_document(
            ctx: RunContext[DocumentDependencies],
            title: str,
            document_type: str,
            content_description: str,
        ) -> str:
            """Create a new document with structured content based on the description."""
            try:
                # Send progress update if callback available
                if ctx.deps.progress_callback:
                    await ctx.deps.progress_callback({
                        "step": "ai_generation",
                        "log": f"📝 Creating {document_type}: {title}",
                    })

                # Generate blocks for the document
                blocks = self._convert_to_blocks(title, document_type, content_description)

                # Create the document content in the expected format
                content = {"id": str(uuid.uuid4()), "title": title, "blocks": blocks}

                # Create document via DocumentService
                from ..services.projects.document_service import DocumentService

                doc_service = DocumentService()
                success, result_data = doc_service.add_document(
                    project_id=ctx.deps.project_id,
                    document_type=document_type,
                    title=title,
                    content=content,
                    tags=[document_type, "conversational"],
                    author=ctx.deps.user_id or "DocumentAgent",
                )

                if result_data.get("success", False):
                    doc_id = result_data.get("document_id", "unknown")

                    # Send success progress update if callback available
                    if ctx.deps.progress_callback:
                        await ctx.deps.progress_callback({
                            "step": "ai_generation",
                            "log": f"✅ Successfully created {document_type}: {title}",
                        })

                    return f"Successfully created document '{title}' of type '{document_type}'. Document ID: {doc_id}"
                else:
                    error_msg = result_data.get("error", "Unknown error")

                    # Send error progress update if callback available
                    if ctx.deps.progress_callback:
                        await ctx.deps.progress_callback({
                            "step": "ai_generation",
                            "log": f"❌ Failed to create document: {error_msg}",
                        })

                    return f"Failed to create document: {error_msg}"

            except Exception as e:
                logger.error(f"Error creating document: {e}")
                return f"Error creating document: {str(e)}"

        @agent.tool
        async def update_document(
            ctx: RunContext[DocumentDependencies],
            document_title: str,
            section_to_update: str,
            new_content: str,
            update_description: str,
        ) -> str:
            """Update a specific section of an existing document."""
            try:
                # First get the current document via MCP
                mcp_client = await get_mcp_client()
                get_result = await mcp_client.manage_document(
                    action="get", project_id=ctx.deps.project_id, title=document_title
                )

                # Parse the response
                get_data = json.loads(get_result)
                if not get_data.get("success", False):
                    return f"Failed to get document: {get_data.get('error', 'Unknown error')}"

                doc = get_data.get("document", {})
                if not doc:
                    return f"No document found matching '{document_title}'"

                doc_id = doc.get("id")
                current_content = doc.get("content", {})

                # Update the specified section
                if section_to_update in current_content:
                    if isinstance(current_content[section_to_update], list):
                        # If it's a list, append or replace based on new_content format
                        if new_content.startswith("[") and new_content.endswith("]"):
                            try:
                                current_content[section_to_update] = json.loads(new_content)
                            except:
                                current_content[section_to_update].append(new_content)
                        else:
                            current_content[section_to_update].append(new_content)
                    elif isinstance(current_content[section_to_update], dict):
                        # If it's a dict, try to parse new_content as JSON
                        try:
                            update_dict = json.loads(new_content)
                            current_content[section_to_update].update(update_dict)
                        except:
                            current_content[section_to_update]["update"] = new_content
                    else:
                        # Simple string replacement
                        current_content[section_to_update] = new_content
                else:
                    # Create new section
                    try:
                        current_content[section_to_update] = json.loads(new_content)
                    except:
                        current_content[section_to_update] = new_content

                # Update document via MCP
                update_result = await mcp_client.manage_document(
                    action="update",
                    project_id=ctx.deps.project_id,
                    doc_id=doc_id,
                    content=current_content,
                    version=f"{float(doc.get('version', '1.0')) + 0.1:.1f}",
                )

                result_data = json.loads(update_result)
                if result_data.get("success"):
                    return f"Successfully updated section '{section_to_update}' in document '{document_title}'. Change: {update_description}"
                else:
                    return f"Failed to update document: {result_data.get('error', 'Unknown error')}"

            except Exception as e:
                logger.error(f"Error updating document: {e}")
                return f"Error updating document: {str(e)}"

        @agent.tool
        async def create_feature_plan(
            ctx: RunContext[DocumentDependencies],
            feature_name: str,
            feature_description: str,
            user_stories: str,
        ) -> str:
            """Create a React Flow feature plan with nodes and connections."""
            try:
                # Generate React Flow nodes and edges for the feature
                nodes = [
                    {
                        "id": "start",
                        "type": "input",
                        "position": {"x": 100, "y": 100},
                        "data": {"label": f"Start: {feature_name}"},
                    },
                    {
                        "id": "user_input",
                        "type": "default",
                        "position": {"x": 300, "y": 100},
                        "data": {"label": "User Input/Action"},
                    },
                    {
                        "id": "validation",
                        "type": "default",
                        "position": {"x": 500, "y": 100},
                        "data": {"label": "Validation Logic"},
                    },
                    {
                        "id": "processing",
                        "type": "default",
                        "position": {"x": 700, "y": 100},
                        "data": {"label": "Core Processing"},
                    },
                    {
                        "id": "response",
                        "type": "output",
                        "position": {"x": 900, "y": 100},
                        "data": {"label": "User Response/Result"},
                    },
                ]

                edges = [
                    {"id": "e1", "source": "start", "target": "user_input"},
                    {"id": "e2", "source": "user_input", "target": "validation"},
                    {"id": "e3", "source": "validation", "target": "processing"},
                    {"id": "e4", "source": "processing", "target": "response"},
                ]

                # Create feature plan document
                content = {
                    "feature_overview": {
                        "name": feature_name,
                        "description": feature_description,
                        "priority": "high",
                        "estimated_effort": "To be determined",
                    },
                    "user_stories": user_stories.split("\n") if user_stories else [],
                    "react_flow_diagram": {
                        "nodes": nodes,
                        "edges": edges,
                        "viewport": {"x": 0, "y": 0, "zoom": 1},
                    },
                    "acceptance_criteria": [
                        "User can successfully complete the main flow",
                        "All edge cases are handled gracefully",
                        "Performance meets requirements",
                    ],
                    "technical_notes": {
                        "frontend_components": [
                            f"{feature_name}Container",
                            f"{feature_name}Form",
                            f"{feature_name}Display",
                        ],
                        "backend_endpoints": [f"/api/{feature_name.lower().replace(' ', '-')}"],
                        "database_changes": "To be determined",
                    },
                }

                # Create feature via MCP
                mcp_client = await get_mcp_client()

                # Create new feature entry
                new_feature = {
                    "id": str(uuid.uuid4()),
                    "feature_type": "feature_plan",
                    "name": feature_name,
                    "title": f"{feature_name} - Feature Plan",
                    "content": content,
                    "created_by": ctx.deps.user_id or "DocumentAgent",
                }

                # Use MCP to update project features
                result_json = await mcp_client.manage_project(
                    action="add_feature", project_id=ctx.deps.project_id, feature=new_feature
                )

                result_data = json.loads(result_json)

                if result_data.get("success", False):
                    return f"Successfully created React Flow feature plan for '{feature_name}'. The plan includes a visual flow with 5 nodes and user story breakdown. You can now view and edit this in the project documents."
                else:
                    return f"Failed to create feature plan: {result_data.get('error', 'Unknown error')}"

            except Exception as e:
                logger.error(f"Error creating feature plan: {e}")
                return f"Error creating feature plan: {str(e)}"

        @agent.tool
        async def create_erd(
            ctx: RunContext[DocumentDependencies],
            system_name: str,
            entity_descriptions: str,
            relationships_description: str,
        ) -> str:
            """Create an Entity Relationship Diagram description and schema."""
            try:
                # Parse entity descriptions to create database schema
                entities = []
                entity_lines = entity_descriptions.split("\n")

                current_entity = None
                for line in entity_lines:
                    line = line.strip()
                    if line and not line.startswith("-"):
                        # New entity
                        current_entity = {
                            "name": line,
                            "attributes": [],
                            "primary_key": "id",
                            "relationships": [],
                        }
                        entities.append(current_entity)
                    elif line.startswith("-") and current_entity:
                        # Attribute of current entity
                        attr_name = line[1:].strip()
                        attr_type = "VARCHAR(255)"  # Default type

                        # Detect common patterns
                        if "id" in attr_name.lower():
                            attr_type = "UUID"
                        elif "email" in attr_name.lower():
                            attr_type = "VARCHAR(255) UNIQUE"
                        elif "password" in attr_name.lower():
                            attr_type = "VARCHAR(255)"
                        elif "created" in attr_name.lower() or "updated" in attr_name.lower():
                            attr_type = "TIMESTAMP"
                        elif "count" in attr_name.lower() or "number" in attr_name.lower():
                            attr_type = "INTEGER"
                        elif "price" in attr_name.lower() or "cost" in attr_name.lower():
                            attr_type = "DECIMAL(10,2)"
                        elif "active" in attr_name.lower() or "enabled" in attr_name.lower():
                            attr_type = "BOOLEAN"

                        current_entity["attributes"].append({
                            "name": attr_name,
                            "type": attr_type,
                            "nullable": True,
                            "description": f"The {attr_name.replace('_', ' ')} field",
                        })

                # Generate SQL schema
                sql_schema = []
                for entity in entities:
                    table_sql = f"CREATE TABLE {entity['name'].lower().replace(' ', '_')} (\n"
                    table_sql += "    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n"

                    for attr in entity["attributes"]:
                        nullable = "NULL" if attr["nullable"] else "NOT NULL"
                        table_sql += f"    {attr['name'].lower().replace(' ', '_')} {attr['type']} {nullable},\n"

                    table_sql += "    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,\n"
                    table_sql += "    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n"
                    table_sql += ");"
                    sql_schema.append(table_sql)

                # Create ERD document
                content = {
                    "system_overview": {
                        "name": system_name,
                        "description": entity_descriptions,
                        "total_entities": len(entities),
                    },
                    "entities": entities,
                    "relationships": {
                        "description": relationships_description,
                        "relationship_types": ["one-to-one", "one-to-many", "many-to-many"],
                        "foreign_keys": "To be defined based on relationships",
                    },
                    "database_schema": {
                        "sql_statements": sql_schema,
                        "indexes": [
                            "CREATE INDEX idx_created_at ON each_table (created_at);",
                            "CREATE INDEX idx_updated_at ON each_table (updated_at);",
                        ],
                        "constraints": "Foreign key constraints to be added based on relationships",
                    },
                    "erd_notes": {
                        "diagram_tool": "Can be visualized using tools like dbdiagram.io, Draw.io, or Lucidchart",
                        "normalization_level": "3NF recommended",
                        "scalability_notes": "Consider partitioning for large tables",
                    },
                }

                # Create ERD via MCP
                mcp_client = await get_mcp_client()

                # Create new data entry
                new_data_model = {
                    "id": str(uuid.uuid4()),
                    "data_type": "erd",
                    "name": system_name,
                    "title": f"{system_name} - Entity Relationship Diagram",
                    "content": content,
                    "created_by": ctx.deps.user_id or "DocumentAgent",
                }

                # Use MCP to update project data
                result_json = await mcp_client.manage_project(
                    action="add_data", project_id=ctx.deps.project_id, data=new_data_model
                )

                result_data = json.loads(result_json)

                if result_data.get("success", False):
                    return f"Successfully created ERD for '{system_name}' with {len(entities)} entities. Generated SQL schema and relationship mappings. The ERD includes detailed entity definitions and can be imported into database design tools."
                else:
                    return f"Failed to create ERD: {result_data.get('error', 'Unknown error')}"

            except Exception as e:
                logger.error(f"Error creating ERD: {e}")
                return f"Error creating ERD: {str(e)}"

        @agent.tool
        async def request_approval(
            ctx: RunContext[DocumentDependencies],
            document_title: str,
            change_summary: str,
            change_type: str = "update",
        ) -> str:
            """Request approval for document changes with change tracking."""
            try:
                # Create approval request document
                approval_content = {
                    "approval_request": {
                        "requested_by": ctx.deps.user_id or "DocumentAgent",
                        "request_date": datetime.now().isoformat(),
                        "target_document": document_title,
                        "change_type": change_type,
                        "status": "pending_approval",
                    },
                    "change_summary": change_summary,
                    "impact_analysis": {
                        "affected_stakeholders": ["Product Team", "Development Team", "QA Team"],
                        "risk_level": "medium",
                        "effort_estimate": "To be determined by reviewers",
                    },
                    "approval_workflow": {
                        "required_approvers": ["Product Manager", "Technical Lead"],
                        "approval_deadline": (datetime.now() + timedelta(days=3)).isoformat(),
                        "approval_status": {
                            "product_manager": "pending",
                            "technical_lead": "pending",
                        },
                    },
                    "version_control": {
                        "previous_version": "Current version backed up",
                        "proposed_changes": change_summary,
                        "rollback_plan": "Revert to previous version if needed",
                    },
                }

                # Save approval request via MCP
                mcp_client = await get_mcp_client()
                result_json = await mcp_client.manage_document(
                    action="create",
                    project_id=ctx.deps.project_id,
                    document_type="approval_request",
                    title=f"Approval Request: {document_title}",
                    content=approval_content,
                    tags=["approval", "workflow", "change-management"],
                    author=ctx.deps.user_id or "DocumentAgent",
                )

                result_data = json.loads(result_json)

                if result_data.get("success", False):
                    return f"Approval request created for changes to '{document_title}'. Status: Pending approval from Product Manager and Technical Lead. Deadline: 3 days. Change summary: {change_summary}"
                else:
                    return f"Failed to create approval request: {result_data.get('error', 'Unknown error')}"

            except Exception as e:
                logger.error(f"Error creating approval request: {e}")
                return f"Error creating approval request: {str(e)}"

        return agent

    def _generate_block_id(self) -> str:
        """Generate a unique block ID."""
        return str(uuid.uuid4())

    def _create_block(
        self, block_type: str, content: str, properties: dict = None
    ) -> dict[str, Any]:
        """Create a block in the document format."""
        return {
            "id": self._generate_block_id(),
            "type": block_type,
            "content": content,
            "properties": properties or {"text": content},
        }

    def _convert_to_blocks(
        self, title: str, document_type: str, content_description: str
    ) -> list[dict[str, Any]]:
        """Convert content to block-based format for PRD documents."""
        blocks = []

        # Title block
        blocks.append(self._create_block("heading_1", title))

        if document_type == "prd":
            # Project Overview section
            blocks.append(self._create_block("heading_2", "Project Overview"))
            blocks.append(self._create_block("paragraph", content_description))

            # Goals section
            blocks.append(self._create_block("heading_2", "Goals"))
            blocks.append(
                self._create_block(
                    "bulleted_list", "Define clear project objectives and success metrics"
                )
            )
            blocks.append(
                self._create_block(
                    "bulleted_list", "Establish technical requirements and constraints"
                )
            )
            blocks.append(
                self._create_block("bulleted_list", "Identify key stakeholders and their needs")
            )

            # Scope section
            blocks.append(self._create_block("heading_2", "Scope"))
            blocks.append(
                self._create_block(
                    "paragraph", "**In Scope:** Core features and functionality to be delivered"
                )
            )
            blocks.append(
                self._create_block(
                    "paragraph",
                    "**Out of Scope:** Features and functionality explicitly excluded from this phase",
                )
            )

            # Technical Requirements section
            blocks.append(self._create_block("heading_2", "Technical Requirements"))
            blocks.append(self._create_block("heading_3", "Technology Stack"))
            blocks.append(
                self._create_block("bulleted_list", "Frontend: React, TypeScript, Tailwind CSS")
            )
            blocks.append(self._create_block("bulleted_list", "Backend: FastAPI, Python"))
            blocks.append(self._create_block("bulleted_list", "Database: Supabase (PostgreSQL)"))
            blocks.append(
                self._create_block("bulleted_list", "Infrastructure: Docker, Cloud deployment")
            )

            # Architecture section
            blocks.append(self._create_block("heading_2", "Architecture"))
            blocks.append(
                self._create_block(
                    "paragraph", "High-level system architecture and component interactions"
                )
            )

            # User Stories section
            blocks.append(self._create_block("heading_2", "User Stories"))
            blocks.append(
                self._create_block("paragraph", "Key user stories and acceptance criteria")
            )

            # Timeline section
            blocks.append(self._create_block("heading_2", "Timeline & Milestones"))
            blocks.append(self._create_block("paragraph", "Project phases and delivery timeline"))

            # Risks section
            blocks.append(self._create_block("heading_2", "Risks & Mitigations"))
            blocks.append(
                self._create_block("paragraph", "Identified risks and mitigation strategies")
            )

        elif document_type == "technical_spec":
            blocks.append(self._create_block("heading_2", "Overview"))
            blocks.append(self._create_block("paragraph", content_description))

            blocks.append(self._create_block("heading_2", "Technical Architecture"))
            blocks.append(
                self._create_block("paragraph", "System architecture and design decisions")
            )

            blocks.append(self._create_block("heading_2", "API Design"))
            blocks.append(self._create_block("paragraph", "API endpoints and data models"))

            blocks.append(self._create_block("heading_2", "Database Schema"))
            blocks.append(self._create_block("paragraph", "Database design and relationships"))

        elif document_type == "meeting_notes":
            blocks.append(self._create_block("heading_2", "Meeting Details"))
            blocks.append(
                self._create_block("paragraph", f"Date: {datetime.now().strftime('%Y-%m-%d')}")
            )
            blocks.append(self._create_block("paragraph", f"Topic: {content_description}"))

            blocks.append(self._create_block("heading_2", "Attendees"))
            blocks.append(self._create_block("paragraph", "List of meeting participants"))

            blocks.append(self._create_block("heading_2", "Discussion Points"))
            blocks.append(self._create_block("paragraph", "Key topics discussed"))

            blocks.append(self._create_block("heading_2", "Action Items"))
            blocks.append(self._create_block("paragraph", "Tasks and next steps"))

        else:
            # Generic document
            blocks.append(self._create_block("heading_2", "Overview"))
            blocks.append(self._create_block("paragraph", content_description))

        return blocks

    def get_system_prompt(self) -> str:
        """Get the base system prompt for this agent."""
        try:
            from ..services.prompt_service import prompt_service

            # For now, use document_builder as default
            # In future, could make this configurable based on operation type
            return prompt_service.get_prompt(
                "document_builder",
                default="Document Management Assistant for conversational document operations.",
            )
        except Exception as e:
            logger.warning(f"Could not load prompt from service: {e}")
            return "Document Management Assistant for conversational document operations."

    async def run_conversation(
        self,
        user_message: str,
        project_id: str,
        user_id: str = None,
        current_document_id: str = None,
        progress_callback: Any = None,
    ) -> DocumentOperation:
        """
        Run the agent for conversational document management.

        Args:
            user_message: The user's conversational input
            project_id: ID of the project to work with
            user_id: ID of the user making the request
            current_document_id: ID of currently focused document (if any)
            progress_callback: Optional callback for progress updates

        Returns:
            Structured DocumentOperation result
        """
        deps = DocumentDependencies(
            project_id=project_id,
            user_id=user_id,
            current_document_id=current_document_id,
            progress_callback=progress_callback,
        )

        try:
            result = await self.run(user_message, deps)
            self.logger.info(f"Document operation completed: {result.operation_type}")
            return result
        except Exception as e:
            self.logger.error(f"Document operation failed: {str(e)}")
            # Return error result
            return DocumentOperation(
                operation_type="error",
                document_id=None,
                document_type=None,
                title=None,
                success=False,
                message=f"Failed to process request: {str(e)}",
                changes_made=[],
                content_preview=None,
            )


# Note: DocumentAgent instances should be created on-demand in API endpoints
# to avoid initialization issues during module import
