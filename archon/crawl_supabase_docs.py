import os
import sys
import asyncio
import threading
import requests
import json
import time
import html2text
import re
from typing import List, Dict, Any, Optional, Callable, Set
from xml.etree import ElementTree
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from urllib.parse import urlparse
from dotenv import load_dotenv

# Add the parent directory to sys.path to allow importing from the parent directory
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils.utils import get_env_var

# Import Crawl4AI components for version 0.5.0
try:
    from crawl4ai import AsyncWebCrawler, BrowserConfig
    # CrawlerRunConfig is no longer needed in v0.5.0
except ImportError:
    print("Warning: crawl4ai package not found. Crawl4AI functionality will not be available.")

from openai import AsyncOpenAI
from supabase import create_client, Client

load_dotenv()

# Initialize OpenAI and Supabase clients
base_url = get_env_var('BASE_URL') or 'https://api.openai.com/v1'
api_key = get_env_var('LLM_API_KEY') or 'no-llm-api-key-provided'
is_ollama = "localhost" in base_url.lower()

embedding_model = get_env_var('EMBEDDING_MODEL') or 'text-embedding-3-small'

openai_client = None

if is_ollama:
    openai_client = AsyncOpenAI(base_url=base_url, api_key=api_key)
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

def clean_markdown_content(content: str) -> str:
    """
    Clean markdown content by removing artifacts that might confuse an AI model.
    Focus on preserving semantic meaning rather than visual formatting.
    
    Args:
        content: The markdown content to clean
        
    Returns:
        str: The cleaned markdown content
    """
    if not content:
        return content
    
    # Remove _NUMBER patterns (e.g., _10, _23) that appear as artifacts
    cleaned = re.sub(r'_\d+\s+', ' ', content)
    cleaned = re.sub(r'\s+_\d+', ' ', cleaned)
    
    # Remove line numbers at the beginning of lines that might confuse the AI
    # This handles patterns like "1 -- Schema" or "34 --"
    cleaned = re.sub(r'^\s*\d+\s+', '', cleaned, flags=re.MULTILINE)
    
    # Remove adjacent line numbers that might confuse the model (like "15 return secret_value; 16 end; 17")
    cleaned = re.sub(r';\s*\d+\s+', '; ', cleaned)
    cleaned = re.sub(r'\)\s*\d+\s+', ') ', cleaned)
    
    # Fix common code formatting issues that might confuse the model
    cleaned = re.sub(r'(\d+)(\s+)(select|create|insert|update|delete|alter|drop)', r'\2\3', cleaned)
    
    # Ensure headers are properly formatted for the AI to recognize them
    cleaned = re.sub(r'(#+)(\w)', r'\1 \2', cleaned)
    
    # Preserve important semantic markers like code blocks
    # Make sure SQL code blocks are properly delimited
    if '$$' in cleaned and not '```sql' in cleaned:
        cleaned = re.sub(r'\$\$', r'```sql', cleaned, count=1)
        cleaned = re.sub(r'\$\$', r'```', cleaned, count=1)
        # Handle any remaining $$ pairs
        cleaned = re.sub(r'\$\$', r'```sql', cleaned, count=1)
        cleaned = re.sub(r'\$\$', r'```', cleaned, count=1)
    
    # Ensure proper spacing for list items so the AI recognizes them
    cleaned = re.sub(r'(\*|\d+\.)\s*(\w)', r'\1 \2', cleaned)
    
    return cleaned.strip()

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
        """Update the last activity timestamp and call progress callback."""
        self.last_activity_time = time.time()
        
        # Call the progress callback if provided
        if self.progress_callback:
            self.progress_callback(self.get_status())
    
    def log(self, message: str):
        """Add a log message and update progress."""
        self.last_activity_time = time.time()
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
        self.is_stopping = False
        self.start_time = datetime.now()
        self.log("Crawling process started")
        
        # Call the progress callback if provided
        if self.progress_callback:
            self.progress_callback(self.get_status())
    
    def stop(self):
        """Signal the crawling process to stop."""
        self.is_stopping = True
        self.log("Stopping crawling process...")
        
        # Call the progress callback if provided
        if self.progress_callback:
            self.progress_callback(self.get_status())
    
    def complete(self):
        """Mark the crawling process as completed."""
        self.is_running = False
        self.is_stopping = False
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
            "is_stopping": self.is_stopping,
            "urls_found": self.urls_found,
            "urls_processed": self.urls_processed,
            "urls_succeeded": self.urls_succeeded,
            "urls_failed": self.urls_failed,
            "chunks_stored": self.chunks_stored,
            "progress_percentage": (self.urls_processed / self.urls_found * 100) if self.urls_found > 0 else 0,
            "logs": self.logs,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "last_activity_time": self.last_activity_time
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
    """Extract title and summary using an LLM."""
    system_prompt = """You are an AI that extracts titles and summaries from documentation chunks.
    Return a JSON object with 'title' and 'summary' keys.
    For the title: If this seems like the start of a document, extract its title. If it's a middle chunk, derive a descriptive title.
    For the summary: Create a concise summary of the main points in this chunk.
    Keep both title and summary concise but informative."""
    
    try:
        response = await openai_client.chat.completions.create(
            model="gpt-4o-mini",  # Use a specific, known OpenAI model - this will have to change if needing to use PRIMARY_MODEL, because anthropic doesn't support response_format
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"URL: {url}\n\nContent:\n{chunk[:1000]}..."}  # Send first 1000 chars for context
            ],
            response_format={ "type": "json_object" }
        )
        return json.loads(response.choices[0].message.content)
    except Exception as e:
        print(f"Error getting title and summary: {e}")
        # Return placeholder title and summary when there's an error
        return {
            "title": f"Supabase Documentation: {url.split('/')[-1]}",
            "summary": "This is a documentation page from Supabase."
        }

async def get_embedding(text: str) -> List[float]:
    """Generate an embedding for the given text."""
    try:
        # Use text-embedding-3-small for embeddings, which works with OpenAI API
        response = await openai_client.embeddings.create(
            model=embedding_model,
            input=text
        )
        return response.data[0].embedding
    except Exception as e:
        print(f"Error getting embedding: {e}")
        # Return a default embedding (all zeros) if there's an error
        return [0.0] * 1536  # Standard size for OpenAI embeddings

async def process_chunk(chunk: str, chunk_number: int, url: str) -> ProcessedChunk:
    """Process a single chunk of text."""
    # Get title and summary
    extracted = await get_title_and_summary(chunk, url)
    
    # Get embedding
    embedding = await get_embedding(chunk)
    
    # Create metadata
    metadata = {
        "source": "supabase_docs",
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
        result = supabase.table("site_pages").insert({
            "url": chunk.url,
            "chunk_number": chunk.chunk_number,
            "title": chunk.title,
            "summary": chunk.summary,
            "content": chunk.content,
            "metadata": chunk.metadata,
            "embedding": chunk.embedding
        }).execute()
        
        if hasattr(result, 'error') and result.error is not None:
            print(f"Error inserting chunk: {result.error}")
            return False
        
        return True
    except Exception as e:
        print(f"Exception inserting chunk: {e}")
        return False

async def process_and_store_document(url: str, markdown: str, tracker: Optional[CrawlProgressTracker] = None):
    """Process and store a document.
    
    Args:
        url: The URL of the document
        markdown: The markdown content
        tracker: Optional progress tracker
        
    Returns:
        Number of chunks processed and stored
    """
    if not markdown:
        if tracker:
            tracker.log(f"Empty content for {url}")
        return 0
    
    # Split the document into chunks
    chunks = chunk_text(markdown)
    
    # Log the number of chunks
    if tracker:
        tracker.log(f"Split {url} into {len(chunks)} chunks")
    
    # Process each chunk
    chunks_processed = 0
    try:
        for i, chunk in enumerate(chunks):
            # Check if we should stop
            if tracker and tracker.is_stopping:
                if tracker:
                    tracker.log(f"Stopped processing chunks for {url}")
                break
            
            try:
                # Process the chunk
                processed = await process_chunk(chunk, i + 1, url)
                
                # Store the chunk
                await insert_chunk(processed)
                
                # Update the tracker
                if tracker:
                    tracker.chunks_stored += 1
                    chunks_processed += 1
                    tracker.log(f"Stored chunk {i + 1}/{len(chunks)} for {url}")
                    
                    # Update progress after each chunk is stored
                    if tracker.progress_callback:
                        tracker.progress_callback(tracker.get_status())
                        
            except Exception as e:
                # Log the error and continue with the next chunk
                if tracker:
                    tracker.log(f"Error processing chunk {i + 1} for {url}: {str(e)}")
                    
                    # Update progress after each error
                    if tracker.progress_callback:
                        tracker.progress_callback(tracker.get_status())
                        
    except Exception as e:
        # Log the error
        if tracker:
            tracker.log(f"Error processing document {url}: {str(e)}")
            
            # Update progress after error
            if tracker.progress_callback:
                tracker.progress_callback(tracker.get_status())
    
    # Return the number of chunks processed
    return chunks_processed

def fetch_url_content(url: str) -> str:
    """Fetch content from a URL using requests."""
    try:
        response = requests.get(url)
        response.raise_for_status()
        
        # Convert HTML to Markdown
        markdown = html_converter.handle(response.text)
        
        # Clean the markdown content to remove artifacts
        markdown = clean_markdown_content(markdown)
        
        return markdown
    except Exception as e:
        print(f"Error fetching URL {url}: {e}")
        return ""

async def crawl_parallel_with_requests(urls: List[str], tracker: Optional[CrawlProgressTracker] = None, max_concurrent: int = 5):
    """Crawl a list of URLs in parallel using requests.
    
    Args:
        urls: List of URLs to crawl
        tracker: Optional progress tracker
        max_concurrent: Maximum number of concurrent crawl operations
    """
    if tracker:
        tracker.log(f"Starting parallel crawling with {max_concurrent} workers")
        # Force an immediate update
        if tracker.progress_callback:
            tracker.progress_callback(tracker.get_status())
    
    # Keep track of processed URLs to avoid duplicates
    processed_urls = set()
    
    async def process_url(url: str):
        # Check if we should stop
        if tracker and tracker.is_stopping:
            if tracker.progress_callback:
                tracker.progress_callback(tracker.get_status())
            return False
            
        # Skip if already processed
        if url in processed_urls:
            if tracker:
                tracker.log(f"Skipping already processed URL: {url}")
            return False
            
        processed_urls.add(url)

        try:
            # Log the crawling
            if tracker:
                tracker.log(f"Crawling: {url}")
                # Update progress after logging
                if tracker.progress_callback:
                    tracker.progress_callback(tracker.get_status())
            
            # Fetch the URL content
            markdown = fetch_url_content(url)
            
            if markdown:
                # Process and store the document
                chunks_added = await process_and_store_document(url, markdown, tracker)
                
                # Update tracker
                if tracker:
                    tracker.urls_succeeded += 1
                    tracker.urls_processed += 1
                    if chunks_added:
                        tracker.log(f"Successfully processed {url} - added {chunks_added} chunks")
                    else:
                        tracker.log(f"Successfully processed {url} but no chunks were added")
                    
                    # Update the UI after successful processing
                    if tracker.progress_callback:
                        tracker.progress_callback(tracker.get_status())
                return True
            else:
                # Update tracker for empty content
                if tracker:
                    tracker.urls_failed += 1
                    tracker.urls_processed += 1
                    tracker.log(f"Failed to crawl: {url} - Empty content")
                    
                    # Update the UI after failed processing
                    if tracker.progress_callback:
                        tracker.progress_callback(tracker.get_status())
                return False
                
        except Exception as e:
            # Update tracker for errors
            if tracker:
                tracker.urls_failed += 1
                tracker.urls_processed += 1
                tracker.log(f"Error crawling {url}: {str(e)}")
                
                # Update the UI after error
                if tracker.progress_callback:
                    tracker.progress_callback(tracker.get_status())
            return False
    
    # Create a semaphore to limit concurrency
    sem = asyncio.Semaphore(max_concurrent)
    
    async def limited_process_url(url):
        async with sem:
            return await process_url(url)
    
    # Create tasks for each URL
    tasks = []
    for url in urls:
        # Check if we should stop
        if tracker and tracker.is_stopping:
            break
        
        # Use create_task instead of directly calling the function
        task = asyncio.create_task(limited_process_url(url))
        tasks.append(task)
    
    # Wait for all tasks to complete with exception handling
    try:
        if tasks:
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            # Log any exceptions that were returned
            for i, result in enumerate(results):
                if isinstance(result, Exception):
                    error_msg = f"Error in task {i}: {str(result)}"
                    print(error_msg)
                    if tracker:
                        tracker.log(error_msg)
    except Exception as e:
        error_msg = f"Error in parallel crawling: {str(e)}"
        print(error_msg)
        if tracker:
            tracker.log(error_msg)

def get_supabase_docs_urls(url_limit: int = 50) -> List[str]:
    """Get a list of URLs from the Supabase docs sitemap.
    
    Args:
        url_limit: Maximum number of URLs to return. Set to -1 for no limit.
        
    Returns:
        List of URLs
    """
    # Define the hardcoded fallback URLs to use if sitemap fails
    fallback_urls = [
        "https://supabase.com/docs/guides/getting-started",
        "https://supabase.com/docs/guides/database",
        "https://supabase.com/docs/guides/auth",
        "https://supabase.com/docs/guides/storage",
        "https://supabase.com/docs/guides/api",
        "https://supabase.com/docs/guides/functions",
        "https://supabase.com/docs/guides/realtime",
        "https://supabase.com/docs/guides/resources",
    ]
    
    print("Starting to fetch Supabase URLs through proper sitemap crawling")
    
    # Function to extract URLs from a sitemap
    def extract_urls_from_sitemap(sitemap_url: str, namespace: str = '{http://www.sitemaps.org/schemas/sitemap/0.9}') -> List[str]:
        try:
            print(f"Fetching sitemap from {sitemap_url}")
            response = requests.get(sitemap_url, timeout=10)
            if response.status_code != 200:
                print(f"Failed to fetch sitemap {sitemap_url}: HTTP {response.status_code}")
                return []
                
            try:
                root = ElementTree.fromstring(response.content)
            except Exception as e:
                print(f"Failed to parse sitemap XML from {sitemap_url}: {e}")
                return []
            
            # First, check if this is a sitemap index (contains other sitemaps)
            sitemap_urls = []
            for sitemap in root.findall(f".//{namespace}sitemap"):
                loc_element = sitemap.find(f"{namespace}loc")
                if loc_element is not None and loc_element.text:
                    sitemap_urls.append(loc_element.text)
            
            # If this is a sitemap index, recursively fetch all sitemaps
            all_page_urls = []
            if sitemap_urls:
                print(f"Found {len(sitemap_urls)} nested sitemaps in {sitemap_url}")
                for nested_sitemap in sitemap_urls:
                    # Only process if it looks like a docs sitemap
                    if 'docs' in nested_sitemap or 'guides' in nested_sitemap or 'reference' in nested_sitemap:
                        nested_urls = extract_urls_from_sitemap(nested_sitemap, namespace)
                        all_page_urls.extend(nested_urls)
            
            # Also check for direct URLs in this sitemap
            page_urls = []
            for url in root.findall(f".//{namespace}url"):
                loc_element = url.find(f"{namespace}loc")
                if loc_element is not None and loc_element.text:
                    # Filter for only docs URLs
                    if '/docs/' in loc_element.text:
                        page_urls.append(loc_element.text)
            
            print(f"Found {len(page_urls)} direct page URLs in {sitemap_url}")
            all_page_urls.extend(page_urls)
            
            # Remove duplicates while preserving order
            seen = set()
            unique_urls = []
            for url in all_page_urls:
                if url not in seen:
                    seen.add(url)
                    unique_urls.append(url)
            
            return unique_urls
        except requests.exceptions.Timeout:
            print(f"Timeout while fetching sitemap {sitemap_url}")
            return []
        except requests.exceptions.ConnectionError:
            print(f"Connection error while fetching sitemap {sitemap_url}")
            return []
        except Exception as e:
            print(f"Error processing sitemap {sitemap_url}: {e}")
            return []
    
    # Start with the main sitemap
    all_urls = []
    
    # Try different sitemap strategies
    sitemap_strategies = [
        "https://supabase.com/sitemap.xml",
        "https://supabase.com/docs/sitemap.xml",
        "https://supabase.com/sitemap-0.xml"
    ]
    
    for sitemap_url in sitemap_strategies:
        if all_urls:
            # If we already have URLs, don't try other strategies
            break
            
        urls = extract_urls_from_sitemap(sitemap_url)
        if urls:
            all_urls.extend(urls)
            print(f"Found {len(urls)} URLs using strategy {sitemap_url}")
    
    # Filter to only include docs URLs and remove duplicates
    docs_urls = [url for url in all_urls if '/docs/' in url]
    print(f"Total docs URLs found: {len(docs_urls)}")
    
    # If we didn't find any URLs, use fallback
    if not docs_urls:
        print("No docs URLs found in any sitemap, using fallback list")
        docs_urls = fallback_urls
    
    # Apply limit if specified
    if url_limit > 0 and len(docs_urls) > url_limit:
        print(f"Limiting URLs from {len(docs_urls)} to {url_limit}")
        docs_urls = docs_urls[:url_limit]
    
    return docs_urls

async def clear_existing_records():
    """Clear existing Supabase docs records from the database."""
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
        print(f"Deleting records with metadata->>source=supabase_docs from site_pages table")
        result = supabase.table("site_pages").delete().eq("metadata->>source", "supabase_docs").execute()
        print(f"Cleared existing supabase_docs records from site_pages: {result}")
        return result
    except Exception as e:
        error_msg = f"Error clearing existing records: {str(e)}"
        print(error_msg)
        import traceback
        traceback.print_exc()
        return {"error": error_msg}

async def main_with_requests(tracker: Optional[CrawlProgressTracker] = None, url_limit: int = 50):
    """Main function to crawl and process Supabase docs.
    
    Args:
        tracker: Optional progress tracker
        url_limit: Maximum number of URLs to crawl. Set to -1 for no limit.
    """
    print("Starting main_with_requests...")
    
    # Start tracking progress
    if tracker:
        tracker.start()
        print("Tracker started")
        # Force an immediate update to the UI
        if tracker.progress_callback:
            tracker.progress_callback(tracker.get_status())
            print("Initial progress callback sent from main")
    
    try:
        # Clear existing records first
        if tracker:
            tracker.log("Clearing existing Supabase docs records...")
            print("Clearing existing records...")
            # Force an update after each significant log
            if tracker.progress_callback:
                tracker.progress_callback(tracker.get_status())
                
        await clear_existing_records()
        
        if tracker:
            tracker.log("Existing records cleared")
            print("Records cleared successfully")
            # Force an update after each significant log
            if tracker.progress_callback:
                tracker.progress_callback(tracker.get_status())
        
        # Get URLs from Supabase docs
        if tracker:
            tracker.log(f"Fetching URLs from Supabase sitemap (limit: {url_limit if url_limit > 0 else 'none'})...")
            print(f"Fetching URLs with limit {url_limit}...")
            # Force an update after each significant log
            if tracker.progress_callback:
                tracker.progress_callback(tracker.get_status())
                
        # Get the URLs - This is a synchronous call
        print("About to call get_supabase_docs_urls...")
        urls = get_supabase_docs_urls(url_limit)
        print(f"get_supabase_docs_urls returned {len(urls)} URLs")
        
        if not urls:
            if tracker:
                tracker.log("No URLs found to crawl")
                tracker.complete()
                print("No URLs found, completing tracker")
                # Force a final update
                if tracker.progress_callback:
                    tracker.progress_callback(tracker.get_status())
            return
        
        # Set the URLs found count immediately after getting URLs
        if tracker:
            tracker.urls_found = len(urls)
            tracker.log(f"Found {len(urls)} URLs to crawl")
            print(f"Set tracker.urls_found to {len(urls)}")
            
            # Make sure to update the progress callback immediately after setting URLs found
            if tracker.progress_callback:
                tracker.progress_callback(tracker.get_status())
                print("Progress callback sent after setting URLs found")
                
        # Give UI a moment to update before starting crawl
        print("Sleeping to allow UI update...")
        await asyncio.sleep(1)
        print("Sleep complete")
            
        # Check if we should stop
        if tracker and tracker.is_stopping:
            tracker.log("Crawling stopped by user before processing started")
            tracker.complete()
            print("Early stop detected, completing tracker")
            # Force a final update
            if tracker.progress_callback:
                tracker.progress_callback(tracker.get_status())
            return
            
        # Start the actual crawling process
        tracker.log("Starting to crawl URLs...")
        print("Beginning the actual crawling process now")
        if tracker.progress_callback:
            tracker.progress_callback(tracker.get_status())
            
        # Start crawling
        await crawl_parallel_with_requests(urls, tracker)
        print("crawl_parallel_with_requests completed")
        
        # Mark crawling as complete
        if tracker:
            if tracker.is_stopping:
                tracker.log("Crawling stopped by user")
            else:
                if tracker.urls_succeeded > 0:
                    tracker.log(f"Crawling completed successfully. Processed {tracker.urls_processed} URLs and stored {tracker.chunks_stored} chunks.")
                else:
                    tracker.log("Crawling completed but no documents were successfully processed.")
            tracker.complete()
            print("Marked tracker as complete")
            
            # Make sure to update the progress callback one last time
            if tracker.progress_callback:
                tracker.progress_callback(tracker.get_status())
                print("Final progress callback sent")
    
    except Exception as e:
        # Log error and mark as complete
        print(f"Exception in main_with_requests: {str(e)}")
        if tracker:
            tracker.log(f"Error during crawling: {str(e)}")
            tracker.complete()
            print("Marked tracker as complete after error")
            
            # Make sure to update the progress callback
            if tracker.progress_callback:
                tracker.progress_callback(tracker.get_status())
                print("Progress callback sent after error")

def start_crawl_with_requests(progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None, url_limit: int = 50) -> CrawlProgressTracker:
    """Start crawling in a separate thread and return a tracker.
    
    Args:
        progress_callback: Function to call with progress updates
        url_limit: Maximum number of URLs to crawl. Set to -1 for no limit.
        
    Returns:
        A CrawlProgressTracker instance.
    """
    print("Starting crawler with requests...")
    
    # Create a tracker with the provided callback
    tracker = CrawlProgressTracker(progress_callback)
    
    # Ensure it's set to running state
    tracker.is_running = True
    tracker.is_stopping = False
    
    # Log initialization
    tracker.log("Initializing crawler...")
    print("Tracker initialized, crawler starting...")
    
    # Make an initial progress callback to show the tracker is running
    if progress_callback:
        progress_callback(tracker.get_status())
        print("Initial progress callback sent")
    
    # Define the function to run in a separate thread
    def run_crawl():
        print("Crawler thread started")
        # Set up the event loop for this thread
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            print("Starting main_with_requests in thread")
            # Run the main function in this thread's event loop
            loop.run_until_complete(main_with_requests(tracker, url_limit))
            print("main_with_requests completed")
        except Exception as e:
            print(f"Error in crawl thread: {e}")
            if tracker:
                tracker.log(f"Thread error: {str(e)}")
                tracker.complete()
                # Make sure progress gets updated in case of error
                if tracker.progress_callback:
                    tracker.progress_callback(tracker.get_status())
        finally:
            # Clean up
            loop.close()
            print("Crawler thread event loop closed")
    
    # Start a thread to run the crawler
    thread = threading.Thread(target=run_crawl)
    thread.daemon = True
    thread.start()
    print(f"Crawler thread started with daemon={thread.daemon}")
    
    return tracker

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

async def test_crawler():
    """Test the crawler with a single page."""
    tracker = CrawlProgressTracker()
    tracker.start()
    
    # Test URL
    test_url = "https://supabase.com/docs/guides/getting-started"
    
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
    test_url = "https://supabase.com/docs/guides/getting-started"
    
    # Initialize tracker with correct values
    tracker.urls_found = 1
    
    # Explicitly update progress callback after setting urls_found
    if tracker.progress_callback:
        tracker.progress_callback(tracker.get_status())
        
    tracker.log(f"Testing crawler with: {test_url}")
    
    # Crawl the test page
    success = await crawl_single_page(test_url, tracker)
    
    # Ensure UI gets updated with final status
    if tracker.progress_callback:
        tracker.progress_callback(tracker.get_status())
        
    # Complete the tracking
    tracker.complete()
    
    if success:
        tracker.log("Test crawl completed successfully")
    else:
        tracker.log("Test crawl failed")
    
    # Final UI update
    if tracker.progress_callback:
        tracker.progress_callback(tracker.get_status())
        
    return success

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

async def crawl_with_crawl4ai(url: str, tracker: Optional[CrawlProgressTracker] = None, max_retries: int = 3) -> str:
    """
    Crawl a URL using Crawl4AI and return the content as markdown.
    
    Args:
        url: The URL to crawl
        tracker: Optional progress tracker
        max_retries: Maximum number of retry attempts
        
    Returns:
        str: The content of the page as markdown
    """
    if tracker:
        tracker.log(f"Crawling {url} with Crawl4AI")
    
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
                    
                    # Clean the content to remove artifacts
                    content = clean_markdown_content(content)
                    
                    if tracker:
                        tracker.log(f"Cleaned content from {url} - {len(content)} characters")
                    
                    return content
                except asyncio.TimeoutError:
                    if tracker:
                        tracker.log(f"Timeout while crawling {url}")
                    # If this is the last attempt, return empty string
                    if attempt == max_retries:
                        return ""
                    # Wait before retrying
                    await asyncio.sleep(2)
                    continue
            
        except Exception as e:
            if tracker:
                tracker.log(f"Error crawling {url} (attempt {attempt}/{max_retries}): {str(e)}")
            
            # If this is the last attempt, return empty string
            if attempt == max_retries:
                if tracker:
                    tracker.log(f"Failed to crawl {url} after {max_retries} attempts")
                return ""
            
            # Wait before retrying
            await asyncio.sleep(2)
    
    # This should never be reached due to the return in the loop
    return ""

async def crawl_parallel_with_crawl4ai(urls: List[str], tracker: Optional[CrawlProgressTracker] = None, max_concurrent: int = 3):
    """
    Crawl multiple URLs in parallel using Crawl4AI.
    
    Args:
        urls: List of URLs to crawl
        tracker: Optional progress tracker
        max_concurrent: Maximum number of concurrent requests
    """
    if tracker:
        tracker.log(f"Starting parallel crawl with Crawl4AI for {len(urls)} URLs (max {max_concurrent} concurrent)")
    
    # Create a semaphore to limit concurrent requests
    semaphore = asyncio.Semaphore(max_concurrent)
    
    # Keep track of processed URLs to avoid duplicates
    processed_urls = set()
    
    async def process_url(url: str):
        # Check if we should stop
        if tracker and tracker.is_stopping:
            tracker.log(f"Skipping {url} as crawl was stopped")
            return
            
        # Skip if already processed
        if url in processed_urls:
            if tracker:
                tracker.log(f"Skipping already processed URL: {url}")
            return
            
        processed_urls.add(url)
        
        try:
            # Get the content using Crawl4AI
            content = await crawl_with_crawl4ai(url, tracker, max_retries=3)
            
            if not content:
                if tracker:
                    tracker.log(f"No content retrieved for {url}, skipping")
                    tracker.urls_failed += 1
                    tracker.urls_processed += 1  # Still count as processed
                    tracker.update_activity()
                return
                
            # Process and store the document
            await process_and_store_document(url, content, tracker)
            
            # Update the tracker
            if tracker:
                tracker.urls_succeeded += 1
                tracker.urls_processed += 1
                tracker.update_activity()
            
        except Exception as e:
            error_msg = f"Error processing {url}: {str(e)}"
            print(error_msg)
            if tracker:
                tracker.log(error_msg)
                tracker.urls_failed += 1
                tracker.urls_processed += 1  # Still count as processed
                tracker.update_activity()
    
    async def limited_process_url(url):
        async with semaphore:
            await process_url(url)
    
    # Process all URLs concurrently with limited concurrency
    tasks = []
    for url in urls:
        # Use create_task instead of directly calling the function
        task = asyncio.create_task(limited_process_url(url))
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
    Main function to crawl Supabase documentation using Crawl4AI.
    
    Args:
        tracker: Optional progress tracker
        url_limit: Maximum number of URLs to crawl
    """
    if tracker is None:
        tracker = CrawlProgressTracker()
    
    # Start the tracker
    tracker.start()
    tracker.log(f"Starting Supabase documentation crawl with Crawl4AI (limit: {url_limit} URLs)")
    
    try:
        # Check if Crawl4AI is available
        if 'AsyncWebCrawler' not in globals():
            error_msg = "Crawl4AI is not available. Please install it with 'pip install crawl4ai'"
            tracker.log(error_msg)
            tracker.stop()
            return
            
        # Verify that AsyncWebCrawler has the arun method
        try:
            browser_config = BrowserConfig(
                headless=True,
                ignore_https_errors=True
            )
            
            # Use async with context manager pattern to ensure proper initialization and cleanup
            async with AsyncWebCrawler(config=browser_config) as test_crawler:
                if not hasattr(test_crawler, 'arun'):
                    error_msg = "The installed version of Crawl4AI doesn't have the 'arun' method. Please update to version 0.5.0 or later."
                    tracker.log(error_msg)
                    tracker.stop()
                    return
                
            # Continue with the rest of the function
            
        except Exception as e:
            error_msg = f"Error initializing Crawl4AI: {str(e)}"
            tracker.log(error_msg)
            tracker.stop()
            return
            
        # Clear existing records
        tracker.log("Clearing existing Supabase documentation records...")
        try:
            await clear_existing_records()
            tracker.log("Existing records cleared successfully")
        except Exception as e:
            error_msg = f"Error clearing existing records: {str(e)}"
            tracker.log(error_msg)
            # Continue despite this error
        
        # Get URLs to crawl
        tracker.log(f"Fetching Supabase documentation URLs (limit: {url_limit})...")
        try:
            urls = get_supabase_docs_urls(url_limit)
        except Exception as e:
            error_msg = f"Error fetching URLs: {str(e)}"
            tracker.log(error_msg)
            tracker.stop()
            return
        
        if not urls:
            tracker.log("No URLs found to crawl")
            tracker.stop()
            return
            
        tracker.log(f"Found {len(urls)} URLs to crawl")
        tracker.urls_found = len(urls)
        
        # Check if we should stop
        if tracker.is_stopping:
            tracker.log("Crawl stopped before processing started")
            tracker.stop()
            return
            
        # Process URLs in parallel
        tracker.log(f"Starting parallel crawl of {len(urls)} URLs with Crawl4AI...")
        try:
            await crawl_parallel_with_crawl4ai(urls, tracker)
        except Exception as e:
            error_msg = f"Error during parallel crawl: {str(e)}"
            tracker.log(error_msg)
            # Continue to completion handling
        
        # Complete the crawl
        if tracker.urls_processed == 0:
            tracker.log("Crawling completed but no documents were successfully processed.")
            tracker.stop()
        else:
            success_rate = (tracker.urls_succeeded / tracker.urls_processed) * 100 if tracker.urls_processed > 0 else 0
            tracker.log(f"Completed crawling {tracker.urls_processed} URLs with a {success_rate:.1f}% success rate")
            tracker.complete()
            
    except Exception as e:
        error_msg = f"Error during crawl: {str(e)}"
        print(error_msg)
        tracker.log(error_msg)
        tracker.stop()
        
    # Final status update
    if tracker.progress_callback:
        tracker.progress_callback(tracker.get_status())

def start_crawl_with_crawl4ai(progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None, url_limit: int = 50) -> CrawlProgressTracker:
    """
    Start the Supabase documentation crawl with Crawl4AI in a separate thread.
    
    Args:
        progress_callback: Optional callback function to report progress
        url_limit: Maximum number of URLs to crawl
        
    Returns:
        CrawlProgressTracker: The progress tracker
    """
    print("Starting crawler with Crawl4AI...")
    
    # Create a tracker with the provided callback
    tracker = CrawlProgressTracker(progress_callback)
    
    # Ensure it's set to running state
    tracker.is_running = True
    tracker.is_stopping = False
    
    # Log initialization
    tracker.log("Initializing Crawl4AI crawler...")
    print("Tracker initialized, Crawl4AI crawler starting...")
    
    # Make an initial progress callback to show the tracker is running
    if progress_callback:
        progress_callback(tracker.get_status())
        print("Initial progress callback sent")
    
    # Define the function to run in a separate thread
    def run_crawl():
        print("Crawler thread started")
        # Set up the event loop for this thread
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            print("Starting main_with_crawl4ai in thread")
            # Run the main function in this thread's event loop
            loop.run_until_complete(main_with_crawl4ai(tracker, url_limit))
            print("main_with_crawl4ai completed")
        except Exception as e:
            print(f"Error in crawl thread: {e}")
            if tracker:
                tracker.log(f"Thread error: {str(e)}")
                tracker.complete()
        finally:
            # Always close the loop
            loop.close()
            print("Crawler thread event loop closed")
    
    # Start the crawling process in a separate thread
    thread = threading.Thread(target=run_crawl)
    thread.daemon = True
    thread.start()
    
    return tracker

if __name__ == "__main__":
    # Verify that all required functions are defined
    required_functions = [
        "start_crawl_with_requests",
        "start_crawl_with_crawl4ai",
        "clear_existing_records",
        "start_test_crawler"
    ]
    
    # Check if all required functions are defined
    for func_name in required_functions:
        if func_name not in globals():
            print(f"ERROR: Function {func_name} is not defined!")
        else:
            print(f"Function {func_name} is defined.")
    
    print("All required functions are defined and ready to use.")
    
    # Use Crawl4AI by default
    asyncio.run(main_with_crawl4ai())
    
    # Uncomment to use requests instead
    # asyncio.run(main_with_requests()) 