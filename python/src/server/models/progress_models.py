"""Standardized progress response models for consistent API responses."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ProgressDetails(BaseModel):
    """Detailed progress information for granular tracking."""

    current_chunk: int | None = Field(None, alias="currentChunk")
    total_chunks: int | None = Field(None, alias="totalChunks")
    current_batch: int | None = Field(None, alias="currentBatch")
    total_batches: int | None = Field(None, alias="totalBatches")
    current_operation: str | None = Field(None, alias="currentOperation")
    chunks_per_second: float | None = Field(None, alias="chunksPerSecond")
    estimated_time_remaining: int | None = Field(None, alias="estimatedTimeRemaining")
    elapsed_time: int | None = Field(None, alias="elapsedTime")
    pages_crawled: int | None = Field(None, alias="pagesCrawled")
    total_pages: int | None = Field(None, alias="totalPages")
    embeddings_created: int | None = Field(None, alias="embeddingsCreated")
    code_blocks_found: int | None = Field(None, alias="codeBlocksFound")

    model_config = ConfigDict(populate_by_name=True)


class BaseProgressResponse(BaseModel):
    """Base progress response with common fields."""

    progress_id: str = Field(alias="progressId")
    status: str
    progress: float = Field(ge=0, le=100, description="Progress percentage 0-100")
    message: str = ""
    error: str | None = None

    # Current operation details
    current_step: str | None = Field(None, alias="currentStep")
    step_message: str | None = Field(None, alias="stepMessage")
    logs: list[str] = Field(default_factory=list)
    details: ProgressDetails | None = None

    @field_validator("logs", mode="before")
    @classmethod
    def ensure_logs_is_list(cls, v):
        """Ensure logs is always a list of strings, converting from dict if necessary."""
        if v is None:
            return []
        if isinstance(v, str):
            return [v]
        if isinstance(v, list):
            # Convert list of dicts to list of strings if needed
            result = []
            for item in v:
                if isinstance(item, str):
                    result.append(item)
                elif isinstance(item, dict):
                    # Extract the message from the log dict
                    message = item.get('message', str(item))
                    result.append(message)
                else:
                    result.append(str(item))
            return result
        return []

    model_config = ConfigDict(populate_by_name=True)  # Accept both snake_case and camelCase


class CrawlProgressResponse(BaseProgressResponse):
    """Progress response for crawl operations."""

    status: Literal[
        "starting", "analyzing", "crawling", "processing",
        "source_creation", "document_storage", "code_extraction", "code_storage",
        "finalization", "completed", "failed", "cancelled", "stopping", "error"
    ]

    # Crawl-specific fields
    current_url: str | None = Field(None, alias="currentUrl")
    total_pages: int = Field(0, alias="totalPages")
    processed_pages: int = Field(0, alias="processedPages")
    crawl_type: str | None = Field(None, alias="crawlType")  # 'normal', 'sitemap', 'llms-txt', 'refresh'

    # Code extraction specific fields
    code_blocks_found: int = Field(0, alias="codeBlocksFound")
    code_examples_stored: int = Field(0, alias="codeExamplesStored")
    completed_documents: int = Field(0, alias="completedDocuments")
    total_documents: int = Field(0, alias="totalDocuments")
    completed_summaries: int = Field(0, alias="completedSummaries")
    total_summaries: int = Field(0, alias="totalSummaries")

    # Batch processing fields
    parallel_workers: int | None = Field(None, alias="parallelWorkers")
    total_jobs: int | None = Field(None, alias="totalJobs")
    total_batches: int | None = Field(None, alias="totalBatches")
    completed_batches: int = Field(0, alias="completedBatches")
    active_workers: int = Field(0, alias="activeWorkers")
    current_batch: int | None = Field(None, alias="currentBatch")
    chunks_in_batch: int = Field(0, alias="chunksInBatch")
    total_chunks_in_batch: int | None = Field(None, alias="totalChunksInBatch")

    # Results (when completed)
    chunks_stored: int | None = Field(None, alias="chunksStored")
    word_count: int | None = Field(None, alias="wordCount")
    source_id: str | None = Field(None, alias="sourceId")
    duration: str | None = None

    @field_validator("duration", mode="before")
    @classmethod
    def convert_duration_to_string(cls, v):
        """Convert duration to string if it's a float."""
        if v is None:
            return None
        if isinstance(v, int | float):
            return str(v)
        return v

    model_config = ConfigDict(populate_by_name=True)  # Accept both snake_case and camelCase


class UploadProgressResponse(BaseProgressResponse):
    """Progress response for document upload operations."""

    status: Literal[
        "starting", "reading", "text_extraction", "chunking",
        "source_creation", "summarizing", "storing",
        "completed", "failed", "cancelled", "error"
    ]

    # Upload-specific fields
    upload_type: Literal["document"] = Field("document", alias="uploadType")
    file_name: str | None = Field(None, alias="fileName")
    file_type: str | None = Field(None, alias="fileType")

    # Results (when completed)
    chunks_stored: int | None = Field(None, alias="chunksStored")
    word_count: int | None = Field(None, alias="wordCount")
    source_id: str | None = Field(None, alias="sourceId")

    model_config = ConfigDict(populate_by_name=True)  # Accept both snake_case and camelCase


class ProjectCreationProgressResponse(BaseProgressResponse):
    """Progress response for project creation operations."""

    status: Literal[
        "starting", "analyzing", "generating_prp", "creating_tasks",
        "organizing", "completed", "failed", "error"
    ]

    # Project creation specific
    project_title: str | None = Field(None, alias="projectTitle")
    tasks_created: int = Field(0, alias="tasksCreated")
    total_tasks_planned: int | None = Field(None, alias="totalTasksPlanned")

    model_config = ConfigDict(populate_by_name=True)  # Accept both snake_case and camelCase


def create_progress_response(
    operation_type: str,
    progress_data: dict[str, Any]
) -> BaseProgressResponse:
    """
    Factory function to create the appropriate progress response based on operation type.

    Args:
        operation_type: Type of operation (crawl, upload, project_creation)
        progress_data: Raw progress data from ProgressTracker

    Returns:
        Appropriate progress response model
    """
    # Map operation types to response models
    response_models = {
        "crawl": CrawlProgressResponse,
        "upload": UploadProgressResponse,
        "project_creation": ProjectCreationProgressResponse,
    }

    # Get the appropriate model or default to base
    model_class = response_models.get(operation_type, BaseProgressResponse)

    # Ensure essential fields have defaults if missing
    if "status" not in progress_data:
        progress_data["status"] = "starting"
    if "progress" not in progress_data:
        progress_data["progress"] = 0
    if "message" not in progress_data and "log" in progress_data:
        progress_data["message"] = progress_data["log"]

    # Build details object from various progress fields
    details_data = {}

    # Map snake_case fields to camelCase for details
    detail_field_mappings = {
        "current_chunk": "currentChunk",
        "total_chunks": "totalChunks",
        "current_batch": "currentBatch",
        "total_batches": "totalBatches",
        "current_operation": "currentOperation",
        "chunks_per_second": "chunksPerSecond",
        "estimated_time_remaining": "estimatedTimeRemaining",
        "elapsed_time": "elapsedTime",
        "pages_crawled": "pagesCrawled",
        "processed_pages": "pagesCrawled",  # Alternative name
        "total_pages": "totalPages",
        "embeddings_created": "embeddingsCreated",
        "code_blocks_found": "codeBlocksFound",
    }

    for snake_field, camel_field in detail_field_mappings.items():
        if snake_field in progress_data:
            # Use the camelCase name since ProgressDetails expects it
            details_data[camel_field] = progress_data[snake_field]

    # (removed redundant remapping; handled via detail_field_mappings)

    # Create details object if we have any detail fields
    if details_data:
        progress_data["details"] = ProgressDetails(**details_data)

    # Create the response, the model will handle field mapping
    try:
        # Debug logging for code extraction fields
        if operation_type == "crawl" and "completed_summaries" in progress_data:
            from ..config.logfire_config import get_logger
            logger = get_logger(__name__)
            logger.info(f"Code extraction progress fields present: completed_summaries={progress_data.get('completed_summaries')}, total_summaries={progress_data.get('total_summaries')}")

        return model_class(**progress_data)
    except Exception as e:
        # Log validation errors for debugging
        from ..config.logfire_config import get_logger
        logger = get_logger(__name__)
        logger.error(f"Failed to create {model_class.__name__}: {e}", exc_info=True)

        essential_fields = {
            "progress_id": progress_data.get("progress_id", "unknown"),
            "status": progress_data.get("status", "running"),
            "progress": progress_data.get("progress", 0),
            "message": progress_data.get("message", progress_data.get("log", "")),
            "error": progress_data.get("error"),
        }
        return BaseProgressResponse(**essential_fields)
