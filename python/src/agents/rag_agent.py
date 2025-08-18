"""
RAG Agent - Conversational Search and Retrieval with PydanticAI

This agent enables users to search and chat with documents stored in the RAG system.
It uses the perform_rag_query functionality to retrieve relevant content and provide
intelligent responses based on the retrieved information.
"""

import logging
import os
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field
from pydantic_ai import Agent, RunContext

from .base_agent import ArchonDependencies, BaseAgent
from .mcp_client import get_mcp_client

logger = logging.getLogger(__name__)


@dataclass
class RagDependencies(ArchonDependencies):
    """Dependencies for RAG operations."""

    project_id: str | None = None
    source_filter: str | None = None
    match_count: int = 5
    progress_callback: Any | None = None  # Callback for progress updates


class RagQueryResult(BaseModel):
    """Structured output for RAG query results."""

    query_type: str = Field(description="Type of query: search, explain, summarize, compare")
    original_query: str = Field(description="The original user query")
    refined_query: str | None = Field(
        description="Refined query used for search if different from original"
    )
    results_found: int = Field(description="Number of relevant results found")
    sources: list[str] = Field(description="List of unique sources referenced")
    answer: str = Field(description="The synthesized answer based on retrieved content")
    citations: list[dict[str, Any]] = Field(description="Citations with source and relevance info")
    success: bool = Field(description="Whether the query was successful")
    message: str = Field(description="Status message or error description")


class RagAgent(BaseAgent[RagDependencies, str]):
    """
    Conversational agent for RAG-based document search and retrieval.

    Capabilities:
    - Search documents using natural language queries
    - Filter by specific sources
    - Search code examples
    - Provide synthesized answers with citations
    - Explain concepts found in documentation
    """

    def __init__(self, model: str = None, **kwargs):
        # Use provided model or fall back to default
        if model is None:
            model = os.getenv("RAG_AGENT_MODEL", "openai:gpt-4o-mini")

        # Log model usage for visibility
        if model.startswith("ollama:"):
            logger.info(f"Using Ollama model for RAG agent: {model}")
            logger.info("Ensure Ollama server is running at http://localhost:11434")
        elif model.startswith("openrouter:"):
            logger.info(f"Using OpenRouter model for RAG agent: {model}")
        elif model.startswith("deepseek:"):
            logger.info(f"Using DeepSeek model for RAG agent: {model}")

        super().__init__(
            model=model, name="RagAgent", retries=3, enable_rate_limiting=True, **kwargs
        )

    def _create_agent(self, **kwargs) -> Agent:
        """Create the PydanticAI agent with tools and prompts."""

        agent = Agent(
            model=self.model,
            deps_type=RagDependencies,
            system_prompt="""You are a RAG (Retrieval-Augmented Generation) Assistant that helps users search and understand documentation through conversation.

**Your Capabilities:**
- Search through crawled documentation using semantic search
- Filter searches by specific sources or domains
- Find relevant code examples
- Synthesize information from multiple sources
- Provide clear, cited answers based on retrieved content
- Explain technical concepts found in documentation

**Your Approach:**
1. **Understand the query** - Interpret what the user is looking for
2. **Search effectively** - Use appropriate search terms and filters
3. **Analyze results** - Review retrieved content for relevance
4. **Synthesize answers** - Combine information from multiple sources
5. **Cite sources** - Always provide references to source documents

**Common Queries:**
- "What resources/sources are available?" → Use list_available_sources tool
- "Search for X" → Use search_documents tool
- "Find code examples for Y" → Use search_code_examples tool
- "What documentation do you have?" → Use list_available_sources tool

**Search Strategies:**
- For conceptual questions: Use broader search terms
- For specific features: Use exact terminology
- For code examples: Search for function names, patterns
- For comparisons: Search for each item separately

**Response Guidelines:**
- Provide direct answers based on retrieved content
- Include relevant quotes from sources
- Cite sources with URLs when available
- Admit when information is not found
- Suggest alternative searches if needed""",
            **kwargs,
        )

        # Register dynamic system prompt for context
        @agent.system_prompt
        async def add_search_context(ctx: RunContext[RagDependencies]) -> str:
            source_info = (
                f"Source Filter: {ctx.deps.source_filter}"
                if ctx.deps.source_filter
                else "No source filter"
            )
            return f"""
**Current Search Context:**
- Project ID: {ctx.deps.project_id or "Global search"}
- {source_info}
- Max Results: {ctx.deps.match_count}
- Timestamp: {datetime.now().isoformat()}
"""

        # Register tools for RAG operations
        @agent.tool
        async def search_documents(
            ctx: RunContext[RagDependencies], query: str, source_filter: str | None = None
        ) -> str:
            """Search through documents using RAG query."""
            try:
                # Use source filter from context if not provided
                if source_filter is None:
                    source_filter = ctx.deps.source_filter

                # Use MCP client to perform RAG query
                mcp_client = await get_mcp_client()
                result_json = await mcp_client.perform_rag_query(
                    query=query, source=source_filter, match_count=ctx.deps.match_count
                )

                # Parse the JSON response
                import json

                result = json.loads(result_json)

                if not result.get("success", False):
                    return f"Search failed: {result.get('error', 'Unknown error')}"

                results = result.get("results", [])
                if not results:
                    return "No results found for your query. Try using different search terms or removing filters."

                # Format results for display
                formatted_results = []
                for i, res in enumerate(results, 1):
                    similarity = res.get("similarity_score", res.get("similarity", 0))
                    metadata = res.get("metadata", {})
                    source = metadata.get("source", "Unknown")
                    url = metadata.get("url", res.get("url", ""))
                    content = res.get("content", "")

                    # Truncate content if too long
                    if len(content) > 500:
                        content = content[:500] + "..."

                    formatted_results.append(
                        f"**Result {i}** (Relevance: {similarity:.2%})\n"
                        f"Source: {source}\n"
                        f"URL: {url}\n"
                        f"Content: {content}\n"
                    )

                return f"Found {len(results)} relevant results:\n\n" + "\n---\n".join(
                    formatted_results
                )

            except Exception as e:
                logger.error(f"Error searching documents: {e}")
                return f"Error performing search: {str(e)}"

        @agent.tool
        async def list_available_sources(ctx: RunContext[RagDependencies]) -> str:
            """List all available sources that can be searched."""
            try:
                # Use MCP client to get available sources
                mcp_client = await get_mcp_client()
                result_json = await mcp_client.get_available_sources()

                # Parse the JSON response
                import json

                result = json.loads(result_json)

                if not result.get("success", False):
                    return f"Failed to get sources: {result.get('error', 'Unknown error')}"

                sources = result.get("sources", [])
                if not sources:
                    return "No sources are currently available. You may need to crawl some documentation first."

                source_list = []
                for source in sources:
                    source_id = source.get("source_id", "Unknown")
                    title = source.get("title", "Untitled")
                    description = source.get("description", "")
                    created = source.get("created_at", "")

                    # Format the description if available
                    desc_text = f" - {description}" if description else ""

                    source_list.append(
                        f"- **{source_id}**: {title}{desc_text} (added {created[:10]})"
                    )

                return f"Available sources ({len(sources)} total):\n" + "\n".join(source_list)

            except Exception as e:
                logger.error(f"Error listing sources: {e}")
                return f"Error retrieving sources: {str(e)}"

        @agent.tool
        async def search_code_examples(
            ctx: RunContext[RagDependencies], query: str, source_filter: str | None = None
        ) -> str:
            """Search for code examples related to the query."""
            try:
                # Use source filter from context if not provided
                if source_filter is None:
                    source_filter = ctx.deps.source_filter

                # Use MCP client to search code examples
                mcp_client = await get_mcp_client()
                result_json = await mcp_client.search_code_examples(
                    query=query, source_id=source_filter, match_count=ctx.deps.match_count
                )

                # Parse the JSON response
                import json

                result = json.loads(result_json)

                if not result.get("success", False):
                    return f"Code search failed: {result.get('error', 'Unknown error')}"

                examples = result.get("results", result.get("code_examples", []))
                if not examples:
                    return "No code examples found for your query."

                formatted_examples = []
                for i, example in enumerate(examples, 1):
                    similarity = example.get("similarity", 0)
                    summary = example.get("summary", "No summary")
                    code = example.get("code", example.get("code_block", ""))
                    url = example.get("url", "")

                    # Extract language from code block if available
                    lang = "code"
                    if code.startswith("```"):
                        first_line = code.split("\n")[0]
                        if len(first_line) > 3:
                            lang = first_line[3:].strip()

                    formatted_examples.append(
                        f"**Example {i}** (Relevance: {similarity:.2%})\n"
                        f"Summary: {summary}\n"
                        f"Source: {url}\n"
                        f"```{lang}\n{code}\n```"
                    )

                return f"Found {len(examples)} code examples:\n\n" + "\n---\n".join(
                    formatted_examples
                )

            except Exception as e:
                logger.error(f"Error searching code examples: {e}")
                return f"Error searching code: {str(e)}"

        @agent.tool
        async def refine_search_query(
            ctx: RunContext[RagDependencies], original_query: str, context: str
        ) -> str:
            """Refine a search query based on context to get better results."""
            try:
                # Simple query expansion based on context
                refined_parts = [original_query]

                # Add contextual keywords
                if "how" in original_query.lower():
                    refined_parts.append("tutorial guide example")
                elif "what" in original_query.lower():
                    refined_parts.append("definition explanation overview")
                elif "error" in original_query.lower() or "issue" in original_query.lower():
                    refined_parts.append("troubleshooting solution fix")
                elif "api" in original_query.lower():
                    refined_parts.append("endpoint method parameters response")

                # Add project-specific context if available
                if ctx.deps.project_id:
                    refined_parts.append(f"project:{ctx.deps.project_id}")

                refined_query = " ".join(refined_parts)
                return f"Refined query: '{refined_query}' (original: '{original_query}')"

            except Exception as e:
                return f"Could not refine query: {str(e)}"

        return agent

    def get_system_prompt(self) -> str:
        """Get the base system prompt for this agent."""
        try:
            from ..services.prompt_service import prompt_service

            return prompt_service.get_prompt(
                "rag_assistant",
                default="RAG Assistant for intelligent document search and retrieval.",
            )
        except Exception as e:
            logger.warning(f"Could not load prompt from service: {e}")
            return "RAG Assistant for intelligent document search and retrieval."

    async def run_conversation(
        self,
        user_message: str,
        project_id: str | None = None,
        source_filter: str | None = None,
        match_count: int = 5,
        user_id: str = None,
        progress_callback: Any = None,
    ) -> RagQueryResult:
        """
        Run the agent for conversational RAG queries.

        Args:
            user_message: The user's search query or question
            project_id: Optional project ID for context
            source_filter: Optional source domain to filter results
            match_count: Maximum number of results to return
            user_id: ID of the user making the request
            progress_callback: Optional callback for progress updates

        Returns:
            Structured RagQueryResult
        """
        deps = RagDependencies(
            project_id=project_id,
            source_filter=source_filter,
            match_count=match_count,
            user_id=user_id,
            progress_callback=progress_callback,
        )

        try:
            # Run the agent and get the string response
            response_text = await self.run(user_message, deps)
            self.logger.info("RAG query completed successfully")

            # Create a structured result from the response text
            # Try to extract some basic information from the response
            query_type = "search"  # Default type
            results_found = 0
            sources = []

            # Simple analysis of the response to gather metadata
            if "found" in response_text.lower() and "results" in response_text.lower():
                # Try to extract number of results
                import re

                match = re.search(r"found (\d+)", response_text.lower())
                if match:
                    results_found = int(match.group(1))

            if "available sources" in response_text.lower():
                query_type = "list_sources"
            elif "code example" in response_text.lower():
                query_type = "code_search"
            elif "no results" in response_text.lower():
                results_found = 0

            # Extract source references if present
            source_lines = [line for line in response_text.split("\n") if "Source:" in line]
            sources = [line.split("Source:")[-1].strip() for line in source_lines]

            return RagQueryResult(
                query_type=query_type,
                original_query=user_message,
                refined_query=None,
                results_found=results_found,
                sources=list(set(sources)),  # Remove duplicates
                answer=response_text,
                citations=[],  # Could be enhanced to extract citations
                success=True,
                message="Query completed successfully",
            )

        except Exception as e:
            self.logger.error(f"RAG query failed: {str(e)}")
            # Return error result
            return RagQueryResult(
                query_type="error",
                original_query=user_message,
                refined_query=None,
                results_found=0,
                sources=[],
                answer=f"I encountered an error while searching: {str(e)}",
                citations=[],
                success=False,
                message=f"Failed to process query: {str(e)}",
            )


# Note: RagAgent instances should be created on-demand in API endpoints
# to avoid initialization issues during module import
