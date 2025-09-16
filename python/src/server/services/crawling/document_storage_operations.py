"""
Document Storage Operations

Handles the storage and processing of crawled documents.
Extracted from crawl_orchestration_service.py for better modularity.
"""

import asyncio
from collections.abc import Callable
from typing import Any

from ...config.logfire_config import get_logger, safe_logfire_error, safe_logfire_info
from ..source_management_service import extract_source_summary, update_source_info
from ..storage.document_storage_service import add_documents_to_supabase
from ..storage.storage_services import DocumentStorageService
from .code_extraction_service import CodeExtractionService

logger = get_logger(__name__)


class DocumentStorageOperations:
    """
    Handles document storage operations for crawled content.
    """

    def __init__(self, supabase_client):
        """
        Initialize document storage operations.

        Args:
            supabase_client: The Supabase client for database operations
        """
        self.supabase_client = supabase_client
        self.doc_storage_service = DocumentStorageService(supabase_client)
        self.code_extraction_service = CodeExtractionService(supabase_client)

    async def process_and_store_documents(
        self,
        crawl_results: list[dict],
        request: dict[str, Any],
        crawl_type: str,
        original_source_id: str,
        progress_callback: Callable | None = None,
        cancellation_check: Callable | None = None,
        source_url: str | None = None,
        source_display_name: str | None = None,
    ) -> dict[str, Any]:
        """
        Process crawled documents and store them in the database.

        Args:
            crawl_results: List of crawled documents
            request: The original crawl request
            crawl_type: Type of crawl performed
            original_source_id: The source ID for all documents
            progress_callback: Optional callback for progress updates
            cancellation_check: Optional function to check for cancellation
            source_url: Optional original URL that was crawled
            source_display_name: Optional human-readable name for the source

        Returns:
            Dict containing storage statistics and document mappings
        """
        # Reuse initialized storage service for chunking
        storage_service = self.doc_storage_service

        # Prepare data for chunked storage
        all_urls = []
        all_chunk_numbers = []
        all_contents = []
        all_metadatas = []
        source_word_counts = {}
        url_to_full_document = {}
        processed_docs = 0

        # Process and chunk each document
        for doc_index, doc in enumerate(crawl_results):
            # Check for cancellation during document processing
            if cancellation_check:
                try:
                    cancellation_check()
                except asyncio.CancelledError:
                    if progress_callback:
                        await progress_callback(
                            "cancelled",
                            99,
                            f"Document processing cancelled at document {doc_index + 1}/{len(crawl_results)}"
                        )
                    raise

            doc_url = (doc.get('url') or '').strip()
            markdown_content = (doc.get('markdown') or '').strip()

            # Skip documents with empty or whitespace-only content or missing URLs
            if not markdown_content or not doc_url:
                logger.debug(f"Skipping document {doc_index}: empty {'URL' if not doc_url else 'content'}")
                continue

            # Increment processed document count
            processed_docs += 1

            # Store full document for code extraction context
            url_to_full_document[doc_url] = markdown_content

            # CHUNK THE CONTENT
            chunks = await storage_service.smart_chunk_text_async(markdown_content, chunk_size=5000)

            # Use the original source_id for all documents
            source_id = original_source_id
            safe_logfire_info(f"Using original source_id '{source_id}' for URL '{doc_url}'")

            # Process each chunk
            for i, chunk in enumerate(chunks):
                # Check for cancellation during chunk processing
                if cancellation_check and i % 10 == 0:  # Check every 10 chunks
                    try:
                        cancellation_check()
                    except asyncio.CancelledError:
                        if progress_callback:
                            await progress_callback(
                                "cancelled",
                                99,
                                f"Chunk processing cancelled at chunk {i + 1}/{len(chunks)} of document {doc_index + 1}"
                            )
                        raise

                all_urls.append(doc_url)
                all_chunk_numbers.append(i)
                all_contents.append(chunk)

                # Create metadata for each chunk
                word_count = len(chunk.split())
                metadata = {
                    "url": doc_url,
                    "title": doc.get("title", ""),
                    "description": doc.get("description", ""),
                    "source_id": source_id,
                    "knowledge_type": request.get("knowledge_type", "documentation"),
                    "crawl_type": crawl_type,
                    "word_count": word_count,
                    "char_count": len(chunk),
                    "chunk_index": i,
                    "tags": request.get("tags", []),
                }
                all_metadatas.append(metadata)

                # Accumulate word count
                source_word_counts[source_id] = source_word_counts.get(source_id, 0) + word_count

                # Yield control every 10 chunks to prevent event loop blocking
                if i > 0 and i % 10 == 0:
                    await asyncio.sleep(0)

            # Yield control after processing each document
            if doc_index > 0 and doc_index % 5 == 0:
                await asyncio.sleep(0)

        # Create/update source record FIRST before storing documents
        if all_contents and all_metadatas:
            await self._create_source_records(
                all_metadatas, all_contents, source_word_counts, request,
                source_url, source_display_name
            )

        safe_logfire_info(f"url_to_full_document keys: {list(url_to_full_document.keys())[:5]}")

        # Log chunking results
        avg_chunks = (len(all_contents) / processed_docs) if processed_docs > 0 else 0.0
        safe_logfire_info(
            f"Document storage | processed={processed_docs}/{len(crawl_results)} | chunks={len(all_contents)} | avg_chunks_per_doc={avg_chunks:.1f}"
        )

        # Call add_documents_to_supabase with the correct parameters
        storage_stats = await add_documents_to_supabase(
            client=self.supabase_client,
            urls=all_urls,  # Now has entry per chunk
            chunk_numbers=all_chunk_numbers,  # Proper chunk numbers (0, 1, 2, etc)
            contents=all_contents,  # Individual chunks
            metadatas=all_metadatas,  # Metadata per chunk
            url_to_full_document=url_to_full_document,
            batch_size=25,  # Increased from 10 for better performance
            progress_callback=progress_callback,  # Pass the callback for progress updates
            enable_parallel_batches=True,  # Enable parallel processing
            provider=None,  # Use configured provider
            cancellation_check=cancellation_check,  # Pass cancellation check
        )

        # Calculate chunk counts
        chunk_count = len(all_contents)
        chunks_stored = storage_stats.get("chunks_stored", 0)

        return {
            'chunk_count': chunk_count,
            'chunks_stored': chunks_stored,
            'total_word_count': sum(source_word_counts.values()),
            'url_to_full_document': url_to_full_document,
            'source_id': original_source_id
        }

    async def _create_source_records(
        self,
        all_metadatas: list[dict],
        all_contents: list[str],
        source_word_counts: dict[str, int],
        request: dict[str, Any],
        source_url: str | None = None,
        source_display_name: str | None = None,
    ):
        """
        Create or update source records in the database.

        Args:
            all_metadatas: List of metadata for all chunks
            all_contents: List of all chunk contents
            source_word_counts: Word counts per source_id
            request: Original crawl request
        """
        # Find ALL unique source_ids in the crawl results
        unique_source_ids = set()
        source_id_contents = {}
        source_id_word_counts = {}

        for i, metadata in enumerate(all_metadatas):
            source_id = metadata["source_id"]
            unique_source_ids.add(source_id)

            # Group content by source_id for better summaries
            if source_id not in source_id_contents:
                source_id_contents[source_id] = []
            source_id_contents[source_id].append(all_contents[i])

            # Track word counts per source_id
            if source_id not in source_id_word_counts:
                source_id_word_counts[source_id] = 0
            source_id_word_counts[source_id] += metadata.get('word_count', 0)

        safe_logfire_info(
            f"Found {len(unique_source_ids)} unique source_ids: {list(unique_source_ids)}"
        )

        # Create source records for ALL unique source_ids
        for source_id in unique_source_ids:
            # Get combined content for this specific source_id
            source_contents = source_id_contents[source_id]
            combined_content = ""
            for chunk in source_contents[:3]:  # First 3 chunks for this source
                if len(combined_content) + len(chunk) < 15000:
                    combined_content += " " + chunk
                else:
                    break

            # Generate summary with fallback
            try:
                # Call async extract_source_summary directly
                summary = await extract_source_summary(source_id, combined_content)
            except Exception as e:
                logger.error(f"Failed to generate AI summary for '{source_id}'", exc_info=True)
                safe_logfire_error(
                    f"Failed to generate AI summary for '{source_id}': {str(e)}, using fallback"
                )
                # Fallback to simple summary
                summary = f"Documentation from {source_id} - {len(source_contents)} pages crawled"

            # Update source info in database BEFORE storing documents
            safe_logfire_info(
                f"About to create/update source record for '{source_id}' (word count: {source_id_word_counts[source_id]})"
            )
            try:
                # Call async update_source_info directly
                await update_source_info(
                    client=self.supabase_client,
                    source_id=source_id,
                    summary=summary,
                    word_count=source_id_word_counts[source_id],
                    content=combined_content,
                    knowledge_type=request.get("knowledge_type", "documentation"),
                    tags=request.get("tags", []),
                    update_frequency=0,  # Set to 0 since we're using manual refresh
                    original_url=request.get("url"),  # Store the original crawl URL
                    source_url=source_url,
                    source_display_name=source_display_name,
                )
                safe_logfire_info(f"Successfully created/updated source record for '{source_id}'")
            except Exception as e:
                logger.error(f"Failed to create/update source record for '{source_id}'", exc_info=True)
                safe_logfire_error(
                    f"Failed to create/update source record for '{source_id}': {str(e)}"
                )
                # Try a simpler approach with minimal data
                try:
                    safe_logfire_info(f"Attempting fallback source creation for '{source_id}'")
                    fallback_data = {
                        "source_id": source_id,
                        "title": source_id,  # Use source_id as title fallback
                        "summary": summary,
                        "total_word_count": source_id_word_counts[source_id],
                        "metadata": {
                            "knowledge_type": request.get("knowledge_type", "documentation"),
                            "tags": request.get("tags", []),
                            "auto_generated": True,
                            "fallback_creation": True,
                            "original_url": request.get("url"),
                        },
                    }

                    # Add new fields if provided
                    if source_url:
                        fallback_data["source_url"] = source_url
                    if source_display_name:
                        fallback_data["source_display_name"] = source_display_name

                    self.supabase_client.table("archon_sources").upsert(fallback_data).execute()
                    safe_logfire_info(f"Fallback source creation succeeded for '{source_id}'")
                except Exception as fallback_error:
                    logger.error(f"Both source creation attempts failed for '{source_id}'", exc_info=True)
                    safe_logfire_error(
                        f"Both source creation attempts failed for '{source_id}': {str(fallback_error)}"
                    )
                    raise RuntimeError(
                        f"Unable to create source record for '{source_id}'. This will cause foreign key violations."
                    ) from fallback_error

        # Verify ALL source records exist before proceeding with document storage
        if unique_source_ids:
            for source_id in unique_source_ids:
                try:
                    source_check = (
                        self.supabase_client.table("archon_sources")
                        .select("source_id")
                        .eq("source_id", source_id)
                        .execute()
                    )
                    if not source_check.data:
                        raise Exception(
                            f"Source record verification failed - '{source_id}' does not exist in sources table"
                        )
                    safe_logfire_info(f"Source record verified for '{source_id}'")
                except Exception as e:
                    logger.error(f"Source verification failed for '{source_id}'", exc_info=True)
                    safe_logfire_error(f"Source verification failed for '{source_id}': {str(e)}")
                    raise

            safe_logfire_info(
                f"All {len(unique_source_ids)} source records verified - proceeding with document storage"
            )

    async def extract_and_store_code_examples(
        self,
        crawl_results: list[dict],
        url_to_full_document: dict[str, str],
        source_id: str,
        progress_callback: Callable | None = None,
        cancellation_check: Callable[[], None] | None = None,
    ) -> int:
        """
        Extract code examples from crawled documents and store them.

        Args:
            crawl_results: List of crawled documents
            url_to_full_document: Mapping of URLs to full document content
            source_id: The unique source_id for all documents
            progress_callback: Optional callback for progress updates
            cancellation_check: Optional function to check for cancellation

        Returns:
            Number of code examples stored
        """
        result = await self.code_extraction_service.extract_and_store_code_examples(
            crawl_results, url_to_full_document, source_id, progress_callback, cancellation_check
        )

        return result
