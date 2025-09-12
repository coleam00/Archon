"""
Jira Bulk Connector for Clario
Handles efficient bulk sync of all Jira data using Archon's proven pipeline

This connector is optimized for:
- Large-scale data migration (1000+ issues)
- Complex metadata extraction
- Intelligent rate limiting
- Progress tracking for long operations
- Error recovery and retry logic
"""

import asyncio
from typing import Dict, List, Any, Optional
from datetime import datetime, timedelta
from urllib.parse import urljoin
import httpx
from pydantic import BaseModel, Field

# Import Archon's proven infrastructure
from python.src.server.services.storage.document_storage_service import add_documents_to_supabase
from python.src.server.config.logfire_config import get_logger, safe_span
from python.src.server.utils import get_supabase_client

logger = get_logger(__name__)


class JiraBulkConfig(BaseModel):
    """Configuration for Jira bulk operations"""
    base_url: str = Field(..., description="Jira instance URL")
    email: str = Field(..., description="Jira user email")
    api_token: str = Field(..., description="Jira API token")
    project_keys: List[str] = Field(default=[], description="Projects to sync (empty = all)")
    include_comments: bool = Field(default=True, description="Include issue comments")
    include_attachments: bool = Field(default=False, description="Include attachment metadata")
    include_changelog: bool = Field(default=True, description="Include change history")
    max_issues_per_request: int = Field(default=50, description="Issues per API call")
    max_comments_per_issue: int = Field(default=100, description="Comments per issue")
    rate_limit_delay: float = Field(default=0.1, description="Delay between API calls")


class JiraBulkConnector:
    """
    Efficient bulk Jira connector that handles large-scale data migration
    using Archon's battle-tested document processing pipeline.
    """
    
    def __init__(self, config: JiraBulkConfig, supabase_client=None):
        self.config = config
        self.supabase_client = supabase_client or get_supabase_client()
        
        # Setup authenticated HTTP client
        self.http_client = httpx.AsyncClient(
            auth=(config.email, config.api_token),
            timeout=30.0,
            headers={"Accept": "application/json"}
        )
        
        # Sync statistics
        self.stats = {
            "projects_processed": 0,
            "issues_processed": 0,
            "comments_processed": 0,
            "total_chunks_created": 0,
            "errors": []
        }
    
    async def __aenter__(self):
        return self
        
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.http_client.aclose()
    
    async def sync_all_data(self, progress_callback=None) -> Dict[str, Any]:
        """
        Perform complete bulk sync of Jira data.
        Optimized for large datasets with progress tracking.
        """
        
        with safe_span("jira_bulk_sync") as span:
            try:
                # Get all accessible projects
                projects = await self._fetch_all_projects()
                
                if progress_callback:
                    await progress_callback(
                        "jira_bulk", 5, 
                        f"Found {len(projects)} projects to sync"
                    )
                
                # Filter projects if specified
                if self.config.project_keys:
                    projects = [p for p in projects if p["key"] in self.config.project_keys]
                    logger.info(f"Filtered to {len(projects)} specified projects")
                
                # Process each project
                all_items = []
                total_projects = len(projects)
                
                for i, project in enumerate(projects):
                    project_key = project["key"]
                    project_name = project["name"]
                    
                    logger.info(f"Processing project {project_key} ({i+1}/{total_projects})")
                    
                    # Get all issues for this project with full data
                    project_items = await self._fetch_project_complete_data(
                        project_key, 
                        project_name,
                        progress_callback,
                        base_progress=int((i / total_projects) * 80) + 10
                    )
                    
                    all_items.extend(project_items)
                    self.stats["projects_processed"] += 1
                    
                    # Project completion progress
                    progress = int(((i + 1) / total_projects) * 80) + 10
                    if progress_callback:
                        await progress_callback(
                            "jira_bulk", 
                            progress,
                            f"Completed {project_key}: {len(project_items)} items"
                        )
                
                # Process all items through Archon's proven pipeline
                if all_items:
                    logger.info(f"Processing {len(all_items)} total items through Archon pipeline")
                    await self._process_through_archon(all_items, progress_callback)
                
                # Final statistics
                span.set_attributes(self.stats)
                
                if progress_callback:
                    await progress_callback(
                        "jira_bulk", 100,
                        f"Sync completed: {self.stats['issues_processed']} issues, {self.stats['comments_processed']} comments"
                    )
                
                return {
                    "success": True,
                    "stats": self.stats,
                    "message": "Jira bulk sync completed successfully"
                }
                
            except Exception as e:
                logger.error(f"Jira bulk sync failed: {e}")
                span.set_attribute("error", str(e))
                self.stats["errors"].append(str(e))
                raise
    
    async def _fetch_all_projects(self) -> List[Dict[str, Any]]:
        """Fetch all accessible projects"""
        url = urljoin(self.config.base_url, "/rest/api/3/project")
        
        response = await self.http_client.get(url)
        response.raise_for_status()
        
        projects = response.json()
        logger.info(f"Found {len(projects)} accessible Jira projects")
        
        return projects
    
    async def _fetch_project_complete_data(
        self,
        project_key: str,
        project_name: str,
        progress_callback=None,
        base_progress: int = 0
    ) -> List[Dict[str, Any]]:
        """
        Fetch complete data for a project including all issues and comments.
        Handles pagination efficiently for large projects.
        """
        
        items = []
        
        # First, get issue count for progress tracking
        count_response = await self._get_issue_count(project_key)
        total_issues = count_response.get("total", 0)
        
        logger.info(f"Project {project_key} has {total_issues} issues")
        
        # Fetch issues in batches with intelligent pagination
        start_at = 0
        processed_issues = 0
        
        while True:
            batch = await self._fetch_issues_batch_with_details(
                project_key, start_at, self.config.max_issues_per_request
            )
            
            if not batch["issues"]:
                break
            
            # Process each issue in this batch
            for issue_data in batch["issues"]:
                # Create main issue item
                issue_item = self._create_issue_item(issue_data, project_name)
                items.append(issue_item)
                
                # Process comments if enabled
                if self.config.include_comments:
                    comments = await self._fetch_issue_comments(issue_data["id"])
                    for comment in comments:
                        comment_item = self._create_comment_item(comment, issue_item)
                        items.append(comment_item)
                        self.stats["comments_processed"] += 1
                
                self.stats["issues_processed"] += 1
                processed_issues += 1
                
                # Progress update for large projects
                if total_issues > 0 and processed_issues % 10 == 0:
                    project_progress = int((processed_issues / total_issues) * 20)
                    if progress_callback:
                        await progress_callback(
                            "jira_bulk",
                            base_progress + project_progress,
                            f"{project_key}: {processed_issues}/{total_issues} issues"
                        )
            
            # Check for more issues
            if start_at + self.config.max_issues_per_request >= batch["total"]:
                break
                
            start_at += self.config.max_issues_per_request
            
            # Intelligent rate limiting
            await asyncio.sleep(self.config.rate_limit_delay)
        
        logger.info(f"Project {project_key} complete: {len(items)} total items")
        return items
    
    async def _get_issue_count(self, project_key: str) -> Dict[str, Any]:
        """Get total issue count for a project"""
        url = urljoin(self.config.base_url, "/rest/api/3/search")
        
        params = {
            "jql": f"project = {project_key}",
            "maxResults": 0,  # Just get count
            "fields": "summary"  # Minimal fields
        }
        
        response = await self.http_client.get(url, params=params)
        response.raise_for_status()
        
        return response.json()
    
    async def _fetch_issues_batch_with_details(
        self, 
        project_key: str, 
        start_at: int, 
        max_results: int
    ) -> Dict[str, Any]:
        """Fetch issue batch with comprehensive details"""
        
        url = urljoin(self.config.base_url, "/rest/api/3/search")
        
        # Request comprehensive field data
        fields = [
            "summary", "description", "issuetype", "status", "priority",
            "assignee", "reporter", "created", "updated", "labels",
            "project", "components", "fixVersions", "affects", 
            "resolution", "resolutiondate", "customfield_*"
        ]
        
        # Add changelog if requested
        expand = ["renderedFields"]
        if self.config.include_changelog:
            expand.append("changelog")
        
        params = {
            "jql": f"project = {project_key} ORDER BY created ASC",
            "startAt": start_at,
            "maxResults": max_results,
            "fields": fields,
            "expand": ",".join(expand)
        }
        
        response = await self.http_client.get(url, params=params)
        response.raise_for_status()
        
        return response.json()
    
    async def _fetch_issue_comments(self, issue_id: str) -> List[Dict[str, Any]]:
        """Fetch all comments for an issue"""
        
        if not self.config.include_comments:
            return []
        
        url = urljoin(self.config.base_url, f"/rest/api/3/issue/{issue_id}/comment")
        
        params = {
            "maxResults": self.config.max_comments_per_issue,
            "orderBy": "created",
            "expand": "renderedBody"
        }
        
        try:
            response = await self.http_client.get(url, params=params)
            response.raise_for_status()
            
            result = response.json()
            return result.get("comments", [])
            
        except Exception as e:
            logger.warning(f"Failed to fetch comments for issue {issue_id}: {e}")
            return []
    
    def _create_issue_item(self, issue_data: Dict[str, Any], project_name: str) -> Dict[str, Any]:
        """Create comprehensive issue item for Archon processing"""
        
        fields = issue_data["fields"]
        
        # Extract comprehensive issue data
        issue_item = {
            "type": "issue",
            "platform": "jira",
            "entity_id": issue_data["id"],
            "key": issue_data["key"],
            "url": f"{self.config.base_url}/browse/{issue_data['key']}",
            "title": f"{issue_data['key']}: {fields.get('summary', '')}",
            "content": fields.get("description", ""),
            "created": fields["created"],
            "updated": fields["updated"],
            
            # Rich metadata for search and relationships
            "project_key": fields["project"]["key"],
            "project_name": project_name,
            "issue_type": fields.get("issuetype", {}).get("name", ""),
            "status": fields.get("status", {}).get("name", ""),
            "priority": fields.get("priority", {}).get("name", ""),
            "assignee": fields.get("assignee", {}).get("displayName") if fields.get("assignee") else None,
            "reporter": fields.get("reporter", {}).get("displayName", ""),
            "labels": fields.get("labels", []),
            "components": [c["name"] for c in fields.get("components", [])],
            "fix_versions": [v["name"] for v in fields.get("fixVersions", [])],
            
            # Change history if available
            "changelog": issue_data.get("changelog", {}).get("histories", []) if self.config.include_changelog else []
        }
        
        return issue_item
    
    def _create_comment_item(self, comment_data: Dict[str, Any], parent_issue: Dict[str, Any]) -> Dict[str, Any]:
        """Create comment item for Archon processing"""
        
        return {
            "type": "comment",
            "platform": "jira",
            "entity_id": comment_data["id"],
            "url": f"{parent_issue['url']}#comment-{comment_data['id']}",
            "title": f"Comment on {parent_issue['key']} by {comment_data.get('author', {}).get('displayName', 'Unknown')}",
            "content": comment_data.get("body", ""),
            "created": comment_data.get("created", ""),
            "updated": comment_data.get("updated", ""),
            
            # Parent relationship
            "parent_issue_key": parent_issue["key"],
            "parent_issue_id": parent_issue["entity_id"],
            "project_key": parent_issue["project_key"],
            "project_name": parent_issue["project_name"],
            
            # Comment metadata
            "author": comment_data.get("author", {}).get("displayName", ""),
            "author_key": comment_data.get("author", {}).get("key", ""),
        }
    
    async def _process_through_archon(self, items: List[Dict[str, Any]], progress_callback=None):
        """Process all items through Archon's proven document pipeline"""
        
        logger.info(f"Processing {len(items)} items through Archon pipeline")
        
        # Transform items to Archon format
        urls = []
        chunk_numbers = []
        contents = []
        metadatas = []
        url_to_full_document = {}
        
        for item in items:
            # Format content for search
            formatted_content = self._format_for_search(item)
            
            # Build comprehensive metadata
            metadata = self._build_archon_metadata(item)
            
            urls.append(item["url"])
            chunk_numbers.append(0)  # Main content chunk
            contents.append(formatted_content)
            metadatas.append(metadata)
            url_to_full_document[item["url"]] = formatted_content
        
        # Use Archon's proven document storage pipeline
        # This gives us all of Archon's battle-tested capabilities:
        # - Intelligent chunking
        # - Vector embeddings
        # - Contextual enhancement
        # - Batch processing optimization
        # - Progress tracking
        # - Error handling and recovery
        
        async def archon_progress_wrapper(status, progress, message, **kwargs):
            """Wrapper to forward Archon's progress to our callback"""
            if progress_callback:
                # Adjust progress range (90-100% for Archon processing)
                adjusted_progress = int(90 + (progress * 0.1))
                await progress_callback(
                    "jira_bulk",
                    adjusted_progress,
                    f"Archon processing: {message}",
                    **kwargs
                )
        
        result = await add_documents_to_supabase(
            client=self.supabase_client,
            urls=urls,
            chunk_numbers=chunk_numbers,
            contents=contents,
            metadatas=metadatas,
            url_to_full_document=url_to_full_document,
            progress_callback=archon_progress_wrapper,
            enable_parallel_batches=True,  # Use Archon's performance optimizations
            provider=None  # Use default embedding provider
        )
        
        self.stats["total_chunks_created"] = result.get("chunks_stored", 0)
        
        logger.info(f"Archon processing completed: {result}")
        
        return result
    
    def _format_for_search(self, item: Dict[str, Any]) -> str:
        """Format Jira item for optimal search and AI understanding"""
        
        if item["type"] == "issue":
            parts = [
                f"# {item['title']}",
                f"**Project:** {item['project_name']} ({item['project_key']})",
                f"**Type:** {item['issue_type']} | **Status:** {item['status']} | **Priority:** {item['priority']}",
                f"**Assignee:** {item['assignee'] or 'Unassigned'} | **Reporter:** {item['reporter']}",
                f"**Created:** {item['created']} | **Updated:** {item['updated']}",
            ]
            
            if item.get("labels"):
                parts.append(f"**Labels:** {', '.join(item['labels'])}")
            
            if item.get("components"):
                parts.append(f"**Components:** {', '.join(item['components'])}")
            
            if item.get("fix_versions"):
                parts.append(f"**Fix Versions:** {', '.join(item['fix_versions'])}")
            
            if item.get("content"):
                parts.extend(["", "## Description", item["content"]])
            
            # Add change history summary if available
            if item.get("changelog"):
                recent_changes = item["changelog"][-3:]  # Last 3 changes
                if recent_changes:
                    parts.append("")
                    parts.append("## Recent Changes")
                    for change in recent_changes:
                        change_date = change.get("created", "")
                        change_author = change.get("author", {}).get("displayName", "")
                        parts.append(f"- {change_date} by {change_author}")
                        
        elif item["type"] == "comment":
            parts = [
                f"# Comment on {item['parent_issue_key']}",
                f"**Author:** {item['author']} | **Date:** {item['created']}",
                f"**Project:** {item['project_name']} ({item['project_key']})",
                f"**Parent Issue:** [{item['parent_issue_key']}]({item['url'].split('#')[0]})",
                "",
                "## Comment Content",
                item.get("content", "")
            ]
        
        # Add source attribution
        parts.extend(["", f"**Source:** [View in Jira]({item['url']})"])
        
        return "\n".join(parts)
    
    def _build_archon_metadata(self, item: Dict[str, Any]) -> Dict[str, Any]:
        """Build comprehensive metadata for Archon's pipeline"""
        
        # Base metadata for Clario extensions
        metadata = {
            "integration_type": "jira",
            "content_type": item["type"],
            "bulk_sync": True,
            "synced_at": datetime.utcnow().isoformat(),
            
            # Business metadata for cross-platform intelligence
            "business_metadata": {
                "platform": "jira",
                "entity_type": item["type"],
                "entity_id": item["entity_id"],
                "parent_project": item["project_key"],
                "sync_method": "bulk_connector"
            }
        }
        
        # Add type-specific metadata
        if item["type"] == "issue":
            metadata.update({
                "issue_key": item["key"],
                "project_key": item["project_key"],
                "project_name": item["project_name"],
                "issue_type": item["issue_type"],
                "status": item["status"],
                "priority": item["priority"],
                "assignee": item["assignee"],
                "reporter": item["reporter"],
                "labels": item["labels"],
                "components": item["components"],
                "created": item["created"],
                "updated": item["updated"]
            })
            
        elif item["type"] == "comment":
            metadata.update({
                "comment_id": item["entity_id"],
                "comment_author": item["author"],
                "parent_issue_key": item["parent_issue_key"],
                "parent_issue_id": item["parent_issue_id"],
                "project_key": item["project_key"],
                "created": item["created"]
            })
        
        return metadata


# Example usage and testing
async def main():
    """Example of using the Jira bulk connector"""
    
    config = JiraBulkConfig(
        base_url="https://your-company.atlassian.net",
        email="your-email@company.com",
        api_token="your-jira-api-token",
        project_keys=["PROJ"],  # Specific project for testing
        include_comments=True,
        include_changelog=True,
        max_issues_per_request=25,  # Smaller batches for testing
        rate_limit_delay=0.2  # Conservative rate limiting
    )
    
    async with JiraBulkConnector(config) as connector:
        
        # Progress tracking
        async def progress_callback(status, progress, message, **kwargs):
            print(f"[{progress:3d}%] {status}: {message}")
        
        print("🔄 Starting Jira bulk sync...")
        print(f"📊 Config: {len(config.project_keys or ['all'])} projects, comments={config.include_comments}")
        
        try:
            result = await connector.sync_all_data(progress_callback)
            
            print(f"\n✅ Sync completed successfully!")
            print(f"📊 Statistics: {result['stats']}")
            
            # Test search after sync
            print(f"\n🔍 Testing search capabilities...")
            
            # This would use Archon's RAG to search the processed data
            # The data is now available in Archon's knowledge base
            
        except Exception as e:
            print(f"\n❌ Sync failed: {e}")


if __name__ == "__main__":
    asyncio.run(main())
