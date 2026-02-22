"""
Embedding Worker

Processes embedding sets from the queue.
This is a separate pass that can be run independently of the download/chunk flow.
"""

import uuid
from typing import Any

from supabase import Client

from ...config.logfire_config import get_logger, safe_logfire_error, safe_logfire_info
from ..embeddings.embedding_service import EmbeddingBatchResult, create_embeddings_batch
from .ingestion_state_service import (
    EmbeddingStatus,
    get_ingestion_state_service,
)

logger = get_logger(__name__)


class EmbeddingWorker:
    def __init__(self, supabase_client: Client):
        self.supabase = supabase_client
        self.state_service = get_ingestion_state_service(supabase_client)

    async def process_pending_embeddings(
        self,
        embedder_id: str | None = None,
        max_batch_size: int = 10,
        provider: str | None = None,
    ) -> dict[str, Any]:
        pending_sets = await self.state_service.get_pending_embedding_sets(embedder_id)

        if not pending_sets:
            return {"processed": 0, "message": "No pending embedding sets"}

        results = {
            "processed": 0,
            "failed": 0,
            "sets_processed": [],
        }

        for embedding_set in pending_sets[:max_batch_size]:
            if not embedding_set.id:
                results["failed"] += 1
                continue
            try:
                success = await self._process_embedding_set(embedding_set, provider)
                if success:
                    results["processed"] += 1
                    results["sets_processed"].append(str(embedding_set.id))
                else:
                    results["failed"] += 1
            except Exception as e:
                safe_logfire_error(f"Error processing embedding set {embedding_set.id}: {e}")
                await self.state_service.update_embedding_set_status(
                    embedding_set.id,
                    EmbeddingStatus.FAILED,
                    error_info={"error": str(e), "stage": "embedding_set_processing"},
                )
                results["failed"] += 1

        return results

    async def _process_embedding_set(self, embedding_set, provider: str | None = None) -> bool:
        await self.state_service.update_embedding_set_status(embedding_set.id, EmbeddingStatus.IN_PROGRESS)

        chunks = await self.state_service.get_chunks_by_source(embedding_set.source_id)
        if not chunks:
            await self.state_service.update_embedding_set_status(
                embedding_set.id,
                EmbeddingStatus.FAILED,
                error_info={"error": "No chunks found for source"},
            )
            return False

        chunk_ids = [c.id for c in chunks]
        chunk_contents = [c.content for c in chunks]

        try:
            result: EmbeddingBatchResult = await create_embeddings_batch(
                chunk_contents,
                provider=provider,
                progress_callback=None,
            )

            if result.has_failures:
                safe_logfire_error(f"Embedding set {embedding_set.id}: {result.failure_count} failures")

            successful_embeddings = []
            for _i, (chunk_id, embedding) in enumerate(zip(chunk_ids, result.embeddings, strict=False)):
                if embedding and len(embedding) > 0:
                    successful_embeddings.append((chunk_id, embedding))

            stored_count = await self.state_service.store_embeddings(embedding_set.id, successful_embeddings)

            await self.state_service.update_embedding_set_status(
                embedding_set.id,
                EmbeddingStatus.DONE,
                processed_chunk_count=stored_count,
            )

            safe_logfire_info(f"Embedding set {embedding_set.id}: stored {stored_count}/{len(chunks)} embeddings")
            return True

        except Exception as e:
            safe_logfire_error(f"Failed to process embedding set {embedding_set.id}: {e}")
            await self.state_service.update_embedding_set_status(
                embedding_set.id,
                EmbeddingStatus.FAILED,
                error_info={"error": str(e), "stage": "embedding_generation"},
            )
            return False

    async def retry_failed_embeddings(self, embedder_id: str | None = None) -> dict[str, Any]:
        query = self.supabase.table("archon_embedding_sets").select("*").eq("status", "failed")
        if embedder_id:
            query = query.eq("embedder_id", embedder_id)
        response = query.execute()

        updated = 0
        for row in response.data:
            await self.state_service.update_embedding_set_status(uuid.UUID(row["id"]), EmbeddingStatus.PENDING)
            updated += 1

        return {"reset": updated}


def get_embedding_worker(supabase_client: Client) -> EmbeddingWorker:
    return EmbeddingWorker(supabase_client)
