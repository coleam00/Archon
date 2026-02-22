"""
Ingestion Services

Provides restartable, separable pipeline stages for RAG ingestion:
- Document blobs (raw downloaded content)
- Chunks (chunked content)
- Embedding sets + embeddings (with full metadata)
- Summaries (with full metadata)
"""

from .embedding_worker import EmbeddingWorker, get_embedding_worker
from .health_check import IngestionHealthCheck, get_ingestion_health_check
from .ingestion_state_service import (
    Chunk,
    DocumentBlob,
    DownloadStatus,
    EmbeddingSet,
    EmbeddingStatus,
    IngestionStateService,
    PipelineStatus,
    Summary,
    SummaryStatus,
    SummaryStyle,
    get_ingestion_state_service,
)
from .pipeline_orchestrator import PipelineOrchestrator, get_pipeline_orchestrator
from .summary_worker import SummaryWorker, get_summary_worker

__all__ = [
    "EmbeddingWorker",
    "get_embedding_worker",
    "SummaryWorker",
    "get_summary_worker",
    "PipelineOrchestrator",
    "get_pipeline_orchestrator",
    "IngestionHealthCheck",
    "get_ingestion_health_check",
    "IngestionStateService",
    "get_ingestion_state_service",
    "DocumentBlob",
    "Chunk",
    "EmbeddingSet",
    "Summary",
    "DownloadStatus",
    "EmbeddingStatus",
    "SummaryStatus",
    "PipelineStatus",
    "SummaryStyle",
]
