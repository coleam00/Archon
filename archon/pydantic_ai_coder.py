from __future__ import annotations as _annotations

from dataclasses import dataclass
from dotenv import load_dotenv
import logfire
import asyncio
import httpx
import os
import sys
import json
from typing import List, Optional
from pydantic import BaseModel
from pydantic_ai import Agent, ModelRetry, RunContext
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.openai import OpenAIModel
from openai import AsyncOpenAI
from supabase import Client

# Add the parent directory to sys.path to allow importing from the parent directory
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils.utils import get_env_var
from archon.agent_prompts import primary_coder_prompt
from archon.agent_tools import (
    retrieve_relevant_documentation_tool,
    list_documentation_pages_tool,
    get_page_content_tool,
    get_available_sources
)

load_dotenv()

provider = get_env_var('LLM_PROVIDER') or 'OpenAI'
llm = get_env_var('PRIMARY_MODEL') or 'gpt-4o-mini'
base_url = get_env_var('BASE_URL') or 'https://api.openai.com/v1'
api_key = get_env_var('LLM_API_KEY') or 'no-llm-api-key-provided'

model = AnthropicModel(llm, api_key=api_key) if provider == "Anthropic" else OpenAIModel(llm, base_url=base_url, api_key=api_key)

logfire.configure(send_to_logfire='if-token-present')

@dataclass
class PydanticAIDeps:
    supabase: Client
    embedding_client: AsyncOpenAI
    reasoner_output: str

pydantic_ai_coder = Agent(
    model,
    system_prompt=primary_coder_prompt,
    deps_type=PydanticAIDeps,
    retries=2
)

@pydantic_ai_coder.system_prompt  
def add_reasoner_output(ctx: RunContext[str]) -> str:
    return f"""
    \n\nAdditional thoughts/instructions from the reasoner LLM. 
    This scope includes documentation pages for you to search as well: 
    {ctx.deps.reasoner_output}
    """

@pydantic_ai_coder.tool
async def retrieve_relevant_documentation(ctx: RunContext[PydanticAIDeps], user_query: str, source_id: Optional[str] = None) -> str:
    """
    Retrieve relevant documentation chunks based on the query with RAG.
    
    Args:
        ctx: The context including the Supabase client and OpenAI client
        user_query: The user's question or query
        source_id: The documentation source ID (defaults to None to search across all available sources)
        
    Returns:
        A formatted string containing the top 4 most relevant documentation chunks
    """
    return await retrieve_relevant_documentation_tool(ctx.deps.supabase, ctx.deps.embedding_client, user_query, source_id)

@pydantic_ai_coder.tool
async def list_documentation_pages(ctx: RunContext[PydanticAIDeps], source_id: Optional[str] = None) -> List[str]:
    """
    Retrieve a list of all available documentation pages for a specific source or all sources.
    
    Args:
        ctx: The context including the Supabase client
        source_id: The documentation source ID (defaults to None to list pages from all sources)
        
    Returns:
        List[str]: List of unique URLs for all documentation pages from the specified source(s)
    """
    return await list_documentation_pages_tool(ctx.deps.supabase, source_id)

@pydantic_ai_coder.tool
async def get_page_content(ctx: RunContext[PydanticAIDeps], url: str, source_id: Optional[str] = None) -> str:
    """
    Retrieve the full content of a specific documentation page by combining all its chunks.
    
    Args:
        ctx: The context including the Supabase client
        url: The URL of the page to retrieve
        source_id: The documentation source ID (defaults to None to search in all sources)
        
    Returns:
        str: The complete page content with all chunks combined in order
    """
    return await get_page_content_tool(ctx.deps.supabase, url, source_id)

@pydantic_ai_coder.tool
async def get_available_documentation_sources(ctx: RunContext[PydanticAIDeps]) -> List[str]:
    """
    Get a list of all available documentation sources.
    
    Args:
        ctx: The context including the Supabase client
        
    Returns:
        List[str]: A list of documentation source IDs available for searching
    """
    sources = await get_available_sources(ctx.deps.supabase)
    if not sources:
        print("No documentation sources available. Please add sources in the Documentation tab.")
    return sources