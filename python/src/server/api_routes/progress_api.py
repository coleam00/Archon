"""Progress API endpoints for polling operation status."""

from datetime import datetime

from fastapi import APIRouter, Header, HTTPException, Response
from fastapi import status as http_status

from ..config.logfire_config import get_logger, logfire
from ..models.progress_models import create_progress_response
from ..utils.etag_utils import check_etag, generate_etag
from ..utils.progress import ProgressTracker

logger = get_logger(__name__)

router = APIRouter(prefix="/api/progress", tags=["progress"])


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
        

        # Ensure we have the progress_id in the data
        operation["progress_id"] = operation_id
        
        # Get operation type for proper model selection
        operation_type = operation.get("type", "crawl")
        
        # Create standardized response using Pydantic model
        progress_response = create_progress_response(operation_type, operation)
        
        
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
            response.status_code = http_status.HTTP_304_NOT_MODIFIED
            response.headers["ETag"] = current_etag
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
            return None

        # Set headers for caching
        response.headers["ETag"] = current_etag
        response.headers["Last-Modified"] = datetime.utcnow().isoformat()
        response.headers["Cache-Control"] = "no-cache, must-revalidate"

        # Add polling hint headers
        if operation.get("status") == "running":
            # Suggest polling every second for running operations
            response.headers["X-Poll-Interval"] = "1000"
        else:
            # No need to poll completed/failed operations
            response.headers["X-Poll-Interval"] = "0"

        logfire.info(f"Progress retrieved | operation_id={operation_id} | status={response_data.get('status')} | progress={response_data.get('progress')}")

        return response_data

    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to get progress | error={str(e)} | operation_id={operation_id}")
        raise HTTPException(status_code=500, detail={"error": str(e)})


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
        for op_id, operation in ProgressTracker._progress_states.items():
            if operation.get("status") in ["starting", "running"]:
                active_operations.append({
                    "operation_id": op_id,
                    "operation_type": operation.get("type", "unknown"),
                    "status": operation.get("status"),
                    "progress": operation.get("progress", 0),
                    "message": operation.get("log", "Processing..."),
                    "started_at": operation.get("start_time", datetime.utcnow()).isoformat() if operation.get("start_time") else None
                })

        logfire.info(f"Active operations listed | count={len(active_operations)}")

        return {
            "operations": active_operations,
            "count": len(active_operations),
            "timestamp": datetime.utcnow().isoformat()
        }

    except Exception as e:
        logfire.error(f"Failed to list active operations | error={str(e)}")
        raise HTTPException(status_code=500, detail={"error": str(e)})
