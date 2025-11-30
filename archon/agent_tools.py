from typing import Dict, Any, List, Optional
from openai import AsyncOpenAI
import sys
import os

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils.utils import get_env_var

# Phase 3: Import des interfaces Domain
from archon.domain.interfaces import ISitePagesRepository, IEmbeddingService

embedding_model = get_env_var('EMBEDDING_MODEL') or 'text-embedding-3-small'

async def get_embedding(
    text: str,
    embedding_client: Optional[AsyncOpenAI] = None,
    embedding_service: Optional[IEmbeddingService] = None
) -> List[float]:
    """
    Get embedding vector from OpenAI.

    Args:
        text: Text to embed
        embedding_client: (Legacy) AsyncOpenAI client
        embedding_service: (New) IEmbeddingService implementation

    Returns:
        Embedding vector as list of floats
    """
    try:
        # Phase 3: Prefer embedding_service if provided
        if embedding_service is not None:
            return await embedding_service.get_embedding(text)

        # Fallback to legacy client
        if embedding_client is not None:
            response = await embedding_client.embeddings.create(
                model=embedding_model,
                input=text
            )
            return response.data[0].embedding

        raise ValueError("Either embedding_service or embedding_client must be provided")
    except Exception as e:
        print(f"Error getting embedding: {e}")
        return [0] * 1536  # Return zero vector on error

async def retrieve_relevant_documentation_tool(
    supabase: Optional[Any] = None,  # Legacy fallback (deprecated)
    embedding_client: Optional[AsyncOpenAI] = None,
    repository: Optional[ISitePagesRepository] = None,
    embedding_service: Optional[IEmbeddingService] = None,
    user_query: str = ""
) -> str:
    """
    Retrieve relevant documentation chunks using RAG.

    Args:
        supabase: (Legacy) Supabase client
        embedding_client: (Legacy) OpenAI client for embeddings
        repository: (New) ISitePagesRepository implementation
        embedding_service: (New) IEmbeddingService implementation
        user_query: Query text to search for

    Returns:
        Formatted documentation chunks as string
    """
    try:
        # Get the embedding for the query
        query_embedding = await get_embedding(
            user_query,
            embedding_client=embedding_client,
            embedding_service=embedding_service
        )

        # Phase 3: Prefer repository if provided
        if repository is not None:
            # Use repository pattern
            search_results = await repository.search_similar(
                embedding=query_embedding,
                limit=4,
                filter={'source': 'pydantic_ai_docs'}
            )

            if not search_results:
                return "No relevant documentation found."

            # Format the results
            formatted_chunks = []
            for result in search_results:
                chunk_text = f"""
# {result.page.title}

{result.page.content}
"""
                formatted_chunks.append(chunk_text)

            return "\n\n---\n\n".join(formatted_chunks)

        # Fallback: Legacy Supabase RPC call
        if supabase is not None:
            result = supabase.rpc(
                'match_site_pages',
                {
                    'query_embedding': query_embedding,
                    'match_count': 4,
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

        raise ValueError("Either repository or supabase must be provided")

    except Exception as e:
        print(f"Error retrieving documentation: {e}")
        return f"Error retrieving documentation: {str(e)}" 

async def list_documentation_pages_tool(
    supabase: Optional[Any] = None,  # Legacy fallback (deprecated)
    repository: Optional[ISitePagesRepository] = None
) -> List[str]:
    """
    Function to retrieve a list of all available Pydantic AI documentation pages.
    This is called by the list_documentation_pages tool and also externally
    to fetch documentation pages for the reasoner LLM.

    Args:
        supabase: (Legacy) Supabase client
        repository: (New) ISitePagesRepository implementation

    Returns:
        List[str]: List of unique URLs for all documentation pages
    """
    try:
        # Phase 3: Prefer repository if provided
        if repository is not None:
            urls = await repository.list_unique_urls(source='pydantic_ai_docs')
            return urls

        # Fallback: Legacy Supabase query
        if supabase is not None:
            # Query Supabase for unique URLs where source is pydantic_ai_docs
            result = supabase.from_('site_pages') \
                .select('url') \
                .eq('metadata->>source', 'pydantic_ai_docs') \
                .execute()

            if not result.data:
                return []

            # Extract unique URLs
            urls = sorted(set(doc['url'] for doc in result.data))
            return urls

        raise ValueError("Either repository or supabase must be provided")

    except Exception as e:
        print(f"Error retrieving documentation pages: {e}")
        return []

async def get_page_content_tool(
    supabase: Optional[Any] = None,  # Legacy fallback (deprecated)
    repository: Optional[ISitePagesRepository] = None,
    url: str = ""
) -> str:
    """
    Retrieve the full content of a specific documentation page by combining all its chunks.

    Args:
        supabase: (Legacy) Supabase client
        repository: (New) ISitePagesRepository implementation
        url: The URL of the page to retrieve

    Returns:
        str: The complete page content with all chunks combined in order
    """
    try:
        # Phase 3: Prefer repository if provided
        if repository is not None:
            # Use repository pattern
            chunks = await repository.find_by_url(url)

            if not chunks:
                return f"No content found for URL: {url}"

            # Format the page with its title and all chunks
            page_title = chunks[0].title.split(' - ')[0]  # Get the main title
            formatted_content = [f"# {page_title}\n"]

            # Add each chunk's content
            for chunk in chunks:
                formatted_content.append(chunk.content)

            # Join everything together but limit the characters in case the page is massive
            # This will be improved later so if the page is too big RAG will be performed on the page itself
            return "\n\n".join(formatted_content)[:20000]

        # Fallback: Legacy Supabase query
        if supabase is not None:
            # Query Supabase for all chunks of this URL, ordered by chunk_number
            result = supabase.from_('site_pages') \
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

            # Join everything together but limit the characters in case the page is massive (there are a coule big ones)
            # This will be improved later so if the page is too big RAG will be performed on the page itself
            return "\n\n".join(formatted_content)[:20000]

        raise ValueError("Either repository or supabase must be provided")

    except Exception as e:
        print(f"Error retrieving page content: {e}")
        return f"Error retrieving page content: {str(e)}"

def get_file_content_tool(file_path: str) -> str:
    """
    Retrieves the content of a specific file. Use this to get the contents of an example, tool, config for an MCP server

    Args:
        file_path: The path to the file
        
    Returns:
        The raw contents of the file
    """
    try:
        with open(file_path, "r") as file:
            file_contents = file.read()
        return file_contents
    except Exception as e:
        print(f"Error retrieving file contents: {e}")
        return f"Error retrieving file contents: {str(e)}"           
