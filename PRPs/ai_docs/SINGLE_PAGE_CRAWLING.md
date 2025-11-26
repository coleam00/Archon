# Single Page Crawling Strategy

This document describes the `SinglePageCrawlStrategy` class implementation in `python/src/server/services/crawling/strategies/single_page.py`.

## Overview

The `SinglePageCrawlStrategy` class handles the crawling of individual web pages using the Crawl4AI library. It provides specialized configurations for different site types (documentation sites vs. regular sites) and implements robust retry logic with exponential backoff.

## Class Structure

### Initialization

```python
def __init__(self, crawler, markdown_generator):
```

**Parameters:**
- `crawler` (AsyncWebCrawler): The Crawl4AI crawler instance for web crawling operations
- `markdown_generator` (DefaultMarkdownGenerator): The markdown generator instance for converting HTML to markdown

## Key Methods

### 1. Documentation Site Detection

```python
def _get_wait_selector_for_docs(self, url: str) -> str:
```

Identifies the type of documentation framework used by a site based on URL patterns and returns appropriate CSS selectors to wait for content to load.

**Supported Frameworks:**

| Framework | URL Pattern | Wait Selector |
|-----------|-------------|---------------|
| Docusaurus | `docusaurus` | `.markdown, .theme-doc-markdown, article` |
| VitePress | `vitepress` | `.VPDoc, .vp-doc, .content` |
| GitBook | `gitbook` | `.markdown-section, .page-wrapper` |
| MkDocs | `mkdocs` | `.md-content, article` |
| Docsify | `docsify` | `#main, .markdown-section` |
| CopilotKit | `copilotkit` | `div[class*="content"], div[class*="doc"], #__next` |
| Milkdown | `milkdown` | `main, article, .prose, [class*="content"]` |
| Generic | (fallback) | `body` |

**Purpose:** JavaScript-heavy documentation sites need specific selectors to ensure content is fully loaded before extraction.

### 2. Main Crawling Method

```python
async def crawl_single_page(
    self,
    url: str,
    transform_url_func: Callable[[str], str],
    is_documentation_site_func: Callable[[str], bool],
    retry_count: int = 3
) -> dict[str, Any]:
```

The primary method for crawling individual web pages with sophisticated retry logic and content validation.

#### Parameters

- `url`: The web page URL to crawl
- `transform_url_func`: Function to transform URLs (e.g., GitHub URLs to raw content)
- `is_documentation_site_func`: Function to check if URL is a documentation site
- `retry_count`: Number of retry attempts (default: 3)

#### Retry Logic

- Attempts crawling up to `retry_count` times
- Uses **exponential backoff** between retries: `2^attempt` seconds
  - 1st retry: wait 1 second
  - 2nd retry: wait 2 seconds
  - 3rd retry: wait 4 seconds
- First attempt uses **cached content** (if available)
- Subsequent attempts **bypass cache** for fresh content

#### Configuration: Documentation Sites

When `is_documentation_site_func(url)` returns `True`:

```python
CrawlerRunConfig(
    cache_mode=cache_mode,
    stream=True,                    # Enable streaming for parallel processing
    markdown_generator=markdown_generator,
    wait_for=wait_selector,         # Framework-specific selector
    wait_until='domcontentloaded',  # Don't wait for full page load
    page_timeout=30000,             # 30 seconds
    delay_before_return_html=0.5,   # 500ms delay for JS rendering
    wait_for_images=False,          # Skip image loading
    scan_full_page=True,            # Trigger lazy loading
    exclude_all_images=False,       # Keep images in content
    remove_overlay_elements=True,   # Remove popups/modals
    process_iframes=True            # Extract iframe content
)
```

#### Configuration: Regular Sites

For non-documentation sites:

```python
CrawlerRunConfig(
    cache_mode=cache_mode,
    stream=True,                    # Enable streaming
    markdown_generator=markdown_generator,
    wait_until='domcontentloaded',  # Faster than 'networkidle'
    page_timeout=45000,             # 45 seconds
    delay_before_return_html=0.3,   # 300ms delay
    scan_full_page=True             # Trigger lazy loading
)
```

#### Content Validation

The method validates crawled content before returning:

1. **Success check**: `result.success` must be `True`
2. **Content length**: Markdown must have at least 50 characters
3. **Non-empty**: Markdown content must exist

If validation fails, the method retries with exponential backoff.

#### Debug Logging

The method logs extensive debug information:

- Markdown length and presence
- Triple backtick count (code blocks)
- Sample content for specific URLs (e.g., 'getting-started')
- Configuration details (wait_until, page_timeout)

#### Return Value

**On Success:**
```python
{
    "success": True,
    "url": original_url,           # Original URL (before transformation)
    "markdown": result.markdown,   # Extracted markdown content
    "html": result.html,           # Raw HTML (used for code extraction)
    "title": result.title,         # Page title or "Untitled"
    "links": result.links,         # Extracted links from page
    "content_length": len(markdown) # Length of markdown content
}
```

**On Failure:**
```python
{
    "success": False,
    "error": "Error message describing what went wrong"
}
```

### 3. Markdown File Crawling

```python
async def crawl_markdown_file(
    self,
    url: str,
    transform_url_func: Callable[[str], str],
    progress_callback: Callable[..., Awaitable[None]] | None = None,
    start_progress: int = 10,
    end_progress: int = 20
) -> list[dict[str, Any]]:
```

Handles direct crawling of `.txt` or `.md` files with progress reporting.

#### Parameters

- `url`: URL of the text/markdown file
- `transform_url_func`: Function to transform URLs (e.g., GitHub URLs to raw content)
- `progress_callback`: Optional callback for progress updates
- `start_progress`: Starting progress percentage (default: 10)
- `end_progress`: Ending progress percentage (default: 20)

#### Features

- **URL transformation**: Converts GitHub URLs to raw content URLs
- **Progress reporting**: Reports progress at start and completion
- **Simpler configuration**: No special wait conditions needed
- **Single document**: Always returns a list with one document

#### Configuration

```python
CrawlerRunConfig(
    cache_mode=CacheMode.ENABLED,
    stream=False                    # Streaming not needed for single files
)
```

#### Progress Reporting

The method reports progress via the optional callback:

**Start:**
```python
progress_callback('crawling', start_progress, 
    f"Fetching text file: {url}",
    total_pages=1,
    processed_pages=0
)
```

**Completion:**
```python
progress_callback('crawling', end_progress,
    f"Text file crawled successfully: {original_url}",
    total_pages=1,
    processed_pages=1
)
```

#### Return Value

**On Success:**
```python
[{
    'url': original_url,
    'markdown': result.markdown,
    'html': result.html
}]
```

**On Failure:**
```python
[]  # Empty list
```

## Error Handling

The strategy follows beta development guidelines with intelligent error handling:

### Fail Fast Scenarios

- **Missing crawler instance**: Returns error immediately without retrying
- **Invalid configuration**: Raises exceptions for bad parameters

### Complete with Detailed Errors

- **Individual page failures**: Logs error, continues processing (in batch contexts)
- **Timeout errors**: Catches `TimeoutError`, logs, and retries
- **Crawl failures**: Logs detailed error messages with full context

### Error Logging

All errors are logged with:
- Full stack traces (`traceback.format_exc()`)
- URL being crawled
- Attempt number
- Specific error messages from Crawl4AI
- Validation failure reasons

### Error Messages

Error messages include:
- What operation was being attempted
- Which URL failed
- Why it failed (timeout, validation, exception)
- Number of attempts made

## Performance Optimizations

The strategy includes several optimizations for speed and efficiency:

1. **Streaming enabled**: Allows parallel processing of crawl results
2. **Reduced delays**: 
   - Documentation sites: 0.5s (down from 2.0s)
   - Regular sites: 0.3s (down from 1.0s)
3. **Cache mode**: First attempts use cached content when available
4. **domcontentloaded**: Doesn't wait for full page load (faster than 'networkidle')
5. **Skip image waiting**: Documentation sites don't wait for images to load
6. **Exponential backoff**: Prevents hammering failing servers

## Usage Example

```python
from crawl4ai import AsyncWebCrawler
from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator

# Initialize dependencies
crawler = AsyncWebCrawler()
markdown_generator = DefaultMarkdownGenerator()

# Create strategy
strategy = SinglePageCrawlStrategy(crawler, markdown_generator)

# Define helper functions
def transform_url(url: str) -> str:
    # Transform GitHub URLs to raw content
    if 'github.com' in url and '/blob/' in url:
        return url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/')
    return url

def is_documentation_site(url: str) -> bool:
    doc_indicators = ['docs.', '/docs/', 'documentation', 'docusaurus', 'vitepress']
    return any(indicator in url.lower() for indicator in doc_indicators)

# Crawl a page
result = await strategy.crawl_single_page(
    url='https://docs.example.com/getting-started',
    transform_url_func=transform_url,
    is_documentation_site_func=is_documentation_site,
    retry_count=3
)

if result['success']:
    print(f"Successfully crawled: {result['title']}")
    print(f"Content length: {result['content_length']} characters")
    print(f"Found {len(result['links'])} links")
else:
    print(f"Failed to crawl: {result['error']}")
```

## Integration with Archon

This strategy is used by Archon's crawling service to:

1. **Crawl individual documentation pages** during sitemap/recursive crawls
2. **Handle direct URL submissions** from users
3. **Process text files** (llms.txt, README.md, etc.)
4. **Extract code examples** from documentation sites

The crawled content (markdown + HTML) is then:
- Chunked into manageable pieces
- Embedded using the embedding service
- Stored in Supabase for RAG (Retrieval Augmented Generation)
- Made searchable via the knowledge base

## Related Files

- `python/src/server/services/crawling/strategies/sitemap.py` - Sitemap crawling strategy
- `python/src/server/services/crawling/strategies/recursive.py` - Recursive crawling strategy
- `python/src/server/services/crawling/crawler_manager.py` - Crawler lifecycle management
- `python/src/server/services/crawling/orchestrator.py` - Orchestrates all crawling strategies

