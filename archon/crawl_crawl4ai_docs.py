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

load_dotenv()

# Initialize embedding and Supabase clients
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
    Keep both title and summary concise but informative.
    
    IMPORTANT: Your entire response must be valid JSON with the exact format:
    {"title": "The extracted or derived title", "summary": "The concise summary of content"}
    """
    
    try:
        print(f"Attempting to get title and summary for URL: {url[:50]}...")
        model_name = get_env_var("PRIMARY_MODEL") or "gpt-4o-mini"
        print(f"Using model: {model_name}")
        
        # Try without the response_format parameter which might be causing issues with some models
        response = await llm_client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"URL: {url}\n\nContent:\n{chunk[:1000]}..."}  # Send first 1000 chars for context
            ]
            # Removed response_format parameter
        )
        
        content = response.choices[0].message.content
        print(f"Received response from LLM. Response length: {len(content)}")
        
        try:
            # Clean the content string in case the model returns markdown or extra text
            # Try to find JSON-like content within the response
            content_clean = content
            
            # Look for JSON-like patterns
            import re
            json_pattern = r'\{[\s\S]*\}'
            json_match = re.search(json_pattern, content)
            if json_match:
                content_clean = json_match.group(0)
                
            parsed_response = json.loads(content_clean)
            
            if 'title' not in parsed_response or 'summary' not in parsed_response:
                print(f"Missing keys in parsed response: {parsed_response}")
                return {"title": f"Invalid response format: missing keys", 
                        "summary": f"Response was valid JSON but missing required fields: {list(parsed_response.keys())}"}
                        
            # Ensure we have string values
            title = str(parsed_response.get('title', '')).strip()
            summary = str(parsed_response.get('summary', '')).strip()
            
            if not title or not summary:
                print(f"Empty title or summary in response: title={title}, summary={summary}")
                if not title:
                    title = "Untitled section"
                if not summary:
                    summary = "No summary available"
                    
            return {"title": title, "summary": summary}
        except json.JSONDecodeError as json_err:
            print(f"JSON parsing error: {json_err}")
            print(f"Response content that failed to parse: {content[:200]}...")
            
            # Try an alternative approach - extract title and summary directly
            lines = content.split('\n')
            title = "Extracted title"
            summary = "Extracted summary"
            
            for line in lines:
                if "title" in line.lower() and ":" in line:
                    title = line.split(":", 1)[1].strip().strip('"\'{}').strip()
                elif "summary" in line.lower() and ":" in line:
                    summary = line.split(":", 1)[1].strip().strip('"\'{}').strip()
            
            return {"title": title, "summary": summary}
            
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f"Error getting title and summary: {e}")
        print(f"Full error traceback: {error_details}")
        return {"title": f"Error: {str(e)[:50]}", "summary": f"Error processing summary: {str(e)[:100]}"}

async def get_embedding(text: str) -> List[float]:
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

async def process_chunk(chunk: str, chunk_number: int, url: str) -> ProcessedChunk:
    """Process a single chunk of text."""
    # Get title and summary
    extracted = await get_title_and_summary(chunk, url)
    
    # Get embedding
    embedding = await get_embedding(chunk)
    
    # Create metadata
    metadata = {
        "source": "crawl4ai_docs",
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

async def crawl_parallel_with_requests(urls: List[str], tracker: Optional[CrawlProgressTracker] = None, max_concurrent: int = 5):
    """Crawl multiple URLs in parallel with a concurrency limit using direct HTTP requests."""
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
                    
                    await process_and_store_document(url, markdown, tracker)
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

def get_crawl4ai_docs_urls() -> List[str]:
    """Get URLs from crawl4ai sitemap."""
    sitemap_url = "https://docs.crawl4ai.com/sitemap.xml"
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

def clear_existing_records():
    """Clear all existing records with source='crawl4ai_docs' from the site_pages table."""
    try:
        result = supabase.table("site_pages").delete().eq("metadata->>source", "crawl4ai_docs").execute()
        print("Cleared existing crawl4ai_docs records from site_pages")
        return result
    except Exception as e:
        print(f"Error clearing existing records: {e}")
        return None

async def main_with_requests(tracker: Optional[CrawlProgressTracker] = None):
    """Main function using direct HTTP requests instead of browser automation."""
    try:
        # Start tracking if tracker is provided
        if tracker:
            tracker.start()
        else:
            print("Starting crawling process...")
        
        # Clear existing records first
        if tracker:
            tracker.log("Clearing existing crawl4ai docs records...")
        else:
            print("Clearing existing crawl4ai docs records...")
        clear_existing_records()
        if tracker:
            tracker.log("Existing records cleared")
        else:
            print("Existing records cleared")
        
        # Get URLs from Pydantic AI docs
        if tracker:
            tracker.log("Fetching URLs from crawl4ai sitemap...")
        else:
            print("Fetching URLs from crawl4ai sitemap...")
        urls = get_crawl4ai_docs_urls()
        
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
        
        # Crawl the URLs using direct HTTP requests
        await crawl_parallel_with_requests(urls, tracker)
        
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

def start_crawl_with_requests(progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None) -> CrawlProgressTracker:
    """Start the crawling process using direct HTTP requests in a separate thread and return the tracker."""
    tracker = CrawlProgressTracker(progress_callback)
    
    def run_crawl():
        try:
            asyncio.run(main_with_requests(tracker))
        except Exception as e:
            print(f"Error in crawl thread: {e}")
            tracker.log(f"Thread error: {str(e)}")
            tracker.complete()
    
    # Start the crawling process in a separate thread
    thread = threading.Thread(target=run_crawl)
    thread.daemon = True
    thread.start()
    
    return tracker

def start_crawl(progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None) -> CrawlProgressTracker:
    """
    Wrapper function to call start_crawl_with_requests().
    This facilitates consistent naming across modules.
    
    Args:
        progress_callback: Function to call with progress updates
        
    Returns:
        CrawlProgressTracker: A tracker object for monitoring the crawl progress
    """
    return start_crawl_with_requests(progress_callback)

if __name__ == "__main__":    
    # Run the main function directly
    print("Starting crawler...")
    asyncio.run(main_with_requests())
    print("Crawler finished.")
