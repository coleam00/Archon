"""
API routes for version checking and update management.
"""

from datetime import datetime
from typing import Any

import logfire
from fastapi import APIRouter, Header, HTTPException, Response
from pydantic import BaseModel

from ..config.version import ARCHON_VERSION
from ..services.version_service import version_service
from ..utils.etag_utils import check_etag, generate_etag


# Response models
class ReleaseAsset(BaseModel):
    """Represents a downloadable asset from a release."""

    name: str
    size: int
    download_count: int
    browser_download_url: str
    content_type: str


class VersionCheckResponse(BaseModel):
    """Version check response with update information."""

    current: str
    latest: str | None
    update_available: bool
    release_url: str | None
    release_notes: str | None
    published_at: datetime | None
    check_error: str | None = None
    assets: list[dict[str, Any]] | None = None
    author: str | None = None


class CurrentVersionResponse(BaseModel):
    """Simple current version response."""

    version: str
    timestamp: datetime


# Create router
router = APIRouter(prefix="/api/version", tags=["version"])


@router.get("/check", response_model=VersionCheckResponse)
async def check_for_updates(response: Response, if_none_match: str | None = Header(None)):
    """
    Check for available Archon updates.

    Queries GitHub releases API to determine if a newer version is available.
    Results are cached for 1 hour to avoid rate limiting.

    Returns:
        Version information including current, latest, and update availability
    """
    try:
        # Get version check results from service
        result = await version_service.check_for_updates()

        # Generate ETag for response
        etag = generate_etag(result)

        # Check if client has current data
        if check_etag(if_none_match, etag):
            # Client has current data, return 304
            response.status_code = 304
            response.headers["ETag"] = f'"{etag}"'
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
            return Response(status_code=304)
        else:
            # Client needs new data
            response.headers["ETag"] = f'"{etag}"'
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
            return VersionCheckResponse(**result)

    except Exception as e:
        logfire.error(f"Error checking for updates: {e}")
        # Return safe response with error
        return VersionCheckResponse(
            current=ARCHON_VERSION,
            latest=None,
            update_available=False,
            release_url=None,
            release_notes=None,
            published_at=None,
            check_error=str(e),
        )


@router.get("/current", response_model=CurrentVersionResponse)
async def get_current_version():
    """
    Get the current Archon version.

    Simple endpoint that returns the installed version without checking for updates.
    """
    return CurrentVersionResponse(version=ARCHON_VERSION, timestamp=datetime.now())


@router.post("/clear-cache")
async def clear_version_cache():
    """
    Clear the version check cache.

    Forces the next version check to query GitHub API instead of using cached data.
    Useful for testing or forcing an immediate update check.
    """
    try:
        version_service.clear_cache()
        return {"message": "Version cache cleared successfully", "success": True}
    except Exception as e:
        logfire.error(f"Error clearing version cache: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to clear cache: {str(e)}") from e
