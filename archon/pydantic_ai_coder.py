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
from openai import AsyncOpenAI

# Add the parent directory to sys.path to allow importing from the parent directory
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils.utils import get_env_var
from archon.agent_prompts import primary_coder_prompt
from archon.agent_tools import (
    retrieve_relevant_documentation_tool,
    list_documentation_pages_tool,
    get_page_content_tool
)
from archon.domain import ISitePagesRepository, IEmbeddingService

load_dotenv()

provider = get_env_var('LLM_PROVIDER') or 'OpenAI'
llm = get_env_var('PRIMARY_MODEL') or 'gpt-4o-mini'
base_url = get_env_var('BASE_URL') or 'https://api.openai.com/v1'
api_key = get_env_var('LLM_API_KEY') or 'no-llm-api-key-provided'

model = AnthropicModel(llm, api_key=api_key) if provider == "Anthropic" else OpenAIModel(llm, base_url=base_url, api_key=api_key)

logfire.configure(send_to_logfire='if-token-present')

@dataclass
class PydanticAIDeps:
    repository: ISitePagesRepository
    embedding_service: IEmbeddingService
    reasoner_output: str
    advisor_output: str

pydantic_ai_coder = Agent(
    model,
    system_prompt=primary_coder_prompt,
    deps_type=PydanticAIDeps,
    retries=2
)

@pydantic_ai_coder.system_prompt  
def add_reasoner_output(ctx: RunContext[str]) -> str:
    return f"""
    
    Additional thoughts/instructions from the reasoner LLM. 
    This scope includes documentation pages for you to search as well: 
    {ctx.deps.reasoner_output}

    Recommended starting point from the advisor agent:
    {ctx.deps.advisor_output}
    """

@pydantic_ai_coder.tool
async def retrieve_relevant_documentation(ctx: RunContext[PydanticAIDeps], user_query: str) -> str:
    """
    Retrieve relevant documentation chunks based on the query with RAG.

    Args:
        ctx: The context including the repository and embedding service
        user_query: The user's question or query

    Returns:
        A formatted string containing the top 4 most relevant documentation chunks
    """
    return await retrieve_relevant_documentation_tool(
        repository=ctx.deps.repository,
        embedding_service=ctx.deps.embedding_service,
        user_query=user_query
    )

@pydantic_ai_coder.tool
async def list_documentation_pages(ctx: RunContext[PydanticAIDeps]) -> List[str]:
    """
    Retrieve a list of all available Pydantic AI documentation pages.

    Returns:
        List[str]: List of unique URLs for all documentation pages
    """
    return await list_documentation_pages_tool(repository=ctx.deps.repository)

@pydantic_ai_coder.tool
async def get_page_content(ctx: RunContext[PydanticAIDeps], url: str) -> str:
    """
    Retrieve the full content of a specific documentation page by combining all its chunks.

    Args:
        ctx: The context including the repository
        url: The URL of the page to retrieve

    Returns:
        str: The complete page content with all chunks combined in order
    """
    return await get_page_content_tool(repository=ctx.deps.repository, url=url)