"""
Archon RAG Connector Tool for Open WebUI
=========================================
This tool provides seamless integration between Open WebUI and Archon's RAG system.
Install this tool through Open WebUI's Workspace > Tools interface.

Author: Archon Team
Version: 1.0.0
Compatible with: Open WebUI v0.6+
"""

import requests
import json
import asyncio
import os
from typing import Optional, List, Dict, Any
from datetime import datetime
from pydantic import BaseModel, Field


class Tools:
    """
    Archon RAG Connector for Open WebUI
    Provides seamless integration with Archon's knowledge base
    """

    class Valves(BaseModel):
        """Configuration settings for Archon RAG connector"""
        
        ARCHON_BASE_URL: str = Field(
            default="http://localhost:8181",
            description="Base URL for Archon server (e.g., http://localhost:8181)"
        )
        ARCHON_TIMEOUT_MS: int = Field(
            default=15000,
            description="Request timeout in milliseconds (default: 15000)"
        )
        ARCHON_MAX_RESULTS: int = Field(
            default=5,
            description="Maximum number of results to return (1-20)"
        )
        ARCHON_API_KEY: str = Field(
            default="",
            description="API key for Archon authentication (if required)"
        )
        ENABLE_STREAMING: bool = Field(
            default=True,
            description="Enable streaming responses for better UX"
        )
        ENABLE_CACHING: bool = Field(
            default=True,
            description="Enable result caching for repeated queries"
        )
        CACHE_TTL_SECONDS: int = Field(
            default=300,
            description="Cache time-to-live in seconds (default: 5 minutes)"
        )

    def __init__(self):
        """Initialize the Archon RAG connector"""
        self.valves = self.Valves()
        self.citation = True  # Enable citation support
        self._cache = {}  # Simple result cache with TTL
        self._cache_timestamps = {}  # Track cache entry timestamps

    async def on_valves_updated(self):
        """Called when tool configuration is updated"""
        print(f"[Archon RAG] Configuration updated at {datetime.now()}")
        self._cache.clear()  # Clear cache on config change
        self._cache_timestamps.clear()

    def get_headers(self) -> Dict[str, str]:
        """Get HTTP headers for Archon API requests"""
        headers = {"Content-Type": "application/json"}
        if self.valves.ARCHON_API_KEY:
            headers["Authorization"] = f"Bearer {self.valves.ARCHON_API_KEY}"
        return headers

    def is_cache_valid(self, cache_key: str) -> bool:
        """Check if a cache entry is still valid based on TTL"""
        if not self.valves.ENABLE_CACHING:
            return False
        
        if cache_key not in self._cache_timestamps:
            return False
        
        elapsed = (datetime.now() - self._cache_timestamps[cache_key]).total_seconds()
        return elapsed < self.valves.CACHE_TTL_SECONDS

    async def get_available_sources(
        self,
        __user__ = None,
        __event_emitter__ = None
    ) -> str:
        """
        Get list of available sources from Archon
        
        Returns:
            str: Formatted list of available sources
        """
        try:
            if __event_emitter__:
                await __event_emitter__({
                    "type": "status",
                    "data": {
                        "description": "Fetching available sources from Archon...",
                        "done": False
                    }
                })

            response = requests.get(
                f"{self.valves.ARCHON_BASE_URL}/api/rag/sources",
                headers=self.get_headers(),
                timeout=self.valves.ARCHON_TIMEOUT_MS / 1000.0
            )

            if not response.ok:
                error_msg = self._extract_error_message(response)
                return f"❌ **Error fetching sources**: {error_msg}"

            data = response.json()
            sources = data.get("sources", [])

            if not sources:
                return "📭 **No sources available** in Archon knowledge base\n\nPlease upload documents or crawl websites first."

            # Format sources list
            result = "# 📚 Available Sources in Archon\n\n"
            for source in sources:
                source_id = source.get("source_id", "Unknown")
                title = source.get("title", source_id)
                doc_count = source.get("document_count", 0)
                source_type = source.get("type", "unknown")
                
                result += f"### {title}\n"
                result += f"- **ID:** `{source_id}`\n"
                result += f"- **Type:** {source_type}\n"
                if doc_count:
                    result += f"- **Documents:** {doc_count:,}\n"
                result += "\n"

            result += "---\n\n"
            result += "💡 **Usage Tips:**\n"
            result += "- Use source IDs to filter queries: `archon_rag_query('your question', source='source_id')`\n"
            result += "- Leave source empty to search all sources\n"

            if __event_emitter__:
                await __event_emitter__({
                    "type": "status",
                    "data": {
                        "description": f"Found {len(sources)} source(s)",
                        "done": True
                    }
                })

            return result

        except requests.exceptions.Timeout:
            return self._format_timeout_error("fetching sources")
        except requests.exceptions.ConnectionError:
            return self._format_connection_error()
        except Exception as e:
            return self._format_unexpected_error(str(e), "fetching sources")

    async def archon_rag_query(
        self,
        query: str,
        match_count: Optional[int] = None,
        __user__ = None,
        __event_emitter__ = None
    ) -> str:
        """
        Query Archon knowledge base and return relevant passages with citations
        
        Args:
            query (str): The search query or question
            match_count (int, optional): Maximum number of results (1-20, default from settings)
            __user__: User context (automatically provided)
            __event_emitter__: Event emitter for streaming updates
        
        Returns:
            str: Formatted results with citations in Markdown
        """
        try:
            # Validate inputs
            if not query or not query.strip():
                return "❌ **Error**: Please provide a search query"

            # Use provided values or fallback to defaults
            final_match_count = match_count or self.valves.ARCHON_MAX_RESULTS
            
            # Clamp match_count to reasonable bounds
            final_match_count = max(1, min(20, final_match_count))

            # Check cache
            cache_key = f"{query}:{final_match_count}"
            if self.is_cache_valid(cache_key):
                cached_result = self._cache[cache_key]
                if __event_emitter__:
                    await __event_emitter__({
                        "type": "status",
                        "data": {
                            "description": "Retrieved from cache",
                            "done": True
                        }
                    })
                return f"🔄 **(Cached Result)**\n\n{cached_result}"

            # Start streaming status updates
            if __event_emitter__ and self.valves.ENABLE_STREAMING:
                await __event_emitter__({
                    "type": "status",
                    "data": {
                        "description": f"🔍 Searching Archon knowledge base...",
                        "done": False
                    }
                })

            # Prepare request
            request_body = {
                "query": query,
                "match_count": final_match_count
            }

            # Make API request
            timeout = self.valves.ARCHON_TIMEOUT_MS / 1000.0
            response = requests.post(
                f"{self.valves.ARCHON_BASE_URL}/api/rag/query",
                json=request_body,
                headers=self.get_headers(),
                timeout=timeout
            )

            # Handle response
            if not response.ok:
                error_msg = self._extract_error_message(response)
                return self._format_query_error(error_msg)

            data = response.json()
            results = data.get("results", [])

            if not results:
                return self._format_no_results(query)

            # Stream results if enabled
            if __event_emitter__ and self.valves.ENABLE_STREAMING:
                await self._stream_results(query, results, __event_emitter__)

            # Format final response
            formatted_result = self._format_results(results, query)

            # Cache result
            if self.valves.ENABLE_CACHING:
                # Cleanup old cache entries
                if len(self._cache) > 50:
                    oldest_key = min(self._cache_timestamps, key=self._cache_timestamps.get)
                    del self._cache[oldest_key]
                    del self._cache_timestamps[oldest_key]
                
                self._cache[cache_key] = formatted_result
                self._cache_timestamps[cache_key] = datetime.now()

            return formatted_result

        except requests.exceptions.Timeout:
            return self._format_timeout_error("querying")
        except requests.exceptions.ConnectionError:
            return self._format_connection_error()
        except Exception as e:
            return self._format_unexpected_error(str(e), "querying")

    async def archon_code_search(
        self,
        query: str,
        language: Optional[str] = None,
        limit: Optional[int] = None,
        __user__ = None,
        __event_emitter__ = None
    ) -> str:
        """
        Search for code examples in Archon's knowledge base
        
        Args:
            query (str): Code-related search query
            language (str, optional): Programming language filter (python, javascript, etc.)
            limit (int, optional): Maximum number of code examples
            __user__: User context
            __event_emitter__: Event emitter for streaming
        
        Returns:
            str: Formatted code examples with syntax highlighting
        """
        try:
            if __event_emitter__:
                await __event_emitter__({
                    "type": "status",
                    "data": {
                        "description": "🔍 Searching for code examples...",
                        "done": False
                    }
                })

            # Prepare request
            request_body = {
                "query": query,
                "limit": limit or 5
            }
            if language:
                request_body["language"] = language

            # Make API request
            timeout = self.valves.ARCHON_TIMEOUT_MS / 1000.0
            response = requests.post(
                f"{self.valves.ARCHON_BASE_URL}/api/rag/code-examples",
                json=request_body,
                headers=self.get_headers(),
                timeout=timeout
            )

            if not response.ok:
                error_msg = self._extract_error_message(response)
                return f"❌ **Error searching code examples**: {error_msg}"

            data = response.json()
            examples = data.get("examples", [])

            if not examples:
                return f"📭 **No code examples found** for: \"{query}\"\n\nTry different keywords or remove language filter."

            # Format code examples
            result = f"# 💻 Code Examples for: \"{query}\"\n\n"
            if language:
                result += f"**Language Filter:** {language}\n\n"
            result += "---\n\n"

            for i, example in enumerate(examples, 1):
                code = example.get("code", "")
                lang = example.get("language", "text")
                summary = example.get("summary", "")
                source = example.get("source", "")
                
                result += f"## Example {i}"
                if summary:
                    result += f": {summary}"
                result += "\n\n"
                
                # Code block with syntax highlighting
                result += f"```{lang}\n{code}\n```\n\n"
                result += "---\n\n"

            if __event_emitter__:
                await __event_emitter__({
                    "type": "status",
                    "data": {
                        "description": f"Found {len(examples)} code example(s)",
                        "done": True
                    }
                })

            return result

        except requests.exceptions.Timeout:
            return self._format_timeout_error("searching code examples")
        except requests.exceptions.ConnectionError:
            return self._format_connection_error()
        except Exception as e:
            return self._format_unexpected_error(str(e), "searching code examples")

    async def _stream_results(
        self,
        query: str,
        results: List[dict],
        event_emitter
    ):
        """Stream results progressively for better UX"""
        
        # Stream header
        header = f"# 🔍 Archon RAG Results\n\n"
        header += f"**Query:** \"{query}\"\n"
        header += f"**Found:** {len(results)} result(s)\n\n"
        header += "---\n\n"

        await event_emitter({
            "type": "chat:message:delta",
            "data": {"content": header}
        })

        # Stream each result
        for i, result in enumerate(results, 1):
            content = result.get("content", "").strip()
            metadata = result.get("metadata", {})
            url = metadata.get("url", metadata.get("source_url", ""))
            score = result.get("similarity", 0)
            source_id = metadata.get("source_id", "Unknown Source")

            # Stream citation header
            citation_header = f"## [{i}] {source_id}"
            if score:
                citation_header += f" (Relevance: {score:.1%})"
            citation_header += "\n\n"

            await event_emitter({
                "type": "chat:message:delta",
                "data": {"content": citation_header}
            })
            await asyncio.sleep(0.05)  # Small delay for smooth streaming

            # Stream source URL
            if url:
                source_line = f"**🔗 Source:** [{url}]({url})\n\n"
                await event_emitter({
                    "type": "chat:message:delta",
                    "data": {"content": source_line}
                })
                await asyncio.sleep(0.05)

            # Stream content
            snippet = content[:400] + "..." if len(content) > 400 else content
            content_text = f"**📝 Content:**\n> {snippet}\n\n"
            
            # Add metadata if available
            if metadata:
                interesting_fields = ["title", "author", "date", "type", "chapter", "section"]
                meta_info = []
                for field in interesting_fields:
                    if field in metadata and metadata[field]:
                        meta_info.append(f"**{field.title()}:** {metadata[field]}")
                if meta_info:
                    content_text += "\n".join(meta_info) + "\n\n"
            
            content_text += "---\n\n"

            await event_emitter({
                "type": "chat:message:delta",
                "data": {"content": content_text}
            })
            await asyncio.sleep(0.1)

        # Stream footer with suggestions
        footer = "## 💡 Follow-up Options\n\n"
        footer += "- Ask for more details about any citation\n"
        footer += "- Request summaries: \"Summarize citation [1]\"\n"
        footer += "- Compare sources: \"What's the difference between citations [1] and [2]?\"\n"
        footer += "- Refine search: \"Find more about [specific topic]\"\n"
        footer += "- Check sources: Use `get_available_sources()` to see all sources\n\n"

        await event_emitter({
            "type": "chat:message:delta",
            "data": {"content": footer}
        })

        # Final completion status
        await event_emitter({
            "type": "status",
            "data": {
                "description": f"✅ Retrieved {len(results)} results from Archon",
                "done": True
            }
        })

    def _format_results(
        self,
        results: List[dict],
        original_query: str
    ) -> str:
        """Format results in markdown with rich citations"""
        
        header = f"# 🔍 Archon RAG Results\n\n"
        header += f"**Query:** \"{original_query}\"\n"
        header += f"**Found:** {len(results)} result(s)\n"
        header += f"**Timestamp:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
        header += "---\n\n"

        citations = []
        for i, result in enumerate(results, 1):
            content = result.get("content", "").strip()
            metadata = result.get("metadata", {})
            url = metadata.get("url", metadata.get("source_url", ""))
            score = result.get("similarity", 0)
            source_id = metadata.get("source_id", "Unknown Source")

            citation = f"## [{i}] {source_id}"
            if score:
                citation += f" (Relevance: {score:.1%})"
            citation += "\n\n"

            if url:
                citation += f"**🔗 Source:** [{url}]({url})\n\n"

            # Truncate very long content for readability
            snippet = content[:400] + "..." if len(content) > 400 else content
            citation += f"**📝 Content:**\n> {snippet}\n\n"

            # Add metadata if available
            if metadata:
                interesting_fields = ["title", "author", "date", "type", "chapter", "section", "page"]
                meta_info = []
                for field in interesting_fields:
                    if field in metadata and metadata[field]:
                        meta_info.append(f"**{field.title()}:** {metadata[field]}")
                if meta_info:
                    citation += "\n".join(meta_info) + "\n\n"

            citation += "---\n\n"
            citations.append(citation)

        # Add follow-up suggestions
        footer = "## 💡 Follow-up Options\n\n"
        footer += "- Ask for more details about any citation\n"
        footer += "- Request summaries: \"Summarize citation [1]\"\n"
        footer += "- Compare sources: \"What's the difference between citations [1] and [2]?\"\n"
        footer += "- Refine search: \"Find more about [specific topic]\"\n"
        footer += "- Check sources: Use `get_available_sources()` to see all sources\n"
        footer += "- Search code: Use `archon_code_search()` for code examples\n\n"

        return header + "".join(citations) + footer

    def _extract_error_message(self, response) -> str:
        """Extract error message from response"""
        try:
            error_data = response.json()
            return error_data.get("detail", error_data.get("error", f"HTTP {response.status_code}"))
        except:
            return f"HTTP {response.status_code}"

    def _format_query_error(self, error_msg: str) -> str:
        """Format query error message"""
        result = f"❌ **Archon RAG Error**: {error_msg}\n\n"
        result += "**Troubleshooting:**\n"
        result += f"- Check Archon server at `{self.valves.ARCHON_BASE_URL}`\n"
        result += "- Verify network connectivity\n"
        if self.valves.ARCHON_API_KEY:
            result += "- Confirm API credentials are valid\n"
        return result

    def _format_no_results(self, query: str) -> str:
        """Format no results message"""
        result = "📭 **No Results Found**\n\n"
        result += f"No relevant information found for: **\"{query}\"**\n\n"
        result += "**Try:**\n"
        result += "- Rephrasing your question\n"
        result += "- Using different keywords\n"
        result += "- Checking if documents are indexed in Archon\n"
        return result

    def _format_timeout_error(self, action: str) -> str:
        """Format timeout error message"""
        result = f"⏱️ **Request Timeout**\n\n"
        result += f"Archon didn't respond within {self.valves.ARCHON_TIMEOUT_MS/1000}s while {action}.\n\n"
        result += "**Try:**\n"
        result += "- Increasing timeout in tool settings\n"
        result += "- Reducing match_count parameter\n"
        result += "- Checking Archon server performance\n"
        result += f"- Verifying server is running at `{self.valves.ARCHON_BASE_URL}`\n"
        return result

    def _format_connection_error(self) -> str:
        """Format connection error message"""
        result = f"🔌 **Connection Error**\n\n"
        result += f"Cannot connect to Archon at `{self.valves.ARCHON_BASE_URL}`\n\n"
        result += "**Check:**\n"
        result += "- Archon server is running (`docker compose ps`)\n"
        result += "- Base URL is correct in tool settings\n"
        result += "- Network connectivity between Open WebUI and Archon\n"
        result += "- Firewall/security group settings\n"
        result += "- If using Docker, ensure containers are on same network\n"
        return result

    def _format_unexpected_error(self, error: str, action: str) -> str:
        """Format unexpected error message"""
        result = f"💥 **Unexpected Error**\n\n"
        result += f"Error while {action}:\n"
        result += f"```\n{error}\n```\n\n"
        result += "**Actions:**\n"
        result += "- Check tool configuration in settings\n"
        result += "- Verify Archon server status\n"
        result += "- Review Open WebUI logs for details\n"
        result += "- Contact administrator if error persists\n"
        return result