# Open WebUI × Archon RAG Connector - Technical Implementation Guide

_Research conducted: 2025-09-06_
_Based on Open WebUI v0.6+ architecture_

## Executive Summary

This comprehensive technical guide provides concrete implementation details for building an Archon RAG connector for Open WebUI. After extensive research into Open WebUI's plugin system, the **Tool API** approach is recommended as the most suitable for our use case, offering native function calling support, streaming capabilities via `__event_emitter__`, and built-in UI integration.

## Research Scope and Methodology

Conducted extensive research across:

- Open WebUI official documentation (docs.openwebui.com)
- GitHub repository analysis (open-webui/open-webui, open-webui/pipelines)
- Community discussions and implementation examples
- Backend architecture and API endpoint analysis
- Plugin system comparison (Tools vs Functions vs Pipelines)

## Key Findings

### 1. Open WebUI Plugin Architecture Overview

Open WebUI provides three distinct plugin types:

#### Tools (Recommended for Archon Connector)

- **Definition**: Small Python scripts that add "superpowers" to LLMs
- **Execution**: Direct execution on Open WebUI server
- **Dependencies**: Limited to pre-installed Python libraries in Open WebUI
- **Use Case**: Perfect for API integrations like Archon RAG
- **Native Function Calling**: Supports models like GPT-4o for automatic tool invocation

#### Functions

- **Types**: Pipe Functions (custom models), Filter Functions (input/output processing), Action Functions (chat buttons)
- **Execution**: Direct execution on Open WebUI server
- **Limitation**: Cannot download new packages
- **Use Case**: Built-in functionality extensions

#### Pipelines

- **Definition**: Heavyweight plugin framework for custom logic
- **Execution**: Separate server with full Python dependency support
- **Use Case**: Computationally heavy tasks, custom model integrations
- **Complexity**: Overkill for simple API integrations

### 2. Tool Registration API and Implementation

#### Exact Class Structure

```python
import requests
import json
from typing import Optional, List, Dict, Any
import asyncio

class Tools:
    def __init__(self):
        self.citation = True  # Enable citation support

    class Valves(BaseModel):
        """Configuration valves for the tool"""
        ARCHON_BASE_URL: str = Field(
            default="http://localhost:8181",
            description="Base URL for Archon server"
        )
        ARCHON_TIMEOUT_MS: int = Field(
            default=15000,
            description="Request timeout in milliseconds"
        )
        ARCHON_MAX_RESULTS: int = Field(
            default=5,
            description="Maximum number of RAG results to return"
        )
        ARCHON_DEFAULT_SOURCE: str = Field(
            default="",
            description="Default source to query (empty for all sources)"
        )
```

#### Method Signature for RAG Query Tool

```python
async def archon_rag_query(
    self,
    query: str,
    source: Optional[str] = None,
    match_count: Optional[int] = None,
    __user__: Optional[dict] = None,
    __event_emitter__: Optional[callable] = None
) -> str:
    """
    Query Archon knowledge base and return relevant passages with citations.

    Args:
        query (str): The search query or question
        source (str, optional): Specific source to search (source_id)
        match_count (int, optional): Maximum number of results to return
        __user__ (dict): User context (automatically provided by Open WebUI)
        __event_emitter__ (callable): Event emitter for streaming updates

    Returns:
        str: Formatted results with citations in Markdown
    """
```

### 3. Streaming Support and Implementation

#### Event Emitter System

Open WebUI provides comprehensive streaming support through the `__event_emitter__` system:

```python
# Status updates during processing
await __event_emitter__({
    "type": "status",
    "data": {
        "description": "Querying Archon knowledge base...",
        "done": False
    }
})

# Stream partial results
await __event_emitter__({
    "type": "chat:message:delta",
    "data": {
        "content": "Found relevant information:\n\n"
    }
})

# Stream citations progressively
for i, result in enumerate(results):
    citation_text = f"[{i+1}] {result.get('metadata', {}).get('url', 'N/A')}\n"
    await __event_emitter__({
        "type": "chat:message:delta",
        "data": {
            "content": citation_text
        }
    })
    await asyncio.sleep(0.1)  # Small delay for better UX

# Final completion
await __event_emitter__({
    "type": "chat:message",
    "data": {
        "content": final_formatted_response
    }
})
```

#### Available Event Types

- `status`: Progress indicators
- `chat:message:delta`: Streaming text chunks
- `chat:message`: Final/complete message
- `citation`: Structured citation data
- `notification`: UI toast messages
- `confirmation`: User confirmation dialogs
- `input`: Request user input

### 4. File Structure and Deployment

#### Tool File Placement

Tools are installed through the Open WebUI interface:

1. Navigate to **Workspace > Tools**
2. Click **"Create New Tool"**
3. Paste Python code containing the `Tools` class
4. Provide name and description
5. Enable for specific models or globally

#### No Physical File Deployment Required

- Tools are stored in Open WebUI's database
- No need to place files in specific directories
- Hot-reload supported - changes take effect immediately
- No server restart required

### 5. Environment Variable Handling

#### Valves System for Configuration

Open WebUI uses a "Valves" system for tool configuration:

```python
from pydantic import BaseModel, Field
import os

class Tools:
    class Valves(BaseModel):
        ARCHON_BASE_URL: str = Field(
            default=os.getenv("ARCHON_BASE_URL", "http://localhost:8181"),
            description="Archon server base URL"
        )
        # Other configuration fields...

    def __init__(self):
        self.valves = self.Valves()

    async def on_valves_updated(self):
        """Called when configuration is updated"""
        print(f"Configuration updated: {self.valves}")
```

#### Environment Variable Access Patterns

```python
# Direct access
base_url = os.getenv("ARCHON_BASE_URL", "http://localhost:8181")

# Through valves (recommended)
base_url = self.valves.ARCHON_BASE_URL

# Docker environment variables
# Set in docker-compose.yml:
# environment:
#   - ARCHON_BASE_URL=http://host.docker.internal:8181
#   - ARCHON_TIMEOUT_MS=30000
```

### 6. Authentication and CORS Handling

#### API Key Management

```python
class Tools:
    class Valves(BaseModel):
        ARCHON_API_KEY: str = Field(
            default="",
            description="API key for Archon authentication"
        )

    def get_headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.valves.ARCHON_API_KEY:
            headers["Authorization"] = f"Bearer {self.valves.ARCHON_API_KEY}"
        return headers
```

#### CORS Configuration

- Tools run server-side in Open WebUI, avoiding CORS issues
- No browser-based requests - all HTTP calls are server-side
- If Archon needs CORS enabled: `CORS_ALLOW_ORIGIN=http://localhost:3737` (Open WebUI frontend)

### 7. Error Handling Patterns

#### Comprehensive Error Handling

````python
async def archon_rag_query(self, query: str, __event_emitter__=None) -> str:
    try:
        # Update status
        if __event_emitter__:
            await __event_emitter__({
                "type": "status",
                "data": {
                    "description": "Connecting to Archon...",
                    "done": False
                }
            })

        timeout = self.valves.ARCHON_TIMEOUT_MS / 1000.0

        response = requests.post(
            f"{self.valves.ARCHON_BASE_URL}/api/rag/query",
            json={
                "query": query,
                "match_count": self.valves.ARCHON_MAX_RESULTS,
                "source": self.valves.ARCHON_DEFAULT_SOURCE or None
            },
            headers=self.get_headers(),
            timeout=timeout
        )

        if not response.ok:
            error_detail = "Unknown error"
            try:
                error_data = response.json()
                error_detail = error_data.get("detail", f"HTTP {response.status_code}")
            except:
                error_detail = f"HTTP {response.status_code}"

            return f"❌ **Archon RAG Error**: {error_detail}\n\nTry checking:\n- Archon server is running at `{self.valves.ARCHON_BASE_URL}`\n- Network connectivity\n- API credentials"

        data = response.json()
        results = data.get("results", [])

        if not results:
            return f"📭 **No Results Found**\n\nNo relevant information found for: \"{query}\"\n\nTry:\n- Rephrasing your question\n- Using different keywords\n- Checking if documents are indexed"

        return self.format_results(results, query)

    except requests.exceptions.Timeout:
        return f"⏱️ **Request Timeout**\n\nArchon didn't respond within {self.valves.ARCHON_TIMEOUT_MS/1000}s.\n\nTry:\n- Increasing timeout in tool settings\n- Reducing match_count\n- Checking Archon server performance"

    except requests.exceptions.ConnectionError:
        return f"🔌 **Connection Error**\n\nCannot connect to Archon at `{self.valves.ARCHON_BASE_URL}`\n\nCheck:\n- Archon server is running\n- Base URL is correct\n- Network connectivity"

    except Exception as e:
        return f"💥 **Unexpected Error**\n\n```\n{str(e)}\n```\n\nPlease check tool configuration and try again."
````

### 8. State Management and Caching

#### Per-Conversation Memory

Open WebUI doesn't provide built-in conversation memory for Tools, but you can implement it:

```python
class Tools:
    def __init__(self):
        self._conversation_cache = {}  # Simple in-memory cache

    def get_conversation_id(self, __user__: dict) -> str:
        """Extract conversation ID from user context"""
        # Note: Actual conversation ID extraction may vary
        return __user__.get("conversation_id", "default")

    async def archon_rag_query(self, query: str, __user__: dict = None) -> str:
        conv_id = self.get_conversation_id(__user__)

        # Check cache
        cache_key = f"{conv_id}:{query[:50]}"  # Truncated query as key
        if cache_key in self._conversation_cache:
            cached_result = self._conversation_cache[cache_key]
            return f"🔄 **Cached Result**\n\n{cached_result}"

        # Make request...
        result = await self.make_archon_request(query)

        # Cache result (with size limit)
        if len(self._conversation_cache) > 50:
            # Simple LRU: remove oldest
            oldest_key = next(iter(self._conversation_cache))
            del self._conversation_cache[oldest_key]

        self._conversation_cache[cache_key] = result
        return result
```

#### Follow-up Query Support

```python
def format_results(self, results: List[dict], original_query: str) -> str:
    """Format results with follow-up suggestions"""

    formatted = f"# 🔍 Archon RAG Results for: \"{original_query}\"\n\n"

    for i, result in enumerate(results, 1):
        content = result.get("content", "")[:300] + "..." if len(result.get("content", "")) > 300 else result.get("content", "")
        metadata = result.get("metadata", {})
        url = metadata.get("url", metadata.get("source_url", ""))
        score = result.get("similarity", 0)

        formatted += f"## [{i}] Citation (Score: {score:.3f})\n"
        if url:
            formatted += f"**Source**: [{url}]({url})\n\n"
        formatted += f"> {content}\n\n"
        formatted += "---\n\n"

    # Add follow-up suggestions
    formatted += "## 💡 Follow-up Options\n\n"
    formatted += "- Ask more specific questions about any citation\n"
    formatted += "- Request summaries: \"Summarize citation [1]\"\n"
    formatted += "- Compare sources: \"Compare citations [1] and [2]\"\n"
    formatted += f"- Refine search: \"More results like citation [1]\"\n\n"

    return formatted
```

### 9. UI Integration and Citation Rendering

#### Structured Citation Format

```python
async def emit_structured_citations(self, results: List[dict], __event_emitter__):
    """Emit structured citation events for better UI integration"""

    for i, result in enumerate(results):
        await __event_emitter__({
            "type": "citation",
            "data": {
                "name": f"archon_citation_{i+1}",
                "document": [result.get("content", "")],
                "metadata": {
                    "name": f"Citation {i+1}",
                    "source": result.get("metadata", {}).get("url", ""),
                    "score": result.get("similarity", 0),
                    "source_id": result.get("metadata", {}).get("source_id", "")
                },
                "distances": [1 - result.get("similarity", 0)]  # Convert similarity to distance
            }
        })
```

#### Markdown Citation Rendering

```python
def render_citations_markdown(self, results: List[dict]) -> str:
    """Render citations in markdown format with rich formatting"""

    if not results:
        return "No citations found."

    citations = []
    for i, result in enumerate(results, 1):
        content = result.get("content", "").strip()
        metadata = result.get("metadata", {})
        url = metadata.get("url", metadata.get("source_url", ""))
        score = result.get("similarity", 0)
        source_id = metadata.get("source_id", "Unknown Source")

        # Truncate content for readability
        snippet = content[:240] + "..." if len(content) > 240 else content

        citation = f"### [{i}] {source_id}"
        if score:
            citation += f" (Relevance: {score:.1%})"
        citation += "\n\n"

        if url:
            citation += f"**🔗 Source:** [{url}]({url})\n\n"

        citation += f"**📝 Content:**\n> {snippet}\n\n"
        citation += "---\n"

        citations.append(citation)

    return "\n".join(citations)
```

### 10. Complete Implementation Template

#### Full Tool Implementation

````python
import requests
import json
import asyncio
import os
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field

class Tools:
    """
    Archon RAG Connector for Open WebUI
    Provides seamless integration with Archon's knowledge base
    """

    class Valves(BaseModel):
        """Configuration settings for Archon RAG connector"""
        ARCHON_BASE_URL: str = Field(
            default=os.getenv("ARCHON_BASE_URL", "http://localhost:8181"),
            description="Base URL for Archon server (e.g., http://localhost:8181)"
        )
        ARCHON_TIMEOUT_MS: int = Field(
            default=int(os.getenv("ARCHON_TIMEOUT_MS", "15000")),
            description="Request timeout in milliseconds"
        )
        ARCHON_MAX_RESULTS: int = Field(
            default=int(os.getenv("ARCHON_MAX_RESULTS", "5")),
            description="Maximum number of RAG results to return (1-20)"
        )
        ARCHON_DEFAULT_SOURCE: str = Field(
            default=os.getenv("ARCHON_DEFAULT_SOURCE", ""),
            description="Default source to query (empty for all sources)"
        )
        ARCHON_API_KEY: str = Field(
            default=os.getenv("ARCHON_API_KEY", ""),
            description="API key for Archon authentication (if required)"
        )
        ENABLE_STREAMING: bool = Field(
            default=True,
            description="Enable streaming responses for better UX"
        )

    def __init__(self):
        """Initialize the Archon RAG connector"""
        self.valves = self.Valves()
        self.citation = True  # Enable citation support
        self._cache = {}  # Simple result cache

    async def on_valves_updated(self):
        """Called when tool configuration is updated"""
        print(f"Archon RAG Connector configuration updated")
        self._cache.clear()  # Clear cache on config change

    def get_headers(self) -> Dict[str, str]:
        """Get HTTP headers for Archon API requests"""
        headers = {"Content-Type": "application/json"}
        if self.valves.ARCHON_API_KEY:
            headers["Authorization"] = f"Bearer {self.valves.ARCHON_API_KEY}"
        return headers

    async def get_available_sources(
        self,
        __user__: Optional[dict] = None,
        __event_emitter__: Optional[callable] = None
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
                        "description": "Fetching available sources...",
                        "done": False
                    }
                })

            response = requests.get(
                f"{self.valves.ARCHON_BASE_URL}/api/rag/sources",
                headers=self.get_headers(),
                timeout=self.valves.ARCHON_TIMEOUT_MS / 1000.0
            )

            if not response.ok:
                return f"❌ Error fetching sources: HTTP {response.status_code}"

            data = response.json()
            sources = data.get("sources", [])

            if not sources:
                return "📭 No sources available in Archon knowledge base"

            result = "# 📚 Available Sources in Archon\n\n"
            for source in sources:
                source_id = source.get("source_id", "Unknown")
                title = source.get("title", source_id)
                doc_count = source.get("document_count", "Unknown")

                result += f"- **{title}** (`{source_id}`)\n"
                if doc_count != "Unknown":
                    result += f"  - Documents: {doc_count}\n"
                result += "\n"

            result += "\n💡 Use source IDs in queries: `archon_rag_query('your question', source='source_id')`"

            return result

        except requests.exceptions.Timeout:
            return f"⏱️ Timeout fetching sources from {self.valves.ARCHON_BASE_URL}"
        except requests.exceptions.ConnectionError:
            return f"🔌 Cannot connect to Archon at {self.valves.ARCHON_BASE_URL}"
        except Exception as e:
            return f"💥 Error fetching sources: {str(e)}"

    async def archon_rag_query(
        self,
        query: str,
        source: Optional[str] = None,
        match_count: Optional[int] = None,
        __user__: Optional[dict] = None,
        __event_emitter__: Optional[callable] = None
    ) -> str:
        """
        Query Archon knowledge base and return relevant passages with citations

        Args:
            query (str): The search query or question
            source (str, optional): Specific source to search (source_id from get_available_sources)
            match_count (int, optional): Maximum number of results (1-20, default from settings)
            __user__ (dict): User context (automatically provided)
            __event_emitter__ (callable): Event emitter for streaming updates

        Returns:
            str: Formatted results with citations in Markdown
        """
        try:
            # Validate inputs
            if not query or not query.strip():
                return "❌ **Error**: Please provide a search query"

            # Use provided values or fallback to defaults
            final_source = source or self.valves.ARCHON_DEFAULT_SOURCE or None
            final_match_count = match_count or self.valves.ARCHON_MAX_RESULTS

            # Clamp match_count to reasonable bounds
            final_match_count = max(1, min(20, final_match_count))

            # Check cache
            cache_key = f"{query}:{final_source}:{final_match_count}"
            if cache_key in self._cache:
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
                        "description": f"Querying Archon knowledge base...",
                        "done": False
                    }
                })

            # Prepare request
            request_body = {
                "query": query,
                "match_count": final_match_count
            }
            if final_source:
                request_body["source"] = final_source

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
                error_detail = "Unknown error"
                try:
                    error_data = response.json()
                    error_detail = error_data.get("detail", error_data.get("error", f"HTTP {response.status_code}"))
                except:
                    error_detail = f"HTTP {response.status_code}"

                return f"❌ **Archon RAG Error**: {error_detail}\n\n**Troubleshooting:**\n- Check Archon server at `{self.valves.ARCHON_BASE_URL}`\n- Verify network connectivity\n- Confirm API credentials\n- Check source ID: `{final_source or 'all sources'}`"

            data = response.json()
            results = data.get("results", [])

            if not results:
                suggestion_text = f"No relevant information found for: **\"{query}\"**"
                if final_source:
                    suggestion_text += f" in source `{final_source}`"

                return f"📭 **No Results Found**\n\n{suggestion_text}\n\n**Try:**\n- Rephrasing your question\n- Using different keywords\n- Removing source filter\n- Checking if documents are indexed"

            # Stream results if enabled
            if __event_emitter__ and self.valves.ENABLE_STREAMING:
                await self.stream_results(query, results, final_source, __event_emitter__)

            # Format final response
            formatted_result = self.format_results(results, query, final_source)

            # Cache result (simple size limit)
            if len(self._cache) > 20:
                oldest_key = next(iter(self._cache))
                del self._cache[oldest_key]
            self._cache[cache_key] = formatted_result

            return formatted_result

        except requests.exceptions.Timeout:
            return f"⏱️ **Request Timeout**\n\nArchon didn't respond within {self.valves.ARCHON_TIMEOUT_MS/1000}s.\n\n**Try:**\n- Increasing timeout in tool settings\n- Reducing match_count parameter\n- Checking Archon server performance"

        except requests.exceptions.ConnectionError:
            return f"🔌 **Connection Error**\n\nCannot connect to Archon at `{self.valves.ARCHON_BASE_URL}`\n\n**Check:**\n- Archon server is running\n- Base URL is correct\n- Network connectivity\n- Firewall settings"

        except Exception as e:
            return f"💥 **Unexpected Error**\n\n```\n{str(e)}\n```\n\n**Actions:**\n- Check tool configuration\n- Verify Archon server status\n- Contact administrator if error persists"

    async def stream_results(
        self,
        query: str,
        results: List[dict],
        source: Optional[str],
        event_emitter: callable
    ):
        """Stream results progressively for better UX"""

        # Stream header
        header = f"# 🔍 Archon RAG Results\n\n**Query:** \"{query}\""
        if source:
            header += f"\n**Source:** `{source}`"
        header += f"\n**Found:** {len(results)} result(s)\n\n---\n\n"

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
            await asyncio.sleep(0.1)

            # Stream source URL
            if url:
                source_line = f"**🔗 Source:** [{url}]({url})\n\n"
                await event_emitter({
                    "type": "chat:message:delta",
                    "data": {"content": source_line}
                })
                await asyncio.sleep(0.1)

            # Stream content in chunks for very long content
            snippet = content[:400] + "..." if len(content) > 400 else content
            content_text = f"**📝 Content:**\n> {snippet}\n\n---\n\n"

            await event_emitter({
                "type": "chat:message:delta",
                "data": {"content": content_text}
            })
            await asyncio.sleep(0.2)

        # Stream footer with suggestions
        footer = "## 💡 Follow-up Options\n\n"
        footer += "- Ask more specific questions about any citation\n"
        footer += "- Request summaries: \"Summarize citation [1]\"\n"
        footer += "- Compare sources: \"Compare citations [1] and [2]\"\n"
        footer += "- Refine search: \"More results about [specific topic]\"\n\n"

        await event_emitter({
            "type": "chat:message:delta",
            "data": {"content": footer}
        })

        # Final completion status
        await event_emitter({
            "type": "status",
            "data": {
                "description": f"Retrieved {len(results)} results from Archon",
                "done": True
            }
        })

    def format_results(
        self,
        results: List[dict],
        original_query: str,
        source: Optional[str] = None
    ) -> str:
        """Format results in markdown with rich citations"""

        header = f"# 🔍 Archon RAG Results\n\n**Query:** \"{original_query}\""
        if source:
            header += f"\n**Source:** `{source}`"
        header += f"\n**Found:** {len(results)} result(s)\n\n---\n\n"

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
                interesting_fields = ["title", "author", "date", "type"]
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
        footer += "- Ask more specific questions about any citation\n"
        footer += "- Request summaries: \"Summarize citation [1]\"\n"
        footer += "- Compare sources: \"Compare citations [1] and [2]\"\n"
        footer += "- Refine search: \"More results about [specific topic]\"\n\n"

        return header + "".join(citations) + footer
````

## Analysis and Insights

### Comparison Matrix: Tools vs Functions vs Pipelines

| Feature                     | Tools (⭐ Recommended) | Functions               | Pipelines              |
| --------------------------- | ---------------------- | ----------------------- | ---------------------- |
| **Complexity**              | Simple API integration | Moderate                | High                   |
| **Dependencies**            | Pre-installed only     | Pre-installed only      | Any Python package     |
| **Execution**               | Open WebUI server      | Open WebUI server       | Separate server        |
| **Performance**             | Good for API calls     | Good for built-in logic | Best for heavy compute |
| **Setup**                   | UI-based installation  | UI-based installation   | Docker deployment      |
| **Native Function Calling** | ✅ Yes                 | ❌ No                   | ⚠️ Limited             |
| **Streaming**               | ✅ Full support        | ⚠️ Limited              | ✅ Full support        |
| **State Management**        | Manual implementation  | Manual implementation   | Built-in support       |
| **Hot Reload**              | ✅ Immediate           | ✅ Immediate            | ❌ Restart required    |
| **Use Case Fit**            | Perfect for Archon RAG | Overkill                | Massive overkill       |

### Recommended Architecture

Based on research findings, the **Tool API approach** is optimal for the Archon RAG connector:

1. **Native Function Calling**: Models like GPT-4o can automatically invoke the tool based on user queries
2. **Streaming Support**: Full `__event_emitter__` support for real-time updates
3. **Simple Deployment**: No file system access or server setup required
4. **Configuration**: Built-in Valves system for easy configuration
5. **Error Handling**: Rich error reporting capabilities
6. **UI Integration**: Automatic citation rendering and formatting

## Conclusions

### Key Implementation Requirements Met

1. ✅ **Custom Tool Registration**: Use Tools class with proper method signatures
2. ✅ **Streaming Support**: Full SSE-like streaming via `__event_emitter__`
3. ✅ **Webhook Alternative**: Direct API integration more reliable than webhooks
4. ✅ **UI Citation Rendering**: Markdown formatting with structured citations
5. ✅ **State Management**: Manual caching implementation provided
6. ✅ **Authentication**: API key support through Valves configuration
7. ✅ **Error Handling**: Comprehensive error patterns with user-friendly messages

### Deployment Checklist

- [ ] Copy complete tool code to Open WebUI Workspace > Tools
- [ ] Configure Valves (Archon URL, timeouts, API keys)
- [ ] Enable tool for specific models (recommend GPT-4o for native function calling)
- [ ] Test with sample queries
- [ ] Configure environment variables if using Docker
- [ ] Set up Archon CORS if needed: `CORS_ALLOW_ORIGIN=http://localhost:3737`

### Testing Commands

```bash
# Test Archon server accessibility
curl -X POST http://localhost:8181/api/rag/query \
  -H 'Content-Type: application/json' \
  -d '{"query":"test query","match_count":3}'

# Test available sources
curl -X GET http://localhost:8181/api/rag/sources

# Test from Open WebUI chat
# 1. Enable "Archon RAG Query" tool for your model
# 2. Ask: "What information do you have about [topic]?"
# 3. The model should automatically invoke the tool
```

### Production Considerations

1. **Error Monitoring**: Implement logging for production deployments
2. **Rate Limiting**: Consider implementing request throttling for high-volume usage
3. **Caching**: Current implementation uses simple in-memory cache - consider Redis for production
4. **Security**: Always validate API keys and implement proper authentication
5. **Performance**: Monitor response times and optimize match_count based on usage patterns

## References and Sources

- [Open WebUI Documentation](https://docs.openwebui.com/)
- [Open WebUI GitHub Repository](https://github.com/open-webui/open-webui)
- [Pipelines Framework](https://github.com/open-webui/pipelines)
- [Open WebUI Community Tools](https://openwebui.com/tools)
- [Open WebUI Community Functions](https://openwebui.com/functions)
- Community discussions and implementation examples from GitHub
