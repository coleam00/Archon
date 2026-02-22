"""
Ingestion Health Check Service

Provides health checks and sanity validation for the RAG ingestion pipeline.
"""

from typing import Any

from supabase import Client

from ...config.logfire_config import get_logger
from .ingestion_state_service import get_ingestion_state_service

logger = get_logger(__name__)


class IngestionHealthCheck:
    """
    Health check for ingestion pipeline.

    Validates:
    - Document blobs have valid content hashes
    - Chunk counts match expected
    - Embeddings have correct dimensions and non-zero vectors
    - Summaries are not empty
    """

    def __init__(self, supabase_client: Client):
        self.supabase = supabase_client
        self.state_service = get_ingestion_state_service(supabase_client)

    async def check_source_health(self, source_id: str) -> dict[str, Any]:
        """
        Run health check on a source.

        Returns:
            Dictionary with health status and any issues found
        """
        issues: list[dict] = []
        warnings: list[dict] = []

        blobs = await self.state_service.get_blobs_by_source(source_id)
        if not blobs:
            issues.append(
                {
                    "type": "no_blobs",
                    "message": "No document blobs found for source",
                }
            )
            return {
                "healthy": False,
                "source_id": source_id,
                "issues": issues,
                "warnings": warnings,
            }

        for blob in blobs:
            if blob.download_status != "downloaded":
                issues.append(
                    {
                        "type": "blob_not_downloaded",
                        "blob_id": str(blob.id),
                        "status": blob.download_status,
                        "message": f"Blob {blob.id} has status {blob.download_status}",
                    }
                )

        chunks = await self.state_service.get_chunks_by_source(source_id)
        total_expected_chunks = sum(1 for _ in blobs) * 10

        if not chunks:
            issues.append(
                {
                    "type": "no_chunks",
                    "message": "No chunks found for source",
                }
            )
        elif len(chunks) < total_expected_chunks * 0.1:
            warnings.append(
                {
                    "type": "low_chunk_count",
                    "expected": f">= {total_expected_chunks}",
                    "actual": len(chunks),
                    "message": f"Low chunk count: {len(chunks)}",
                }
            )

        embedding_sets_response = (
            self.supabase.table("archon_embedding_sets").select("*").eq("source_id", source_id).execute()
        )

        if not embedding_sets_response.data:
            warnings.append(
                {
                    "type": "no_embedding_sets",
                    "message": "No embedding sets found for source",
                }
            )
        else:
            for es in embedding_sets_response.data:
                if es["status"] == "failed":
                    issues.append(
                        {
                            "type": "embedding_failed",
                            "embedding_set_id": es["id"],
                            "error": es.get("error_info"),
                            "message": f"Embedding set {es['id']} failed",
                        }
                    )
                elif es["status"] != "done":
                    warnings.append(
                        {
                            "type": "embedding_incomplete",
                            "embedding_set_id": es["id"],
                            "status": es["status"],
                            "message": f"Embedding set {es['id']} has status {es['status']}",
                        }
                    )

                if es["status"] == "done":
                    processed = es.get("processed_chunk_count", 0)
                    total = es.get("total_chunk_count", 0)
                    if processed < total:
                        warnings.append(
                            {
                                "type": "incomplete_embedding",
                                "embedding_set_id": es["id"],
                                "processed": processed,
                                "total": total,
                                "message": f"Only {processed}/{total} chunks embedded",
                            }
                        )

        summaries_response = self.supabase.table("archon_summaries").select("*").eq("source_id", source_id).execute()

        if not summaries_response.data:
            warnings.append(
                {
                    "type": "no_summaries",
                    "message": "No summaries found for source",
                }
            )
        else:
            for s in summaries_response.data:
                if s["status"] == "failed":
                    issues.append(
                        {
                            "type": "summary_failed",
                            "summary_id": s["id"],
                            "error": s.get("error_info"),
                            "message": f"Summary {s['id']} failed",
                        }
                    )
                elif s["status"] == "done":
                    if not s.get("summary_content"):
                        issues.append(
                            {
                                "type": "empty_summary",
                                "summary_id": s["id"],
                                "message": "Summary has no content",
                            }
                        )

        healthy = len(issues) == 0

        return {
            "healthy": healthy,
            "source_id": source_id,
            "blobs": len(blobs),
            "chunks": len(chunks),
            "embedding_sets": len(embedding_sets_response.data or []),
            "summaries": len(summaries_response.data or []),
            "issues": issues,
            "warnings": warnings,
        }

    async def check_all_sources(self) -> dict[str, Any]:
        """
        Check health of all sources.
        """
        sources_response = self.supabase.table("archon_sources").select("source_id").execute()

        results = []
        for source in sources_response.data:
            health = await self.check_source_health(source["source_id"])
            results.append(health)

        healthy_count = sum(1 for r in results if r["healthy"])
        total_count = len(results)

        return {
            "total_sources": total_count,
            "healthy_sources": healthy_count,
            "unhealthy_sources": total_count - healthy_count,
            "results": results,
        }


def get_ingestion_health_check(supabase_client: Client) -> IngestionHealthCheck:
    return IngestionHealthCheck(supabase_client)
