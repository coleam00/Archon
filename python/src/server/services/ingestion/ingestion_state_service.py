"""
Ingestion Pipeline State Service

Manages the state machine for the RAG ingestion pipeline.
Provides checkpointing, restartability, and metadata tracking for:
- Document blobs (downloaded content)
- Chunks (chunked content)
- Embedding sets (embeddings with metadata)
- Summaries (summaries with metadata)
"""

import hashlib
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any

from supabase import Client

from ...config.logfire_config import get_logger

logger = get_logger(__name__)


class DownloadStatus(str, Enum):
    PENDING = "pending"
    DOWNLOADING = "downloading"
    DOWNLOADED = "downloaded"
    FAILED = "failed"


class EmbeddingStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    DONE = "done"
    FAILED = "failed"


class SummaryStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    DONE = "done"
    FAILED = "failed"


class PipelineStatus(str, Enum):
    IDLE = "idle"
    DOWNLOADING = "downloading"
    CHUNKING = "chunking"
    EMBEDDING = "embedding"
    SUMMARIZING = "summarizing"
    COMPLETE = "complete"
    ERROR = "error"


class SummaryStyle(str, Enum):
    TECHNICAL = "technical"
    OVERVIEW = "overview"
    USER = "user"
    BRIEF = "brief"


@dataclass
class DocumentBlob:
    id: uuid.UUID | None = None
    source_id: str = ""
    source_type: str = "url"
    blob_uri: str = ""
    content_hash: str = ""
    content_length: int | None = None
    download_status: str = "pending"
    download_error: dict | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass
class Chunk:
    id: uuid.UUID | None = None
    blob_id: uuid.UUID | None = None
    chunk_index: int = 0
    start_offset: int | None = None
    end_offset: int | None = None
    content: str = ""
    token_count: int | None = None
    created_at: datetime | None = None


@dataclass
class EmbeddingSet:
    id: uuid.UUID | None = None
    source_id: str = ""
    embedder_id: str = ""
    embedder_version: str | None = None
    embedder_config: dict = field(default_factory=dict)
    status: str = "pending"
    error_info: dict | None = None
    embedding_dimension: int | None = None
    processed_chunk_count: int = 0
    total_chunk_count: int = 0
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass
class Summary:
    id: uuid.UUID | None = None
    source_id: str = ""
    summarizer_model_id: str = ""
    summarizer_version: str | None = None
    prompt_template_id: str | None = None
    prompt_hash: str | None = None
    style: str = "overview"
    status: str = "pending"
    error_info: dict | None = None
    summary_content: str = ""
    created_at: datetime | None = None
    updated_at: datetime | None = None


class IngestionStateService:
    def __init__(self, supabase_client: Client):
        self.supabase = supabase_client

    async def create_document_blob(
        self,
        source_id: str,
        source_type: str,
        blob_uri: str,
        content: str,
    ) -> DocumentBlob:
        content_hash = hashlib.sha256(content.encode()).hexdigest()
        content_length = len(content)

        response = (
            self.supabase.table("archon_document_blobs")
            .insert(
                {
                    "source_id": source_id,
                    "source_type": source_type,
                    "blob_uri": blob_uri,
                    "content_hash": content_hash,
                    "content_length": content_length,
                    "download_status": "downloaded",
                }
            )
            .execute()
        )

        if response.data:
            row = response.data[0]
            return DocumentBlob(
                id=uuid.UUID(row["id"]),
                source_id=row["source_id"],
                source_type=row["source_type"],
                blob_uri=row["blob_uri"],
                content_hash=row["content_hash"],
                content_length=row["content_length"],
                download_status=row["download_status"],
                created_at=row.get("created_at"),
                updated_at=row.get("updated_at"),
            )
        raise Exception("Failed to create document blob")

    async def get_document_blob(self, blob_id: uuid.UUID) -> DocumentBlob | None:
        response = self.supabase.table("archon_document_blobs").select("*").eq("id", str(blob_id)).execute()
        if response.data:
            row = response.data[0]
            return DocumentBlob(
                id=uuid.UUID(row["id"]),
                source_id=row["source_id"],
                source_type=row["source_type"],
                blob_uri=row["blob_uri"],
                content_hash=row["content_hash"],
                content_length=row.get("content_length"),
                download_status=row["download_status"],
                download_error=row.get("download_error"),
                created_at=row.get("created_at"),
                updated_at=row.get("updated_at"),
            )
        return None

    async def get_blobs_by_source(self, source_id: str, status: str | None = None) -> list[DocumentBlob]:
        query = self.supabase.table("archon_document_blobs").select("*").eq("source_id", source_id)
        if status:
            query = query.eq("download_status", status)
        response = query.execute()
        return [
            DocumentBlob(
                id=uuid.UUID(row["id"]),
                source_id=row["source_id"],
                source_type=row["source_type"],
                blob_uri=row["blob_uri"],
                content_hash=row["content_hash"],
                content_length=row.get("content_length"),
                download_status=row["download_status"],
                download_error=row.get("download_error"),
                created_at=row.get("created_at"),
                updated_at=row.get("updated_at"),
            )
            for row in response.data
        ]

    async def create_chunks(
        self,
        blob_id: uuid.UUID,
        chunks: list[str],
        start_offsets: list[int] | None = None,
    ) -> list[Chunk]:
        chunk_records = []
        for i, content in enumerate(chunks):
            record = {
                "blob_id": str(blob_id),
                "chunk_index": i,
                "content": content,
                "token_count": len(content.split()) * 4 // 3,
            }
            if start_offsets and i < len(start_offsets):
                record["start_offset"] = start_offsets[i]
                record["end_offset"] = start_offsets[i] + len(content)
            chunk_records.append(record)

        response = self.supabase.table("archon_chunks").insert(chunk_records).execute()

        return [
            Chunk(
                id=uuid.UUID(row["id"]),
                blob_id=uuid.UUID(row["blob_id"]),
                chunk_index=row["chunk_index"],
                start_offset=row.get("start_offset"),
                end_offset=row.get("end_offset"),
                content=row["content"],
                token_count=row.get("token_count"),
                created_at=row.get("created_at"),
            )
            for row in response.data
        ]

    async def get_chunks_by_blob(self, blob_id: uuid.UUID) -> list[Chunk]:
        response = (
            self.supabase.table("archon_chunks").select("*").eq("blob_id", str(blob_id)).order("chunk_index").execute()
        )
        return [
            Chunk(
                id=uuid.UUID(row["id"]),
                blob_id=uuid.UUID(row["blob_id"]),
                chunk_index=row["chunk_index"],
                start_offset=row.get("start_offset"),
                end_offset=row.get("end_offset"),
                content=row["content"],
                token_count=row.get("token_count"),
                created_at=row.get("created_at"),
            )
            for row in response.data
        ]

    async def get_chunks_by_source(self, source_id: str) -> list[Chunk]:
        response = (
            self.supabase.table("archon_chunks")
            .select("archon_chunks.*, archon_document_blobs.source_id")
            .eq("archon_document_blobs.source_id", source_id)
            .execute()
        )
        return [
            Chunk(
                id=uuid.UUID(row["id"]),
                blob_id=uuid.UUID(row["blob_id"]),
                chunk_index=row["chunk_index"],
                start_offset=row.get("start_offset"),
                end_offset=row.get("end_offset"),
                content=row["content"],
                token_count=row.get("token_count"),
                created_at=row.get("created_at"),
            )
            for row in response.data
        ]

    async def create_embedding_set(
        self,
        source_id: str,
        embedder_id: str,
        embedder_version: str | None,
        embedder_config: dict,
        total_chunk_count: int,
        embedding_dimension: int,
    ) -> EmbeddingSet:
        response = (
            self.supabase.table("archon_embedding_sets")
            .insert(
                {
                    "source_id": source_id,
                    "embedder_id": embedder_id,
                    "embedder_version": embedder_version,
                    "embedder_config": embedder_config,
                    "status": "pending",
                    "total_chunk_count": total_chunk_count,
                    "embedding_dimension": embedding_dimension,
                }
            )
            .execute()
        )

        if response.data:
            row = response.data[0]
            return EmbeddingSet(
                id=uuid.UUID(row["id"]),
                source_id=row["source_id"],
                embedder_id=row["embedder_id"],
                embedder_version=row.get("embedder_version"),
                embedder_config=row.get("embedder_config", {}),
                status=row["status"],
                embedding_dimension=row.get("embedding_dimension"),
                processed_chunk_count=row.get("processed_chunk_count", 0),
                total_chunk_count=row.get("total_chunk_count", 0),
                created_at=row.get("created_at"),
                updated_at=row.get("updated_at"),
            )
        raise Exception("Failed to create embedding set")

    async def get_embedding_set(self, set_id: uuid.UUID) -> EmbeddingSet | None:
        response = self.supabase.table("archon_embedding_sets").select("*").eq("id", str(set_id)).execute()
        if response.data:
            row = response.data[0]
            return EmbeddingSet(
                id=uuid.UUID(row["id"]),
                source_id=row["source_id"],
                embedder_id=row["embedder_id"],
                embedder_version=row.get("embedder_version"),
                embedder_config=row.get("embedder_config", {}),
                status=row["status"],
                error_info=row.get("error_info"),
                embedding_dimension=row.get("embedding_dimension"),
                processed_chunk_count=row.get("processed_chunk_count", 0),
                total_chunk_count=row.get("total_chunk_count", 0),
                created_at=row.get("created_at"),
                updated_at=row.get("updated_at"),
            )
        return None

    async def get_pending_embedding_sets(self, embedder_id: str | None = None) -> list[EmbeddingSet]:
        query = self.supabase.table("archon_embedding_sets").select("*").eq("status", "pending")
        if embedder_id:
            query = query.eq("embedder_id", embedder_id)
        response = query.execute()
        return [
            EmbeddingSet(
                id=uuid.UUID(row["id"]),
                source_id=row["source_id"],
                embedder_id=row["embedder_id"],
                embedder_version=row.get("embedder_version"),
                embedder_config=row.get("embedder_config", {}),
                status=row["status"],
                embedding_dimension=row.get("embedding_dimension"),
                processed_chunk_count=row.get("processed_chunk_count", 0),
                total_chunk_count=row.get("total_chunk_count", 0),
                created_at=row.get("created_at"),
                updated_at=row.get("updated_at"),
            )
            for row in response.data
        ]

    async def update_embedding_set_status(
        self,
        set_id: uuid.UUID,
        status: str,
        processed_chunk_count: int | None = None,
        error_info: dict | None = None,
    ) -> None:
        update_data: dict[str, Any] = {
            "status": status,
            "updated_at": datetime.now(UTC).isoformat(),
        }
        if processed_chunk_count is not None:
            update_data["processed_chunk_count"] = processed_chunk_count
        if error_info is not None:
            update_data["error_info"] = error_info

        self.supabase.table("archon_embedding_sets").update(update_data).eq("id", str(set_id)).execute()

    async def store_embeddings(
        self, embedding_set_id: uuid.UUID, chunk_embeddings: list[tuple[uuid.UUID, list[float]]]
    ) -> int:
        records = [
            {
                "chunk_id": str(chunk_id),
                "embedding_set_id": str(embedding_set_id),
                "vector": embedding,
            }
            for chunk_id, embedding in chunk_embeddings
        ]

        response = self.supabase.table("archon_embeddings").insert(records).execute()
        return len(response.data) if response.data else 0

    async def get_embeddings_by_set(self, embedding_set_id: uuid.UUID) -> list[tuple[uuid.UUID, list[float]]]:
        response = (
            self.supabase.table("archon_embeddings")
            .select("chunk_id, vector")
            .eq("embedding_set_id", str(embedding_set_id))
            .execute()
        )
        return [(uuid.UUID(row["chunk_id"]), row["vector"]) for row in response.data]

    async def create_summary(
        self,
        source_id: str,
        summarizer_model_id: str,
        summarizer_version: str | None,
        prompt_template_id: str,
        prompt_text: str,
        style: str,
    ) -> Summary:
        prompt_hash = hashlib.sha256(prompt_text.encode()).hexdigest()

        response = (
            self.supabase.table("archon_summaries")
            .insert(
                {
                    "source_id": source_id,
                    "summarizer_model_id": summarizer_model_id,
                    "summarizer_version": summarizer_version,
                    "prompt_template_id": prompt_template_id,
                    "prompt_hash": prompt_hash,
                    "style": style,
                    "status": "pending",
                }
            )
            .execute()
        )

        if response.data:
            row = response.data[0]
            return Summary(
                id=uuid.UUID(row["id"]),
                source_id=row["source_id"],
                summarizer_model_id=row["summarizer_model_id"],
                summarizer_version=row.get("summarizer_version"),
                prompt_template_id=row.get("prompt_template_id"),
                prompt_hash=row.get("prompt_hash"),
                style=row["style"],
                status=row["status"],
                created_at=row.get("created_at"),
                updated_at=row.get("updated_at"),
            )
        raise Exception("Failed to create summary record")

    async def get_pending_summaries(
        self,
        summarizer_model_id: str | None = None,
        style: str | None = None,
    ) -> list[Summary]:
        query = self.supabase.table("archon_summaries").select("*").eq("status", "pending")
        if summarizer_model_id:
            query = query.eq("summarizer_model_id", summarizer_model_id)
        if style:
            query = query.eq("style", style)
        response = query.execute()
        return [
            Summary(
                id=uuid.UUID(row["id"]),
                source_id=row["source_id"],
                summarizer_model_id=row["summarizer_model_id"],
                summarizer_version=row.get("summarizer_version"),
                prompt_template_id=row.get("prompt_template_id"),
                prompt_hash=row.get("prompt_hash"),
                style=row["style"],
                status=row["status"],
                summary_content=row.get("summary_content", ""),
                created_at=row.get("created_at"),
                updated_at=row.get("updated_at"),
            )
            for row in response.data
        ]

    async def update_summary(
        self,
        summary_id: uuid.UUID,
        status: str,
        summary_content: str | None = None,
        error_info: dict | None = None,
    ) -> None:
        update_data: dict[str, Any] = {
            "status": status,
            "updated_at": datetime.now(UTC).isoformat(),
        }
        if summary_content is not None:
            update_data["summary_content"] = summary_content
        if error_info is not None:
            update_data["error_info"] = error_info

        self.supabase.table("archon_summaries").update(update_data).eq("id", str(summary_id)).execute()

    async def update_source_pipeline_status(
        self,
        source_id: str,
        status: str,
        error_info: dict | None = None,
    ) -> None:
        update_data: dict[str, Any] = {"pipeline_status": status}
        if error_info:
            update_data["pipeline_error"] = error_info
        if status == "complete":
            update_data["pipeline_completed_at"] = datetime.now(UTC).isoformat()
        elif status == "error":
            update_data["pipeline_error"] = error_info

        self.supabase.table("archon_sources").update(update_data).eq("source_id", source_id).execute()


def get_ingestion_state_service(supabase_client: Client) -> IngestionStateService:
    return IngestionStateService(supabase_client)
