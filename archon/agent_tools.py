from typing import Dict, Any, List, Optional
from openai import AsyncOpenAI
from supabase import Client
import sys
import os

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils.utils import get_env_var

embedding_model = get_env_var('EMBEDDING_MODEL') or 'text-embedding-3-small'

async def get_embedding(text: str, embedding_client: AsyncOpenAI) -> List[float]:
    """Get embedding vector from OpenAI."""
    try:
        response = await embedding_client.embeddings.create(
            model=embedding_model,
            input=text
        )
        return response.data[0].embedding
    except Exception as e:
        print(f"Error getting embedding: {e}")
        return [0] * 1536  # Return zero vector on error

async def get_available_sources(supabase: Client) -> List[str]:
    """
    Get a list of all available documentation sources from the database.
    
    Args:
        supabase: The Supabase client
        
    Returns:
        List[str]: A list of all source IDs available in the database
    """
    try:
        # Query to get distinct source values using the proper JSONB extraction operator
        result = supabase.from_('site_pages') \
            .select('metadata->>source', count='exact') \
            .execute()
        
        if not result.data:
            # Query the raw SQL - a more direct approach
            result = supabase.table('site_pages') \
                .select("distinct metadata->>source as source") \
                .execute()
            
            if not result.data:
                # If still no results, check if we have any indexed documents at all
                any_docs = supabase.table('site_pages').select('*', count='exact').limit(1).execute()
                if any_docs.count == 0:
                    return []  # Return empty list if no docs at all
                return []  # No sources found, return empty list
        
        # Extract unique source IDs from the response
        sources = set()
        for item in result.data:
            # The response structure can vary based on the query and Supabase client version
            # Check different possible keys in the returned data
            if isinstance(item, dict):
                # Try to extract source from different possible locations
                if 'source' in item:
                    # Direct key from the raw SQL query
                    source = item['source']
                    if source:
                        sources.add(source)
                elif 'metadata' in item and item['metadata'] and 'source' in item['metadata']:
                    # Nested in metadata field
                    source = item['metadata']['source']
                    if source:
                        sources.add(source)
                elif 'metadata->>source' in item:
                    # Using the JSONB extraction key name
                    source = item['metadata->>source']
                    if source:
                        sources.add(source)
        
        source_list = list(sources)
        if not source_list:
            # If we still don't have any sources, try a more direct SQL approach
            try:
                # This is a direct SQL query as a last resort
                result = supabase.rpc(
                    'execute_sql', 
                    {'query': "SELECT DISTINCT metadata->>'source' AS source FROM site_pages WHERE metadata->>'source' IS NOT NULL"}
                ).execute()
                
                if result.data and isinstance(result.data, list):
                    for row in result.data:
                        if isinstance(row, dict) and 'source' in row and row['source']:
                            sources.add(row['source'])
                    
                    source_list = list(sources)
            except Exception as e:
                print(f"Error executing direct SQL: {e}")
                # Don't fall back to hardcoded values, just return empty list
                return []
        
        return source_list
    except Exception as e:
        print(f"Error retrieving sources: {e}")
        # Don't fall back to hardcoded values, return empty list
        return []

async def retrieve_relevant_documentation_tool(supabase: Client, embedding_client: AsyncOpenAI, user_query: str, source_id: Optional[str] = None) -> str:
    try:
        # Get the embedding for the query
        query_embedding = await get_embedding(user_query, embedding_client)
        
        # Prepare filter based on source_id
        filter_obj = {}
        if source_id:
            filter_obj = {'source': source_id}
        
        # Query Supabase for relevant documents
        result = supabase.rpc(
            'match_site_pages',
            {
                'query_embedding': query_embedding,
                'match_count': 4,
                'filter': filter_obj
            }
        ).execute()
        
        if not result.data:
            return "No relevant documentation found."
            
        # Format the results
        formatted_chunks = []
        for doc in result.data:
            # Include the source in the output for clarity
            source_label = f"[Source: {doc['metadata']['source']}]" if doc.get('metadata') and doc['metadata'].get('source') else ""
            chunk_text = f"""
# {doc['title']} {source_label}

{doc['content']}
"""
            formatted_chunks.append(chunk_text)
            
        # Join all chunks with a separator
        return "\n\n---\n\n".join(formatted_chunks)
        
    except Exception as e:
        print(f"Error retrieving documentation: {e}")
        return f"Error retrieving documentation: {str(e)}" 

async def list_documentation_pages_tool(supabase: Client, source_id: Optional[str] = None) -> List[str]:
    """
    Function to retrieve a list of available documentation pages.
    This is called by the list_documentation_pages tool and also externally
    to fetch documentation pages for the reasoner LLM.
    
    Args:
        supabase: The Supabase client
        source_id: The documentation source ID (defaults to None to list from all sources)
    
    Returns:
        List[str]: List of unique URLs for documentation pages
    """
    try:
        # Base query
        query = supabase.from_('site_pages').select('url')
        
        # Add source filter if specified
        if source_id:
            query = query.eq('metadata->>source', source_id)
        
        # Execute query
        result = query.execute()
        
        if not result.data:
            return []
            
        # Extract unique URLs
        urls = sorted(set(doc['url'] for doc in result.data))
        return urls
        
    except Exception as e:
        print(f"Error retrieving documentation pages: {e}")
        return []

async def get_page_content_tool(supabase: Client, url: str, source_id: Optional[str] = None) -> str:
    """
    Retrieve the full content of a specific documentation page by combining all its chunks.
    
    Args:
        supabase: The Supabase client
        url: The URL of the page to retrieve
        source_id: The documentation source ID (defaults to None to search in all sources)
        
    Returns:
        str: The complete page content with all chunks combined in order
    """
    try:
        # Base query
        query = supabase.from_('site_pages') \
            .select('title, content, chunk_number, metadata') \
            .eq('url', url)
        
        # Add source filter if specified
        if source_id:
            query = query.eq('metadata->>source', source_id)
        
        # Execute query with ordering
        result = query.order('chunk_number').execute()
        
        if not result.data:
            return f"No content found for URL: {url}"
            
        # Format the page with its title and all chunks
        page_title = result.data[0]['title'].split(' - ')[0]  # Get the main title
        
        # Get the source for display
        source = result.data[0].get('metadata', {}).get('source', 'unknown')
        formatted_content = [f"# {page_title} [Source: {source}]\n"]
        
        # Add each chunk's content
        for chunk in result.data:
            formatted_content.append(chunk['content'])
            
        # Join everything together but limit the characters in case the page is massive
        return "\n\n".join(formatted_content)[:20000]
        
    except Exception as e:
        print(f"Error retrieving page content: {e}")
        return f"Error retrieving page content: {str(e)}"
