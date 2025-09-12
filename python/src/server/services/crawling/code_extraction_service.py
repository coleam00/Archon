"""
Code Extraction Service

Handles extraction, processing, and storage of code examples from documents.
"""

import asyncio
import re
from collections.abc import Callable
from typing import Any

from ...config.logfire_config import safe_logfire_error, safe_logfire_info
from ...services.credential_service import credential_service
from ..storage.code_storage_service import (
    add_code_examples_to_supabase,
    generate_code_summaries_batch,
)


class CodeExtractionService:
    """
    Service for extracting and processing code examples from documents.
    """

    # Language-specific patterns for better extraction
    LANGUAGE_PATTERNS = {
        "typescript": {
            "block_start": r"^\s*(export\s+)?(class|interface|function|const|type|enum)\s+\w+",
            "block_end": r"^\}(\s*;)?$",
            "min_indicators": [":", "{", "}", "=>", "function", "class", "interface", "type"],
        },
        "javascript": {
            "block_start": r"^\s*(export\s+)?(class|function|const|let|var)\s+\w+",
            "block_end": r"^\}(\s*;)?$",
            "min_indicators": ["function", "{", "}", "=>", "const", "let", "var"],
        },
        "python": {
            "block_start": r"^\s*(class|def|async\s+def)\s+\w+",
            "block_end": r"^\S",  # Unindented line
            "min_indicators": ["def", ":", "return", "self", "import", "class"],
        },
        "java": {
            "block_start": r"^\s*(public|private|protected)?\s*(class|interface|enum)\s+\w+",
            "block_end": r"^\}$",
            "min_indicators": ["class", "public", "private", "{", "}", ";"],
        },
        "rust": {
            "block_start": r"^\s*(pub\s+)?(fn|struct|impl|trait|enum)\s+\w+",
            "block_end": r"^\}$",
            "min_indicators": ["fn", "let", "mut", "impl", "struct", "->"],
        },
        "go": {
            "block_start": r"^\s*(func|type|struct)\s+\w+",
            "block_end": r"^\}$",
            "min_indicators": ["func", "type", "struct", "{", "}", ":="],
        },
    }

    def __init__(self, supabase_client):
        """
        Initialize the code extraction service.

        Args:
            supabase_client: The Supabase client for database operations
        """
        self.supabase_client = supabase_client
        self._settings_cache = {}

    async def _get_setting(self, key: str, default: Any) -> Any:
        """Get a setting from credential service with caching."""
        if key in self._settings_cache:
            return self._settings_cache[key]

        try:
            value = await credential_service.get_credential(key, default)
            # Convert string values to appropriate types
            if isinstance(default, bool):
                value = str(value).lower() == "true" if value is not None else default
            elif isinstance(default, int):
                value = int(value) if value is not None else default
            elif isinstance(default, float):
                value = float(value) if value is not None else default
            self._settings_cache[key] = value
            return value
        except Exception as e:
            safe_logfire_error(f"Error getting setting {key}: {e}, using default: {default}")
            # Make sure we return the default value with correct type
            self._settings_cache[key] = default
            return default

    async def _get_min_code_length(self) -> int:
        """Get minimum code block length setting."""
        return await self._get_setting("MIN_CODE_BLOCK_LENGTH", 250)

    async def _get_max_code_length(self) -> int:
        """Get maximum code block length setting."""
        return await self._get_setting("MAX_CODE_BLOCK_LENGTH", 5000)

    async def _is_complete_block_detection_enabled(self) -> bool:
        """Check if complete block detection is enabled."""
        return await self._get_setting("ENABLE_COMPLETE_BLOCK_DETECTION", True)

    async def _is_language_patterns_enabled(self) -> bool:
        """Check if language-specific patterns are enabled."""
        return await self._get_setting("ENABLE_LANGUAGE_SPECIFIC_PATTERNS", True)

    async def _is_prose_filtering_enabled(self) -> bool:
        """Check if prose filtering is enabled."""
        return await self._get_setting("ENABLE_PROSE_FILTERING", True)

    async def _get_max_prose_ratio(self) -> float:
        """Get maximum allowed prose ratio."""
        return await self._get_setting("MAX_PROSE_RATIO", 0.15)

    async def _get_min_code_indicators(self) -> int:
        """Get minimum required code indicators."""
        return await self._get_setting("MIN_CODE_INDICATORS", 3)

    async def _is_diagram_filtering_enabled(self) -> bool:
        """Check if diagram filtering is enabled."""
        return await self._get_setting("ENABLE_DIAGRAM_FILTERING", True)

    async def _is_contextual_length_enabled(self) -> bool:
        """Check if contextual length adjustment is enabled."""
        return await self._get_setting("ENABLE_CONTEXTUAL_LENGTH", True)

    async def _get_context_window_size(self) -> int:
        """Get context window size for code blocks."""
        return await self._get_setting("CONTEXT_WINDOW_SIZE", 1000)

    async def _is_code_summaries_enabled(self) -> bool:
        """Check if code summaries generation is enabled."""
        return await self._get_setting("ENABLE_CODE_SUMMARIES", True)

    async def extract_and_store_code_examples(
        self,
        crawl_results: list[dict[str, Any]],
        url_to_full_document: dict[str, str],
        source_id: str,
        progress_callback: Callable | None = None,
        cancellation_check: Callable[[], None] | None = None,
    ) -> int:
        """
        Extract code examples from crawled documents and store them.

        Args:
            crawl_results: List of crawled documents with url and markdown content
            url_to_full_document: Mapping of URLs to full document content
            source_id: The unique source_id for all documents
            progress_callback: Optional async callback for progress updates
            cancellation_check: Optional function to check for cancellation

        Returns:
            Number of code examples stored
        """
        # Phase 1: Extract code blocks (0-20% of overall code_extraction progress)
        extraction_callback = None
        if progress_callback:
            async def extraction_progress(data: dict):
                # Scale progress to 0-20% range
                raw_progress = data.get("progress", 0)
                scaled_progress = int(raw_progress * 0.2)  # 0-20%
                data["progress"] = scaled_progress
                await progress_callback(data)
            extraction_callback = extraction_progress

        # Extract code blocks from all documents
        all_code_blocks = await self._extract_code_blocks_from_documents(
            crawl_results, source_id, extraction_callback, cancellation_check
        )

        if not all_code_blocks:
            safe_logfire_info("No code examples found in any crawled documents")
            # Still report completion when no code examples found
            if progress_callback:
                await progress_callback({
                    "status": "code_extraction",
                    "progress": 100,
                    "log": "No code examples found to extract",
                    "code_blocks_found": 0,
                    "completed_documents": len(crawl_results),
                    "total_documents": len(crawl_results),
                })
            return 0

        # Log what we found
        safe_logfire_info(f"Found {len(all_code_blocks)} total code blocks to process")
        for i, block_data in enumerate(all_code_blocks[:3]):
            block = block_data["block"]
            safe_logfire_info(
                f"Sample code block {i + 1} | language={block.get('language', 'none')} | code_length={len(block.get('code', ''))}"
            )

        # Phase 2: Generate summaries (20-90% of overall progress - this is the slowest part!)
        summary_callback = None
        if progress_callback:
            async def summary_progress(data: dict):
                # Scale progress to 20-90% range
                raw_progress = data.get("progress", 0)
                scaled_progress = 20 + int(raw_progress * 0.7)  # 20-90%
                data["progress"] = scaled_progress
                await progress_callback(data)
            summary_callback = summary_progress

        # Generate summaries for code blocks
        summary_results = await self._generate_code_summaries(
            all_code_blocks, summary_callback, cancellation_check
        )

        # Prepare code examples for storage
        storage_data = self._prepare_code_examples_for_storage(all_code_blocks, summary_results)

        # Phase 3: Store in database (90-100% of overall progress)
        storage_callback = None
        if progress_callback:
            async def storage_progress(data: dict):
                # Scale progress to 90-100% range
                raw_progress = data.get("progress", 0)
                scaled_progress = 90 + int(raw_progress * 0.1)  # 90-100%
                data["progress"] = scaled_progress
                await progress_callback(data)
            storage_callback = storage_progress

        # Store code examples in database
        return await self._store_code_examples(
            storage_data, url_to_full_document, storage_callback
        )

    async def _extract_code_blocks_from_documents(
        self,
        crawl_results: list[dict[str, Any]],
        source_id: str,
        progress_callback: Callable | None = None,
        cancellation_check: Callable[[], None] | None = None,
    ) -> list[dict[str, Any]]:
        """
        Extract code blocks from all documents.

        Args:
            crawl_results: List of crawled documents
            source_id: The unique source_id for all documents

        Returns:
            List of code blocks with metadata
        """
        # Progress will be reported during the loop below

        all_code_blocks = []
        total_docs = len(crawl_results)
        completed_docs = 0

        for doc in crawl_results:
            # Check for cancellation before processing each document
            if cancellation_check:
                try:
                    cancellation_check()
                except asyncio.CancelledError:
                    if progress_callback:
                        await progress_callback({
                            "status": "cancelled",
                            "progress": 99,
                            "message": f"Code extraction cancelled at document {completed_docs + 1}/{total_docs}"
                        })
                    raise

            try:
                source_url = doc["url"]
                html_content = doc.get("html", "")
                md = doc.get("markdown", "")

                # Debug logging
                safe_logfire_info(
                    f"Document content check | url={source_url} | has_html={bool(html_content)} | has_markdown={bool(md)} | html_len={len(html_content) if html_content else 0} | md_len={len(md) if md else 0}"
                )

                # Get dynamic minimum length based on document context

                # Check markdown first to see if it has code blocks
                if md:
                    has_backticks = "```" in md
                    backtick_count = md.count("```")
                    safe_logfire_info(
                        f"Markdown check | url={source_url} | has_backticks={has_backticks} | backtick_count={backtick_count}"
                    )

                    if "getting-started" in source_url and md:
                        # Log a sample of the markdown
                        sample = md[:500]
                        safe_logfire_info(f"Markdown sample for getting-started: {sample}...")

                # Improved extraction logic - check for text files first, then HTML, then markdown
                code_blocks = []

                # Check if this is a text file (e.g., .txt, .md)
                is_text_file = source_url.endswith((
                    ".txt",
                    ".text",
                    ".md",
                )) or "text/plain" in doc.get("content_type", "")

                if is_text_file:
                    # For text files, use specialized text extraction
                    safe_logfire_info(f"🎯 TEXT FILE DETECTED | url={source_url}")
                    safe_logfire_info(
                        f"📊 Content types - has_html={bool(html_content)}, has_md={bool(md)}"
                    )
                    # For text files, the HTML content should be the raw text (not wrapped in <pre>)
                    text_content = html_content if html_content else md
                    if text_content:
                        safe_logfire_info(
                            f"📝 Using {'HTML' if html_content else 'MARKDOWN'} content for text extraction"
                        )
                        safe_logfire_info(
                            f"🔍 Content preview (first 500 chars): {repr(text_content[:500])}..."
                        )
                        code_blocks = await self._extract_text_file_code_blocks(
                            text_content, source_url
                        )
                        safe_logfire_info(
                            f"📦 Text extraction complete | found={len(code_blocks)} blocks | url={source_url}"
                        )
                    else:
                        safe_logfire_info(f"⚠️ NO CONTENT for text file | url={source_url}")

                # If not a text file or no code blocks found, try HTML extraction first
                if len(code_blocks) == 0 and html_content and not is_text_file:
                    safe_logfire_info(
                        f"Trying HTML extraction first | url={source_url} | html_length={len(html_content)}"
                    )
                    html_code_blocks = await self._extract_html_code_blocks(html_content)
                    if html_code_blocks:
                        code_blocks = html_code_blocks
                        safe_logfire_info(
                            f"Found {len(code_blocks)} code blocks from HTML | url={source_url}"
                        )

                # If still no code blocks, try markdown extraction as fallback
                if len(code_blocks) == 0 and md and "```" in md:
                    safe_logfire_info(
                        f"No code blocks from HTML, trying markdown extraction | url={source_url}"
                    )
                    from ..storage.code_storage_service import extract_code_blocks

                    # Use dynamic minimum for markdown extraction
                    base_min_length = 250  # Default for markdown
                    code_blocks = extract_code_blocks(md, min_length=base_min_length)
                    safe_logfire_info(
                        f"Found {len(code_blocks)} code blocks from markdown | url={source_url}"
                    )

                if code_blocks:
                    # Use the provided source_id for all code blocks
                    for block in code_blocks:
                        all_code_blocks.append({
                            "block": block,
                            "source_url": source_url,
                            "source_id": source_id,
                        })

                # Update progress only after completing document extraction
                completed_docs += 1
                if progress_callback and total_docs > 0:
                    # Report raw progress (0-100) for this extraction phase
                    raw_progress = int((completed_docs / total_docs) * 100)
                    await progress_callback({
                        "status": "code_extraction",
                        "progress": raw_progress,
                        "log": f"Extracted code from {completed_docs}/{total_docs} documents ({len(all_code_blocks)} code blocks found)",
                        "completed_documents": completed_docs,
                        "total_documents": total_docs,
                        "code_blocks_found": len(all_code_blocks),
                    })

            except Exception as e:
                safe_logfire_error(
                    f"Error processing code from document | url={doc.get('url')} | error={str(e)}"
                )

        return all_code_blocks

    async def _extract_html_code_blocks(self, content: str) -> list[dict[str, Any]]:
        """
        Extract code blocks from HTML patterns in content.
        This is a fallback when markdown conversion didn't preserve code blocks.

        Args:
            content: The content to search for HTML code patterns
            min_length: Minimum length for code blocks

        Returns:
            List of code blocks with metadata
        """
        import re

        # Add detailed logging
        safe_logfire_info(f"Processing HTML of length {len(content)} for code extraction")

        # Check if we have actual content
        if len(content) < 1000:
            safe_logfire_info(
                f"Warning: HTML content seems too short, first 500 chars: {repr(content[:500])}"
            )

        # Look for specific indicators of code blocks
        has_prism = "prism" in content.lower()
        has_highlight = "highlight" in content.lower()
        has_shiki = "shiki" in content.lower()
        has_codemirror = "codemirror" in content.lower() or "cm-" in content
        safe_logfire_info(
            f"Code library indicators | prism={has_prism} | highlight={has_highlight} | shiki={has_shiki} | codemirror={has_codemirror}"
        )

        # Check for any pre tags with different attributes
        pre_matches = re.findall(r"<pre[^>]*>", content[:5000], re.IGNORECASE)
        if pre_matches:
            safe_logfire_info(f"Found {len(pre_matches)} <pre> tags in first 5000 chars")
            for i, pre_tag in enumerate(pre_matches[:3]):  # Show first 3
                safe_logfire_info(f"Pre tag {i + 1}: {pre_tag}")

        code_blocks = []
        extracted_positions = set()  # Track already extracted code block positions

        # Comprehensive patterns for various code block formats
        # Order matters - more specific patterns first
        patterns = [
            # GitHub/GitLab patterns
            (
                r'<div[^>]*class=["\'][^"\']*highlight[^"\']*["\'][^>]*>.*?<pre[^>]*class=["\'][^"\']*(?:language-)?(\w+)[^"\']*["\'][^>]*><code[^>]*>(.*?)</code></pre>',
                "github-highlight",
            ),
            (
                r'<div[^>]*class=["\'][^"\']*snippet-clipboard-content[^"\']*["\'][^>]*>.*?<pre[^>]*><code[^>]*>(.*?)</code></pre>',
                "github-snippet",
            ),
            # Docusaurus patterns
            (
                r'<div[^>]*class=["\'][^"\']*codeBlockContainer[^"\']*["\'][^>]*>.*?<pre[^>]*class=["\'][^"\']*prism-code[^"\']*language-(\w+)[^"\']*["\'][^>]*>(.*?)</pre>',
                "docusaurus",
            ),
            (
                r'<div[^>]*class=["\'][^"\']*language-(\w+)[^"\']*["\'][^>]*>.*?<pre[^>]*class=["\'][^"\']*prism-code[^"\']*["\'][^>]*>(.*?)</pre>',
                "docusaurus-alt",
            ),
            # Milkdown specific patterns - check their actual HTML structure
            (
                r'<pre[^>]*><code[^>]*class=["\'][^"\']*language-(\w+)[^"\']*["\'][^>]*>(.*?)</code></pre>',
                "milkdown-typed",
            ),
            (
                r'<div[^>]*class=["\'][^"\']*code-wrapper[^"\']*["\'][^>]*>.*?<pre[^>]*>(.*?)</pre>',
                "milkdown-wrapper",
            ),
            (
                r'<div[^>]*class=["\'][^"\']*code-block-wrapper[^"\']*["\'][^>]*>.*?<pre[^>]*><code[^>]*>(.*?)</code></pre>',
                "milkdown-wrapper-code",
            ),
            (
                r'<div[^>]*class=["\'][^"\']*milkdown-code-block[^"\']*["\'][^>]*>.*?<pre[^>]*><code[^>]*>(.*?)</code></pre>',
                "milkdown-code-block",
            ),
            (
                r'<pre[^>]*class=["\'][^"\']*code-block[^"\']*["\'][^>]*><code[^>]*>(.*?)</code></pre>',
                "milkdown",
            ),
            (r"<div[^>]*data-code-block[^>]*>.*?<pre[^>]*>(.*?)</pre>", "milkdown-alt"),
            (
                r'<div[^>]*class=["\'][^"\']*milkdown[^"\']*["\'][^>]*>.*?<pre[^>]*><code[^>]*>(.*?)</code></pre>',
                "milkdown-div",
            ),
            # Monaco Editor - capture all view-lines content
            (
                r'<div[^>]*class=["\'][^"\']*monaco-editor[^"\']*["\'][^>]*>.*?<div[^>]*class=["\'][^"\']*view-lines[^"\']*[^>]*>(.*?)</div>(?=.*?</div>.*?</div>)',
                "monaco",
            ),
            # CodeMirror patterns
            (
                r'<div[^>]*class=["\'][^"\']*cm-content[^"\']*["\'][^>]*>((?:<div[^>]*class=["\'][^"\']*cm-line[^"\']*["\'][^>]*>.*?</div>\s*)+)</div>',
                "codemirror",
            ),
            (
                r'<div[^>]*class=["\'][^"\']*CodeMirror[^"\']*["\'][^>]*>.*?<div[^>]*class=["\'][^"\']*CodeMirror-code[^"\']*["\'][^>]*>(.*?)</div>',
                "codemirror-legacy",
            ),
            # Prism.js with language - must be before generic pre
            (
                r'<pre[^>]*class=["\'][^"\']*language-(\w+)[^"\']*["\'][^>]*>\s*<code[^>]*>(.*?)</code>\s*</pre>',
                "prism",
            ),
            (
                r'<pre[^>]*>\s*<code[^>]*class=["\'][^"\']*language-(\w+)[^"\']*["\'][^>]*>(.*?)</code>\s*</pre>',
                "prism-alt",
            ),
            # highlight.js - must be before generic pre/code
            (
                r'<pre[^>]*><code[^>]*class=["\'][^"\']*hljs(?:\s+language-(\w+))?[^"\']*["\'][^>]*>(.*?)</code></pre>',
                "hljs",
            ),
            (
                r'<pre[^>]*class=["\'][^"\']*hljs[^"\']*["\'][^>]*><code[^>]*>(.*?)</code></pre>',
                "hljs-pre",
            ),
            # Shiki patterns (VitePress, Astro, etc.)
            (
                r'<pre[^>]*class=["\'][^"\']*shiki[^"\']*["\'][^>]*(?:.*?style=["\'][^"\']*background-color[^"\']*["\'])?[^>]*>\s*<code[^>]*>(.*?)</code>\s*</pre>',
                "shiki",
            ),
            (r'<pre[^>]*class=["\'][^"\']*astro-code[^"\']*["\'][^>]*>(.*?)</pre>', "astro-shiki"),
            (
                r'<div[^>]*class=["\'][^"\']*astro-code[^"\']*["\'][^>]*>.*?<pre[^>]*>(.*?)</pre>',
                "astro-wrapper",
            ),
            # VitePress/Vue patterns
            (
                r'<div[^>]*class=["\'][^"\']*language-(\w+)[^"\']*["\'][^>]*>.*?<pre[^>]*>(.*?)</pre>',
                "vitepress",
            ),
            (
                r'<div[^>]*class=["\'][^"\']*vp-code[^"\']*["\'][^>]*>.*?<pre[^>]*>(.*?)</pre>',
                "vitepress-vp",
            ),
            # Nextra patterns
            (r"<div[^>]*data-nextra-code[^>]*>.*?<pre[^>]*>(.*?)</pre>", "nextra"),
            (
                r'<pre[^>]*class=["\'][^"\']*nx-[^"\']*["\'][^>]*><code[^>]*>(.*?)</code></pre>',
                "nextra-nx",
            ),
            # Standard pre/code patterns - should be near the end
            (
                r'<pre[^>]*><code[^>]*class=["\'][^"\']*language-(\w+)[^"\']*["\'][^>]*>(.*?)</code></pre>',
                "standard-lang",
            ),
            (r"<pre[^>]*>\s*<code[^>]*>(.*?)</code>\s*</pre>", "standard"),
            # Generic patterns - should be last
            (
                r'<div[^>]*class=["\'][^"\']*code-block[^"\']*["\'][^>]*>.*?<pre[^>]*>(.*?)</pre>',
                "generic-div",
            ),
            (
                r'<div[^>]*class=["\'][^"\']*codeblock[^"\']*["\'][^>]*>(.*?)</div>',
                "generic-codeblock",
            ),
            (
                r'<div[^>]*class=["\'][^"\']*highlight[^"\']*["\'][^>]*>.*?<pre[^>]*>(.*?)</pre>',
                "highlight",
            ),
        ]

        for pattern_tuple in patterns:
            pattern_str, source_type = pattern_tuple
            matches = list(re.finditer(pattern_str, content, re.DOTALL | re.IGNORECASE))

            # Log pattern matches for Milkdown patterns and CodeMirror
            if matches and (
                "milkdown" in source_type
                or "codemirror" in source_type
                or "milkdown" in content[:1000].lower()
            ):
                safe_logfire_info(f"Pattern {source_type} found {len(matches)} matches")

            for match in matches:
                # Extract code content based on pattern type
                if source_type in ["standard-lang", "prism", "vitepress", "hljs", "milkdown-typed"]:
                    # These patterns capture language in group 1, code in group 2
                    if match.lastindex and match.lastindex >= 2:
                        language = match.group(1)
                        code_content = match.group(2).strip()
                    else:
                        code_content = match.group(1).strip()
                        language = ""
                else:
                    # Most patterns have code in group 1
                    code_content = match.group(1).strip()
                    # Try to extract language from the full match
                    full_match = match.group(0)
                    lang_match = re.search(r'class=["\'].*?language-(\w+)', full_match)
                    language = lang_match.group(1) if lang_match else ""

                # Get the start position for complete block extraction
                code_start_pos = match.start()

                # For CodeMirror, extract text from cm-lines
                if source_type == "codemirror":
                    # Extract text from each cm-line div
                    cm_lines = re.findall(
                        r'<div[^>]*class=["\'][^"\']*cm-line[^"\']*["\'][^>]*>(.*?)</div>',
                        code_content,
                        re.DOTALL,
                    )
                    if cm_lines:
                        # Clean each line and join
                        cleaned_lines = []
                        for line in cm_lines:
                            # Remove span tags but keep content
                            line = re.sub(r"<span[^>]*>", "", line)
                            line = re.sub(r"</span>", "", line)
                            # Remove other HTML tags
                            line = re.sub(r"<[^>]+>", "", line)
                            cleaned_lines.append(line)
                        code_content = "\n".join(cleaned_lines)
                    else:
                        # Fallback: just clean HTML
                        code_content = re.sub(r"<span[^>]*>", "", code_content)
                        code_content = re.sub(r"</span>", "", code_content)
                        code_content = re.sub(r"<[^>]+>", "\n", code_content)

                # For Monaco, extract text from nested divs
                if source_type == "monaco":
                    # Extract actual code from Monaco's complex structure
                    code_content = re.sub(r"<div[^>]*>", "\n", code_content)
                    code_content = re.sub(r"</div>", "", code_content)
                    code_content = re.sub(r"<span[^>]*>", "", code_content)
                    code_content = re.sub(r"</span>", "", code_content)

                # Calculate dynamic minimum length
                context_for_length = content[max(0, code_start_pos - 500) : code_start_pos + 500]
                min_length = await self._calculate_min_length(language, context_for_length)

                # Skip if initial content is too short
                if len(code_content) < min_length:
                    # Try to find complete block if we have a language
                    if language and code_start_pos > 0:
                        # Look for complete code block
                        complete_code, block_end_pos = await self._find_complete_code_block(
                            content, code_start_pos, min_length, language
                        )
                        if len(complete_code) >= min_length:
                            code_content = complete_code
                            end_pos = block_end_pos
                        else:
                            continue
                    else:
                        continue

                # Extract position info for deduplication
                start_pos = match.start()
                end_pos = (
                    match.end()
                    if len(code_content) <= len(match.group(0))
                    else code_start_pos + len(code_content)
                )

                # Check if we've already extracted code from this position
                position_key = (start_pos, end_pos)
                overlapping = False
                for existing_start, existing_end in extracted_positions:
                    # Check if this match overlaps with an existing extraction
                    if not (end_pos <= existing_start or start_pos >= existing_end):
                        overlapping = True
                        break

                if not overlapping:
                    extracted_positions.add(position_key)

                    # Extract context
                    context_before = content[max(0, start_pos - 1000) : start_pos].strip()
                    context_after = content[end_pos : min(len(content), end_pos + 1000)].strip()

                    # Clean the code content
                    cleaned_code = self._clean_code_content(code_content, language)

                    # Validate code quality
                    if await self._validate_code_quality(cleaned_code, language):
                        # Log successful extraction
                        safe_logfire_info(
                            f"Extracted code block | source_type={source_type} | language={language} | min_length={min_length} | original_length={len(code_content)} | cleaned_length={len(cleaned_code)}"
                        )

                        code_blocks.append({
                            "code": cleaned_code,
                            "language": language,
                            "context_before": context_before,
                            "context_after": context_after,
                            "full_context": f"{context_before}\n\n{cleaned_code}\n\n{context_after}",
                            "source_type": source_type,  # Track which pattern matched
                        })
                    else:
                        safe_logfire_info(
                            f"Code block failed validation | source_type={source_type} | language={language} | length={len(cleaned_code)}"
                        )

        # Pattern 2: <code>...</code> (standalone)
        if not code_blocks:  # Only if we didn't find pre/code blocks
            code_pattern = r"<code[^>]*>(.*?)</code>"
            matches = re.finditer(code_pattern, content, re.DOTALL | re.IGNORECASE)

            for match in matches:
                code_content = match.group(1).strip()
                # Clean the code content
                cleaned_code = self._clean_code_content(code_content, "")

                # Check if it's multiline or substantial enough and validate quality
                # Use a minimal length for standalone code tags
                if len(cleaned_code) >= 100 and ("\n" in cleaned_code or len(cleaned_code) > 100):
                    if await self._validate_code_quality(cleaned_code, ""):
                        start_pos = match.start()
                        end_pos = match.end()
                        context_before = content[max(0, start_pos - 1000) : start_pos].strip()
                        context_after = content[end_pos : min(len(content), end_pos + 1000)].strip()

                        code_blocks.append({
                            "code": cleaned_code,
                            "language": "",
                            "context_before": context_before,
                            "context_after": context_after,
                            "full_context": f"{context_before}\n\n{cleaned_code}\n\n{context_after}",
                        })
                    else:
                        safe_logfire_info(
                            f"Standalone code block failed validation | length={len(cleaned_code)}"
                        )

        return code_blocks

    async def _extract_text_file_code_blocks(
        self, content: str, url: str, min_length: int | None = None
    ) -> list[dict[str, Any]]:
        """
        Extract code blocks from plain text files (like .txt files).
        Handles formats like llms.txt where code blocks may be indicated by:
        - Triple backticks (```)
        - Language indicators (e.g., "typescript", "python")
        - Indentation patterns
        - Code block separators

        Args:
            content: The plain text content
            url: The URL of the text file for context
            min_length: Minimum length for code blocks

        Returns:
            List of code blocks with metadata
        """
        import re

        safe_logfire_info(
            f"🔍 TEXT FILE EXTRACTION START | url={url} | content_length={len(content)}"
        )
        safe_logfire_info(f"📄 First 1000 chars: {repr(content[:1000])}...")
        safe_logfire_info(
            f"📄 Sample showing backticks: {repr(content[5000:6000])}..."
            if len(content) > 6000
            else "Content too short for mid-sample"
        )

        code_blocks = []

        # Method 1: Look for triple backtick code blocks (Markdown style)
        # Pattern allows for additional text after language (e.g., "typescript TypeScript")
        backtick_pattern = r"```(\w*)[^\n]*\n(.*?)```"
        matches = list(re.finditer(backtick_pattern, content, re.DOTALL | re.MULTILINE))
        safe_logfire_info(f"📊 Backtick pattern matches: {len(matches)}")

        for i, match in enumerate(matches):
            language = match.group(1) or ""
            code_content = match.group(2).strip()

            # Log match info without including the actual content that might break formatting
            safe_logfire_info(
                f"🔎 Match {i + 1}: language='{language}', raw_length={len(code_content)}"
            )

            # Get position info first
            start_pos = match.start()
            end_pos = match.end()

            # Calculate dynamic minimum length
            context_around = content[max(0, start_pos - 500) : min(len(content), end_pos + 500)]
            if min_length is None:
                actual_min_length = await self._calculate_min_length(language, context_around)
            else:
                actual_min_length = min_length

            if len(code_content) >= actual_min_length:
                # Get context
                context_before = content[max(0, start_pos - 500) : start_pos].strip()
                context_after = content[end_pos : min(len(content), end_pos + 500)].strip()

                # Clean and validate
                cleaned_code = self._clean_code_content(code_content, language)
                safe_logfire_info(f"🧹 After cleaning: length={len(cleaned_code)}")

                if await self._validate_code_quality(cleaned_code, language):
                    safe_logfire_info(
                        f"✅ VALID backtick code block | language={language} | length={len(cleaned_code)}"
                    )
                    code_blocks.append({
                        "code": cleaned_code,
                        "language": language,
                        "context_before": context_before,
                        "context_after": context_after,
                        "full_context": f"{context_before}\n\n{cleaned_code}\n\n{context_after}",
                        "source_type": "text_backticks",
                    })
                else:
                    safe_logfire_info(
                        f"❌ INVALID code block failed validation | language={language}"
                    )
            else:
                safe_logfire_info(
                    f"❌ Code block too short: {len(code_content)} < {actual_min_length}"
                )

        # Method 2: Look for language-labeled code blocks (e.g., "TypeScript:" or "Python example:")
        language_pattern = r"(?:^|\n)((?:typescript|javascript|python|java|c\+\+|rust|go|ruby|php|swift|kotlin|scala|r|matlab|julia|dart|elixir|erlang|haskell|clojure|lua|perl|shell|bash|sql|html|css|xml|json|yaml|toml|ini|dockerfile|makefile|cmake|gradle|maven|npm|yarn|pip|cargo|gem|pod|composer|nuget|apt|yum|brew|choco|snap|flatpak|appimage|msi|exe|dmg|pkg|deb|rpm|tar|zip|7z|rar|gz|bz2|xz|zst|lz4|lzo|lzma|lzip|lzop|compress|uncompress|gzip|gunzip|bzip2|bunzip2|xz|unxz|zstd|unzstd|lz4|unlz4|lzo|unlzo|lzma|unlzma|lzip|lunzip|lzop|unlzop)\s*(?:code|example|snippet)?)[:\s]*\n((?:(?:^[ \t]+.*\n?)+)|(?:.*\n)+?)(?=\n(?:[A-Z][a-z]+\s*:|^\s*$|\n#|\n\*|\n-|\n\d+\.))"
        matches = re.finditer(language_pattern, content, re.IGNORECASE | re.MULTILINE)

        for match in matches:
            language_info = match.group(1).lower()
            # Extract just the language name
            language = (
                re.match(r"(\w+)", language_info).group(1)
                if re.match(r"(\w+)", language_info)
                else ""
            )
            code_content = match.group(2).strip()

            # Calculate dynamic minimum length for language-labeled blocks
            if min_length is None:
                actual_min_length_lang = await self._calculate_min_length(
                    language, code_content[:500]
                )
            else:
                actual_min_length_lang = min_length

            if len(code_content) >= actual_min_length_lang:
                # Get context
                start_pos = match.start()
                end_pos = match.end()
                context_before = content[max(0, start_pos - 500) : start_pos].strip()
                context_after = content[end_pos : min(len(content), end_pos + 500)].strip()

                # Clean and validate
                cleaned_code = self._clean_code_content(code_content, language)
                if await self._validate_code_quality(cleaned_code, language):
                    safe_logfire_info(
                        f"Found language-labeled code block | language={language} | length={len(cleaned_code)}"
                    )
                    code_blocks.append({
                        "code": cleaned_code,
                        "language": language,
                        "context_before": context_before,
                        "context_after": context_after,
                        "full_context": f"{context_before}\n\n{cleaned_code}\n\n{context_after}",
                        "source_type": "text_language_label",
                    })

        # Method 3: Look for consistently indented blocks (at least 4 spaces or 1 tab)
        # This is more heuristic and should be used carefully
        if len(code_blocks) == 0:  # Only if we haven't found code blocks yet
            # Split content into potential code sections
            lines = content.split("\n")
            current_block = []
            current_indent = None
            block_start_idx = 0

            for i, line in enumerate(lines):
                # Check if line is indented
                stripped = line.lstrip()
                indent = len(line) - len(stripped)

                if indent >= 4 and stripped:  # At least 4 spaces and not empty
                    if current_indent is None:
                        current_indent = indent
                        block_start_idx = i
                    current_block.append(line)
                elif current_block and len("\n".join(current_block)) >= min_length:
                    # End of indented block, check if it's code
                    code_content = "\n".join(current_block)

                    # Try to detect language from content
                    language = self._detect_language_from_content(code_content)

                    # Get context
                    context_before_lines = lines[max(0, block_start_idx - 10) : block_start_idx]
                    context_after_lines = lines[i : min(len(lines), i + 10)]
                    context_before = "\n".join(context_before_lines).strip()
                    context_after = "\n".join(context_after_lines).strip()

                    # Clean and validate
                    cleaned_code = self._clean_code_content(code_content, language)
                    if await self._validate_code_quality(cleaned_code, language):
                        safe_logfire_info(
                            f"Found indented code block | language={language} | length={len(cleaned_code)}"
                        )
                        code_blocks.append({
                            "code": cleaned_code,
                            "language": language,
                            "context_before": context_before,
                            "context_after": context_after,
                            "full_context": f"{context_before}\n\n{cleaned_code}\n\n{context_after}",
                            "source_type": "text_indented",
                        })

                    # Reset for next block
                    current_block = []
                    current_indent = None
                else:
                    # Reset if not indented
                    if current_block and not stripped:
                        # Allow empty lines within code blocks
                        current_block.append(line)
                    else:
                        current_block = []
                        current_indent = None

        safe_logfire_info(
            f"📊 TEXT FILE EXTRACTION COMPLETE | total_blocks={len(code_blocks)} | url={url}"
        )
        for i, block in enumerate(code_blocks[:3]):  # Log first 3 blocks
            safe_logfire_info(
                f"📦 Block {i + 1} summary: language='{block.get('language', '')}', source_type='{block.get('source_type', '')}', length={len(block.get('code', ''))}"
            )
        return code_blocks

    def _detect_language_from_content(self, code: str) -> str:
        """
        Try to detect programming language from code content.
        This is a simple heuristic approach.
        """
        import re

        # Language detection patterns
        patterns = {
            "python": [
                r"\bdef\s+\w+\s*\(",
                r"\bclass\s+\w+",
                r"\bimport\s+\w+",
                r"\bfrom\s+\w+\s+import",
            ],
            "javascript": [
                r"\bfunction\s+\w+\s*\(",
                r"\bconst\s+\w+\s*=",
                r"\blet\s+\w+\s*=",
                r"\bvar\s+\w+\s*=",
            ],
            "typescript": [
                r"\binterface\s+\w+",
                r":\s*\w+\[\]",
                r"\btype\s+\w+\s*=",
                r"\bclass\s+\w+.*\{",
            ],
            "java": [
                r"\bpublic\s+class\s+\w+",
                r"\bprivate\s+\w+\s+\w+",
                r"\bpublic\s+static\s+void\s+main",
            ],
            "rust": [r"\bfn\s+\w+\s*\(", r"\blet\s+mut\s+\w+", r"\bimpl\s+\w+", r"\bstruct\s+\w+"],
            "go": [r"\bfunc\s+\w+\s*\(", r"\bpackage\s+\w+", r"\btype\s+\w+\s+struct"],
        }

        # Count matches for each language
        scores = {}
        for lang, lang_patterns in patterns.items():
            score = 0
            for pattern in lang_patterns:
                if re.search(pattern, code, re.MULTILINE):
                    score += 1
            if score > 0:
                scores[lang] = score

        # Return language with highest score
        if scores:
            return max(scores, key=scores.get)

        return ""

    async def _find_complete_code_block(
        self,
        content: str,
        start_pos: int,
        min_length: int = 250,
        language: str = "",
        max_length: int = None,
    ) -> tuple[str, int]:
        """
        Find a complete code block starting from a position, extending until we find a natural boundary.

        Args:
            content: The full content to search in
            start_pos: Starting position in the content
            min_length: Minimum length for the code block
            language: Detected language for language-specific patterns

        Returns:
            Tuple of (complete_code_block, end_position)
        """
        # Start with the minimum content
        if start_pos + min_length > len(content):
            return content[start_pos:], len(content)

        # Look for natural code boundaries
        boundary_patterns = [
            r"\n}\s*$",  # Closing brace at end of line
            r"\n}\s*;?\s*$",  # Closing brace with optional semicolon
            r"\n\)\s*;?\s*$",  # Closing parenthesis
            r"\n\s*$\n\s*$",  # Double newline (paragraph break)
            r"\n(?=class\s)",  # Before next class
            r"\n(?=function\s)",  # Before next function
            r"\n(?=def\s)",  # Before next Python function
            r"\n(?=export\s)",  # Before next export
            r"\n(?=const\s)",  # Before next const declaration
            r"\n(?=//)",  # Before comment block
            r"\n(?=#)",  # Before Python comment
            r"\n(?=\*)",  # Before JSDoc/comment
            r"\n(?=```)",  # Before next code block
        ]

        # Add language-specific patterns if available
        if language and language.lower() in self.LANGUAGE_PATTERNS:
            lang_patterns = self.LANGUAGE_PATTERNS[language.lower()]
            if "block_end" in lang_patterns:
                boundary_patterns.insert(0, lang_patterns["block_end"])

        # Extend until we find a boundary
        extended_pos = start_pos + min_length
        while extended_pos < len(content):
            # Check next 500 characters for a boundary
            lookahead_end = min(extended_pos + 500, len(content))
            lookahead = content[extended_pos:lookahead_end]

            for pattern in boundary_patterns:
                match = re.search(pattern, lookahead, re.MULTILINE)
                if match:
                    final_pos = extended_pos + match.end()
                    return content[start_pos:final_pos].rstrip(), final_pos

            # If no boundary found, extend by another chunk
            extended_pos += 100

            # Cap at maximum length
            if max_length is None:
                max_length = await self._get_max_code_length()
            if extended_pos - start_pos > max_length:
                break

        # Return what we have
        return content[start_pos:extended_pos].rstrip(), extended_pos

    async def _calculate_min_length(self, language: str, context: str) -> int:
        """
        Calculate appropriate minimum length based on language and context.

        Args:
            language: The detected programming language
            context: Surrounding context of the code

        Returns:
            Calculated minimum length
        """
        # Base lengths by language
        # Check if contextual length adjustment is enabled
        if not await self._is_contextual_length_enabled():
            # Return default minimum length
            return await self._get_min_code_length()

        # Base lengths by language
        base_lengths = {
            "json": 100,  # JSON can be short
            "yaml": 100,  # YAML too
            "xml": 100,  # XML structures
            "html": 150,  # HTML snippets
            "css": 150,  # CSS rules
            "sql": 150,  # SQL queries
            "python": 200,  # Python functions
            "javascript": 250,  # JavaScript typically longer
            "typescript": 250,  # TypeScript typically longer
            "java": 300,  # Java even more verbose
            "c++": 300,  # C++ similar to Java
            "cpp": 300,  # C++ alternative
            "c": 250,  # C slightly less verbose
            "rust": 250,  # Rust medium verbosity
            "go": 200,  # Go is concise
        }

        # Get default minimum from settings
        default_min = await self._get_min_code_length()
        min_length = base_lengths.get(language.lower(), default_min)

        # Adjust based on context clues
        context_lower = context.lower()
        if any(word in context_lower for word in ["example", "snippet", "sample", "demo"]):
            min_length = int(min_length * 0.7)  # Examples can be shorter
        elif any(word in context_lower for word in ["implementation", "complete", "full"]):
            min_length = int(min_length * 1.5)  # Full implementations should be longer
        elif any(word in context_lower for word in ["minimal", "simple", "basic"]):
            min_length = int(min_length * 0.8)  # Simple examples can be shorter

        # Ensure reasonable bounds
        return max(100, min(1000, min_length))

    def _decode_html_entities(self, text: str) -> str:
        """Decode common HTML entities and clean HTML tags from code."""
        import re

        # First, handle span tags that wrap individual tokens
        # Check if spans are being used for syntax highlighting (no spaces between tags)
        if "</span><span" in text:
            # This indicates syntax highlighting - preserve the structure
            text = re.sub(r"</span>", "", text)
            text = re.sub(r"<span[^>]*>", "", text)
        else:
            # Normal span usage - might need spacing
            # Only add space if there isn't already whitespace
            text = re.sub(r"</span>(?=[A-Za-z0-9])", " ", text)
            text = re.sub(r"<span[^>]*>", "", text)

        # Remove any other HTML tags but preserve their content
        text = re.sub(r"</?[^>]+>", "", text)

        # Decode HTML entities
        replacements = {
            "&lt;": "<",
            "&gt;": ">",
            "&amp;": "&",
            "&quot;": '"',
            "&#39;": "'",
            "&nbsp;": " ",
            "&#x27;": "'",
            "&#x2F;": "/",
            "&#60;": "<",
            "&#62;": ">",
        }

        for entity, char in replacements.items():
            text = text.replace(entity, char)

        # Replace escaped newlines with actual newlines
        text = text.replace("\\n", "\n")

        # Clean up excessive whitespace while preserving intentional spacing
        # Replace multiple spaces with single space, but preserve newlines
        lines = text.split("\n")
        cleaned_lines = []
        for line in lines:
            # Replace multiple spaces with single space
            line = re.sub(r" +", " ", line)
            # Trim trailing spaces but preserve leading spaces (indentation)
            line = line.rstrip()
            cleaned_lines.append(line)

        text = "\n".join(cleaned_lines)

        return text

    def _clean_code_content(self, code: str, language: str = "") -> str:
        """
        Clean and fix common issues in extracted code content.

        Args:
            code: The code content to clean
            language: The detected language (optional)

        Returns:
            Cleaned code content
        """
        import re

        # First apply HTML entity decoding and tag cleaning
        code = self._decode_html_entities(code)

        # Fix common concatenation issues from span removal
        # Common patterns where spaces are missing between keywords
        spacing_fixes = [
            # Import statements
            (r"(\b(?:from|import|as)\b)([A-Za-z])", r"\1 \2"),
            # Function/class definitions
            (r"(\b(?:def|class|async|await|return|raise|yield)\b)([A-Za-z])", r"\1 \2"),
            # Control flow
            (r"(\b(?:if|elif|else|for|while|try|except|finally|with)\b)([A-Za-z])", r"\1 \2"),
            # Type hints and declarations
            (
                r"(\b(?:int|str|float|bool|list|dict|tuple|set|None|True|False)\b)([A-Za-z])",
                r"\1 \2",
            ),
            # Common Python keywords
            (r"(\b(?:and|or|not|in|is|lambda)\b)([A-Za-z])", r"\1 \2"),
            # Fix missing spaces around operators (but be careful with negative numbers)
            (r"([A-Za-z_)])(\+|-|\*|/|=|<|>|%)", r"\1 \2"),
            (r"(\+|-|\*|/|=|<|>|%)([A-Za-z_(])", r"\1 \2"),
        ]

        for pattern, replacement in spacing_fixes:
            code = re.sub(pattern, replacement, code)

        # Fix specific patterns for different languages
        if language.lower() in ["python", "py"]:
            # Fix Python-specific issues
            code = re.sub(r"(\b(?:from|import)\b)(\w+)(\b(?:import)\b)", r"\1 \2 \3", code)
            # Fix missing colons
            code = re.sub(
                r"(\b(?:def|class|if|elif|else|for|while|try|except|finally|with)\b[^:]+)$",
                r"\1:",
                code,
                flags=re.MULTILINE,
            )

        # Remove backticks that might have been included
        if code.startswith("```") and code.endswith("```"):
            lines = code.split("\n")
            if len(lines) > 2:
                # Remove first and last line
                code = "\n".join(lines[1:-1])
        elif code.startswith("`") and code.endswith("`"):
            code = code[1:-1]

        # Final cleanup
        # Remove any remaining excessive spaces while preserving indentation
        lines = code.split("\n")
        cleaned_lines = []
        for line in lines:
            # Don't touch leading whitespace (indentation)
            stripped = line.lstrip()
            indent = line[: len(line) - len(stripped)]
            # Clean the rest of the line
            cleaned = re.sub(r" {2,}", " ", stripped)
            cleaned_lines.append(indent + cleaned)

        return "\n".join(cleaned_lines).strip()

    async def _validate_code_quality(self, code: str, language: str = "") -> bool:
        """
        Enhanced validation to ensure extracted content is actual code.

        Args:
            code: The code content to validate
            language: The detected language (optional)

        Returns:
            True if code passes quality checks, False otherwise
        """
        import re

        # Basic checks
        if not code or len(code.strip()) < 20:
            return False

        # Skip diagram languages if filtering is enabled
        if await self._is_diagram_filtering_enabled():
            if language.lower() in ["mermaid", "plantuml", "graphviz", "dot", "diagram"]:
                safe_logfire_info(f"Skipping diagram language: {language}")
                return False

        # Check for common formatting issues that indicate poor extraction
        bad_patterns = [
            # Concatenated keywords without spaces (but allow camelCase)
            r"\b(from|import|def|class|if|for|while|return)(?=[a-z])",
            # HTML entities that weren't decoded
            r"&[lg]t;|&amp;|&quot;|&#\d+;",
            # Excessive HTML tags
            r"<[^>]{50,}>",  # Very long HTML tags
            # Multiple spans in a row (indicates poor extraction)
            r"(<span[^>]*>){5,}",
            # Suspicious character sequences
            r"[^\s]{200,}",  # Very long unbroken strings (increased threshold)
        ]

        for pattern in bad_patterns:
            if re.search(pattern, code):
                safe_logfire_info(f"Code failed quality check: pattern '{pattern}' found")
                return False

        # Check for minimum code complexity using various indicators
        code_indicators = {
            "function_calls": r"\w+\s*\([^)]*\)",
            "assignments": r"\w+\s*=\s*.+",
            "control_flow": r"\b(if|for|while|switch|case|try|catch|except)\b",
            "declarations": r"\b(var|let|const|def|class|function|interface|type|struct|enum)\b",
            "imports": r"\b(import|from|require|include|using|use)\b",
            "brackets": r"[\{\}\[\]]",
            "operators": r"[\+\-\*\/\%\&\|\^<>=!]",
            "method_chains": r"\.\w+",
            "arrows": r"(=>|->)",
            "keywords": r"\b(return|break|continue|yield|await|async)\b",
        }

        indicator_count = 0
        indicator_details = []
        for name, pattern in code_indicators.items():
            if re.search(pattern, code):
                indicator_count += 1
                indicator_details.append(name)

        # Require minimum code indicators
        min_indicators = await self._get_min_code_indicators()
        if indicator_count < min_indicators:
            safe_logfire_info(
                f"Code has insufficient indicators: {indicator_count} found ({', '.join(indicator_details)})"
            )
            return False

        # Check code-to-comment ratio
        lines = code.split("\n")
        non_empty_lines = [line for line in lines if line.strip()]

        if not non_empty_lines:
            return False

        # Count comment lines (various comment styles)
        comment_patterns = [
            r"^\s*(//|#|/\*|\*|<!--)",  # Single line comments
            r'^\s*"""',  # Python docstrings
            r"^\s*'''",  # Python docstrings alt
            r"^\s*\*\s",  # JSDoc style
        ]

        comment_lines = 0
        for line in lines:
            for pattern in comment_patterns:
                if re.match(pattern, line.strip()):
                    comment_lines += 1
                    break

        # Allow up to 70% comments (documentation is important)
        if non_empty_lines and comment_lines / len(non_empty_lines) > 0.7:
            safe_logfire_info(
                f"Code is mostly comments: {comment_lines}/{len(non_empty_lines)} lines"
            )
            return False

        # Language-specific validation
        if language.lower() in self.LANGUAGE_PATTERNS:
            lang_info = self.LANGUAGE_PATTERNS[language.lower()]
            min_indicators = lang_info.get("min_indicators", [])

            # Check for language-specific indicators
            found_lang_indicators = sum(
                1 for indicator in min_indicators if indicator in code.lower()
            )

            if found_lang_indicators < 2:  # Need at least 2 language-specific indicators
                safe_logfire_info(
                    f"Code lacks {language} indicators: only {found_lang_indicators} found"
                )
                return False

        # Check for reasonable structure
        # Too few meaningful lines
        if len(non_empty_lines) < 3:
            safe_logfire_info(f"Code has too few non-empty lines: {len(non_empty_lines)}")
            return False

        # Check for reasonable line lengths
        very_long_lines = sum(1 for line in lines if len(line) > 300)
        if len(lines) > 0 and very_long_lines > len(lines) * 0.5:
            safe_logfire_info("Code has too many very long lines")
            return False

        # Check if it's mostly prose/documentation
        prose_indicators = [
            r"\b(the|this|that|these|those|is|are|was|were|will|would|should|could|have|has|had)\b",
            r"[.!?]\s+[A-Z]",  # Sentence endings followed by capital letter
            r"\b(however|therefore|furthermore|moreover|nevertheless)\b",
        ]

        prose_score = 0
        word_count = len(code.split())
        for pattern in prose_indicators:
            matches = len(re.findall(pattern, code, re.IGNORECASE))
            prose_score += matches

        # Check prose filtering
        if await self._is_prose_filtering_enabled():
            max_prose_ratio = await self._get_max_prose_ratio()
            if word_count > 0 and prose_score / word_count > max_prose_ratio:
                safe_logfire_info(
                    f"Code appears to be prose: prose_score={prose_score}, word_count={word_count}"
                )
                return False

        # Passed all checks
        safe_logfire_info(
            f"Code passed validation: indicators={indicator_count}, language={language}, lines={len(non_empty_lines)}"
        )
        return True

    async def _generate_code_summaries(
        self,
        all_code_blocks: list[dict[str, Any]],
        progress_callback: Callable | None = None,
        cancellation_check: Callable[[], None] | None = None,
    ) -> list[dict[str, str]]:
        """
        Generate summaries for all code blocks.

        Returns:
            List of summary results
        """
        # Check if code summaries are enabled
        if not await self._is_code_summaries_enabled():
            safe_logfire_info("Code summaries generation is disabled, returning default summaries")
            # Return default summaries for all code blocks
            default_summaries = []
            for item in all_code_blocks:
                block = item["block"]
                language = block.get("language", "")
                default_summaries.append({
                    "example_name": f"Code Example{f' ({language})' if language else ''}",
                    "summary": "Code example for demonstration purposes.",
                })

            # Report progress for skipped summaries
            if progress_callback:
                await progress_callback({
                    "status": "code_extraction",
                    "progress": 100,
                    "log": f"Skipped AI summary generation (disabled). Using default summaries for {len(all_code_blocks)} code blocks.",
                })

            return default_summaries

        # Progress is handled by generate_code_summaries_batch

        # Use default max workers
        max_workers = 3

        # Extract just the code blocks for batch processing
        code_blocks_for_summaries = [item["block"] for item in all_code_blocks]

        # Generate summaries with progress tracking
        summary_progress_callback = None
        if progress_callback:
            # Create a wrapper that ensures correct status
            async def wrapped_callback(data: dict):
                # Check for cancellation during summary generation
                if cancellation_check:
                    try:
                        cancellation_check()
                    except asyncio.CancelledError:
                        # Update data to show cancellation and re-raise
                        data["status"] = "cancelled"
                        data["progress"] = 99
                        data["message"] = "Code summary generation cancelled"
                        await progress_callback(data)
                        raise

                # Ensure status is code_extraction
                data["status"] = "code_extraction"
                # Pass through the raw progress (0-100)
                await progress_callback(data)

            summary_progress_callback = wrapped_callback

        try:
            results = await generate_code_summaries_batch(
                code_blocks_for_summaries, max_workers, progress_callback=summary_progress_callback
            )

            # Ensure all results are valid dicts
            validated_results = []
            for result in results:
                if isinstance(result, dict):
                    validated_results.append(result)
                else:
                    # Handle non-dict results (CancelledError, etc.)
                    validated_results.append({
                        "example_name": "Code Example",
                        "summary": "Code example for demonstration purposes."
                    })

            return validated_results
        except asyncio.CancelledError:
            # Let the caller handle cancellation (upstream emits the cancel progress)
            raise

    def _prepare_code_examples_for_storage(
        self, all_code_blocks: list[dict[str, Any]], summary_results: list[dict[str, str]]
    ) -> dict[str, list[Any]]:
        """
        Prepare code examples for storage by organizing data into arrays.

        Returns:
            Dictionary with arrays for storage
        """
        code_urls = []
        code_chunk_numbers = []
        code_examples = []
        code_summaries = []
        code_metadatas = []

        for code_item, summary_result in zip(all_code_blocks, summary_results, strict=False):
            block = code_item["block"]
            source_url = code_item["source_url"]
            source_id = code_item["source_id"]

            # Handle cancellation errors or invalid summary results
            if isinstance(summary_result, dict):
                summary = summary_result.get("summary", "Code example for demonstration purposes.")
                example_name = summary_result.get("example_name", "Code Example")
            else:
                # Handle CancelledError or other non-dict results
                summary = "Code example for demonstration purposes."
                example_name = "Code Example"

            code_urls.append(source_url)
            code_chunk_numbers.append(len(code_examples))
            code_examples.append(block["code"])
            code_summaries.append(summary)

            code_meta = {
                "chunk_index": len(code_examples) - 1,
                "url": source_url,
                "source": source_id,
                "source_id": source_id,
                "language": block.get("language", ""),
                "char_count": len(block["code"]),
                "word_count": len(block["code"].split()),
                "example_name": example_name,
                "title": example_name,
            }
            code_metadatas.append(code_meta)

        return {
            "urls": code_urls,
            "chunk_numbers": code_chunk_numbers,
            "examples": code_examples,
            "summaries": code_summaries,
            "metadatas": code_metadatas,
        }

    async def _store_code_examples(
        self,
        storage_data: dict[str, list[Any]],
        url_to_full_document: dict[str, str],
        progress_callback: Callable | None = None,
    ) -> int:
        """
        Store code examples in the database.

        Returns:
            Number of code examples stored
        """
        # Create progress callback for storage phase
        storage_progress_callback = None
        if progress_callback:

            async def storage_callback(data: dict):
                # Pass through the raw progress (0-100) with correct status
                update_data = {
                    "status": "code_extraction",  # Keep as code_extraction for consistency
                    "progress": data.get("progress", data.get("percentage", 0)),
                    "log": data.get("log", "Storing code examples..."),
                }

                # Pass through any additional batch info
                if "batch_number" in data:
                    update_data["batch_number"] = data["batch_number"]
                if "total_batches" in data:
                    update_data["total_batches"] = data["total_batches"]
                if "examples_stored" in data:
                    update_data["examples_stored"] = data["examples_stored"]

                await progress_callback(update_data)

            storage_progress_callback = storage_callback

        try:
            await add_code_examples_to_supabase(
                client=self.supabase_client,
                urls=storage_data["urls"],
                chunk_numbers=storage_data["chunk_numbers"],
                code_examples=storage_data["examples"],
                summaries=storage_data["summaries"],
                metadatas=storage_data["metadatas"],
                batch_size=20,
                url_to_full_document=url_to_full_document,
                progress_callback=storage_progress_callback,
                provider=None,  # Use configured provider
            )

            # Report completion of code extraction/storage phase
            if progress_callback:
                await progress_callback({
                    "status": "code_extraction",
                    "progress": 100,
                    "log": f"Code extraction completed. Stored {len(storage_data['examples'])} code examples.",
                    "code_blocks_found": len(storage_data['examples']),
                    "code_examples_stored": len(storage_data['examples']),
                })

            safe_logfire_info(f"Successfully stored {len(storage_data['examples'])} code examples")
            return len(storage_data["examples"])

        except Exception as e:
            safe_logfire_error(f"Error storing code examples | error={e}")
            raise RuntimeError("Failed to store code examples") from e
