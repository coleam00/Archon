"""
n8n Integration API for Clario
Receives data from n8n workflows and processes through Archon's proven pipeline
"""

from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field, validator
from typing import Dict, Any, List, Optional
from datetime import datetime
import uuid
import asyncio

# Import Archon's proven infrastructure - now properly available
from python.src.server.services.storage.document_storage_service import add_documents_to_supabase
from python.src.server.utils import get_supabase_client
from python.src.server.config.logfire_config import get_logger, safe_span

logger = get_logger(__name__)


class N8NDataPayload(BaseModel):
    """Standardized data format from n8n workflows"""
    platform: str = Field(..., description="Source platform (jira, notion, slack, etc.)")
    entity_type: str = Field(..., description="Type of entity (issue, page, message, etc.)")
    entity_id: str = Field(..., description="Unique ID from source platform")
    title: str = Field(..., description="Human-readable title")
    content: str = Field(default="", description="Main content text")
    url: str = Field(..., description="Link to original item")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Platform-specific metadata")
    business_context: Dict[str, Any] = Field(default_factory=dict, description="Business intelligence context")
    relationships: List[Dict[str, Any]] = Field(default_factory=list, description="Detected relationships")
    
    @validator('platform')
    def validate_platform(cls, v):
        allowed_platforms = ['jira', 'notion', 'slack', 'github', 'linear', 'google', 'asana']
        if v.lower() not in allowed_platforms:
            raise ValueError(f"Platform must be one of: {allowed_platforms}")
        return v.lower()


class ArchonN8NProcessor:
    """
    Processes n8n data through Archon's battle-tested pipeline.
    This leverages all of Archon's proven capabilities.
    """
    
    def __init__(self, supabase_client=None):
        self.supabase_client = supabase_client or get_supabase_client()
        self.processed_count = 0
        self.platform_stats = {}
    
    async def process_n8n_item(self, data: N8NDataPayload) -> Dict[str, Any]:
        """Process single n8n item through Archon's proven pipeline"""
        
        with safe_span(f"n8n_process_{data.platform}_{data.entity_type}") as span:
            span.set_attributes({
                "platform": data.platform,
                "entity_type": data.entity_type,
                "entity_id": data.entity_id,
                "title": data.title[:100]
            })
            
            try:
                # Transform to Archon format
                archon_data = self._transform_for_archon(data)
                
                # Use Archon's proven document storage pipeline
                # This gives us ALL of Archon's battle-tested capabilities:
                # - Intelligent chunking
                # - Vector embeddings  
                # - Contextual enhancement
                # - Progress tracking
                # - Error handling
                # - Batch optimization
                
                result = await add_documents_to_supabase(
                    client=self.supabase_client,
                    urls=[archon_data["url"]],
                    chunk_numbers=[archon_data["chunk_number"]],
                    contents=[archon_data["content"]],
                    metadatas=[archon_data["metadata"]],
                    url_to_full_document={archon_data["url"]: archon_data["content"]},
                    enable_parallel_batches=False,  # Single item
                    provider=None  # Use default embedding provider
                )
                
                # Update stats
                self.processed_count += 1
                self.platform_stats[data.platform] = self.platform_stats.get(data.platform, 0) + 1
                
                span.set_attribute("success", True)
                span.set_attribute("chunks_stored", result.get("chunks_stored", 0))
                
                return {
                    "success": True,
                    "processed_through_archon": True,
                    "archon_result": result,
                    "processed_at": datetime.utcnow(),
                    "total_processed": self.processed_count
                }
                
            except Exception as e:
                logger.error(f"Failed to process {data.platform} {data.entity_type}: {e}")
                span.set_attribute("error", str(e))
                raise
    
    def _transform_for_archon(self, data: N8NDataPayload) -> Dict[str, Any]:
        """Transform n8n data into Archon's document format"""
        
        # Format content for optimal search
        formatted_content = self._format_searchable_content(data)
        
        # Build rich metadata for Archon's pipeline
        archon_metadata = {
            # Clario extensions to Archon's metadata schema
            "integration_type": data.platform,  # This extends Archon's existing metadata
            "content_type": data.entity_type,
            "entity_id": data.entity_id,
            "clario_ingestion": True,
            "ingested_at": datetime.utcnow().isoformat(),
            
            # Business metadata for cross-platform intelligence
            "business_metadata": {
                "platform": data.platform,
                "entity_type": data.entity_type, 
                "entity_id": data.entity_id,
                **data.business_context
            },
            
            # Platform-specific metadata (preserved from n8n)
            **data.metadata,
            
            # Relationships for future graph building
            "relationships": data.relationships,
            
            # Source tracking
            "source_id": f"{data.platform}_{data.entity_id}",
            "original_url": data.url
        }
        
        return {
            "url": data.url,
            "chunk_number": 0,  # Main content chunk
            "content": formatted_content,
            "metadata": archon_metadata
        }
    
    def _format_searchable_content(self, data: N8NDataPayload) -> str:
        """Format content for optimal search and AI understanding"""
        
        parts = [
            f"# {data.title}",
            f"**Platform:** {data.platform.title()}", 
            f"**Type:** {data.entity_type}",
        ]
        
        # Add platform-specific context for better search
        if data.platform == "jira":
            metadata = data.metadata
            if metadata.get("project_key"):
                parts.append(f"**Project:** {metadata.get('project_name', '')} ({metadata['project_key']})")
            if metadata.get("status"):
                parts.append(f"**Status:** {metadata['status']}")
            if metadata.get("assignee"):
                parts.append(f"**Assignee:** {metadata['assignee']}")
            if metadata.get("priority"):
                parts.append(f"**Priority:** {metadata['priority']}")
            if metadata.get("labels"):
                parts.append(f"**Labels:** {', '.join(metadata['labels'])}")
                
        elif data.platform == "slack":
            metadata = data.metadata
            if metadata.get("channel_name"):
                parts.append(f"**Channel:** #{metadata['channel_name']}")
            if metadata.get("user_name"):
                parts.append(f"**Author:** {metadata['user_name']}")
                
        elif data.platform == "notion":
            metadata = data.metadata
            if metadata.get("workspace"):
                parts.append(f"**Workspace:** {metadata['workspace']}")
            if metadata.get("created_by"):
                parts.append(f"**Author:** {metadata['created_by']}")
                
        elif data.platform == "github":
            metadata = data.metadata
            if metadata.get("repository"):
                parts.append(f"**Repository:** {metadata['repository']}")
            if metadata.get("labels"):
                parts.append(f"**Labels:** {', '.join(metadata['labels'])}")
        
        # Add main content
        if data.content:
            parts.extend(["", "## Content", data.content])
        
        # Add detected relationships
        if data.relationships:
            parts.append("")
            parts.append("## Related Items")
            for rel in data.relationships:
                rel_type = rel.get('type', 'relates to')
                rel_platform = rel.get('platform', '')
                rel_entities = rel.get('entities', [])
                if rel_entities:
                    parts.append(f"- {rel_type} {rel_platform}: {', '.join(rel_entities[:3])}")
        
        # Add source attribution
        parts.extend(["", f"**Source:** [View in {data.platform.title()}]({data.url})"])
        
        return "\n".join(parts)


# Global processor instance
processor = ArchonN8NProcessor()


def create_n8n_router() -> APIRouter:
    """Create FastAPI router for n8n integration endpoints"""
    
    router = APIRouter()
    
    @router.get("/health")
    async def n8n_health():
        """Health check for n8n integration"""
        return {
            "status": "healthy",
            "service": "clario-n8n-integration",
            "archon_available": True,  # We're now properly integrated
            "processed_count": processor.processed_count,
            "platform_stats": processor.platform_stats,
            "timestamp": datetime.utcnow()
        }
    
    @router.post("/ingest")
    async def ingest_from_n8n(
        data: N8NDataPayload,
        background_tasks: BackgroundTasks
    ):
        """
        Main ingestion endpoint for n8n workflows.
        
        This receives data from n8n and processes it through Archon's pipeline.
        n8n → Clario → Archon → Searchable Knowledge
        """
        try:
            ingestion_id = str(uuid.uuid4())
            
            logger.info(f"[{ingestion_id}] Received {data.platform} {data.entity_type}: {data.title}")
            
            # Process in background for fast n8n response
            background_tasks.add_task(
                _process_item_background,
                data,
                ingestion_id
            )
            
            return {
                "success": True,
                "ingestion_id": ingestion_id,
                "platform": data.platform,
                "entity_type": data.entity_type,
                "entity_id": data.entity_id,
                "status": "queued_for_archon_processing",
                "message": f"Received {data.platform} {data.entity_type} for Archon pipeline processing",
                "will_be_searchable_in": "30-60 seconds"
            }
            
        except Exception as e:
            logger.error(f"n8n ingestion failed: {e}")
            raise HTTPException(status_code=500, detail=f"Ingestion failed: {str(e)}")
    
    @router.post("/ingest/batch")
    async def ingest_batch_from_n8n(
        items: List[N8NDataPayload],
        background_tasks: BackgroundTasks
    ):
        """Batch ingestion for efficient processing"""
        
        try:
            batch_id = str(uuid.uuid4())
            
            logger.info(f"[{batch_id}] Received batch of {len(items)} items for Archon processing")
            
            # Process batch in background
            background_tasks.add_task(
                _process_batch_background,
                items,
                batch_id
            )
            
            return {
                "success": True,
                "batch_id": batch_id,
                "items_queued": len(items),
                "status": "queued_for_archon_processing",
                "platforms": list(set(item.platform for item in items)),
                "estimated_processing_time": f"{len(items) * 2} seconds"
            }
            
        except Exception as e:
            logger.error(f"Batch ingestion failed: {e}")
            raise HTTPException(status_code=500, detail=f"Batch ingestion failed: {str(e)}")
    
    @router.post("/test-connection")
    async def test_n8n_connection(test_data: Dict[str, Any] = None):
        """Test endpoint for n8n workflow development"""
        
        return {
            "success": True,
            "message": "n8n → Clario connection successful",
            "archon_status": "integrated",
            "clario_version": "1.0.0",
            "received_data": test_data or {},
            "timestamp": datetime.utcnow(),
            "next_steps": [
                "Create n8n workflow pointing to /api/n8n/ingest",
                "Send real platform data",
                "Verify data appears in Archon UI (http://localhost:3737)"
            ]
        }
    
    return router


async def _process_item_background(data: N8NDataPayload, ingestion_id: str):
    """Background processing through Archon's pipeline"""
    try:
        start_time = datetime.utcnow()
        
        logger.info(f"[{ingestion_id}] Processing {data.platform} {data.entity_type} through Archon pipeline")
        
        # Process through Archon's proven infrastructure
        result = await processor.process_n8n_item(data)
        
        processing_time = datetime.utcnow() - start_time
        
        logger.info(
            f"[{ingestion_id}] ✅ Processed through Archon in {processing_time.total_seconds():.2f}s"
            f" - Now searchable via Archon RAG"
        )
        
    except Exception as e:
        logger.error(f"[{ingestion_id}] ❌ Archon processing failed: {e}")


async def _process_batch_background(items: List[N8NDataPayload], batch_id: str):
    """Background batch processing through Archon"""
    try:
        start_time = datetime.utcnow()
        
        logger.info(f"[{batch_id}] Processing batch of {len(items)} items through Archon")
        
        # Process each item (could be optimized with Archon's batch capabilities)
        successful = 0
        failed = 0
        
        for item in items:
            try:
                await processor.process_n8n_item(item)
                successful += 1
            except Exception as e:
                logger.error(f"[{batch_id}] Failed to process {item.platform} {item.entity_id}: {e}")
                failed += 1
        
        processing_time = datetime.utcnow() - start_time
        
        logger.info(
            f"[{batch_id}] ✅ Batch completed in {processing_time.total_seconds():.2f}s"
            f" - {successful} successful, {failed} failed"
        )
        
    except Exception as e:
        logger.error(f"[{batch_id}] ❌ Batch processing failed: {e}")


# Example n8n workflow configuration for reference
N8N_WORKFLOW_EXAMPLES = {
    "jira_issue_to_clario": {
        "description": "Sync Jira issues to Clario via Archon",
        "nodes": [
            {
                "name": "Jira Trigger",
                "type": "n8n-nodes-base.jiraTrigger",
                "parameters": {
                    "events": ["jira:issue_created", "jira:issue_updated"],
                    "jqlFilter": "project in (PROJ, TEAM) AND updated >= -1d"
                }
            },
            {
                "name": "Transform for Clario",
                "type": "n8n-nodes-base.code",
                "parameters": {
                    "code": """
const issue = $input.item.json;
const fields = issue.fields;

return {
  platform: "jira",
  entity_type: "issue",
  entity_id: issue.id,
  title: `${issue.key}: ${fields.summary}`,
  content: fields.description || '',
  url: `https://your-company.atlassian.net/browse/${issue.key}`,
  metadata: {
    project_key: fields.project.key,
    project_name: fields.project.name,
    issue_type: fields.issuetype.name,
    status: fields.status.name,
    priority: fields.priority?.name || 'None',
    assignee: fields.assignee?.displayName || null,
    labels: fields.labels || [],
    created: fields.created,
    updated: fields.updated
  },
  business_context: {
    platform: "jira",
    entity_type: "issue",
    parent_project: fields.project.key
  }
};
                    """
                }
            },
            {
                "name": "Send to Clario",
                "type": "n8n-nodes-base.httpRequest",
                "parameters": {
                    "url": "http://host.docker.internal:8080/api/n8n/ingest",
                    "method": "POST",
                    "headers": {
                        "Content-Type": "application/json"
                    },
                    "body": "={{ JSON.stringify($json) }}"
                }
            }
        ]
    }
}
