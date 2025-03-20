from __future__ import annotations as _annotations

from dataclasses import dataclass
from dotenv import load_dotenv
import logfire
import asyncio
import httpx
import os

from pydantic_ai import Agent, ModelRetry, RunContext
from pydantic_ai.models.groq import GroqModel
# from openai import AsyncOpenAI
from groq import AsyncGroq
from supabase import Client
from typing import List
from nomic import embed 

load_dotenv()

llm = os.getenv("LLM_MODEL", "llama-3.3-70b-versatile")
model = GroqModel(llm)

logfire.configure(send_to_logfire='if-token-present')


@dataclass
class PydanticAIDeps:
    supabase: Client
    groq_client: AsyncGroq


system_prompt = """
~~ CONTEXT: ~~

You are an expert at Pydantic AI - a Python AI agent framework that you have access to all the documentation to,
including examples, an API reference, and other resources to help you build Pydantic AI agents.

~~ GOAL: ~~

Your only job is to help the user create an AI agent with Pydantic AI.
The user will describe the AI agent they want to build, or if they don't, guide them towards doing so.
You will take their requirements, and then search through the Pydantic AI documentation with the tools provided
to find all the necessary information to create the AI agent with correct code.

It's important for you to search through multiple Pydantic AI documentation pages to get all the information you need.
Almost never stick to just one page - use RAG and the other documentation tools multiple times when you are creating
an AI agent from scratch for the user.

~~ STRUCTURE: ~~

When you build an AI agent from scratch, split the agent into this files and give the code for each:
- `agent.py`: The main agent file, which is where the Pydantic AI agent is defined.
- `agent_tools.py`: A tools file for the agent, which is where all the tool functions are defined. Use this for more complex agents.
- `agent_prompts.py`: A prompts file for the agent, which includes all system prompts and other prompts used by the agent. Use this when there are many prompts or large ones.
- `.env.example`: An example `.env` file - specify each variable that the user will need to fill in and a quick comment above each one for how to do so.
- `requirements.txt`: Don't include any versions, just the top level package names needed for the agent.

~~ INSTRUCTIONS: ~~

- Don't ask the user before taking an action, just do it. Always make sure you look at the documentation with the provided tools before writing any code.
- When you first look at the documentation, always start with RAG.
Then also always check the list of available documentation pages and retrieve the content of page(s) if it'll help.
- Always let the user know when you didn't find the answer in the documentation or the right URL - be honest.
- Helpful tip: when starting a new AI agent build, it's a good idea to look at the 'weather agent' in the docs as an example.
- When starting a new AI agent build, always produce the full code for the AI agent - never tell the user to finish a tool/function.
- When refining an existing AI agent build in a conversation, just share the code changes necessary.
"""

pydantic_ai_coder = Agent(
    llm,
    system_prompt=system_prompt,
    deps_type=PydanticAIDeps,
    retries=2
)


def get_embedding(text: str) -> List[float]:
    """Get embedding for a given text using nomic."""
    try:
        response = embed.text(
            texts=[text],
            model='nomic-embed-text-v1.5',
            task_type='search_query',  # we use search_query for the query and search_document for the source
            inference_mode='local', # remove this line if using remote nomic api (needs nomic api key)
            device='gpu'  # defaults to cpu if not specified
        )
        return response["embeddings"][0]
    except Exception as e:
        print(f"Error in get_embedding: {e}")
        return [0] * 768  # Return a zero vector in case of error


@pydantic_ai_coder.tool
async def retrieve_relevant_documentation(ctx: RunContext[PydanticAIDeps],
                                          user_query: str) -> str:
    """
    Retrieve relevant documentation chunks based on the query with RAG.

    Args:
        ctx: The context including the Supabase client and OpenAI client
        user_query: The user's question or query

    Returns:
        A formatted string containing the top 5 most relevant documentation chunks
    """
    try:
        # Get the embedding for the query
        query_embedding = await get_embedding(user_query)

        # query supabase for relevant documentats
        result = ctx.deps.supabase.rpc(
            'match_site_pages',
            {
                'query_embedding': query_embedding,
                'match_count': 5,
                'filter': {'source': 'pydantic_ai_docs'}
            }

        ).execute()

        if not result.data:
            return "No relevant documentation found."

        # Format the results
        formatted_chunks = []
        for doc in result.data:
            chunk_text = f"""
# {doc['title']}

{doc['content']}
"""
            formatted_chunks.append(chunk_text)

        # Join all chunks with a separator
        return "\n\n---\n\n".join(formatted_chunks)

    except Exception as e:
        print(f"Error retrieving documentation: {e}")
        return f"Error retrieving documentation: {str(e)}"


@pydantic_ai_coder.tool
async def list_documentation_pages(ctx: RunContext[PydanticAIDeps]) -> List[str]:
    """
    Retrieve a list of all available Pydantic AI documentation pages.

    Returns:
        List[str]: List of unique URLs for all documentation pages
    """
    try:
        # Query Supabase for unique URLs where source is pydantic_ai_docs
        result = ctx.deps.supabase.from_('site_pages') \
            .select('url') \
            .eq('metadata->>source', 'pydantic_ai_docs') \
            .execute()

        if not result.data:
            return []

        # Extract unique URLs
        urls = sorted(set(doc['url'] for doc in result.data))
        return urls

    except Exception as e:
        print(f"Error retrieving documentation pages: {e}")
        return []


@pydantic_ai_coder.tool
async def get_page_content(ctx: RunContext[PydanticAIDeps], url: str) -> str:
    """
    Retrieve the full content of a specific documentation page by combining
    all its chunks.

    Args:
        ctx: The context including the Supabase client
        url: The URL of the page to retrieve

    Returns:
        str: The complete page content with all chunks combined in order
    """
    try:
        # Query Supabase for all chunks of this URL, ordered by chunk_number
        result = ctx.deps.supabase.from_('site_pages') \
            .select('title, content, chunk_number') \
            .eq('url', url) \
            .eq('metadata->>source', 'pydantic_ai_docs') \
            .order('chunk_number') \
            .execute()

        if not result.data:
            return f"No content found for URL: {url}"

        # Format the page with its title and all chunks
        page_title = result.data[0]['title'].split(' - ')[0]  # Get the main title
        formatted_content = [f"# {page_title}\n"]

        # Add each chunk's content
        for chunk in result.data:
            formatted_content.append(chunk['content'])

        # Join everything together
        return "\n\n".join(formatted_content)

    except Exception as e:
        print(f"Error retrieving page content: {e}")
        return f"Error retrieving page content: {str(e)}"
