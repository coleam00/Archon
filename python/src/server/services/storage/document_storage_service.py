"""
Document Storage Service

Handles storage of documents in Supabase with parallel processing support.
"""

import asyncio
import os
from typing import Any
from urllib.parse import urlparse

from ...config.logfire_config import safe_span, search_logger
from ..credential_service import credential_service
from ..embeddings.contextual_embedding_service import generate_contextual_embeddings_batch
from ..embeddings.embedding_service import create_embeddings_batch


async def add_documents_to_supabase(
    client,
    urls: list[str],
    chunk_numbers: list[int],
    contents: list[str],
    metadatas: list[dict[str, Any]],
    url_to_full_document: dict[str, str],
    batch_size: int = None,  # Will load from settings
    progress_callback: Any | None = None,
    enable_parallel_batches: bool = True,
    provider: str | None = None,
    cancellation_check: Any | None = None,
) -> dict[str, int]:
    """
    Add documents to Supabase with threading optimizations.

    This is the simpler sequential version for smaller batches.

    Args:
        client: Supabase client
        urls: List of URLs
        chunk_numbers: List of chunk numbers
        contents: List of document contents
        metadatas: List of document metadata
        url_to_full_document: Dictionary mapping URLs to their full document content
        batch_size: Size of each batch for insertion
        progress_callback: Optional async callback function for progress reporting
        provider: Optional provider override for embeddings
    """
    with safe_span(
        "add_documents_to_supabase", total_documents=len(contents), batch_size=batch_size
    ) as span:
        # Simple progress reporting helper with batch info support
        async def report_progress(message: str, progress: int, batch_info: dict = None):
            if progress_callback and asyncio.iscoroutinefunction(progress_callback):
                try:
                    if batch_info:
                        await progress_callback("document_storage", progress, message, **batch_info)
                    else:
                        await progress_callback("document_storage", progress, message)
                except Exception as e:
                    search_logger.warning(f"Progress callback failed: {e}. Storage continuing...")

        # Load settings from database
        try:
            rag_settings = await credential_service.get_credentials_by_category("rag_strategy")
            if batch_size is None:
                batch_size = int(rag_settings.get("DOCUMENT_STORAGE_BATCH_SIZE", "50"))
            delete_batch_size = int(rag_settings.get("DELETE_BATCH_SIZE", "50"))
            enable_parallel = rag_settings.get("ENABLE_PARALLEL_BATCHES", "true").lower() == "true"
        except Exception as e:
            search_logger.warning(f"Failed to load storage settings: {e}, using defaults")
            if batch_size is None:
                batch_size = 50
            delete_batch_size = 50
            enable_parallel = True

        # Get unique URLs to delete existing records
        unique_urls = list(set(urls))

        # Delete existing records for these URLs in batches
        try:
            if unique_urls:
                # Delete in configured batch sizes
                for i in range(0, len(unique_urls), delete_batch_size):
                    # Check for cancellation before each delete batch
                    if cancellation_check:
                        cancellation_check()

                    batch_urls = unique_urls[i : i + delete_batch_size]
                    client.table("archon_crawled_pages").delete().in_("url", batch_urls).execute()
                    # Yield control to allow other async operations
                    if i + delete_batch_size < len(unique_urls):
                        await asyncio.sleep(0.05)  # Reduced pause between delete batches
                search_logger.info(
                    f"Deleted existing records for {len(unique_urls)} URLs in batches"
                )
        except Exception as e:
            search_logger.warning(f"Batch delete failed: {e}. Trying smaller batches as fallback.")
            # Fallback: delete in smaller batches with rate limiting
            failed_urls = []
            fallback_batch_size = max(10, delete_batch_size // 5)
            for i in range(0, len(unique_urls), fallback_batch_size):
                # Check for cancellation before each fallback delete batch
                if cancellation_check:
                    cancellation_check()

                batch_urls = unique_urls[i : i + 10]
                try:
                    client.table("archon_crawled_pages").delete().in_("url", batch_urls).execute()
                    await asyncio.sleep(0.05)  # Rate limit to prevent overwhelming
                except Exception as inner_e:
                    search_logger.error(
                        f"Error deleting batch of {len(batch_urls)} URLs: {inner_e}"
                    )
                    failed_urls.extend(batch_urls)

            if failed_urls:
                search_logger.error(f"Failed to delete {len(failed_urls)} URLs")

        # Check if contextual embeddings are enabled
        # Fix: Get from credential service instead of environment
        from ..credential_service import credential_service

        try:
            use_contextual_embeddings = await credential_service.get_credential(
                "USE_CONTEXTUAL_EMBEDDINGS", "false", decrypt=True
            )
            if isinstance(use_contextual_embeddings, str):
                use_contextual_embeddings = use_contextual_embeddings.lower() == "true"
        except:
            # Fallback to environment variable
            use_contextual_embeddings = os.getenv("USE_CONTEXTUAL_EMBEDDINGS", "false") == "true"

        # Initialize batch tracking for simplified progress
        completed_batches = 0
        total_batches = (len(contents) + batch_size - 1) // batch_size
        total_chunks_stored = 0

        # Process in batches to avoid memory issues
        for batch_num, i in enumerate(range(0, len(contents), batch_size), 1):
            # Check for cancellation before each batch
            if cancellation_check:
                cancellation_check()

            batch_end = min(i + batch_size, len(contents))

            # Get batch slices
            batch_urls = urls[i:batch_end]
            batch_chunk_numbers = chunk_numbers[i:batch_end]
            batch_contents = contents[i:batch_end]
            batch_metadatas = metadatas[i:batch_end]

            # Simple batch progress - only track completed batches
            current_progress = int((completed_batches / total_batches) * 100)

            # Get max workers setting FIRST before using it
            if use_contextual_embeddings:
                try:
                    max_workers = await credential_service.get_credential(
                        "CONTEXTUAL_EMBEDDINGS_MAX_WORKERS", "4", decrypt=True
                    )
                    max_workers = int(max_workers)
                except:
                    max_workers = 4
            else:
                max_workers = 1

            # Report batch start with simplified progress
            if progress_callback and asyncio.iscoroutinefunction(progress_callback):
                try:
                    await progress_callback(
                        "document_storage",  # status (will be overridden by base_status anyway)
                        current_progress,    # progress
                        f"Processing batch {batch_num}/{total_batches} ({len(batch_contents)} chunks)",  # message
                    **{  # **kwargs - these will be stored at top level
                        "current_batch": batch_num,
                        "total_batches": total_batches,
                        "completed_batches": completed_batches,
                        "chunks_in_batch": len(batch_contents),
                        "active_workers": max_workers if use_contextual_embeddings else 1,
                    }
                )
                except Exception as e:
                    search_logger.warning(f"Progress callback failed: {e}. Storage continuing...")

            # Skip batch start progress to reduce traffic
            # Only report on completion

            # Apply contextual embedding to each chunk if enabled
            if use_contextual_embeddings:
                # Prepare full documents list for batch processing
                full_documents = []
                for j, content in enumerate(batch_contents):
                    url = batch_urls[j]
                    full_document = url_to_full_document.get(url, "")
                    full_documents.append(full_document)

                # Get contextual embedding batch size from settings
                try:
                    contextual_batch_size = int(
                        rag_settings.get("CONTEXTUAL_EMBEDDING_BATCH_SIZE", "50")
                    )
                except:
                    contextual_batch_size = 50

                try:
                    # Process in smaller sub-batches to avoid token limits
                    contextual_contents = []
                    successful_count = 0

                    for ctx_i in range(0, len(batch_contents), contextual_batch_size):
                        # Check for cancellation before each contextual sub-batch
                        if cancellation_check:
                            cancellation_check()

                        ctx_end = min(ctx_i + contextual_batch_size, len(batch_contents))

                        sub_batch_contents = batch_contents[ctx_i:ctx_end]
                        sub_batch_docs = full_documents[ctx_i:ctx_end]

                        # Process sub-batch with a single API call
                        sub_results = await generate_contextual_embeddings_batch(
                            sub_batch_docs, sub_batch_contents
                        )

                        # Extract results from this sub-batch
                        for idx, (contextual_text, success) in enumerate(sub_results):
                            contextual_contents.append(contextual_text)
                            if success:
                                original_idx = ctx_i + idx
                                batch_metadatas[original_idx]["contextual_embedding"] = True
                                successful_count += 1

                    search_logger.info(
                        f"Batch {batch_num}: Generated {successful_count}/{len(batch_contents)} contextual embeddings using batch API (sub-batch size: {contextual_batch_size})"
                    )

                except Exception as e:
                    search_logger.error(f"Error in batch contextual embedding: {e}")
                    # Fallback to original contents
                    contextual_contents = batch_contents
                    search_logger.warning(
                        f"Batch {batch_num}: Falling back to original content due to error"
                    )
            else:
                # If not using contextual embeddings, use original contents
                contextual_contents = batch_contents

            # Create embeddings for the batch with rate limit progress support
            # Create a wrapper for progress callback to handle rate limiting updates
            async def embedding_progress_wrapper(message: str, percentage: float):
                # Forward rate limiting messages to the main progress callback
                if progress_callback and "rate limit" in message.lower():
                    try:
                        await progress_callback(
                            "document_storage",
                            current_progress,  # Use current batch progress
                            message,
                        batch=batch_num,
                        type="rate_limit_wait"
                    )
                    except Exception as e:
                        search_logger.warning(f"Progress callback failed during rate limiting: {e}")
            
            # Pass progress callback for rate limiting updates
            result = await create_embeddings_batch(
                contextual_contents,
                provider=provider,
                progress_callback=embedding_progress_wrapper if progress_callback else None
            )

            # Log any failures
            if result.has_failures:
                search_logger.error(
                    f"Batch {batch_num}: Failed to create {result.failure_count} embeddings. "
                    f"Successful: {result.success_count}. Errors: {[item['error'] for item in result.failed_items[:3]]}"
                )

            # Use only successful embeddings
            batch_embeddings = result.embeddings
            successful_texts = result.texts_processed

            if not batch_embeddings:
                search_logger.warning(
                    f"Skipping batch {batch_num} - no successful embeddings created"
                )
                completed_batches += 1
                continue

            # Prepare batch data - only for successful embeddings
            batch_data = []
            # Map successful texts back to their original indices
            for j, (embedding, text) in enumerate(
                zip(batch_embeddings, successful_texts, strict=False)
            ):
                # Find the original index of this text
                orig_idx = None
                for idx, orig_text in enumerate(contextual_contents):
                    if orig_text == text:
                        orig_idx = idx
                        break

                if orig_idx is None:
                    search_logger.warning("Could not map embedding back to original text")
                    continue

                j = orig_idx  # Use original index for metadata lookup
                # Use source_id from metadata if available, otherwise extract from URL
                if batch_metadatas[j].get("source_id"):
                    source_id = batch_metadatas[j]["source_id"]
                else:
                    # Fallback: Extract source_id from URL
                    parsed_url = urlparse(batch_urls[j])
                    source_id = parsed_url.netloc or parsed_url.path

                data = {
                    "url": batch_urls[j],
                    "chunk_number": batch_chunk_numbers[j],
                    "content": text,  # Use the successful text
                    "metadata": {"chunk_size": len(text), **batch_metadatas[j]},
                    "source_id": source_id,
                    "embedding": embedding,  # Use the successful embedding
                }
                batch_data.append(data)

            # Insert batch with retry logic - no progress reporting

            max_retries = 3
            retry_delay = 1.0

            for retry in range(max_retries):
                # Check for cancellation before each retry attempt
                if cancellation_check:
                    cancellation_check()

                try:
                    client.table("archon_crawled_pages").insert(batch_data).execute()
                    total_chunks_stored += len(batch_data)

                    # Increment completed batches and report simple progress
                    completed_batches += 1
                    # Ensure last batch reaches 100%
                    if completed_batches == total_batches:
                        new_progress = 100
                    else:
                        new_progress = int((completed_batches / total_batches) * 100)

                    complete_msg = (
                        f"Completed batch {batch_num}/{total_batches} ({len(batch_data)} chunks)"
                    )

                    # Simple batch completion info
                    batch_info = {
                        "completed_batches": completed_batches,
                        "total_batches": total_batches,
                        "current_batch": batch_num,
                        "chunks_processed": len(batch_data),
                        "active_workers": max_workers if use_contextual_embeddings else 1,
                    }
                    await report_progress(complete_msg, new_progress, batch_info)
                    break

                except Exception as e:
                    if retry < max_retries - 1:
                        search_logger.warning(
                            f"Error inserting batch (attempt {retry + 1}/{max_retries}): {e}"
                        )
                        await asyncio.sleep(retry_delay)
                        retry_delay *= 2  # Exponential backoff
                    else:
                        search_logger.error(
                            f"Failed to insert batch after {max_retries} attempts: {e}"
                        )
                        # Try individual inserts as last resort
                        successful_inserts = 0
                        for record in batch_data:
                            # Check for cancellation before each individual insert
                            if cancellation_check:
                                cancellation_check()

                            try:
                                client.table("archon_crawled_pages").insert(record).execute()
                                successful_inserts += 1
                                total_chunks_stored += 1
                            except Exception as individual_error:
                                search_logger.error(
                                    f"Failed individual insert for {record['url']}: {individual_error}"
                                )

                        search_logger.info(
                            f"Individual inserts: {successful_inserts}/{len(batch_data)} successful"
                        )

            # Minimal delay between batches to prevent overwhelming
            if i + batch_size < len(contents):
                # Only yield control briefly to keep system responsive
                await asyncio.sleep(0.1)  # Reduced from 1.5s/0.5s to 0.1s

        # Send final 100% progress report to ensure UI shows completion
        if progress_callback and asyncio.iscoroutinefunction(progress_callback):
            try:
                await progress_callback(
                    "document_storage",
                    100,  # Ensure we report 100%
                    f"Document storage completed: {len(contents)} chunks stored in {total_batches} batches",
                completed_batches=total_batches,
                total_batches=total_batches,
                current_batch=total_batches,
                chunks_processed=len(contents),
                # DON'T send 'status': 'completed' - that's for the orchestration service only!
            )
            except Exception as e:
                search_logger.warning(f"Progress callback failed during completion: {e}. Storage still successful.")

        span.set_attribute("success", True)
        span.set_attribute("total_processed", len(contents))
        span.set_attribute("total_stored", total_chunks_stored)

        return {"chunks_stored": total_chunks_stored}
