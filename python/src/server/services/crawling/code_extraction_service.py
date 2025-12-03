"""
Code Extraction Service

Handles extraction, processing, and storage of code examples from documents.
"""

import asyncio
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
        provider: str | None = None,
        embedding_provider: str | None = None,
    ) -> int:
        """
        Extract code examples from crawled documents and store them.

        Args:
            crawl_results: List of crawled documents with url and markdown content
            url_to_full_document: Mapping of URLs to full document content
            source_id: The unique source_id for all documents
            progress_callback: Optional async callback for progress updates
            cancellation_check: Optional function to check for cancellation
            provider: Optional LLM provider identifier for summary generation
            embedding_provider: Optional embedding provider override for vector creation

        Returns:
            Number of code examples stored
        """
        # Phase 1: Extract code blocks (0-20% of overall code_extraction progress)
        extraction_callback = None
        if progress_callback:
            async def extraction_progress(data: dict):
                # Scale progress to 0-20% range with normalization similar to later phases
                raw = data.get("progress", data.get("percentage", 0))
                try:
                    raw_num = float(raw)
                except (TypeError, ValueError):
                    raw_num = 0.0
                if 0.0 <= raw_num <= 1.0:
                    raw_num *= 100.0
                # 0-20% with clamping
                scaled_progress = min(20, max(0, int(raw_num * 0.2)))
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
                raw = data.get("progress", data.get("percentage", 0))
                try:
                    raw_num = float(raw)
                except (TypeError, ValueError):
                    raw_num = 0.0
                if 0.0 <= raw_num <= 1.0:
                    raw_num *= 100.0
                # 20-90% with clamping
                scaled_progress = min(90, max(20, 20 + int(raw_num * 0.7)))
                data["progress"] = scaled_progress
                await progress_callback(data)
            summary_callback = summary_progress

        # Generate summaries for code blocks
        summary_results = await self._generate_code_summaries(
            all_code_blocks, summary_callback, cancellation_check, provider
        )

        # Prepare code examples for storage
        storage_data = self._prepare_code_examples_for_storage(all_code_blocks, summary_results)

        # Phase 3: Store in database (90-100% of overall progress)
        storage_callback = None
        if progress_callback:
            async def storage_progress(data: dict):
                # Scale progress to 90-100% range
                raw = data.get("progress", data.get("percentage", 0))
                try:
                    raw_num = float(raw)
                except (TypeError, ValueError):
                    raw_num = 0.0
                if 0.0 <= raw_num <= 1.0:
                    raw_num *= 100.0
                # 90-100% with clamping
                scaled_progress = min(100, max(90, 90 + int(raw_num * 0.1)))
                data["progress"] = scaled_progress
                await progress_callback(data)
            storage_callback = storage_progress

        # Store code examples in database
        return await self._store_code_examples(
            storage_data,
            url_to_full_document,
            storage_callback,
            provider,
            embedding_provider,
        )

    async def _extract_code_blocks_from_documents(
        self,
        crawl_results: list[dict[str, Any]],
        source_id: str,
        progress_callback: Callable | None = None,
        cancellation_check: Callable[[], None] | None = None,
    ) -> list[dict[str, Any]]:
        """
        Extract code blocks from all documents using unified markdown extraction.

        All sources now provide markdown:
        - Web crawl: Firecrawl returns markdown field
        - PDF uploads: PyMuPDF4LLM converts to markdown with code blocks
        - MD/text files: Already markdown or plain text

        Args:
            crawl_results: List of crawled documents with 'url' and 'markdown' fields
            source_id: The unique source_id for all documents
            progress_callback: Optional async callback for progress updates
            cancellation_check: Optional function to check for cancellation

        Returns:
            List of code blocks with metadata
        """
        from ..storage.code_storage_service import extract_code_blocks

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
                md = doc.get("markdown", "")
                content_type = doc.get("content_type", "")

                # Skip code extraction for plain text without markdown structure
                # Plain text files (.txt) without code fences have no code blocks to extract
                is_plain_text_without_code = (
                    content_type == "text/plain" and "```" not in md
                )
                if is_plain_text_without_code:
                    safe_logfire_info(f"⏭️ Skipping code extraction for plain text without code blocks | url={source_url}")
                    completed_docs += 1
                    continue

                # Unified markdown extraction for all sources:
                # - Web crawl: Firecrawl markdown
                # - PDF: PyMuPDF4LLM markdown (already has ``` code blocks)
                # - MD files: as-is
                code_blocks = []
                if md and "```" in md:
                    code_blocks = extract_code_blocks(md, min_length=250)
                    safe_logfire_info(
                        f"📦 Extracted {len(code_blocks)} code blocks from markdown | url={source_url}"
                    )

                # Add code blocks to result with metadata
                for block in code_blocks:
                    all_code_blocks.append({
                        "block": block,
                        "source_url": source_url,
                        "source_id": source_id,
                    })

                # Update progress
                completed_docs += 1
                if progress_callback and total_docs > 0:
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
                completed_docs += 1

        return all_code_blocks

    async def _generate_code_summaries(
        self,
        all_code_blocks: list[dict[str, Any]],
        progress_callback: Callable | None = None,
        cancellation_check: Callable[[], None] | None = None,
        provider: str | None = None,
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
                code_blocks_for_summaries, max_workers, progress_callback=summary_progress_callback, provider=provider
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
        provider: str | None = None,
        embedding_provider: str | None = None,
    ) -> int:
        """
        Store code examples in the database.

        Returns:
            Number of code examples stored

        Args:
            storage_data: Prepared code example payloads
            url_to_full_document: Mapping of URLs to their full document content
            progress_callback: Optional callback for progress updates
            provider: Optional LLM provider identifier for summaries
            embedding_provider: Optional embedding provider override for vector storage
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
                provider=provider,
                embedding_provider=embedding_provider,
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
