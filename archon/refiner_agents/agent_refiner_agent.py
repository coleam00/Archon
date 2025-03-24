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
from supabase import Client

# Add the parent directory to sys.path to allow importing from the parent directory
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from utils.utils import get_env_var
from archon.agent_prompts import agent_refiner_prompt
from archon.agent_tools import (
    retrieve_relevant_documentation_tool,
    list_documentation_pages_tool,
    list_crawl4ai_documentation_pages_tool,
    get_page_content_tool
)

load_dotenv()

provider = get_env_var('LLM_PROVIDER') or 'OpenAI'
llm = get_env_var('PRIMARY_MODEL') or 'gpt-4o-mini'
base_url = get_env_var('BASE_URL') or 'https://api.openai.com/v1'
api_key = get_env_var('LLM_API_KEY') or 'no-llm-api-key-provided'

model = AnthropicModel(llm, api_key=api_key) if provider == "Anthropic" else OpenAIModel(llm, base_url=base_url, api_key=api_key)
embedding_model = get_env_var('EMBEDDING_MODEL') or 'text-embedding-3-small'

logfire.configure(send_to_logfire='if-token-present')

@dataclass
class AgentRefinerDeps:
    supabase: Client
    embedding_client: AsyncOpenAI

agent_refiner_agent = Agent(
    model,
    system_prompt=agent_refiner_prompt,
    deps_type=AgentRefinerDeps,
    retries=2
)

@agent_refiner_agent.tool
async def retrieve_relevant_documentation(ctx: RunContext[AgentRefinerDeps], query: str) -> str:
    """
    Retrieve relevant documentation chunks based on the query with RAG.
    Make sure your searches always focus on implementing the agent itself.
    
    Args:
        ctx: The context including the Supabase client and OpenAI client
        query: Your query to retrieve relevant documentation for implementing agents
        
    Returns:
        A formatted string containing the top 4 most relevant documentation chunks
    """
    return await retrieve_relevant_documentation_tool(ctx.deps.supabase, ctx.deps.embedding_client, query)

@agent_refiner_agent.tool
async def list_documentation_pages(ctx: RunContext[AgentRefinerDeps]) -> List[str]:
    """
    Retrieve a list of all available Pydantic AI documentation pages.
    This will give you all pages available, but focus on the ones related to configuring agents and their dependencies.
    
    Returns:
        List[str]: List of unique URLs for all documentation pages
    """
    return await list_documentation_pages_tool(ctx.deps.supabase)

@agent_refiner_agent.tool
async def list_crawl4ai_documentation_pages(ctx: RunContext[AgentRefinerDeps]) -> List[str]:
    """
    Retrieve a list of all available Crawl4AI documentation pages.
    This will give you all pages available, but focus on the ones related to configuring agents and their dependencies.
    
    Returns:
        List[str]: List of unique URLs for all Crawl4AI documentation pages
    """
    return await list_crawl4ai_documentation_pages_tool(ctx.deps.supabase)

@agent_refiner_agent.tool
async def get_page_content(ctx: RunContext[AgentRefinerDeps], url: str) -> str:
    """
    Retrieve the full content of a specific documentation page by combining all its chunks.
    Only use this tool to get pages related to setting up agents with Pydantic AI.
    
    Args:
        ctx: The context including the Supabase client
        url: The URL of the page to retrieve
        
    Returns:
        str: The complete page content with all chunks combined in order
    """
    return await get_page_content_tool(ctx.deps.supabase, url)

@agent_refiner_agent.tool
async def get_crawl4ai_page_content(ctx: RunContext[AgentRefinerDeps], url: str) -> str:
    """
    Retrieve the full content of a specific documentation page by combining all its chunks.
    Only use this tool to get pages related to setting up agents with Crawl4AI.
    
    Args:
        ctx: The context including the Supabase client
        url: The URL of the page to retrieve
        
    Returns:
        str: The complete page content with all chunks combined in order
    """
    return await get_page_content_tool(ctx.deps.supabase, url, "crawl4ai_docs")