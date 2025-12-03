"""
Re-Embed Service

Handles bulk re-embedding of documents when embedding model changes.
Uses existing content from archon_crawled_pages and creates new embeddings.
"""

import asyncio
import uuid
from typing import Any

from ..config.logfire_config import get_logger, safe_logfire_error, safe_logfire_info
from ..utils import get_supabase_client
from ..utils.progress.progress_tracker import ProgressTracker
from . import credential_service
from .embeddings.embedding_service import _maybe_await, create_embeddings_batch
from .llm_provider_service import get_embedding_model

logger = get_logger(__name__)

# Track active re-embed tasks for cancellation support
active_re_embed_tasks: dict[str, asyncio.Task] = {}


class ReEmbedService:
    """Service for bulk re-embedding of documents."""

    def __init__(self, supabase_client=None):
        self.client = supabase_client or get_supabase_client()

    async def _get_embedding_batch_size(self) -> int:
        """Load embedding batch size from settings (same as embedding_service uses)."""
        try:
            rag_settings = await _maybe_await(
                credential_service.get_credentials_by_category("rag_strategy")
            )
            batch_size = int(rag_settings.get("EMBEDDING_BATCH_SIZE", "100"))
            # Clamp to sane values (matching UI limits: 20-200)
            return max(20, min(200, batch_size))
        except Exception as e:
            logger.warning(f"Failed to load EMBEDDING_BATCH_SIZE from settings: {e}, using default 100")
            return 100

    async def start_re_embed(self, provider: str | None = None) -> dict[str, Any]:
        """
        Start a bulk re-embedding operation.

        Returns progress_id for tracking.
        """
        progress_id = str(uuid.uuid4())

        # Initialize progress tracker
        tracker = ProgressTracker(progress_id, operation_type="re_embed")
        await tracker.start({
            "status": "initializing",
            "progress": 0,
            "log": "Starting re-embedding process..."
        })

        # Start background task
        task = asyncio.create_task(
            self._perform_re_embed(progress_id, tracker, provider)
        )
        active_re_embed_tasks[progress_id] = task

        return {
            "progress_id": progress_id,
            "message": "Re-embedding started"
        }

    def _is_cancelled(self, progress_id: str) -> bool:
        """Check if this re-embed operation has been cancelled."""
        return progress_id not in active_re_embed_tasks

    async def _perform_re_embed(
        self,
        progress_id: str,
        tracker: ProgressTracker,
        provider: str | None = None
    ):
        """Perform the actual re-embedding operation."""
        try:
            # Get current embedding model for reference
            embedding_model = await get_embedding_model(provider=provider)
            safe_logfire_info(f"Re-embed starting | progress_id={progress_id} | model={embedding_model}")

            await tracker.update(
                status="fetching",
                progress=5,
                log=f"Fetching documents to re-embed with model: {embedding_model}"
            )

            # Fetch all chunks that need re-embedding
            # Get chunks in batches to handle large datasets
            batch_size = 100
            offset = 0
            all_chunks = []

            while True:
                result = (
                    self.client.table("archon_crawled_pages")
                    .select("id, content, url, chunk_number, source_id, metadata")
                    .order("id")
                    .range(offset, offset + batch_size - 1)
                    .execute()
                )

                if not result.data:
                    break

                all_chunks.extend(result.data)
                offset += batch_size

                await tracker.update(
                    status="fetching",
                    progress=10,
                    log=f"Fetched {len(all_chunks)} chunks..."
                )

            total_chunks = len(all_chunks)

            if total_chunks == 0:
                await tracker.complete({
                    "log": "No documents to re-embed",
                    "chunks_processed": 0
                })
                return

            safe_logfire_info(f"Re-embed: Found {total_chunks} chunks to process | progress_id={progress_id}")

            await tracker.update(
                status="embedding",
                progress=15,
                log=f"Processing {total_chunks} chunks..."
            )

            # Process in batches - use configured batch size from settings
            embedding_batch_size = await self._get_embedding_batch_size()
            safe_logfire_info(f"Re-embed using batch size: {embedding_batch_size}")
            processed = 0
            failed = 0

            for batch_start in range(0, total_chunks, embedding_batch_size):
                # Check for cancellation before each batch
                if self._is_cancelled(progress_id):
                    safe_logfire_info(f"Re-embed cancelled by user | progress_id={progress_id}")
                    await tracker.update(
                        status="cancelled",
                        progress=int(15 + (processed / total_chunks) * 80),
                        log="Re-embedding cancelled by user"
                    )
                    return

                batch_end = min(batch_start + embedding_batch_size, total_chunks)
                batch_chunks = all_chunks[batch_start:batch_end]

                # Extract content for embedding
                contents = [chunk["content"] for chunk in batch_chunks]

                # Create embeddings
                try:
                    result = await create_embeddings_batch(
                        contents,
                        provider=provider
                    )

                    # Check for cancellation after embedding API call
                    if self._is_cancelled(progress_id):
                        safe_logfire_info(f"Re-embed cancelled after embedding | progress_id={progress_id}")
                        await tracker.update(
                            status="cancelled",
                            progress=int(15 + (processed / total_chunks) * 80),
                            log="Re-embedding cancelled by user"
                        )
                        return

                    if result.has_failures:
                        failed += result.failure_count
                        safe_logfire_error(
                            f"Re-embed batch failed for {result.failure_count} items | "
                            f"progress_id={progress_id}"
                        )

                    # Update database with new embeddings
                    for idx, (embedding, text) in enumerate(zip(result.embeddings, result.texts_processed, strict=False)):
                        # Check for cancellation during DB updates
                        if self._is_cancelled(progress_id):
                            safe_logfire_info(f"Re-embed cancelled during DB update | progress_id={progress_id}")
                            await tracker.update(
                                status="cancelled",
                                progress=int(15 + (processed / total_chunks) * 80),
                                log="Re-embedding cancelled by user"
                            )
                            return

                        # Find the chunk that matches this text
                        chunk_idx = None
                        for i, chunk in enumerate(batch_chunks):
                            if chunk["content"] == text:
                                chunk_idx = i
                                break

                        if chunk_idx is None:
                            continue

                        chunk = batch_chunks[chunk_idx]

                        # Determine embedding column
                        embedding_dim = len(embedding) if isinstance(embedding, list) else len(embedding.tolist())
                        if embedding_dim == 768:
                            embedding_column = "embedding_768"
                        elif embedding_dim == 1024:
                            embedding_column = "embedding_1024"
                        elif embedding_dim == 1536:
                            embedding_column = "embedding_1536"
                        elif embedding_dim == 3072:
                            embedding_column = "embedding_3072"
                        else:
                            embedding_column = "embedding_1536"

                        # Clear other embedding columns and set new one
                        update_data = {
                            "embedding_768": None,
                            "embedding_1024": None,
                            "embedding_1536": None,
                            "embedding_3072": None,
                            embedding_column: embedding,
                            "embedding_model": embedding_model,
                            "embedding_dimension": embedding_dim,
                        }

                        try:
                            self.client.table("archon_crawled_pages").update(
                                update_data
                            ).eq("id", chunk["id"]).execute()
                        except Exception as e:
                            safe_logfire_error(f"Failed to update chunk {chunk['id']}: {e}")
                            failed += 1

                    processed += len(batch_chunks)

                except asyncio.CancelledError:
                    # Handle asyncio cancellation
                    safe_logfire_info(f"Re-embed task cancelled | progress_id={progress_id}")
                    await tracker.update(
                        status="cancelled",
                        progress=int(15 + (processed / total_chunks) * 80) if total_chunks > 0 else 15,
                        log="Re-embedding cancelled by user"
                    )
                    raise  # Re-raise to exit the task
                except Exception as e:
                    safe_logfire_error(f"Re-embed batch error: {e}")
                    failed += len(batch_chunks)
                    processed += len(batch_chunks)

                # Update progress (15-95% range for embedding phase)
                progress = int(15 + (processed / total_chunks) * 80)
                await tracker.update(
                    status="embedding",
                    progress=progress,
                    log=f"Processed {processed}/{total_chunks} chunks (failed: {failed})",
                    chunks_processed=processed,
                    chunks_failed=failed
                )

                # Small delay to prevent overwhelming and allow cancellation check
                await asyncio.sleep(0.1)

            # Complete
            await tracker.complete({
                "log": f"Re-embedding completed: {processed - failed}/{total_chunks} chunks updated",
                "chunks_processed": processed,
                "chunks_failed": failed,
                "embedding_model": embedding_model
            })

            safe_logfire_info(
                f"Re-embed completed | progress_id={progress_id} | "
                f"processed={processed} | failed={failed}"
            )

        except Exception as e:
            error_msg = f"Re-embedding failed: {str(e)}"
            safe_logfire_error(f"Re-embed error | progress_id={progress_id} | error={error_msg}")
            await tracker.error(error_msg)
        finally:
            # Cleanup
            if progress_id in active_re_embed_tasks:
                del active_re_embed_tasks[progress_id]

    async def stop_re_embed(self, progress_id: str) -> bool:
        """Stop a running re-embed operation.

        The cancellation works by:
        1. First removing the progress_id from active_re_embed_tasks (signals cancellation)
        2. Then cancelling the asyncio task
        3. The _perform_re_embed function checks _is_cancelled() frequently
        """
        if progress_id in active_re_embed_tasks:
            task = active_re_embed_tasks[progress_id]
            # First remove from dictionary - this signals cancellation to the running task
            del active_re_embed_tasks[progress_id]
            safe_logfire_info(f"Re-embed stop requested | progress_id={progress_id}")

            if not task.done():
                # Cancel the asyncio task
                task.cancel()
                try:
                    # Wait for task to finish (it should exit quickly after seeing cancellation)
                    await asyncio.wait_for(asyncio.shield(task), timeout=5.0)
                except (TimeoutError, asyncio.CancelledError, Exception):
                    # Task may already be cancelled or finished
                    pass

            safe_logfire_info(f"Re-embed stopped | progress_id={progress_id}")
            return True
        return False

    async def get_re_embed_stats(self) -> dict[str, Any]:
        """Get statistics about documents that would be re-embedded."""
        try:
            # Count total chunks
            count_result = (
                self.client.table("archon_crawled_pages")
                .select("id", count="exact", head=True)
                .execute()
            )
            total_chunks = count_result.count if hasattr(count_result, "count") else 0

            # Get distinct embedding models currently in use
            models_result = (
                self.client.table("archon_crawled_pages")
                .select("embedding_model")
                .execute()
            )

            models = set()
            if models_result.data:
                for row in models_result.data:
                    if row.get("embedding_model"):
                        models.add(row["embedding_model"])

            return {
                "total_chunks": total_chunks,
                "embedding_models_in_use": list(models),
                "estimated_time_seconds": total_chunks * 0.1  # Rough estimate
            }
        except Exception as e:
            safe_logfire_error(f"Failed to get re-embed stats: {e}")
            return {
                "total_chunks": 0,
                "embedding_models_in_use": [],
                "error": str(e)
            }
