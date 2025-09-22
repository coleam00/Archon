"""
Version checking service with GitHub API integration.
"""

from datetime import datetime, timedelta
from typing import Any

import httpx
import logfire

from ..config.version import ARCHON_VERSION, GITHUB_REPO_NAME, GITHUB_REPO_OWNER
from ..utils.semantic_version import is_newer_version


class VersionService:
    """Service for checking Archon version against GitHub releases."""

    def __init__(self):
        self._cache: dict[str, Any] | None = None
        self._cache_time: datetime | None = None
        self._cache_ttl = 3600  # 1 hour cache TTL

    def _is_cache_valid(self) -> bool:
        """Check if cached data is still valid."""
        if not self._cache or not self._cache_time:
            return False

        age = datetime.now() - self._cache_time
        return age < timedelta(seconds=self._cache_ttl)

    async def get_latest_release(self) -> dict[str, Any] | None:
        """
        Fetch latest release information from GitHub API.

        Returns:
            Release data dictionary or None if no releases
        """
        # Check cache first
        if self._is_cache_valid():
            logfire.debug("Using cached version data")
            return self._cache

        # GitHub API endpoint
        url = f"https://api.github.com/repos/{GITHUB_REPO_OWNER}/{GITHUB_REPO_NAME}/releases/latest"

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    url,
                    headers={
                        "Accept": "application/vnd.github.v3+json",
                        "User-Agent": f"Archon/{ARCHON_VERSION}",
                    },
                )

                # Handle 404 - no releases yet
                if response.status_code == 404:
                    logfire.info("No releases found on GitHub")
                    return None

                response.raise_for_status()
                data = response.json()

                # Cache the successful response
                self._cache = data
                self._cache_time = datetime.now()

                return data

        except httpx.TimeoutException:
            logfire.warning("GitHub API request timed out")
            # Return cached data if available
            if self._cache:
                return self._cache
            return None
        except httpx.HTTPError as e:
            logfire.error(f"HTTP error fetching latest release: {e}")
            # Return cached data if available
            if self._cache:
                return self._cache
            return None
        except Exception as e:
            logfire.error(f"Unexpected error fetching latest release: {e}")
            # Return cached data if available
            if self._cache:
                return self._cache
            return None

    async def check_for_updates(self) -> dict[str, Any]:
        """
        Check if a newer version of Archon is available.

        Returns:
            Dictionary with version check results
        """
        try:
            # Get latest release from GitHub
            release = await self.get_latest_release()

            if not release:
                # No releases found or error occurred
                return {
                    "current": ARCHON_VERSION,
                    "latest": None,
                    "update_available": False,
                    "release_url": None,
                    "release_notes": None,
                    "published_at": None,
                    "check_error": None,
                }

            # Extract version from tag_name (e.g., "v1.0.0" -> "1.0.0")
            latest_version = release.get("tag_name", "")
            if latest_version.startswith("v"):
                latest_version = latest_version[1:]

            # Check if update is available
            update_available = is_newer_version(ARCHON_VERSION, latest_version)

            # Parse published date
            published_at = None
            if release.get("published_at"):
                try:
                    published_at = datetime.fromisoformat(
                        release["published_at"].replace("Z", "+00:00")
                    )
                except Exception:
                    pass

            return {
                "current": ARCHON_VERSION,
                "latest": latest_version,
                "update_available": update_available,
                "release_url": release.get("html_url"),
                "release_notes": release.get("body"),
                "published_at": published_at,
                "check_error": None,
                "assets": release.get("assets", []),
                "author": release.get("author", {}).get("login"),
            }

        except Exception as e:
            logfire.error(f"Error checking for updates: {e}")
            # Return safe default with error
            return {
                "current": ARCHON_VERSION,
                "latest": None,
                "update_available": False,
                "release_url": None,
                "release_notes": None,
                "published_at": None,
                "check_error": str(e),
            }

    def clear_cache(self):
        """Clear the cached version data."""
        self._cache = None
        self._cache_time = None


# Export singleton instance
version_service = VersionService()
