import os
import sys
import asyncio
import threading
import subprocess
import requests
import json
from typing import List, Dict, Any, Optional, Callable
from xml.etree import ElementTree
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlparse
from dotenv import load_dotenv
import re
import html2text

# Add the parent directory to sys.path to allow importing from the parent directory
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils.utils import get_env_var

# Import Crawl4AI components for version 0.5.0
try:
    from crawl4ai import AsyncWebCrawler, BrowserConfig
except ImportError:
    print("WARNING: crawl4ai package not found. Crawl4AI functionality will not be available.")
    
from openai import AsyncOpenAI
from supabase import create_client, Client

load_dotenv()

# Initialize OpenAI and Supabase clients

base_url = get_env_var('BASE_URL') or 'https://api.openai.com/v1'
api_key = get_env_var('LLM_API_KEY') or 'no-llm-api-key-provided'
is_ollama = "localhost" in base_url.lower()

embedding_model = get_env_var('EMBEDDING_MODEL') or 'text-embedding-3-small'

openai_client=None

if is_ollama:
    openai_client = AsyncOpenAI(base_url=base_url,api_key=api_key)
else:
    openai_client = AsyncOpenAI(api_key=get_env_var("OPENAI_API_KEY"))

supabase: Client = create_client(
    get_env_var("SUPABASE_URL"),
    get_env_var("SUPABASE_SERVICE_KEY")
)

# Initialize HTML to Markdown converter
html_converter = html2text.HTML2Text()
html_converter.ignore_links = False
html_converter.ignore_images = False
html_converter.ignore_tables = False
html_converter.body_width = 0  # No wrapping

def clean_markdown_content(markdown: str) -> str:
    """
    Clean markdown content to remove artifacts and improve quality.
    
    Args:
        markdown: The markdown content to clean
        
    Returns:
        str: The cleaned markdown content
    """
    if not markdown:
        return ""
    
    # Remove excessive newlines
    markdown = re.sub(r'\n{3,}', '\n\n', markdown)
    
    # Remove HTML comments
    markdown = re.sub(r'<!--.*?-->', '', markdown, flags=re.DOTALL)
    
    # Remove script and style tags and their content
    markdown = re.sub(r'<script.*?</script>', '', markdown, flags=re.DOTALL)
    markdown = re.sub(r'<style.*?</style>', '', markdown, flags=re.DOTALL)
    
    # Fix broken markdown links
    markdown = re.sub(r'\[([^\]]+)\]\s*\(([^)]+)\)', r'[\1](\2)', markdown)
    
    # Remove any remaining HTML tags
    markdown = re.sub(r'<[^>]+>', '', markdown)
    
    # Fix spacing around headers
    markdown = re.sub(r'([^\n])(\#{1,6}\s)', r'\1\n\2', markdown)
    
    # Ensure headers have space after #
    markdown = re.sub(r'(\#{1,6})([^\s])', r'\1 \2', markdown)
    
    # Trim leading/trailing whitespace
    markdown = markdown.strip()
    
    return markdown

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
        self._stop_requested = False
        self.processed_urls = set()
        self.last_activity_time = None
    
    def log(self, message: str):
        """Add a log message and update progress."""
        timestamp = datetime.now().strftime("%H:%M:%S")
        log_entry = f"[{timestamp}] {message}"
        self.logs.append(log_entry)
        print(message)  # Also print to console
        
        # Update last activity time
        self.last_activity_time = datetime.now()
        
        # Call the progress callback if provided
        if self.progress_callback:
            self.progress_callback(self.get_status())
    
    def start(self):
        """Mark the crawling process as started."""
        self.is_running = True
        self.start_time = datetime.now()
        self.last_activity_time = datetime.now()
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
    
    def stop(self):
        """Request the crawling process to stop."""
        self._stop_requested = True
        self.log("Stop requested. Crawling will stop after current operations complete.")
    
    def update_activity(self):
        """Update the last activity time."""
        self.last_activity_time = datetime.now()
    
    @property
    def stop_requested(self) -> bool:
        """Return True if a stop has been requested."""
        return self._stop_requested
    
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
        response = await openai_client.chat.completions.create(
            model="gpt-4o-mini",
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

async def get_embedding(text: str) -> List[float]:
    """Get embedding vector from OpenAI."""
    try:
        response = await openai_client.embeddings.create(
            model= embedding_model,
            input=text
        )
        return response.data[0].embedding
    except Exception as e:
        print(f"Error getting embedding: {e}")
        return [0] * 1536  # Return zero vector on error

async def process_chunk(chunk: str, chunk_number: int, url: str) -> ProcessedChunk:
    """Process a single chunk of text."""
    # Get title and summary
    extracted = await get_title_and_summary(chunk, url)
    
    # Get embedding
    embedding = await get_embedding(chunk)
    
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

async def insert_chunk(chunk: ProcessedChunk):
    """Insert a processed chunk into Supabase."""
    try:
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

async def process_and_store_document(url: str, markdown: str, tracker: Optional[CrawlProgressTracker] = None):
    """Process a document and store its chunks in parallel."""
    # Split into chunks
    chunks = chunk_text(markdown)
    
    if tracker:
        tracker.log(f"Split document into {len(chunks)} chunks for {url}")
        # Ensure UI gets updated
        if tracker.progress_callback:
            tracker.progress_callback(tracker.get_status())
    else:
        print(f"Split document into {len(chunks)} chunks for {url}")
    
    # Process chunks in parallel
    tasks = [
        process_chunk(chunk, i, url) 
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
    
    # Store chunks in parallel
    insert_tasks = [
        insert_chunk(chunk) 
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

async def crawl_with_crawl4ai(url: str, tracker: Optional[CrawlProgressTracker] = None, max_retries: int = 3) -> Optional[str]:
    """
    Crawl a single URL using Crawl4AI.
    
    Args:
        url: URL to crawl
        tracker: Optional CrawlProgressTracker to track progress
        max_retries: Maximum number of retry attempts
        
    Returns:
        Optional[str]: The cleaned content as markdown, or None if failed
    """
    if tracker:
        tracker.log(f"Crawling with Crawl4AI: {url}")
    
    # Configure the browser
    browser_config = BrowserConfig(
        headless=True,
        ignore_https_errors=True,
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        viewport_width=1280,
        viewport_height=800
    )
    
    # Implement retry logic
    for attempt in range(1, max_retries + 1):
        try:
            if attempt > 1 and tracker:
                tracker.log(f"Retry attempt {attempt}/{max_retries} for {url}")
            
            # Use async with context manager pattern to ensure proper initialization and cleanup
            async with AsyncWebCrawler(config=browser_config) as crawler:
                # Set a timeout for the crawl operation
                try:
                    # Use arun method which is the correct method in v0.5.0
                    result = await asyncio.wait_for(crawler.arun(url), timeout=120)  # 2 minute timeout
                    
                    # Extract content based on what's available in the result
                    content = ""
                    
                    # In v0.5.0, the result has a markdown property
                    if hasattr(result, 'markdown') and result.markdown:
                        content = result.markdown
                        if tracker:
                            tracker.log(f"Got markdown content from {url} - {len(content)} characters")
                    elif hasattr(result, 'html') and result.html:
                        if tracker:
                            tracker.log(f"Converting HTML to markdown for {url}")
                        h = html2text.HTML2Text()
                        h.ignore_links = False
                        h.ignore_images = False
                        h.ignore_tables = False
                        h.body_width = 0  # No wrapping
                        content = h.handle(result.html)
                    elif hasattr(result, 'text') and result.text:
                        if tracker:
                            tracker.log(f"Using plain text content for {url}")
                        content = result.text
                    
                    # Clean the content
                    if content:
                        content = clean_markdown_content(content)
                        return content
                    else:
                        if tracker:
                            tracker.log(f"No content retrieved from {url}")
                        return None
                except asyncio.TimeoutError:
                    if tracker:
                        tracker.log(f"Timeout while crawling {url}")
                    # If this is the last attempt, return None
                    if attempt == max_retries:
                        return None
                    # Wait before retrying
                    await asyncio.sleep(2)
                    continue
                    
        except Exception as e:
            error_msg = f"Error crawling {url} with Crawl4AI (attempt {attempt}/{max_retries}): {str(e)}"
            print(error_msg)
            if tracker:
                tracker.log(error_msg)
            
            # If this is the last attempt, return None
            if attempt == max_retries:
                return None
            
            # Wait before retrying
            await asyncio.sleep(2)
    
    # This should not be reached, but just in case
    return None

async def crawl_parallel_with_crawl4ai(urls: List[str], tracker: Optional[CrawlProgressTracker] = None, max_concurrent: int = 5):
    """
    Crawl multiple URLs in parallel using Crawl4AI.
    
    Args:
        urls: List of URLs to crawl
        tracker: Optional CrawlProgressTracker to track progress
        max_concurrent: Maximum number of concurrent requests
    """
    # Create a semaphore to limit concurrent requests
    semaphore = asyncio.Semaphore(max_concurrent)
    
    # Define the process_url function
    async def process_url(url: str):
        # Skip if we're stopping
        if tracker and tracker.stop_requested:
            return
        
        # Skip if already processed
        if tracker and url in tracker.processed_urls:
            tracker.log(f"Skipping already processed URL: {url}")
            return
        
        # Acquire the semaphore
        async with semaphore:
            # Skip if we're stopping
            if tracker and tracker.stop_requested:
                return
            
            # Mark as processed
            if tracker:
                tracker.processed_urls.add(url)
            
            try:
                # Get content
                content = await crawl_with_crawl4ai(url, tracker)
                
                # Process the content
                if content:
                    # Store the document
                    await process_and_store_document(url, content, tracker)
                    
                    # Update tracker
                    if tracker:
                        tracker.urls_succeeded += 1
                        tracker.urls_processed += 1
                        tracker.log(f"Successfully processed: {url}")
                else:
                    # Update tracker for failed URLs
                    if tracker:
                        tracker.log(f"Failed to process: {url} - No content retrieved")
                        tracker.urls_failed += 1
                        tracker.urls_processed += 1
            except Exception as e:
                # Log the error
                error_msg = f"Error processing URL {url}: {str(e)}"
                print(error_msg)
                if tracker:
                    tracker.log(error_msg)
                    tracker.urls_failed += 1
                    tracker.urls_processed += 1
            finally:
                # Update tracker activity
                if tracker:
                    tracker.update_activity()
                    # Explicitly update progress
                    if tracker.progress_callback:
                        tracker.progress_callback(tracker.get_status())
    
    # Create tasks for all URLs
    tasks = []
    for url in urls:
        # Use create_task instead of directly calling the function
        task = asyncio.create_task(process_url(url))
        tasks.append(task)
    
    # Wait for all tasks to complete with exception handling
    try:
        await asyncio.gather(*tasks, return_exceptions=True)
    except Exception as e:
        error_msg = f"Error in parallel crawling: {str(e)}"
        print(error_msg)
        if tracker:
            tracker.log(error_msg)

async def main_with_crawl4ai(tracker: Optional[CrawlProgressTracker] = None, url_limit: int = 50):
    """
    Main function to crawl Pydantic AI documentation using Crawl4AI.
    
    Args:
        tracker: Optional CrawlProgressTracker to track progress
        url_limit: Maximum number of URLs to crawl
    """
    # Create a tracker if none is provided
    if tracker is None:
        tracker = CrawlProgressTracker()
    
    # Start tracking
    tracker.start()
    tracker.log("Starting Pydantic AI docs crawl with Crawl4AI")
    
    try:
        # Clear existing records if needed
        tracker.log("Clearing existing records...")
        await clear_existing_records()
        tracker.log("Existing records cleared")
        
        # Fetch URLs to crawl
        tracker.log("Fetching URLs to crawl...")
        all_urls = get_urls_to_crawl()
        
        # Limit the number of URLs if specified
        if url_limit > 0 and len(all_urls) > url_limit:
            tracker.log(f"Limiting URLs to {url_limit} (from {len(all_urls)} total)")
            urls = all_urls[:url_limit]
        else:
            urls = all_urls
        
        tracker.urls_found = len(urls)
        tracker.log(f"Found {len(urls)} URLs to crawl")
        
        # Update progress
        if tracker.progress_callback:
            tracker.progress_callback(tracker.get_status())
        
        # Check if we have any URLs to process
        if not urls:
            tracker.log("No URLs found to crawl")
            tracker.complete()
            return
        
        # Check if AsyncWebCrawler has the arun method
        from crawl4ai import AsyncWebCrawler
        test_crawler = AsyncWebCrawler(
            config=BrowserConfig(headless=True, ignore_https_errors=True)
        )
        
        if not hasattr(test_crawler, 'arun'):
            tracker.log("ERROR: The installed version of Crawl4AI does not have the 'arun' method")
            tracker.log("Please install Crawl4AI version 0.5.0 or later")
            tracker.complete()
            return
        
        # Check if crawl was stopped before processing started
        if tracker.stop_requested:
            tracker.log("Crawl stopped before processing started")
            tracker.complete()
            return
        
        # Process URLs in parallel
        tracker.log("Starting parallel crawl with Crawl4AI...")
        await crawl_parallel_with_crawl4ai(urls, tracker)
        
        # Complete tracking
        tracker.log(f"Crawl completed. Processed {tracker.urls_processed} URLs: {tracker.urls_succeeded} succeeded, {tracker.urls_failed} failed")
        tracker.complete()
        
    except Exception as e:
        error_msg = f"Error in main_with_crawl4ai: {str(e)}"
        print(error_msg)
        tracker.log(error_msg)
        tracker.complete()
        # Update progress one last time
        if tracker.progress_callback:
            tracker.progress_callback(tracker.get_status())

def start_crawl_with_crawl4ai(progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None, url_limit: int = 50) -> CrawlProgressTracker:
    """Start the crawling process using Crawl4AI in a separate thread and return the tracker."""
    tracker = CrawlProgressTracker(progress_callback)
    
    def run_crawl():
        try:
            # Pass the URL limit to main_with_crawl4ai
            asyncio.run(main_with_crawl4ai(tracker, url_limit=url_limit))
        except Exception as e:
            print(f"Error in crawl thread: {e}")
            tracker.log(f"Thread error: {str(e)}")
            tracker.complete()
            if progress_callback:
                progress_callback(tracker.get_status())
    
    # Start the crawling process in a separate thread
    thread = threading.Thread(target=run_crawl)
    thread.daemon = True
    thread.start()
    
    return tracker

async def test_crawler():
    """Test the crawler with a single page."""
    # Create a tracker
    tracker = CrawlProgressTracker()
    
    # Start tracking
    tracker.start()
    
    # Test URL - use a known Pydantic AI docs page
    test_url = "https://ai.pydantic.dev/"
    
    # Initialize tracker with correct values
    tracker.urls_found = 1
    tracker.log(f"Testing crawler with: {test_url}")
    
    # Crawl the test page
    success = await crawl_single_page(test_url, tracker)
    
    # Complete the tracking
    tracker.complete()
    
    if success:
        tracker.log("Test crawl completed successfully")
    else:
        tracker.log("Test crawl failed")
    
    return success

async def test_crawler_with_tracker(tracker: CrawlProgressTracker):
    """Test the crawler with a single page using the provided tracker."""
    # Start tracking and explicitly update UI
    tracker.start()
    
    # Test URL
    test_url = "https://ai.pydantic.dev/"
    
    # Initialize tracker with correct values
    tracker.urls_found = 1
    
    # Explicitly update progress callback after setting urls_found
    if tracker.progress_callback:
        tracker.progress_callback(tracker.get_status())
    
    tracker.log(f"Testing crawler with: {test_url}")
    
    # Crawl the test page
    success = await crawl_single_page(test_url, tracker)
    
    # Complete the tracking
    tracker.complete()
    
    if success:
        tracker.log("Test crawl completed successfully")
    else:
        tracker.log("Test crawl failed")
    
    return success

async def crawl_single_page(url: str, tracker: Optional[CrawlProgressTracker] = None):
    """Crawl a single page for testing purposes."""
    if tracker:
        tracker.log(f"Manually crawling: {url}")
        # Explicitly update progress
        if tracker.progress_callback:
            tracker.progress_callback(tracker.get_status())
    
    # Fetch the content
    markdown = fetch_url_content(url)
    
    if markdown:
        # Process and store the document
        await process_and_store_document(url, markdown, tracker)
        
        # Update tracker
        if tracker:
            tracker.urls_succeeded += 1
            tracker.urls_processed += 1
            tracker.log(f"Successfully crawled: {url}")
            # Explicitly update progress
            if tracker.progress_callback:
                tracker.progress_callback(tracker.get_status())
        return True
    else:
        # Update tracker
        if tracker:
            tracker.urls_failed += 1
            tracker.urls_processed += 1
            tracker.log(f"Failed to crawl: {url} - Empty content")
            # Explicitly update progress
            if tracker.progress_callback:
                tracker.progress_callback(tracker.get_status())
        return False

def start_test_crawler(progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None) -> CrawlProgressTracker:
    """Start a test crawl with a single page in a separate thread."""
    # Create a tracker with the provided callback
    tracker = CrawlProgressTracker(progress_callback)
    
    # Initialize the tracker and ensure callback is triggered
    tracker.urls_found = 1
    tracker.is_running = True
    if progress_callback:
        progress_callback(tracker.get_status())
    
    # Define the function to run in a separate thread
    def run_test_crawl():
        try:
            asyncio.run(test_crawler_with_tracker(tracker))
        except Exception as e:
            print(f"Error in test crawl thread: {e}")
            tracker.log(f"Thread error: {str(e)}")
            tracker.complete()
            if progress_callback:
                progress_callback(tracker.get_status())
    
    # Start the thread
    thread = threading.Thread(target=run_test_crawl)
    thread.daemon = True
    thread.start()
    
    return tracker

def fetch_url_content(url: str) -> str:
    """Fetch content from a URL using requests and convert to markdown."""
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
    
    try:
        response = requests.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        
        # Convert HTML to Markdown
        h = html2text.HTML2Text()
        h.ignore_links = False
        h.ignore_images = False
        h.ignore_tables = False
        markdown = h.handle(response.text)
        
        # Clean the markdown content to remove artifacts
        markdown = clean_markdown_content(markdown)
        
        return markdown
    except Exception as e:
        print(f"Error fetching URL {url}: {e}")
        return ""

def get_urls_to_crawl() -> List[str]:
    """Get URLs from Pydantic AI docs sitemap."""
    sitemap_url = "https://ai.pydantic.dev/sitemap.xml"
    namespace = {'ns': 'http://www.sitemaps.org/schemas/sitemap/0.9'}
    all_urls = []
    
    try:
        # Fetch the main sitemap
        response = requests.get(sitemap_url)
        response.raise_for_status()
        
        # Parse the XML
        root = ElementTree.fromstring(response.content)
        
        # Check if this is a sitemap index (contains other sitemaps)
        sitemap_locs = root.findall('.//ns:sitemap/ns:loc', namespace)
        
        if sitemap_locs:
            print(f"Found sitemap index with {len(sitemap_locs)} child sitemaps")
            # This is a sitemap index, process each child sitemap
            for sitemap_loc in sitemap_locs:
                child_sitemap_url = sitemap_loc.text
                print(f"Processing child sitemap: {child_sitemap_url}")
                try:
                    child_response = requests.get(child_sitemap_url)
                    child_response.raise_for_status()
                    
                    # Parse the child sitemap
                    child_root = ElementTree.fromstring(child_response.content)
                    
                    # Extract URLs from this child sitemap
                    child_urls = [loc.text for loc in child_root.findall('.//ns:url/ns:loc', namespace)]
                    print(f"Found {len(child_urls)} URLs in child sitemap {child_sitemap_url}")
                    all_urls.extend(child_urls)
                except Exception as e:
                    print(f"Error processing child sitemap {child_sitemap_url}: {e}")
        else:
            # This is a regular sitemap, extract URLs directly
            urls = [loc.text for loc in root.findall('.//ns:url/ns:loc', namespace)]
            print(f"Found {len(urls)} URLs in sitemap")
            all_urls.extend(urls)
        
        print(f"Total URLs found: {len(all_urls)}")
        return all_urls
    except Exception as e:
        print(f"Error fetching sitemap: {e}")
        return []

async def clear_existing_records():
    """Clear all existing records with source='pydantic_ai_docs' from the site_pages table."""
    try:
        # Check if Supabase client is properly initialized
        if not supabase:
            error_msg = "Supabase client is not initialized"
            print(error_msg)
            return {"error": error_msg}
        
        # Check Supabase URL and key
        supabase_url = get_env_var("SUPABASE_URL")
        supabase_key = get_env_var("SUPABASE_SERVICE_KEY")
        
        if not supabase_url or not supabase_key:
            error_msg = "Supabase URL or service key is missing"
            print(error_msg)
            return {"error": error_msg}
        
        # Execute the delete operation
        print(f"Deleting records with metadata->>source=pydantic_ai_docs from site_pages table")
        result = supabase.table("site_pages").delete().eq("metadata->>source", "pydantic_ai_docs").execute()
        print(f"Cleared existing pydantic_ai_docs records from site_pages: {result}")
        return result
    except Exception as e:
        error_msg = f"Error clearing existing records: {str(e)}"
        print(error_msg)
        import traceback
        traceback.print_exc()
        return {"error": error_msg}

async def crawl_parallel_with_requests(urls: List[str], tracker: Optional[CrawlProgressTracker] = None, max_concurrent: int = 5):
    """Crawl multiple URLs in parallel with a concurrency limit using direct HTTP requests."""
    # Create a semaphore to limit concurrency
    semaphore = asyncio.Semaphore(max_concurrent)
    
    async def process_url(url: str):
        # Skip if we're stopping
        if tracker and tracker.stop_requested:
            return
        
        # Skip if already processed
        if tracker and url in tracker.processed_urls:
            tracker.log(f"Skipping already processed URL: {url}")
            return
        
        async with semaphore:
            # Skip if we're stopping
            if tracker and tracker.stop_requested:
                return
            
            # Mark as processed
            if tracker:
                tracker.processed_urls.add(url)
            
            try:
                # Use a thread pool to run the blocking HTTP request
                loop = asyncio.get_running_loop()
                if tracker:
                    tracker.log(f"Fetching content from: {url}")
                
                markdown = await loop.run_in_executor(None, fetch_url_content, url)
                
                if markdown:
                    # Process and store the document
                    await process_and_store_document(url, markdown, tracker)
                    
                    # Update tracker
                    if tracker:
                        tracker.urls_succeeded += 1
                        tracker.urls_processed += 1
                        tracker.log(f"Successfully crawled: {url}")
                else:
                    # Update tracker for failed URLs
                    if tracker:
                        tracker.urls_failed += 1
                        tracker.urls_processed += 1
                        tracker.log(f"Failed: {url} - No content retrieved")
            except Exception as e:
                if tracker:
                    tracker.urls_failed += 1
                    tracker.urls_processed += 1
                    tracker.log(f"Error processing {url}: {str(e)}")
            finally:
                # Update tracker activity
                if tracker:
                    tracker.update_activity()
                    # Explicitly update progress
                    if tracker.progress_callback:
                        tracker.progress_callback(tracker.get_status())
    
    # Process all URLs in parallel with limited concurrency
    if tracker:
        tracker.log(f"Processing {len(urls)} URLs with concurrency {max_concurrent}")
    
    # Create tasks for all URLs
    tasks = []
    for url in urls:
        # Use create_task instead of directly calling the function
        task = asyncio.create_task(process_url(url))
        tasks.append(task)
    
    # Wait for all tasks to complete with exception handling
    try:
        await asyncio.gather(*tasks, return_exceptions=True)
    except Exception as e:
        error_msg = f"Error in parallel crawling: {str(e)}"
        print(error_msg)
        if tracker:
            tracker.log(error_msg)

async def main_with_requests(tracker: Optional[CrawlProgressTracker] = None, url_limit: int = 50):
    """Main function using direct HTTP requests instead of browser automation."""
    # Create a tracker if none is provided
    if tracker is None:
        tracker = CrawlProgressTracker()
    
    # Start tracking
    tracker.start()
    tracker.log("Starting Pydantic docs crawl with requests")
    
    try:
        # Clear existing records
        tracker.log("Clearing existing records...")
        await clear_existing_records()
        tracker.log("Existing records cleared")
        
        # Get URLs to crawl
        tracker.log("Fetching URLs to crawl...")
        all_urls = get_urls_to_crawl()
        
        # Limit the number of URLs if specified
        if url_limit > 0 and len(all_urls) > url_limit:
            tracker.log(f"Limiting URLs to {url_limit} (from {len(all_urls)} total)")
            urls = all_urls[:url_limit]
        else:
            urls = all_urls
        
        tracker.urls_found = len(urls)
        tracker.log(f"Found {len(urls)} URLs to crawl")
        
        # Update progress
        if tracker.progress_callback:
            tracker.progress_callback(tracker.get_status())
        
        # Check if we have any URLs to process
        if not urls:
            tracker.log("No URLs found to crawl")
            tracker.complete()
            return
        
        # Check if crawl was stopped before processing started
        if tracker.stop_requested:
            tracker.log("Crawl stopped before processing started")
            tracker.complete()
            return
        
        # Process URLs in parallel
        tracker.log("Starting parallel crawl with requests...")
        await crawl_parallel_with_requests(urls, tracker)
        
        # Complete tracking
        tracker.log(f"Crawl completed. Processed {tracker.urls_processed} URLs: {tracker.urls_succeeded} succeeded, {tracker.urls_failed} failed")
        tracker.complete()
        
    except Exception as e:
        error_msg = f"Error in main_with_requests: {str(e)}"
        print(error_msg)
        tracker.log(error_msg)
        tracker.complete()
        # Update progress one last time
        if tracker.progress_callback:
            tracker.progress_callback(tracker.get_status())

def start_crawl_with_requests(progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None, url_limit: int = 50) -> CrawlProgressTracker:
    """Start the crawling process using direct HTTP requests in a separate thread and return the tracker."""
    tracker = CrawlProgressTracker(progress_callback)
    
    def run_crawl():
        try:
            asyncio.run(main_with_requests(tracker, url_limit=url_limit))
        except Exception as e:
            print(f"Error in crawl thread: {e}")
            tracker.log(f"Thread error: {str(e)}")
            tracker.complete()
            if progress_callback:
                progress_callback(tracker.get_status())
    
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
