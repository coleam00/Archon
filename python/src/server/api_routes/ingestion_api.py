"""
Ingestion Pipeline API

Provides endpoints to trigger and monitor the restartable RAG ingestion pipeline.
"""

from fastapi import APIRouter, Depends
from supabase import Client

from ..services.ingestion.embedding_worker import get_embedding_worker
from ..services.ingestion.health_check import get_ingestion_health_check
from ..services.ingestion.summary_worker import get_summary_worker
from ..utils import get_supabase_client

router = APIRouter(prefix="/api/ingestion", tags=["ingestion"])


@router.post("/process-embeddings")
async def process_pending_embeddings(
    max_batch_size: int = 10,
    embedder_id: str | None = None,
    provider: str | None = None,
    supabase: Client = Depends(get_supabase_client),
):
    """
    Manually trigger processing of pending embedding sets.

    Args:
        max_batch_size: Maximum number of embedding sets to process
        embedder_id: Optional filter by specific embedder
        provider: Optional embedding provider override

    Returns:
        Processing results with counts
    """
    worker = get_embedding_worker(supabase)
    result = await worker.process_pending_embeddings(
        embedder_id=embedder_id,
        max_batch_size=max_batch_size,
        provider=provider,
    )
    return result


@router.post("/process-summaries")
async def process_pending_summaries(
    max_batch_size: int = 10,
    summarizer_model_id: str | None = None,
    style: str | None = None,
    supabase: Client = Depends(get_supabase_client),
):
    """
    Manually trigger processing of pending summaries.

    Args:
        max_batch_size: Maximum number of summaries to process
        summarizer_model_id: Optional filter by model
        style: Optional filter by summary style

    Returns:
        Processing results with counts
    """
    worker = get_summary_worker(supabase)
    result = await worker.process_pending_summaries(
        summarizer_model_id=summarizer_model_id,
        style=style,
        max_batch_size=max_batch_size,
    )
    return result


@router.get("/health/{source_id}")
async def check_source_health(
    source_id: str,
    supabase: Client = Depends(get_supabase_client),
):
    """
    Check health of a specific source's ingestion pipeline.

    Returns issues and warnings found.
    """
    health_check = get_ingestion_health_check(supabase)
    result = await health_check.check_source_health(source_id)
    return result


@router.get("/health")
async def check_all_sources_health(
    supabase: Client = Depends(get_supabase_client),
):
    """
    Check health of all sources.

    Returns aggregate health statistics.
    """
    health_check = get_ingestion_health_check(supabase)
    result = await health_check.check_all_sources()
    return result


@router.post("/retry-failed-embeddings")
async def retry_failed_embeddings(
    embedder_id: str | None = None,
    supabase: Client = Depends(get_supabase_client),
):
    """
    Reset failed embedding sets back to pending for retry.

    Args:
        embedder_id: Optional filter by specific embedder

    Returns:
        Number of embedding sets reset
    """
    worker = get_embedding_worker(supabase)
    result = await worker.retry_failed_embeddings(embedder_id=embedder_id)
    return result


@router.post("/retry-failed-summaries")
async def retry_failed_summaries(
    summarizer_model_id: str | None = None,
    style: str | None = None,
    supabase: Client = Depends(get_supabase_client),
):
    """
    Reset failed summaries back to pending for retry.

    Args:
        summarizer_model_id: Optional filter by model
        style: Optional filter by summary style

    Returns:
        Number of summaries reset
    """
    worker = get_summary_worker(supabase)
    result = await worker.retry_failed_summaries(
        summarizer_model_id=summarizer_model_id,
        style=style,
    )
    return result
