from __future__ import annotations as _annotations

from dataclasses import dataclass
from dotenv import load_dotenv
import logfire
import asyncio
import httpx
import os
import sys
import json
from typing import List
from pydantic import BaseModel
from pydantic_ai import Agent, ModelRetry, RunContext
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.openai import OpenAIModel
from pydantic_ai.providers.openai import OpenAIProvider
from openai import AsyncOpenAI

# Add the parent directory to sys.path to allow importing from the parent directory
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from utils.utils import get_env_var
from archon.agent_prompts import tools_refiner_prompt
from archon.agent_tools import (
    retrieve_relevant_documentation_tool,
    list_documentation_pages_tool,
    get_page_content_tool,
    get_file_content_tool
)
from archon.domain import ISitePagesRepository, IEmbeddingService

load_dotenv()

provider = get_env_var('LLM_PROVIDER') or 'OpenAI'
llm = get_env_var('PRIMARY_MODEL') or 'gpt-4o-mini'
base_url = get_env_var('BASE_URL') or 'https://api.openai.com/v1'
api_key = get_env_var('LLM_API_KEY') or 'no-llm-api-key-provided'

model = AnthropicModel(llm, api_key=api_key) if provider == "Anthropic" else OpenAIModel(llm, provider=OpenAIProvider(base_url=base_url, api_key=api_key))
embedding_model = get_env_var('EMBEDDING_MODEL') or 'text-embedding-3-small'

logfire.configure(send_to_logfire='if-token-present')

@dataclass
class ToolsRefinerDeps:
    repository: ISitePagesRepository
    embedding_service: IEmbeddingService
    file_list: List[str]

tools_refiner_agent = Agent(
    model,
    system_prompt=tools_refiner_prompt,
    deps_type=ToolsRefinerDeps,
    retries=2
)


@tools_refiner_agent.system_prompt  
def add_file_list(ctx: RunContext[str]) -> str:
    joined_files = "\n".join(ctx.deps.file_list)
    return f"""
    
    Here is the list of all the files that you can pull the contents of with the
    'get_file_content' tool if the example/tool/MCP server is relevant to the
    agent the user is trying to build:

    {joined_files}
    """

@tools_refiner_agent.tool
async def retrieve_relevant_documentation(ctx: RunContext[ToolsRefinerDeps], query: str) -> str:
    """
    Retrieve relevant documentation chunks based on the query with RAG.
    Make sure your searches always focus on implementing tools.

    Args:
        ctx: The context including the repository and embedding service
        query: Your query to retrieve relevant documentation for implementing tools

    Returns:
        A formatted string containing the top 4 most relevant documentation chunks
    """
    return await retrieve_relevant_documentation_tool(
        repository=ctx.deps.repository,
        embedding_service=ctx.deps.embedding_service,
        user_query=query
    )

@tools_refiner_agent.tool
async def list_documentation_pages(ctx: RunContext[ToolsRefinerDeps]) -> List[str]:
    """
    Retrieve a list of all available Pydantic AI documentation pages.
    This will give you all pages available, but focus on the ones related to tools.

    Returns:
        List[str]: List of unique URLs for all documentation pages
    """
    return await list_documentation_pages_tool(repository=ctx.deps.repository)

@tools_refiner_agent.tool
async def get_page_content(ctx: RunContext[ToolsRefinerDeps], url: str) -> str:
    """
    Retrieve the full content of a specific documentation page by combining all its chunks.
    Only use this tool to get pages related to using tools with Pydantic AI.

    Args:
        ctx: The context including the repository
        url: The URL of the page to retrieve

    Returns:
        str: The complete page content with all chunks combined in order
    """
    return await get_page_content_tool(repository=ctx.deps.repository, url=url)

@tools_refiner_agent.tool_plain
def get_file_content(file_path: str) -> str:
    """
    Retrieves the content of a specific file. Use this to get the contents of an example, tool, config for an MCP server
    
    Args:
        file_path: The path to the file
        
    Returns:
        The raw contents of the file
    """
    return get_file_content_tool(file_path)    