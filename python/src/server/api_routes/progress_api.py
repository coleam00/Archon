"""Progress API endpoints for polling operation status."""

from datetime import datetime
from email.utils import formatdate

from fastapi import APIRouter, Header, HTTPException, Response
from fastapi import status as http_status

from ..config.logfire_config import get_logger, logfire
from ..models.progress_models import create_progress_response
from ..utils.etag_utils import check_etag, generate_etag
from ..utils.progress import ProgressTracker

logger = get_logger(__name__)

router = APIRouter(prefix="/api/progress", tags=["progress"])

# Terminal states that don't require further polling
TERMINAL_STATES = {"completed", "failed", "error", "cancelled"}


@router.get("/{operation_id}")
async def get_progress(
    operation_id: str,
    response: Response,
    if_none_match: str | None = Header(None)
):
    """
    Get progress for an operation with ETag support.

    Returns progress state with percentage, status, and message.
    Clients should poll this endpoint to track long-running operations.
    """
    try:
        logfire.info(f"Getting progress for operation | operation_id={operation_id}")

        # Get operation progress from ProgressTracker
        operation = ProgressTracker.get_progress(operation_id)

        if not operation:
            logfire.warning(f"Operation not found | operation_id={operation_id}")
            raise HTTPException(
                status_code=404,
                detail={"error": f"Operation {operation_id} not found"}
            )


        # Ensure we have the progress_id in the response without mutating shared state
        operation_with_id = {**operation, "progress_id": operation_id}

        # Get operation type for proper model selection
        operation_type = operation.get("type", "crawl")

        # Create standardized response using Pydantic model
        progress_response = create_progress_response(operation_type, operation_with_id)


        # Convert to dict with camelCase fields for API response
        response_data = progress_response.model_dump(by_alias=True, exclude_none=True)

        # Debug logging for code extraction fields
        if operation_type == "crawl" and operation.get("status") == "code_extraction":
            logger.info(f"Code extraction response fields: completedSummaries={response_data.get('completedSummaries')}, totalSummaries={response_data.get('totalSummaries')}, codeBlocksFound={response_data.get('codeBlocksFound')}")

        # Generate ETag from stable data (excluding timestamp)
        etag_data = {k: v for k, v in response_data.items() if k != "timestamp"}
        current_etag = generate_etag(etag_data)

        # Check if client's ETag matches
        if check_etag(if_none_match, current_etag):
            return Response(
                status_code=http_status.HTTP_304_NOT_MODIFIED,
                headers={"ETag": current_etag, "Cache-Control": "no-cache, must-revalidate"},
            )

        # Set headers for caching
        response.headers["ETag"] = current_etag
        response.headers["Last-Modified"] = formatdate(timeval=None, localtime=False, usegmt=True)
        response.headers["Cache-Control"] = "no-cache, must-revalidate"

        # Add polling hint headers
        if operation.get("status") not in TERMINAL_STATES:
            # Suggest polling every second for active operations
            response.headers["X-Poll-Interval"] = "1000"
        else:
            # No need to poll terminal operations
            response.headers["X-Poll-Interval"] = "0"

        logfire.info(f"Progress retrieved | operation_id={operation_id} | status={response_data.get('status')} | progress={response_data.get('progress')}")

        return response_data

    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to get progress | error={e!s} | operation_id={operation_id}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)}) from e


@router.get("/")
async def list_active_operations():
    """
    List all active operations.

    This endpoint is useful for debugging and monitoring active operations.
    """
    try:
        logfire.info("Listing active operations")

        # Get all active operations from ProgressTracker
        active_operations = []

        # Get active operations from ProgressTracker
        # Include all non-completed statuses
        for op_id, operation in ProgressTracker.list_active().items():
            status = operation.get("status", "unknown")
            # Include all operations that aren't in terminal states
            if status not in TERMINAL_STATES:
                operation_data = {
                    "operation_id": op_id,
                    "operation_type": operation.get("type", "unknown"),
                    "status": operation.get("status"),
                    "progress": operation.get("progress", 0),
                    "message": operation.get("log", "Processing..."),
                    "started_at": operation.get("start_time") or datetime.utcnow().isoformat(),
                    # Include source_id if available (for refresh operations)
                    "source_id": operation.get("source_id"),
                    # Include URL information for matching
                    "url": operation.get("url"),
                    "current_url": operation.get("current_url"),
                    # Include crawl type
                    "crawl_type": operation.get("crawl_type"),
                    # Include stats if available
                    "pages_crawled": operation.get("pages_crawled") or operation.get("processed_pages"),
                    "total_pages": operation.get("total_pages"),
                    "documents_created": operation.get("documents_created") or operation.get("chunks_stored"),
                    "code_blocks_found": operation.get("code_blocks_found") or operation.get("code_examples_found"),
                }
                # Only include non-None values to keep response clean
                active_operations.append({k: v for k, v in operation_data.items() if v is not None})

        logfire.info(f"Active operations listed | count={len(active_operations)}")

        return {
            "operations": active_operations,
            "count": len(active_operations),
            "timestamp": datetime.utcnow().isoformat()
        }

    except Exception as e:
        logfire.error(f"Failed to list active operations | error={e!s}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)}) from e
