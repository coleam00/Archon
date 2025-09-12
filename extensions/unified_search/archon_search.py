"""
Unified Search using Archon's Proven RAG Infrastructure
Provides cross-platform search capabilities for Founder
"""

import asyncio
from typing import Dict, List, Optional, Any
from datetime import datetime
from pydantic import BaseModel, Field

# Import Archon's proven search infrastructure
from python.src.server.services.search.rag_service import RAGService
from python.src.server.config.logfire_config import get_logger, safe_span
from python.src.server.utils import get_supabase_client

logger = get_logger(__name__)


class UniversalSearchQuery(BaseModel):
    """Query model for searching across all business platforms"""
    query: str = Field(..., description="Natural language search query")
    platforms: List[str] = Field(default=[], description="Filter by platforms (jira, notion, slack, etc.)")
    content_types: List[str] = Field(default=[], description="Filter by content type (issue, document, message)")
    max_results: int = Field(default=20, description="Maximum results", le=50)
    min_relevance: float = Field(default=0.7, description="Minimum relevance score")


class SearchResult(BaseModel):
    """Unified search result with business context"""
    id: str
    title: str
    preview: str
    platform: str
    content_type: str
    url: str
    relevance_score: float
    created_date: Optional[datetime] = None
    author: Optional[str] = None
    business_context: Dict[str, Any] = {}
    founder_node_type: str = "document"  # document, project, task, insight


class ArchonUnifiedSearch:
    """
    Unified search engine that leverages Archon's proven RAG capabilities
    to search across all connected business platforms.
    """
    
    def __init__(self, supabase_client=None):
        self.supabase_client = supabase_client or get_supabase_client()
        
        # Use Archon's proven RAG service - this gives us all the power:
        # - Hybrid search (vector + full-text)
        # - Contextual embeddings
        # - Advanced ranking
        # - Code example search
        self.rag_service = RAGService(self.supabase_client)
        
        # Founder node type classification rules
        self.founder_classification = {
            "jira": {
                "epic": "project",
                "story": "task",
                "task": "task", 
                "bug": "task",
                "comment": "insight"
            },
            "notion": {
                "page": "document",
                "database": "document"
            },
            "slack": {
                "message": "insight",
                "thread": "insight"
            },
            "github": {
                "issue": "task",
                "pr": "task",
                "code": "document",
                "documentation": "document"
            }
        }
    
    async def search(self, query: UniversalSearchQuery) -> List[SearchResult]:
        """
        Search across all platforms using Archon's hybrid search.
        
        This leverages Archon's proven capabilities:
        - Vector similarity search
        - PostgreSQL full-text search  
        - Contextual embeddings
        - Advanced result ranking
        """
        
        with safe_span("unified_business_search") as span:
            span.set_attributes({
                "query": query.query,
                "platforms": query.platforms,
                "max_results": query.max_results
            })
            
            try:
                # Build metadata filter for business data
                filter_metadata = self._build_archon_filter(query)
                
                # Use Archon's powerful RAG service
                # This is the magic - we get all of Archon's proven search capabilities
                raw_results = await self.rag_service.search_documents(
                    query=query.query,
                    match_count=query.max_results * 2,  # Get extra for filtering/ranking
                    filter_metadata=filter_metadata,
                    use_hybrid_search=True  # Enable Archon's advanced hybrid search
                )
                
                # Transform Archon results into business-friendly format
                formatted_results = []
                for raw_result in raw_results:
                    formatted_result = self._format_for_founder(raw_result, query)
                    
                    if (formatted_result and 
                        formatted_result.relevance_score >= query.min_relevance):
                        formatted_results.append(formatted_result)
                
                # Sort by relevance and apply final limit
                formatted_results.sort(key=lambda x: x.relevance_score, reverse=True)
                final_results = formatted_results[:query.max_results]
                
                span.set_attributes({
                    "raw_results": len(raw_results),
                    "filtered_results": len(formatted_results),
                    "final_results": len(final_results)
                })
                
                logger.info(f"Unified search for '{query.query}': {len(final_results)} results across {len(set(r.platform for r in final_results))} platforms")
                
                return final_results
                
            except Exception as e:
                logger.error(f"Unified search failed: {e}")
                span.set_attribute("error", str(e))
                raise
    
    async def ask_question(
        self, 
        question: str, 
        context_platforms: List[str] = [],
        max_context: int = 10
    ) -> Dict[str, Any]:
        """
        Ask a natural language question using company data as context.
        
        This uses Archon's RAG to find relevant context, then generates
        an AI answer with proper source attribution.
        """
        
        with safe_span("ai_question_answer") as span:
            span.set_attributes({
                "question": question,
                "context_platforms": context_platforms
            })
            
            try:
                # Search for relevant context using unified search
                context_query = UniversalSearchQuery(
                    query=question,
                    platforms=context_platforms,
                    max_results=max_context,
                    min_relevance=0.6  # Lower threshold for more context
                )
                
                context_results = await self.search(context_query)
                
                # Build context for AI
                context_text = self._build_ai_context(context_results)
                
                # Generate AI response (integrate with Archon's LLM service)
                answer = await self._generate_ai_answer(question, context_text)
                
                response = {
                    "question": question,
                    "answer": answer,
                    "sources": [
                        {
                            "title": result.title,
                            "platform": result.platform,
                            "content_type": result.content_type,
                            "url": result.url,
                            "relevance_score": result.relevance_score,
                            "author": result.author,
                            "business_context": result.business_context
                        }
                        for result in context_results[:5]
                    ],
                    "context_used": len(context_results),
                    "platforms_searched": context_platforms or ["all"],
                    "answered_at": datetime.utcnow()
                }
                
                span.set_attributes({
                    "sources_used": len(context_results),
                    "answer_length": len(answer)
                })
                
                return response
                
            except Exception as e:
                logger.error(f"AI Q&A failed: {e}")
                span.set_attribute("error", str(e))
                raise
    
    def _build_archon_filter(self, query: UniversalSearchQuery) -> Dict[str, Any]:
        """Build metadata filter for Archon's search system"""
        
        filter_metadata = {}
        
        # Filter by integration type (this is our extension to Archon's metadata)
        if query.platforms:
            filter_metadata["integration_type"] = query.platforms
        
        # Filter by content type
        if query.content_types:
            filter_metadata["content_type"] = query.content_types
        
        return filter_metadata
    
    def _format_for_founder(self, raw_result: Dict[str, Any], query: UniversalSearchQuery) -> Optional[SearchResult]:
        """Transform Archon's raw result into Founder-friendly format"""
        
        try:
            metadata = raw_result.get("metadata", {})
            business_metadata = metadata.get("business_metadata", {})
            
            # Extract platform and content type
            platform = business_metadata.get("platform") or metadata.get("integration_type", "unknown")
            content_type = business_metadata.get("entity_type") or metadata.get("content_type", "document")
            
            # Generate business-friendly title
            title = self._extract_title(raw_result, metadata, platform, content_type)
            
            # Generate preview snippet
            content = raw_result.get("content", "")
            preview = self._generate_preview(content, query.query)
            
            # Extract author and dates
            author = self._extract_author(metadata)
            created_date = self._extract_date(metadata)
            
            # Classify into Founder's 4-node taxonomy
            founder_node_type = self._classify_for_founder(platform, content_type, metadata)
            
            # Build business context
            business_context = self._build_business_context(metadata, platform)
            
            return SearchResult(
                id=raw_result.get("id", "unknown"),
                title=title,
                preview=preview,
                platform=platform,
                content_type=content_type,
                url=raw_result.get("url", ""),
                relevance_score=raw_result.get("similarity", 0.0),
                created_date=created_date,
                author=author,
                business_context=business_context,
                founder_node_type=founder_node_type
            )
            
        except Exception as e:
            logger.warning(f"Failed to format search result: {e}")
            return None
    
    def _extract_title(self, result: Dict[str, Any], metadata: Dict[str, Any], platform: str, content_type: str) -> str:
        """Extract meaningful title based on platform and content"""
        
        # Platform-specific title extraction
        if platform == "jira":
            issue_key = metadata.get("issue_key")
            if issue_key:
                return f"[{issue_key}] {metadata.get('summary', 'Jira Issue')}"
            
        elif platform == "slack":
            channel = metadata.get("channel_name", "unknown")
            author = metadata.get("user_name", "Unknown")
            return f"Message by {author} in #{channel}"
            
        elif platform == "notion":
            return metadata.get("page_title", "Notion Page")
            
        elif platform == "github":
            repo = metadata.get("repository", "unknown")
            return f"GitHub {content_type} in {repo}"
        
        # Fallback: extract from content
        content = result.get("content", "")
        first_line = content.split("\n")[0].strip()
        if first_line.startswith("#"):
            return first_line[1:].strip()
        
        return first_line[:80] + "..." if len(first_line) > 80 else first_line
    
    def _generate_preview(self, content: str, query: str) -> str:
        """Generate contextual preview snippet"""
        
        # Find the most relevant paragraph
        paragraphs = [p.strip() for p in content.split("\n\n") if p.strip()]
        query_terms = query.lower().split()
        
        best_paragraph = ""
        best_score = 0
        
        for paragraph in paragraphs:
            if len(paragraph) < 30 or paragraph.startswith("#") or paragraph.startswith("**"):
                continue
                
            para_lower = paragraph.lower()
            score = sum(para_lower.count(term) for term in query_terms)
            
            if score > best_score:
                best_score = score
                best_paragraph = paragraph
        
        # Fallback
        if not best_paragraph:
            for paragraph in paragraphs:
                if len(paragraph) > 30:
                    best_paragraph = paragraph
                    break
        
        # Trim to reasonable length
        if len(best_paragraph) > 200:
            best_paragraph = best_paragraph[:200] + "..."
        
        return best_paragraph or content[:200] + "..."
    
    def _extract_author(self, metadata: Dict[str, Any]) -> Optional[str]:
        """Extract author from metadata"""
        author_fields = ["assignee", "user_name", "created_by", "author", "reporter"]
        for field in author_fields:
            if metadata.get(field):
                return metadata[field]
        return None
    
    def _extract_date(self, metadata: Dict[str, Any]) -> Optional[datetime]:
        """Extract creation date from metadata"""
        date_fields = ["created", "created_time", "timestamp"]
        for field in date_fields:
            date_str = metadata.get(field)
            if date_str:
                try:
                    return datetime.fromisoformat(date_str.replace("Z", "+00:00"))
                except:
                    continue
        return None
    
    def _classify_for_founder(self, platform: str, content_type: str, metadata: Dict[str, Any]) -> str:
        """Classify into Founder's 4-node taxonomy"""
        
        # Use classification rules
        platform_rules = self.founder_classification.get(platform, {})
        founder_type = platform_rules.get(content_type, "document")
        
        # Special cases based on metadata
        if platform == "jira":
            issue_type = metadata.get("issue_type", "").lower()
            if issue_type in ["epic", "initiative"]:
                return "project"
            elif issue_type in ["bug", "task", "story"]:
                return "task"
            elif content_type == "comment":
                return "insight"
        
        return founder_type
    
    def _build_business_context(self, metadata: Dict[str, Any], platform: str) -> Dict[str, Any]:
        """Build rich business context for search results"""
        
        context = {"platform": platform}
        
        if platform == "jira":
            context.update({
                "project": metadata.get("project_name"),
                "status": metadata.get("status"),
                "priority": metadata.get("priority"),
                "assignee": metadata.get("assignee")
            })
        elif platform == "slack":
            context.update({
                "channel": metadata.get("channel_name"),
                "is_thread": metadata.get("thread_ts") is not None
            })
        elif platform == "notion":
            context.update({
                "workspace": metadata.get("workspace")
            })
        elif platform == "github":
            context.update({
                "repository": metadata.get("repository"),
                "labels": metadata.get("labels", [])
            })
        
        return context
    
    def _build_ai_context(self, results: List[SearchResult]) -> str:
        """Build context string for AI question answering"""
        
        context_parts = []
        
        for i, result in enumerate(results, 1):
            context_parts.append(f"Source {i} ({result.platform} - {result.content_type}):")
            context_parts.append(f"Title: {result.title}")
            context_parts.append(f"Content: {result.preview}")
            
            # Add business context
            if result.business_context:
                business_info = []
                for key, value in result.business_context.items():
                    if value and key != "platform":
                        business_info.append(f"{key}: {value}")
                if business_info:
                    context_parts.append(f"Context: {', '.join(business_info)}")
            
            context_parts.append(f"Source: {result.url}")
            context_parts.append("")
        
        return "\n".join(context_parts)
    
    async def _generate_ai_answer(self, question: str, context: str) -> str:
        """Generate AI answer using Archon's LLM capabilities"""
        
        # This would integrate with Archon's existing LLM provider service
        # For now, return a structured response that shows the concept
        
        num_sources = len(context.split("Source ")) - 1
        
        prompt = f"""Based on the following company information, please answer the question comprehensively.

Question: {question}

Company Context from {num_sources} sources:
{context}

Please provide a detailed answer that:
1. Directly addresses the question
2. References specific sources when relevant
3. Highlights patterns or trends across platforms
4. Suggests actionable next steps if appropriate
"""

        # TODO: Integrate with Archon's LLM provider service
        # For now, return a placeholder that shows the structure
        
        return f"""Based on {num_sources} sources across your connected business platforms, here's what I found regarding: {question}

[This would be an AI-generated comprehensive answer using Archon's LLM integration. The answer would:
- Synthesize information from Jira issues, Slack discussions, GitHub content, Notion pages, etc.
- Provide specific insights relevant to your company's context
- Reference the exact sources and provide actionable recommendations
- Highlight patterns and trends across different platforms]

This demonstrates the full power of having all company knowledge unified and searchable through Archon's proven RAG infrastructure."""

    async def get_stats(self) -> Dict[str, Any]:
        """Get search statistics and platform breakdown"""
        
        try:
            # Query Archon's database for statistics
            response = self.supabase_client.table("archon_crawled_pages").select(
                "metadata->integration_type", count="exact"
            ).execute()
            
            platform_counts = {}
            for row in response.data or []:
                platform = row.get("integration_type", "unknown")
                platform_counts[platform] = platform_counts.get(platform, 0) + 1
            
            return {
                "total_items": len(response.data) if response.data else 0,
                "platforms": platform_counts,
                "archon_integration": "active",
                "search_capabilities": [
                    "Vector similarity search",
                    "Full-text search", 
                    "Hybrid search combining both",
                    "Contextual embeddings",
                    "Cross-platform relationships"
                ]
            }
            
        except Exception as e:
            logger.error(f"Failed to get stats: {e}")
            return {
                "total_items": 0,
                "platforms": {},
                "error": str(e)
            }
