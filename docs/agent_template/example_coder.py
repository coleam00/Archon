from __future__ import annotations as _annotations

from dataclasses import dataclass
from dotenv import load_dotenv
import logfire
import asyncio
import os
import sys
import json
from typing import Dict, Any, List, Optional
from pydantic import BaseModel
from pydantic_ai import Agent, ModelRetry, RunContext
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.openai import OpenAIModel
from openai import AsyncOpenAI
from supabase import Client

# Add the parent directory to sys.path to allow importing from the parent directory
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils.utils import get_env_var

load_dotenv()

# Configure the LLM to use
llm = get_env_var('PRIMARY_MODEL') or 'gpt-4o-mini'
base_url = get_env_var('BASE_URL') or 'https://api.openai.com/v1'
api_key = get_env_var('LLM_API_KEY') or 'no-llm-api-key-provided'

is_ollama = "localhost" in base_url.lower()
is_anthropic = "anthropic" in base_url.lower()

model = AnthropicModel(llm, api_key=api_key) if is_anthropic else OpenAIModel(llm, base_url=base_url, api_key=api_key)
embedding_model = get_env_var('EMBEDDING_MODEL') or 'text-embedding-3-small'

logfire.configure(send_to_logfire='if-token-present')

@dataclass
class ExampleDeps:
    """
    Dependencies for the Example Agent.
    
    This dataclass defines what resources the agent needs access to during execution.
    """
    supabase: Client
    openai_client: AsyncOpenAI
    reasoner_output: str

# Initialize the agent with the dependency type
example_coder = Agent[ExampleDeps]()

# Define a system prompt that includes the reasoner output
@example_coder.system_prompt  
def add_reasoner_output(ctx: RunContext[str]) -> str:
    """
    Add the reasoner output to the system prompt.
    
    This function is called to generate a system prompt for the agent.
    It includes the output from the reasoner LLM, which provides a scope
    document for the current task.
    """
    return f"""
    You are a helpful expert in creating applications with Example Technology.
    
    Here is a scope document that outlines what you should build:
    
    {ctx.message}
    
    Write clean, maintainable code that follows best practices for Example Technology.
    Provide explanatory comments for complex sections.
    """

async def get_embedding(text: str, openai_client: AsyncOpenAI) -> List[float]:
    """
    Generate an embedding for the given text using OpenAI's API.
    
    Args:
        text: The text to generate an embedding for
        openai_client: The OpenAI client to use for API calls
        
    Returns:
        List[float]: The embedding vector
    """
    # Truncate text if too long (OpenAI's embedding model has a token limit)
    if len(text) > 8000:
        text = text[:8000]
        
    # Call the OpenAI API to generate the embedding
    response = await openai_client.embeddings.create(
        model=embedding_model,
        input=text
    )
    
    # Return the embedding as a list of floats
    return response.data[0].embedding

@example_coder.tool
async def retrieve_relevant_documentation(ctx: RunContext[ExampleDeps], user_query: str) -> str:
    """
    Search the Example documentation for information relevant to the user's query.
    
    Args:
        user_query: The user's question or request about Example Technology
        
    Returns:
        str: Relevant documentation snippets
    """
    if not ctx.deps.supabase or not ctx.deps.openai_client:
        return "Error: Supabase or OpenAI client not initialized."
    
    try:
        # Generate embedding for the query
        query_embedding = await get_embedding(user_query, ctx.deps.openai_client)
        
        # Log the database query details
        print(f"[EXAMPLE QUERY] Searching for documentation with filter: {{\"source\": \"example_docs\"}}")
        
        # Search for related documentation
        result = ctx.deps.supabase.rpc(
            "match_site_pages",
            {
                "query_embedding": query_embedding,
                "match_count": 5,
                "filter": {"source": "example_docs"}
            }
        ).execute()
        
        if hasattr(result, 'error') and result.error is not None:
            print(f"[EXAMPLE ERROR] Error querying database: {result.error}")
            return f"Error querying database: {result.error}"
        
        # Log the result count
        print(f"[EXAMPLE RESULT] Found {len(result.data if result.data else [])} matching documents")
        
        # Process the results
        if not result.data or len(result.data) == 0:
            return "No relevant documentation found. Please try a different query or consult the Example Technology website directly."
        
        # Format the results
        formatted_chunks = []
        for doc in result.data:
            chunk_text = f"""
# {doc['title']}

{doc['content']}

URL: {doc['url']}
"""
            formatted_chunks.append(chunk_text)
            
        return "\n\n".join(formatted_chunks)
        
    except Exception as e:
        print(f"Error retrieving documentation: {e}")
        return f"Error retrieving documentation: {str(e)}"

async def list_documentation_pages_helper(supabase: Client) -> List[str]:
    """
    Function to retrieve a list of all available Example documentation pages.
    This is called by the list_documentation_pages tool and also externally
    to fetch documentation pages for the reasoner LLM.
    
    Returns:
        List[str]: List of unique URLs for all documentation pages
    """
    try:
        # Log the query
        print(f"[EXAMPLE QUERY] Getting document URLs with filter: metadata->>source=example_docs")
        
        # Query Supabase for unique URLs where source is example_docs
        result = supabase.table("site_pages") \
            .select("url") \
            .eq("metadata->>source", "example_docs") \
            .execute()
        
        if hasattr(result, 'error') and result.error is not None:
            print(f"[EXAMPLE ERROR] Error querying database: {result.error}")
            return []
            
        if not result.data:
            print("[EXAMPLE RESULT] No documentation pages found")
            return []
        
        # Extract unique URLs
        urls = set()
        for item in result.data:
            urls.add(item["url"])
        
        # Log the result count
        print(f"[EXAMPLE RESULT] Found {len(urls)} unique documentation URLs")
        
        return sorted(list(urls))
        
    except Exception as e:
        print(f"Error listing documentation pages: {e}")
        return []

@example_coder.tool
async def list_documentation_pages(ctx: RunContext[ExampleDeps]) -> List[str]:
    """
    List all available Example documentation pages.
    
    Returns:
        List[str]: List of URLs for all documentation pages
    """
    if not ctx.deps.supabase:
        return []
    
    return await list_documentation_pages_helper(ctx.deps.supabase)

@example_coder.tool
async def get_page_content(ctx: RunContext[ExampleDeps], url: str) -> str:
    """
    Get the content of a specific documentation page by URL.
    
    Args:
        url: The URL of the documentation page to fetch
        
    Returns:
        str: The content of the documentation page
    """
    if not ctx.deps.supabase:
        return "Error: Supabase client not initialized."
    
    try:
        # Query Supabase for the page with the given URL
        result = ctx.deps.supabase.table("site_pages") \
            .select("title,content,url") \
            .eq("url", url) \
            .eq("metadata->>source", "example_docs") \
            .execute()
        
        if not result.data or len(result.data) == 0:
            return f"No documentation found for URL: {url}"
        
        # Get the first matching page
        page = result.data[0]
        
        # Format the page content
        formatted_content = f"""
# {page['title']}

{page['content']}

URL: {page['url']}
"""
        
        return formatted_content
        
    except Exception as e:
        print(f"Error getting page content: {e}")
        return f"Error getting page content: {str(e)}" 