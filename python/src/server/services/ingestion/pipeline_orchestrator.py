"""
Pipeline Orchestrator

Orchestrates the new restartable RAG ingestion pipeline.
Coordinates: download → blob → chunk → queue embedding/summarization

This is a clean break from the old monolithic pipeline.
"""

from collections.abc import Callable
from typing import Any

from supabase import Client

from ...config.logfire_config import get_logger, safe_logfire_error, safe_logfire_info
from ..credential_service import credential_service
from ..llm_provider_service import get_embedding_model
from ..storage.storage_services import DocumentStorageService
from .ingestion_state_service import (
    PipelineStatus,
    get_ingestion_state_service,
)

logger = get_logger(__name__)


class PipelineOrchestrator:
    """
    Orchestrates the full ingestion pipeline with checkpointing.

    Flow:
    1. Store document blobs (raw content)
    2. Chunk content into smaller pieces
    3. Create pending embedding sets (separate pass)
    4. Create pending summaries (separate pass)
    5. Return immediately - workers process async
    """

    def __init__(self, supabase_client: Client):
        self.supabase = supabase_client
        self.state_service = get_ingestion_state_service(supabase_client)
        self.storage_service = DocumentStorageService(supabase_client)

    async def run_pipeline(
        self,
        source_id: str,
        documents: list[dict],
        source_type: str = "url",
        chunk_size: int = 5000,
        embedder_id: str | None = None,
        summarizer_model_id: str | None = None,
        summary_style: str = "overview",
        progress_callback: Callable | None = None,
    ) -> dict[str, Any]:
        """
        Run the full ingestion pipeline.

        Args:
            source_id: The source identifier
            documents: List of {url, content, title, ...}
            source_type: Type of source (url, git, file)
            chunk_size: Size of chunks
            embedder_id: Embedding model to use
            summarizer_model_id: Model for summarization
            style: Summary style (overview, technical, user, brief)
            progress_callback: Optional progress callback

        Returns:
            Pipeline result with blob/chunk counts and queue info
        """
        await self.state_service.update_source_pipeline_status(source_id, PipelineStatus.CHUNKING)

        try:
            total_blobs = 0
            total_chunks = 0

            for doc in documents:
                content = doc.get("content") or doc.get("markdown") or ""
                url = doc.get("url", "")

                if not content:
                    continue

                blob = await self.state_service.create_document_blob(
                    source_id=source_id,
                    source_type=source_type,
                    blob_uri=url,
                    content=content,
                )
                if not blob.id:
                    continue
                total_blobs += 1

                chunks = await self.storage_service.smart_chunk_text_async(content, chunk_size)

                start_offsets = []
                current_offset = 0
                for chunk in chunks:
                    start_offsets.append(current_offset)
                    current_offset += len(chunk)

                await self.state_service.create_chunks(blob.id, chunks, start_offsets)
                total_chunks += len(chunks)

                if progress_callback:
                    await progress_callback(
                        "chunking",
                        min(50, total_chunks),
                        f"Processed {total_blobs} documents, {total_chunks} chunks",
                    )

            embedding_set = await self._queue_embedding(
                source_id,
                total_chunks,
                embedder_id,
            )

            summary = await self._queue_summary(
                source_id,
                summarizer_model_id,
                summary_style,
            )

            await self.state_service.update_source_pipeline_status(source_id, PipelineStatus.EMBEDDING)

            return {
                "status": "pipelines_queued",
                "source_id": source_id,
                "blobs_created": total_blobs,
                "chunks_created": total_chunks,
                "embedding_set_id": str(embedding_set.id) if embedding_set else None,
                "summary_id": str(summary.id) if summary else None,
                "message": "Embedding and summarization queued as separate passes",
            }

        except Exception as e:
            await self.state_service.update_source_pipeline_status(
                source_id,
                PipelineStatus.ERROR,
                error_info={"stage": "pipeline_orchestration", "error": str(e)},
            )
            raise

    async def _queue_embedding(
        self,
        source_id: str,
        total_chunks: int,
        embedder_id: str | None,
    ):
        try:
            rag_settings = await credential_service.get_credentials_by_category("rag_strategy")
            embedding_provider = rag_settings.get("EMBEDDING_PROVIDER", "openai")

            if not embedder_id:
                embedder_id = await get_embedding_model(provider=embedding_provider)

            embedding_dimensions = int(rag_settings.get("EMBEDDING_DIMENSIONS", "1536"))

            embedding_config = {
                "provider": embedding_provider,
                "dimensions": embedding_dimensions,
            }

            embedding_set = await self.state_service.create_embedding_set(
                source_id=source_id,
                embedder_id=embedder_id,
                embedder_version=None,
                embedder_config=embedding_config,
                total_chunk_count=total_chunks,
                embedding_dimension=embedding_dimensions,
            )

            safe_logfire_info(f"Created embedding set {embedding_set.id} for source {source_id}")
            return embedding_set

        except Exception as e:
            safe_logfire_error(f"Failed to queue embedding: {e}")
            return None

    async def _queue_summary(
        self,
        source_id: str,
        summarizer_model_id: str | None,
        style: str,
    ):
        try:
            model_id: str = summarizer_model_id or ""
            if not model_id:
                rag_settings = await credential_service.get_credentials_by_category("rag_strategy")
                model_id = rag_settings.get("MODEL_CHOICE", "gpt-4.1-nano")

            summary = await self.state_service.create_summary(
                source_id=source_id,
                summarizer_model_id=model_id,
                summarizer_version=None,
                prompt_template_id=f"default_{style}",
                prompt_text=f"Style: {style}",
                style=style,
            )

            safe_logfire_info(f"Created summary record {summary.id} for source {source_id}")
            return summary

        except Exception as e:
            safe_logfire_error(f"Failed to queue summary: {e}")
            return None


def get_pipeline_orchestrator(supabase_client: Client) -> PipelineOrchestrator:
    return PipelineOrchestrator(supabase_client)
