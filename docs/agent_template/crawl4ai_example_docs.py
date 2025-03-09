from __future__ import annotations

import os
import sys
import asyncio
import threading
import subprocess
import json
import re
import time
from typing import List, Dict, Any, Optional, Callable, Tuple
from urllib.parse import urlparse, urljoin
from dotenv import load_dotenv
from supabase import Client, create_client
from openai import AsyncOpenAI
from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode
import html2text
from dataclasses import dataclass
from datetime import datetime, timezone

# Add the parent directory to sys.path to allow importing from parent directory
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils.utils import get_env_var

# Load environment variables
load_dotenv()

# Initialize OpenAI client
base_url = get_env_var("BASE_URL") or "https://api.openai.com/v1"
api_key = get_env_var("LLM_API_KEY") or "no-llm-api-key-provided"
is_ollama = "localhost" in base_url.lower()

embedding_model = get_env_var("EMBEDDING_MODEL") or "text-embedding-3-small"

openai_client = None

if is_ollama:
    openai_client = AsyncOpenAI(base_url=base_url, api_key=api_key)
else:
    openai_client = AsyncOpenAI(api_key=get_env_var("OPENAI_API_KEY"))

# Initialize Supabase client
supabase_url = get_env_var("SUPABASE_URL")
supabase_key = get_env_var("SUPABASE_SERVICE_KEY")
supabase = create_client(supabase_url, supabase_key)

# Initialize HTML to Markdown converter
html_converter = html2text.HTML2Text()
html_converter.ignore_links = False
html_converter.ignore_images = False
html_converter.ignore_tables = False
html_converter.body_width = 0  # No wrapping

# Configuration settings (adjust as needed)
BASE_URL = "https://example-technology.org/docs"  # Replace with the actual documentation site
CHUNK_SIZE = 5000  # Target size for content chunks
MAX_PAGES = 500  # Maximum number of pages to process

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
    
    def __init__(self, progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None):
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
        self.is_stopping = False
        self.start_time = None
        self.end_time = None
        self.last_activity_time = time.time()
    
    def update_activity(self):
        """Update the last activity timestamp."""
        self.last_activity_time = time.time()
    
    def log(self, message: str):
        """Add a log message and update progress."""
        self.update_activity()
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
    
    def stop(self):
        """Request the crawling process to stop."""
        self.is_stopping = True
        self.log("Stopping crawling process...")
    
    def complete(self):
        """Mark the crawling process as completed."""
        self.is_running = False
        self.end_time = datetime.now()
        duration = self.end_time - self.start_time if self.start_time else None
        duration_str = str(duration).split('.')[0] if duration else "unknown"
        self.log(f"Crawling process completed in {duration_str}")
    
    def get_status(self) -> Dict[str, Any]:
        """Get the current status of the crawling process.
        
        Returns:
            Dict[str, Any]: Status information
        """
        return {
            "is_running": self.is_running,
            "is_stopping": self.is_stopping,
            "urls_found": self.urls_found,
            "urls_processed": self.urls_processed,
            "urls_succeeded": self.urls_succeeded,
            "urls_failed": self.urls_failed,
            "chunks_stored": self.chunks_stored,
            "logs": self.logs,
            "start_time": self.start_time.isoformat() if self.start_time else None,
            "end_time": self.end_time.isoformat() if self.end_time else None,
            "is_completed": self.is_completed,
            "is_successful": self.is_successful
        }
    
    @property
    def is_completed(self) -> bool:
        """Check if the crawling process is completed."""
        return not self.is_running and self.end_time is not None
    
    @property
    def is_successful(self) -> bool:
        """Check if the crawling process was successful."""
        return self.is_completed and self.urls_succeeded > 0

def chunk_text(text: str, chunk_size: int = 5000) -> List[str]:
    """Split text into chunks of approximately the specified size.
    
    Args:
        text: The text to split
        chunk_size: Target size for each chunk
    
    Returns:
        List[str]: List of text chunks
    """
    # Split by paragraphs first
    paragraphs = re.split(r'\n\s*\n', text)
    
    chunks = []
    current_chunk = ""
    
    for paragraph in paragraphs:
        # If adding this paragraph would exceed chunk size, save current chunk and start a new one
        if len(current_chunk) + len(paragraph) > chunk_size and current_chunk:
            chunks.append(current_chunk.strip())
            current_chunk = paragraph
        else:
            if current_chunk:
                current_chunk += "\n\n" + paragraph
            else:
                current_chunk = paragraph
    
    # Add the last chunk if not empty
    if current_chunk:
        chunks.append(current_chunk.strip())
    
    return chunks

async def get_title_and_summary(chunk: str, url: str) -> Dict[str, str]:
    """Extract title and summary using an LLM.
    
    Args:
        chunk: The content chunk
        url: The URL of the page
    
    Returns:
        Dict[str, str]: Dictionary with title and summary
    """
    system_prompt = """You are an AI that extracts titles and summaries from documentation chunks.
    Return a JSON object with 'title' and 'summary' keys.
    For the title: If this seems like the start of a document, extract its title. If it's a middle chunk, derive a descriptive title.
    For the summary: Create a concise summary of the main points in this chunk.
    Keep both title and summary concise but informative."""
    
    try:
        response = await openai_client.chat.completions.create(
            model="gpt-4o-mini",  # Use a specific, known OpenAI model
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"URL: {url}\n\nContent:\n{chunk[:1000]}..."}  # Send first 1000 chars for context
            ],
            response_format={ "type": "json_object" }
        )
        return json.loads(response.choices[0].message.content)
    except Exception as e:
        print(f"Error getting title and summary: {e}")
        # Fallback to rule-based extraction if AI fails
        
        # Extract a simple title from the URL if possible
        parsed_url = urlparse(url)
        path_parts = parsed_url.path.strip('/').split('/')
        default_title = path_parts[-1].replace('-', ' ').replace('_', ' ').title() if path_parts else "Documentation"
        
        # Use the first line as title if it looks like a heading
        first_line = chunk.split('\n', 1)[0].strip()
        if first_line and len(first_line) < 100 and not first_line.endswith('.'):
            title = first_line
        else:
            title = default_title
        
        # Create a simple summary from the first paragraph
        paragraphs = chunk.split('\n\n')
        summary = paragraphs[0][:200] + "..." if paragraphs else "No summary available"
        
        return {
            "title": title,
            "summary": summary
        }

async def get_embedding(text: str) -> List[float]:
    """Generate an embedding for the given text using OpenAI's API.
    
    Args:
        text: The text to generate an embedding for
    
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

async def process_chunk(chunk: str, chunk_number: int, url: str) -> ProcessedChunk:
    """Process a content chunk: generate title, summary, and embedding.
    
    Args:
        chunk: The content chunk
        chunk_number: The chunk number
        url: The URL of the page
    
    Returns:
        ProcessedChunk: The processed chunk
    """
    # Generate title and summary
    title_and_summary = await get_title_and_summary(chunk, url)
    
    # Generate embedding
    embedding = await get_embedding(chunk)
    
    # Create and return the processed chunk
    return ProcessedChunk(
        url=url,
        chunk_number=chunk_number,
        title=title_and_summary["title"],
        summary=title_and_summary["summary"],
        content=chunk,
        metadata={
            "source": "example_docs",
            "processed_at": datetime.now(timezone.utc).isoformat()
        },
        embedding=embedding
    )

async def insert_chunk(chunk: ProcessedChunk):
    """Insert a processed chunk into the Supabase database.
    
    Args:
        chunk: The processed chunk to insert
    """
    # Prepare the record
    record = {
        "url": chunk.url,
        "title": chunk.title,
        "content": chunk.content,
        "summary": chunk.summary,
        "chunk_number": chunk.chunk_number,
        "embedding": chunk.embedding,
        "metadata": chunk.metadata
    }
    
    # Insert into Supabase
    result = supabase.table("site_pages").insert(record).execute()
    
    if hasattr(result, 'error') and result.error is not None:
        raise Exception(f"Error inserting chunk: {result.error}")

async def process_and_store_document(url: str, markdown: str, tracker: Optional[CrawlProgressTracker] = None):
    """Process a document and store its chunks in the database.
    
    Args:
        url: The URL of the document
        markdown: The markdown content of the document
        tracker: Optional progress tracker
    """
    if tracker:
        tracker.log(f"Processing document: {url}")
    
    # Split the content into chunks
    chunks = chunk_text(markdown, CHUNK_SIZE)
    
    if tracker:
        tracker.log(f"Split document into {len(chunks)} chunks")
    
    # Process and store each chunk
    chunk_number = 0
    for chunk in chunks:
        if tracker and tracker.is_stopping:
            tracker.log(f"Stopping processing of {url}")
            break
        
        try:
            # Process the chunk
            processed_chunk = await process_chunk(chunk, chunk_number, url)
            
            # Store the chunk
            await insert_chunk(processed_chunk)
            
            # Update progress
            if tracker:
                tracker.chunks_stored += 1
                tracker.update_activity()
            
            chunk_number += 1
            
        except Exception as e:
            if tracker:
                tracker.log(f"Error processing chunk {chunk_number} of {url}: {str(e)}")
    
    if tracker:
        tracker.urls_succeeded += 1
        tracker.log(f"Successfully processed {url} ({chunk_number} chunks)")

async def crawl_with_crawl4ai(url: str, tracker: Optional[CrawlProgressTracker] = None) -> str:
    """Crawl a URL using crawl4ai.
    
    Args:
        url: The URL to crawl
        tracker: Optional progress tracker
    
    Returns:
        str: The content as markdown
    """
    if tracker:
        tracker.log(f"Crawling {url} with crawl4ai")
    
    # Configure the browser
    browser_config = BrowserConfig(
        headless=True,  # Run in headless mode
        ignore_https_errors=True,  # Ignore HTTPS errors
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",  # Set a user agent
        viewport={"width": 1280, "height": 800}  # Set viewport size
    )
    
    # Configure the crawler
    crawler_config = CrawlerRunConfig(
        cache_mode=CacheMode.NEVER,  # Don't use cache
        timeout=60000,  # 60 seconds timeout
        wait_for_selector="body",  # Wait for body element to be available
        wait_for_timeout=2000,  # Wait 2 seconds after page load
        extract_text=True,  # Extract text
        extract_html=True,  # Extract HTML
        extract_links=True,  # Extract links
        extract_title=True,  # Extract title
        extract_metadata=True  # Extract metadata
    )
    
    # Create the crawler
    crawler = AsyncWebCrawler(browser_config=browser_config)
    
    try:
        # Crawl the URL
        result = await crawler.run(url, config=crawler_config)
        
        # Extract the content
        html_content = result.html
        
        # Convert HTML to markdown
        markdown = html_converter.handle(html_content)
        
        # Extract metadata
        title = result.title
        links = result.links
        
        if tracker:
            tracker.log(f"Successfully crawled {url} (title: {title}, found {len(links)} links)")
            
            # Add found links to tracker for informational purposes
            if links:
                tracker.urls_found += len(links)
        
        return markdown
        
    except Exception as e:
        if tracker:
            tracker.log(f"Error crawling {url}: {str(e)}")
        raise
    finally:
        # Close the crawler
        await crawler.close()

async def crawl_parallel_with_crawl4ai(urls: List[str], tracker: Optional[CrawlProgressTracker] = None, max_concurrent: int = 3):
    """Crawl multiple URLs in parallel using crawl4ai.
    
    Args:
        urls: List of URLs to crawl
        tracker: Optional progress tracker
        max_concurrent: Maximum number of concurrent crawlers
    """
    if tracker:
        tracker.urls_found = len(urls)
        tracker.log(f"Starting to crawl {len(urls)} URLs with max {max_concurrent} concurrent crawlers")
    
    async def process_url(url: str):
        # Check if we should stop
        if tracker and tracker.is_stopping:
            return
        
        try:
            if tracker:
                tracker.log(f"Processing {url}")
            
            # Crawl the URL
            markdown = await crawl_with_crawl4ai(url, tracker)
            
            # Process and store the document
            await process_and_store_document(url, markdown, tracker)
            
        except Exception as e:
            if tracker:
                tracker.urls_failed += 1
                tracker.log(f"Failed to process {url}: {str(e)}")
        finally:
            if tracker:
                tracker.urls_processed += 1
    
    # Create a semaphore to limit concurrent crawlers
    semaphore = asyncio.Semaphore(max_concurrent)
    
    async def limited_process_url(url):
        async with semaphore:
            await process_url(url)
    
    # Create tasks for all URLs
    tasks = [limited_process_url(url) for url in urls]
    
    # Run all tasks
    await asyncio.gather(*tasks)

def get_example_docs_urls() -> List[str]:
    """Get a list of example documentation URLs.
    
    Returns:
        List[str]: List of documentation URLs
    """
    # Replace this with actual code to get URLs or a specific list of URLs
    return [
        "https://example-technology.org/docs/getting-started",
        "https://example-technology.org/docs/concepts",
        "https://example-technology.org/docs/api-reference",
        # Add more URLs as needed
    ]

async def discover_urls(start_url: str, max_urls: int = 50) -> List[str]:
    """Discover URLs by crawling a starting URL and following links.
    
    Args:
        start_url: The URL to start crawling from
        max_urls: Maximum number of URLs to discover
    
    Returns:
        List[str]: List of discovered URLs
    """
    discovered_urls = set([start_url])
    to_crawl = [start_url]
    
    # Configure the browser
    browser_config = BrowserConfig(
        headless=True,
        ignore_https_errors=True,
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    )
    
    # Configure the crawler
    crawler_config = CrawlerRunConfig(
        cache_mode=CacheMode.NEVER,
        timeout=30000,
        extract_links=True
    )
    
    # Create the crawler
    crawler = AsyncWebCrawler(browser_config=browser_config)
    
    try:
        while to_crawl and len(discovered_urls) < max_urls:
            current_url = to_crawl.pop(0)
            
            try:
                # Crawl the URL
                result = await crawler.run(current_url, config=crawler_config)
                
                # Extract links
                links = result.links or []
                
                # Process each link
                for link in links:
                    # Convert relative URLs to absolute
                    absolute_link = urljoin(current_url, link)
                    
                    # Check if the link is within the documentation site
                    if absolute_link.startswith(BASE_URL) and absolute_link not in discovered_urls:
                        # Skip URLs that are likely not documentation pages
                        if any(skip in absolute_link for skip in ['twitter.com', 'github.com', 'facebook.com']):
                            continue
                        
                        discovered_urls.add(absolute_link)
                        to_crawl.append(absolute_link)
                        
                        # Break if we've reached the maximum number of URLs
                        if len(discovered_urls) >= max_urls:
                            break
                
            except Exception as e:
                print(f"Error discovering links from {current_url}: {str(e)}")
    
    finally:
        # Close the crawler
        await crawler.close()
    
    return list(discovered_urls)

async def clear_existing_records():
    """Clear all existing records with source='example_docs' from the site_pages table."""
    try:
        result = supabase.table("site_pages").delete().eq("metadata->>source", "example_docs").execute()
        print("Cleared existing example_docs records from site_pages")
        return True
    except Exception as e:
        print(f"Error clearing records: {e}")
        return False

async def main_with_crawl4ai(tracker: Optional[CrawlProgressTracker] = None):
    """Main function to crawl documentation using crawl4ai.
    
    Args:
        tracker: Optional progress tracker
    """
    try:
        if tracker:
            tracker.start()
            tracker.log("Starting example documentation crawler with crawl4ai")
        
        # Clear existing records
        await clear_existing_records()
        
        # Get the URLs to crawl
        urls = get_example_docs_urls()
        
        if tracker:
            tracker.log(f"Found {len(urls)} initial URLs to crawl")
        
        # Optionally discover more URLs
        if len(urls) > 0 and len(urls) < 10:  # If we have few initial URLs, discover more
            if tracker:
                tracker.log(f"Discovering additional URLs from {urls[0]}")
            
            try:
                discovered_urls = await discover_urls(urls[0], max_urls=50)
                
                # Add new URLs to the list
                for url in discovered_urls:
                    if url not in urls:
                        urls.append(url)
                
                if tracker:
                    tracker.log(f"Discovered {len(discovered_urls)} URLs, total to crawl: {len(urls)}")
            
            except Exception as e:
                if tracker:
                    tracker.log(f"Error discovering URLs: {str(e)}")
        
        # Crawl the URLs
        await crawl_parallel_with_crawl4ai(urls, tracker)
        
        if tracker:
            tracker.log("Crawling completed successfully")
            tracker.complete()
        
        return True
        
    except Exception as e:
        if tracker:
            tracker.log(f"Error during crawling: {str(e)}")
            tracker.complete()
        return False

def start_crawl_with_crawl4ai(progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None) -> CrawlProgressTracker:
    """Start the crawling process in a separate thread.
    
    Args:
        progress_callback: Optional callback for progress updates
    
    Returns:
        CrawlProgressTracker: The progress tracker
    """
    # Create a progress tracker
    tracker = CrawlProgressTracker(progress_callback)
    
    # Define the function to run in a separate thread
    def run_crawl():
        asyncio.run(main_with_crawl4ai(tracker))
    
    # Start the thread
    thread = threading.Thread(target=run_crawl)
    thread.daemon = True
    thread.start()
    
    return tracker

# CLI execution
if __name__ == "__main__":
    print("Starting Example documentation crawler with crawl4ai...")
    asyncio.run(main_with_crawl4ai())
    print("Crawling complete!") 