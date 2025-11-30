import os
import sys
import asyncio
import threading
import subprocess
import requests
import json
import time
from typing import List, Dict, Any, Optional, Callable
from xml.etree import ElementTree
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlparse
from dotenv import load_dotenv
from openai import AsyncOpenAI
import re
import html2text

# Add the parent directory to sys.path to allow importing from the parent directory
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils.utils import get_env_var, get_clients

from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode

# Import domain interfaces for dependency injection
from archon.domain import ISitePagesRepository, IEmbeddingService

load_dotenv()

# Initialize embedding and Supabase clients (fallback for backward compatibility)
embedding_client, supabase = get_clients()

# Define the embedding model for embedding the documentation for RAG
embedding_model = get_env_var('EMBEDDING_MODEL') or 'text-embedding-3-small'

# LLM client setup
llm_client = None
base_url = get_env_var('BASE_URL') or 'https://api.openai.com/v1'
api_key = get_env_var('LLM_API_KEY') or 'no-api-key-provided'
provider = get_env_var('LLM_PROVIDER') or 'OpenAI'

# Setup OpenAI client for LLM
if provider == "Ollama":
    if api_key == "NOT_REQUIRED":
        api_key = "ollama"  # Use a dummy key for Ollama
    llm_client = AsyncOpenAI(base_url=base_url, api_key=api_key)
else:
    llm_client = AsyncOpenAI(base_url=base_url, api_key=api_key)

# Initialize HTML to Markdown converter
html_converter = html2text.HTML2Text()
html_converter.ignore_links = False
html_converter.ignore_images = False
html_converter.ignore_tables = False
html_converter.body_width = 0  # No wrapping

@dataclass
class ProcessedChunk:
    url: str
    chunk_number: int
    title: str
    summary: str
    content: str
    metadata: Dict[str, Any]
    embedding: List[float]

class CrawlProgressTracker:
    """Class to track progress of the crawling process."""
    
    def __init__(self, 
                 progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None):
        """Initialize the progress tracker.
        
        Args:
            progress_callback: Function to call with progress updates
        """
        self.progress_callback = progress_callback
        self.urls_found = 0
        self.urls_processed = 0
        self.urls_succeeded = 0
        self.urls_failed = 0
        self.chunks_stored = 0
        self.logs = []
        self.is_running = False
        self.start_time = None
        self.end_time = None
    
    def log(self, message: str):
        """Add a log message and update progress."""
        timestamp = datetime.now().strftime("%H:%M:%S")
        log_entry = f"[{timestamp}] {message}"
        self.logs.append(log_entry)
        print(message)  # Also print to console
        
        # Call the progress callback if provided
        if self.progress_callback:
            self.progress_callback(self.get_status())
    
    def start(self):
        """Mark the crawling process as started."""
        self.is_running = True
        self.start_time = datetime.now()
        self.log("Crawling process started")
        
        # Call the progress callback if provided
        if self.progress_callback:
            self.progress_callback(self.get_status())
    
    def complete(self):
        """Mark the crawling process as completed."""
        self.is_running = False
        self.end_time = datetime.now()
        duration = self.end_time - self.start_time if self.start_time else None
        duration_str = str(duration).split('.')[0] if duration else "unknown"
        self.log(f"Crawling process completed in {duration_str}")
        
        # Call the progress callback if provided
        if self.progress_callback:
            self.progress_callback(self.get_status())
    
    def get_status(self) -> Dict[str, Any]:
        """Get the current status of the crawling process."""
        return {
            "is_running": self.is_running,
            "urls_found": self.urls_found,
            "urls_processed": self.urls_processed,
            "urls_succeeded": self.urls_succeeded,
            "urls_failed": self.urls_failed,
            "chunks_stored": self.chunks_stored,
            "progress_percentage": (self.urls_processed / self.urls_found * 100) if self.urls_found > 0 else 0,
            "logs": self.logs,
            "start_time": self.start_time,
            "end_time": self.end_time
        }
    
    @property
    def is_completed(self) -> bool:
        """Return True if the crawling process is completed."""
        return not self.is_running and self.end_time is not None
    
    @property
    def is_successful(self) -> bool:
        """Return True if the crawling process completed successfully."""
        return self.is_completed and self.urls_failed == 0 and self.urls_succeeded > 0

def chunk_text(text: str, chunk_size: int = 5000) -> List[str]:
    """Split text into chunks, respecting code blocks and paragraphs."""
    chunks = []
    start = 0
    text_length = len(text)

    while start < text_length:
        # Calculate end position
        end = start + chunk_size

        # If we're at the end of the text, just take what's left
        if end >= text_length:
            chunks.append(text[start:].strip())
            break

        # Try to find a code block boundary first (```)
        chunk = text[start:end]
        code_block = chunk.rfind('```')
        if code_block != -1 and code_block > chunk_size * 0.3:
            end = start + code_block

        # If no code block, try to break at a paragraph
        elif '\n\n' in chunk:
            # Find the last paragraph break
            last_break = chunk.rfind('\n\n')
            if last_break > chunk_size * 0.3:  # Only break if we're past 30% of chunk_size
                end = start + last_break

        # If no paragraph break, try to break at a sentence
        elif '. ' in chunk:
            # Find the last sentence break
            last_period = chunk.rfind('. ')
            if last_period > chunk_size * 0.3:  # Only break if we're past 30% of chunk_size
                end = start + last_period + 1

        # Extract chunk and clean it up
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)

        # Move start position for next chunk
        start = max(start + 1, end)

    return chunks

async def get_title_and_summary(chunk: str, url: str) -> Dict[str, str]:
    """Extract title and summary using GPT-4."""
    system_prompt = """You are an AI that extracts titles and summaries from documentation chunks.
    Return a JSON object with 'title' and 'summary' keys.
    For the title: If this seems like the start of a document, extract its title. If it's a middle chunk, derive a descriptive title.
    For the summary: Create a concise summary of the main points in this chunk.
    Keep both title and summary concise but informative."""
    
    try:
        response = await llm_client.chat.completions.create(
            model=get_env_var("PRIMARY_MODEL") or "gpt-4o-mini",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"URL: {url}\n\nContent:\n{chunk[:1000]}..."}  # Send first 1000 chars for context
            ],
            response_format={ "type": "json_object" }
        )
        return json.loads(response.choices[0].message.content)
    except Exception as e:
        print(f"Error getting title and summary: {e}")
        return {"title": "Error processing title", "summary": "Error processing summary"}

async def get_embedding(
    text: str,
    embedding_service: Optional[IEmbeddingService] = None
) -> List[float]:
    """Get embedding vector from OpenAI or injected embedding service.

    Args:
        text: Text to embed
        embedding_service: Optional embedding service (if None, uses global client)

    Returns:
        List of floats representing the embedding vector
    """
    try:
        # Use injected embedding service if provided (new pattern)
        if embedding_service is not None:
            # IEmbeddingService.get_embedding is async
            return await embedding_service.get_embedding(text)

        # Fallback: use global embedding_client (backward compatibility)
        response = await embedding_client.embeddings.create(
            model=embedding_model,
            input=text
        )
        return response.data[0].embedding
    except Exception as e:
        print(f"Error getting embedding: {e}")
        return [0] * 1536  # Return zero vector on error

async def process_chunk(
    chunk: str,
    chunk_number: int,
    url: str,
    embedding_service: Optional[IEmbeddingService] = None
) -> ProcessedChunk:
    """Process a single chunk of text.

    Args:
        chunk: Text chunk to process
        chunk_number: Chunk number in document
        url: Source URL
        embedding_service: Optional embedding service for dependency injection

    Returns:
        ProcessedChunk with embedding and metadata
    """
    # Get title and summary
    extracted = await get_title_and_summary(chunk, url)

    # Get embedding (use injected service if provided)
    embedding = await get_embedding(chunk, embedding_service)

    # Create metadata
    metadata = {
        "source": "pydantic_ai_docs",
        "chunk_size": len(chunk),
        "crawled_at": datetime.now(timezone.utc).isoformat(),
        "url_path": urlparse(url).path
    }

    return ProcessedChunk(
        url=url,
        chunk_number=chunk_number,
        title=extracted['title'],
        summary=extracted['summary'],
        content=chunk,  # Store the original chunk content
        metadata=metadata,
        embedding=embedding
    )

async def insert_chunk(
    chunk: ProcessedChunk,
    repository: Optional[ISitePagesRepository] = None
):
    """Insert a processed chunk into the database.

    Args:
        chunk: ProcessedChunk to insert
        repository: Optional repository for dependency injection

    Returns:
        Result of the insert operation
    """
    try:
        # Use injected repository if provided (new pattern)
        if repository is not None:
            from archon.domain import SitePage

            page = SitePage(
                id=None,  # Will be assigned by database
                url=chunk.url,
                chunk_number=chunk.chunk_number,
                title=chunk.title,
                summary=chunk.summary,
                content=chunk.content,
                metadata=chunk.metadata,
                embedding=chunk.embedding
            )
            # ISitePagesRepository.insert is async
            result = await repository.insert(page)
            print(f"Inserted chunk {chunk.chunk_number} for {chunk.url}")
            return result

        # Fallback: use global supabase client (backward compatibility)
        data = {
            "url": chunk.url,
            "chunk_number": chunk.chunk_number,
            "title": chunk.title,
            "summary": chunk.summary,
            "content": chunk.content,
            "metadata": chunk.metadata,
            "embedding": chunk.embedding
        }

        result = supabase.table("site_pages").insert(data).execute()
        print(f"Inserted chunk {chunk.chunk_number} for {chunk.url}")
        return result
    except Exception as e:
        print(f"Error inserting chunk: {e}")
        return None

async def process_and_store_document(
    url: str,
    markdown: str,
    tracker: Optional[CrawlProgressTracker] = None,
    repository: Optional[ISitePagesRepository] = None,
    embedding_service: Optional[IEmbeddingService] = None
):
    """Process a document and store its chunks in parallel.

    Args:
        url: Source URL of the document
        markdown: Markdown content to process
        tracker: Optional progress tracker
        repository: Optional repository for dependency injection
        embedding_service: Optional embedding service for dependency injection
    """
    # Split into chunks
    chunks = chunk_text(markdown)

    if tracker:
        tracker.log(f"Split document into {len(chunks)} chunks for {url}")
        # Ensure UI gets updated
        if tracker.progress_callback:
            tracker.progress_callback(tracker.get_status())
    else:
        print(f"Split document into {len(chunks)} chunks for {url}")

    # Process chunks in parallel (pass embedding_service)
    tasks = [
        process_chunk(chunk, i, url, embedding_service)
        for i, chunk in enumerate(chunks)
    ]
    processed_chunks = await asyncio.gather(*tasks)

    if tracker:
        tracker.log(f"Processed {len(processed_chunks)} chunks for {url}")
        # Ensure UI gets updated
        if tracker.progress_callback:
            tracker.progress_callback(tracker.get_status())
    else:
        print(f"Processed {len(processed_chunks)} chunks for {url}")

    # Store chunks in parallel (pass repository)
    insert_tasks = [
        insert_chunk(chunk, repository)
        for chunk in processed_chunks
    ]
    await asyncio.gather(*insert_tasks)

    if tracker:
        tracker.chunks_stored += len(processed_chunks)
        tracker.log(f"Stored {len(processed_chunks)} chunks for {url}")
        # Ensure UI gets updated
        if tracker.progress_callback:
            tracker.progress_callback(tracker.get_status())
    else:
        print(f"Stored {len(processed_chunks)} chunks for {url}")

def fetch_url_content(url: str) -> str:
    """Fetch content from a URL using requests and convert to markdown."""
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
    
    try:
        response = requests.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        
        # Convert HTML to Markdown
        markdown = html_converter.handle(response.text)
        
        # Clean up the markdown
        markdown = re.sub(r'\n{3,}', '\n\n', markdown)  # Remove excessive newlines
        
        return markdown
    except Exception as e:
        raise Exception(f"Error fetching {url}: {str(e)}")

async def crawl_parallel_with_requests(
    urls: List[str],
    tracker: Optional[CrawlProgressTracker] = None,
    max_concurrent: int = 5,
    repository: Optional[ISitePagesRepository] = None,
    embedding_service: Optional[IEmbeddingService] = None
):
    """Crawl multiple URLs in parallel with a concurrency limit using direct HTTP requests.

    Args:
        urls: List of URLs to crawl
        tracker: Optional progress tracker
        max_concurrent: Maximum concurrent requests
        repository: Optional repository for dependency injection
        embedding_service: Optional embedding service for dependency injection
    """
    # Create a semaphore to limit concurrency
    semaphore = asyncio.Semaphore(max_concurrent)

    async def process_url(url: str):
        async with semaphore:
            if tracker:
                tracker.log(f"Crawling: {url}")
                # Ensure UI gets updated
                if tracker.progress_callback:
                    tracker.progress_callback(tracker.get_status())
            else:
                print(f"Crawling: {url}")

            try:
                # Use a thread pool to run the blocking HTTP request
                loop = asyncio.get_running_loop()
                if tracker:
                    tracker.log(f"Fetching content from: {url}")
                else:
                    print(f"Fetching content from: {url}")
                markdown = await loop.run_in_executor(None, fetch_url_content, url)

                if markdown:
                    if tracker:
                        tracker.urls_succeeded += 1
                        tracker.log(f"Successfully crawled: {url}")
                        # Ensure UI gets updated
                        if tracker.progress_callback:
                            tracker.progress_callback(tracker.get_status())
                    else:
                        print(f"Successfully crawled: {url}")

                    # Pass repository and embedding_service
                    await process_and_store_document(url, markdown, tracker, repository, embedding_service)
                else:
                    if tracker:
                        tracker.urls_failed += 1
                        tracker.log(f"Failed: {url} - No content retrieved")
                        # Ensure UI gets updated
                        if tracker.progress_callback:
                            tracker.progress_callback(tracker.get_status())
                    else:
                        print(f"Failed: {url} - No content retrieved")
            except Exception as e:
                if tracker:
                    tracker.urls_failed += 1
                    tracker.log(f"Error processing {url}: {str(e)}")
                    # Ensure UI gets updated
                    if tracker.progress_callback:
                        tracker.progress_callback(tracker.get_status())
                else:
                    print(f"Error processing {url}: {str(e)}")
            finally:
                if tracker:
                    tracker.urls_processed += 1
                    # Ensure UI gets updated
                    if tracker.progress_callback:
                        tracker.progress_callback(tracker.get_status())

        time.sleep(2)

    # Process all URLs in parallel with limited concurrency
    if tracker:
        tracker.log(f"Processing {len(urls)} URLs with concurrency {max_concurrent}")
        # Ensure UI gets updated
        if tracker.progress_callback:
            tracker.progress_callback(tracker.get_status())
    else:
        print(f"Processing {len(urls)} URLs with concurrency {max_concurrent}")
    await asyncio.gather(*[process_url(url) for url in urls])

def get_pydantic_ai_docs_urls() -> List[str]:
    """Get URLs from Pydantic AI docs sitemap."""
    sitemap_url = "https://ai.pydantic.dev/sitemap.xml"
    try:
        response = requests.get(sitemap_url)
        response.raise_for_status()
        
        # Parse the XML
        root = ElementTree.fromstring(response.content)
        
        # Extract all URLs from the sitemap
        namespace = {'ns': 'http://www.sitemaps.org/schemas/sitemap/0.9'}
        urls = [loc.text for loc in root.findall('.//ns:loc', namespace)]
        
        return urls
    except Exception as e:
        print(f"Error fetching sitemap: {e}")
        return []

async def clear_existing_records(repository: Optional[ISitePagesRepository] = None):
    """Clear all existing records with source='pydantic_ai_docs' from the site_pages table.

    Args:
        repository: Optional repository for dependency injection

    Returns:
        Number of deleted records or result object
    """
    try:
        # Use injected repository if provided (new pattern)
        if repository is not None:
            # ISitePagesRepository.delete_by_source is async
            count = await repository.delete_by_source("pydantic_ai_docs")
            print(f"Cleared {count} existing pydantic_ai_docs records from site_pages")
            return count

        # Fallback: use global supabase client (backward compatibility)
        result = supabase.table("site_pages").delete().eq("metadata->>source", "pydantic_ai_docs").execute()
        print("Cleared existing pydantic_ai_docs records from site_pages")
        return result
    except Exception as e:
        print(f"Error clearing existing records: {e}")
        return None

async def main_with_requests(
    tracker: Optional[CrawlProgressTracker] = None,
    repository: Optional[ISitePagesRepository] = None,
    embedding_service: Optional[IEmbeddingService] = None
):
    """Main function using direct HTTP requests instead of browser automation.

    Args:
        tracker: Optional progress tracker
        repository: Optional repository for dependency injection
        embedding_service: Optional embedding service for dependency injection
    """
    try:
        # Start tracking if tracker is provided
        if tracker:
            tracker.start()
        else:
            print("Starting crawling process...")

        # Clear existing records first (pass repository)
        if tracker:
            tracker.log("Clearing existing Pydantic AI docs records...")
        else:
            print("Clearing existing Pydantic AI docs records...")
        await clear_existing_records(repository)
        if tracker:
            tracker.log("Existing records cleared")
        else:
            print("Existing records cleared")

        # Get URLs from Pydantic AI docs
        if tracker:
            tracker.log("Fetching URLs from Pydantic AI sitemap...")
        else:
            print("Fetching URLs from Pydantic AI sitemap...")
        urls = get_pydantic_ai_docs_urls()

        if not urls:
            if tracker:
                tracker.log("No URLs found to crawl")
                tracker.complete()
            else:
                print("No URLs found to crawl")
            return

        if tracker:
            tracker.urls_found = len(urls)
            tracker.log(f"Found {len(urls)} URLs to crawl")
        else:
            print(f"Found {len(urls)} URLs to crawl")

        # Crawl the URLs using direct HTTP requests (pass repository and embedding_service)
        await crawl_parallel_with_requests(
            urls,
            tracker=tracker,
            max_concurrent=5,
            repository=repository,
            embedding_service=embedding_service
        )

        # Mark as complete if tracker is provided
        if tracker:
            tracker.complete()
        else:
            print("Crawling process completed")

    except Exception as e:
        if tracker:
            tracker.log(f"Error in crawling process: {str(e)}")
            tracker.complete()
        else:
            print(f"Error in crawling process: {str(e)}")

def start_crawl_with_requests(
    progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    repository: Optional[ISitePagesRepository] = None,
    embedding_service: Optional[IEmbeddingService] = None
) -> CrawlProgressTracker:
    """Start the crawling process using direct HTTP requests in a separate thread and return the tracker.

    Args:
        progress_callback: Optional callback for progress updates
        repository: Optional repository for dependency injection
        embedding_service: Optional embedding service for dependency injection

    Returns:
        CrawlProgressTracker instance for monitoring progress
    """
    tracker = CrawlProgressTracker(progress_callback)

    def run_crawl():
        try:
            asyncio.run(main_with_requests(tracker, repository, embedding_service))
        except Exception as e:
            print(f"Error in crawl thread: {e}")
            tracker.log(f"Thread error: {str(e)}")
            tracker.complete()

    # Start the crawling process in a separate thread
    thread = threading.Thread(target=run_crawl)
    thread.daemon = True
    thread.start()

    return tracker

if __name__ == "__main__":    
    # Run the main function directly
    print("Starting crawler...")
    asyncio.run(main_with_requests())
    print("Crawler finished.")
