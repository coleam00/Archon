"""
Base Storage Service

Provides common functionality for all document storage operations including:
- Text chunking
- Metadata extraction
- Batch processing
- Progress reporting
"""

import re
from abc import ABC, abstractmethod
from collections.abc import Callable
from typing import Any
from urllib.parse import urlparse

from ...config.logfire_config import get_logger, safe_span

logger = get_logger(__name__)


class BaseStorageService(ABC):
    """Base class for all storage services with common functionality."""

    def __init__(self, supabase_client=None):
        """Initialize with optional supabase client and threading service."""
        # Lazy import to avoid circular dependency
        if supabase_client is None:
            from ...utils import get_supabase_client

            supabase_client = get_supabase_client()
        self.supabase_client = supabase_client

        # Lazy import threading service
        from ...utils import get_utils_threading_service

        self.threading_service = get_utils_threading_service()

    def smart_chunk_text(self, text: str, chunk_size: int = 5000) -> list[str]:
        """
        Split text into chunks intelligently, preserving context.

        This function implements a context-aware chunking strategy that:
        1. Preserves code blocks (```) as complete units when possible
        2. Prefers to break at paragraph boundaries (\\n\\n)
        3. Falls back to sentence boundaries (. ) if needed
        4. Only splits mid-content when absolutely necessary

        Args:
            text: Text to chunk
            chunk_size: Maximum chunk size (default: 5000)

        Returns:
            List of text chunks
        """
        if not text or not isinstance(text, str):
            logger.warning("Invalid text provided for chunking")
            return []

        chunks = []
        start = 0
        text_length = len(text)

        while start < text_length:
            # Determine the end of this chunk
            end = start + chunk_size

            # If we're at the end of the text, take what's left
            if end >= text_length:
                chunk = text[start:].strip()
                if chunk:
                    chunks.append(chunk)
                break

            # Try to find a good break point
            chunk = text[start:end]

            # First, try to break at a code block boundary
            code_block_pos = chunk.rfind("```")
            if code_block_pos != -1 and code_block_pos > chunk_size * 0.3:
                end = start + code_block_pos

            # If no code block, try paragraph break
            elif "\n\n" in chunk:
                last_break = chunk.rfind("\n\n")
                if last_break > chunk_size * 0.3:
                    end = start + last_break

            # If no paragraph break, try sentence break
            elif ". " in chunk:
                last_period = chunk.rfind(". ")
                if last_period > chunk_size * 0.3:
                    end = start + last_period + 1

            # Extract chunk and clean it up
            chunk = text[start:end].strip()
            if chunk:
                chunks.append(chunk)

            # Move start position for next chunk
            start = end

        # Combine consecutive small chunks (<200 chars) together
        if chunks:
            combined_chunks: list[str] = []
            i = 0
            while i < len(chunks):
                current = chunks[i]

                # Keep combining while current is small and there are more chunks
                while len(current) < 200 and i + 1 < len(chunks):
                    i += 1
                    current = current + "\n\n" + chunks[i]

                combined_chunks.append(current)
                i += 1

            chunks = combined_chunks

        return chunks

    async def smart_chunk_text_async(
        self, text: str, chunk_size: int = 5000, progress_callback: Callable | None = None
    ) -> list[str]:
        """
        Async version of smart_chunk_text with optional progress reporting.

        Args:
            text: Text to chunk
            chunk_size: Maximum chunk size
            progress_callback: Optional callback for progress updates

        Returns:
            List of text chunks
        """
        with safe_span(
            "smart_chunk_text_async", text_length=len(text), chunk_size=chunk_size
        ) as span:
            try:
                # For large texts, run chunking in thread pool
                if len(text) > 50000:  # 50KB threshold
                    chunks = await self.threading_service.run_cpu_intensive(
                        self.smart_chunk_text, text, chunk_size
                    )
                else:
                    chunks = self.smart_chunk_text(text, chunk_size)

                if progress_callback:
                    await progress_callback("Text chunking completed", 100)

                span.set_attribute("chunks_created", len(chunks))
                span.set_attribute("success", True)

                logger.info(
                    f"Successfully chunked text: original_length={len(text)}, chunks_created={len(chunks)}"
                )

                return chunks

            except Exception as e:
                span.set_attribute("success", False)
                span.set_attribute("error", str(e))
                logger.error(f"Error chunking text: {e}")
                raise

    def extract_metadata(
        self, chunk: str, base_metadata: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """
        Extract metadata from a text chunk.

        Args:
            chunk: Text chunk to analyze
            base_metadata: Optional base metadata to extend

        Returns:
            Dictionary containing metadata
        """
        # Extract headers
        headers = re.findall(r"^(#+)\s+(.+)$", chunk, re.MULTILINE)
        header_str = "; ".join([f"{h[0]} {h[1]}" for h in headers]) if headers else ""

        # Extract basic stats
        metadata = {
            "headers": header_str,
            "char_count": len(chunk),
            "word_count": len(chunk.split()),
            "line_count": len(chunk.splitlines()),
            "has_code": "```" in chunk,
            "has_links": "http" in chunk or "www." in chunk,
        }

        # Merge with base metadata if provided
        if base_metadata:
            metadata.update(base_metadata)

        return metadata

    def extract_source_id(self, url: str) -> str:
        """
        Extract source ID from URL.

        Args:
            url: URL to extract source ID from

        Returns:
            Source ID (typically the domain)
        """
        try:
            parsed_url = urlparse(url)
            return parsed_url.netloc or parsed_url.path or url
        except Exception as e:
            logger.warning(f"Error parsing URL {url}: {e}")
            return url

    async def batch_process_with_progress(
        self,
        items: list[Any],
        process_func: Callable,
        batch_size: int = 20,
        progress_callback: Callable | None = None,
        description: str = "Processing",
    ) -> list[Any]:
        """
        Process items in batches with progress reporting.

        Args:
            items: Items to process
            process_func: Function to process each batch
            batch_size: Size of each batch
            progress_callback: Optional progress callback
            description: Description for progress messages

        Returns:
            List of processed results
        """
        results = []
        total_items = len(items)

        for i in range(0, total_items, batch_size):
            batch_end = min(i + batch_size, total_items)
            batch = items[i:batch_end]

            # Process batch
            batch_results = await process_func(batch)
            results.extend(batch_results)

            # Report progress
            if progress_callback:
                progress_pct = int((batch_end / total_items) * 100)
                await progress_callback(
                    f"{description}: {batch_end}/{total_items} items", progress_pct
                )

        return results

    @abstractmethod
    async def store_documents(self, documents: list[dict[str, Any]], **kwargs) -> dict[str, Any]:
        """
        Store documents in the database. Must be implemented by subclasses.

        Args:
            documents: List of documents to store
            **kwargs: Additional storage options

        Returns:
            Storage result with success status and metadata
        """
        pass

    @abstractmethod
    async def process_document(self, document: dict[str, Any], **kwargs) -> dict[str, Any]:
        """
        Process a single document. Must be implemented by subclasses.

        Args:
            document: Document to process
            **kwargs: Additional processing options

        Returns:
            Processed document with metadata
        """
        pass
