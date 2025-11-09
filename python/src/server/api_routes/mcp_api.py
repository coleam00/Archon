"""
MCP API endpoints for Archon

Provides status and configuration endpoints for the MCP service.
The MCP container is managed by docker-compose, not by this API.

Status monitoring uses HTTP health checks by default (secure, portable).
Docker socket mode available via ENABLE_DOCKER_SOCKET_MONITORING (legacy, security risk).
"""

import os
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException

# Import unified logging
from ..config.config import get_mcp_monitoring_config
from ..config.logfire_config import api_logger, safe_set_attribute, safe_span
from ..config.service_discovery import get_mcp_url

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


async def get_container_status_http() -> dict[str, Any]:
    """Get MCP server status via HTTP health check endpoint.

    This is the secure, recommended approach that doesn't require Docker socket.
    Works across all deployment environments (Docker, Kubernetes, bare metal).

    Returns:
        Status dict: {"status": str, "uptime": int|None, "logs": []}
    """
    config = get_mcp_monitoring_config()
    mcp_url = get_mcp_url()

    try:
        # Use async context manager for proper connection cleanup
        async with httpx.AsyncClient(timeout=config.health_check_timeout) as client:
            response = await client.get(f"{mcp_url}/health")
            response.raise_for_status()

            # MCP health endpoint returns: {"success": bool, "uptime_seconds": int, "health": {...}}
            data = response.json()

            # Transform to expected API contract
            uptime_value = data.get("uptime_seconds")
            return {
                "status": "running" if data.get("success") else "unhealthy",
                "uptime": int(uptime_value) if uptime_value is not None else None,
                "logs": [],  # Historical artifact, kept for API compatibility
            }

    except httpx.ConnectError:
        # MCP container not running or unreachable
        api_logger.warning("MCP server unreachable via HTTP health check")
        return {
            "status": "unreachable",
            "uptime": None,
            "logs": [],
        }
    except httpx.TimeoutException:
        # MCP responding too slowly
        api_logger.warning(f"MCP server health check timed out after {config.health_check_timeout}s")
        return {
            "status": "unhealthy",
            "uptime": None,
            "logs": [],
        }
    except Exception:
        # Unexpected error
        api_logger.error("Failed to check MCP server health via HTTP", exc_info=True)
        return {
            "status": "error",
            "uptime": None,
            "logs": [],
        }


def get_container_status_docker() -> dict[str, Any]:
    """Get MCP container status via Docker socket (legacy mode).

    SECURITY WARNING: Requires Docker socket mounted, granting root-equivalent host access.
    Only enable this mode if you specifically need Docker container status details.
    Set ENABLE_DOCKER_SOCKET_MONITORING=true to use this mode.

    Returns:
        Status dict: {"status": str, "uptime": int|None, "logs": []}
    """
    import docker
    from docker.errors import NotFound

    docker_client = None
    try:
        docker_client = docker.from_env()
        container = docker_client.containers.get("archon-mcp")

        # Get container status
        container_status = container.status

        # Map Docker statuses to simple statuses
        if container_status == "running":
            status = "running"
            # Try to get uptime from container info
            try:
                from datetime import datetime

                started_at = container.attrs["State"]["StartedAt"]
                started_time = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
                uptime = int((datetime.now(started_time.tzinfo) - started_time).total_seconds())
            except Exception:
                uptime = None
        else:
            status = "stopped"
            uptime = None

        return {
            "status": status,
            "uptime": uptime,
            "logs": [],  # No log streaming anymore
        }

    except NotFound:
        api_logger.warning("MCP container not found via Docker socket")
        return {
            "status": "not_found",
            "uptime": None,
            "logs": [],
            "message": "MCP container not found. Run: docker compose up -d archon-mcp",
        }
    except Exception as e:
        api_logger.error("Failed to get MCP container status via Docker", exc_info=True)
        return {
            "status": "error",
            "uptime": None,
            "logs": [],
            "error": str(e),
        }
    finally:
        # CRITICAL: Always close Docker client to prevent connection leaks
        if docker_client is not None:
            try:
                docker_client.close()
            except Exception:
                pass


async def get_container_status() -> dict[str, Any]:
    """Get MCP server status using configured monitoring strategy.

    Routes to HTTP health check (secure, default) or Docker socket (legacy).

    Returns:
        Status dict: {"status": str, "uptime": int|None, "logs": []}
    """
    config = get_mcp_monitoring_config()

    if config.enable_docker_socket:
        api_logger.info("Using Docker socket monitoring (ENABLE_DOCKER_SOCKET_MONITORING=true)")
        # Docker mode is synchronous
        return get_container_status_docker()
    else:
        # HTTP mode is asynchronous (default)
        return await get_container_status_http()


@router.get("/status")
async def get_status():
    """Get MCP server status.

    Returns container/server status, uptime, and logs (empty).
    Monitoring strategy controlled by ENABLE_DOCKER_SOCKET_MONITORING env var.
    """
    with safe_span("api_mcp_status") as span:
        safe_set_attribute(span, "endpoint", "/api/mcp/status")
        safe_set_attribute(span, "method", "GET")

        try:
            status = await get_container_status()
            api_logger.debug(f"MCP server status checked - status={status.get('status')}")
            safe_set_attribute(span, "status", status.get("status"))
            safe_set_attribute(span, "uptime", status.get("uptime"))
            return status
        except Exception as e:
            api_logger.error(f"MCP server status API failed - error={str(e)}")
            safe_set_attribute(span, "error", str(e))
            raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/config")
async def get_mcp_config():
    """Get MCP server configuration."""
    with safe_span("api_get_mcp_config") as span:
        safe_set_attribute(span, "endpoint", "/api/mcp/config")
        safe_set_attribute(span, "method", "GET")

        try:
            api_logger.info("Getting MCP server configuration")

            # Get actual MCP port from environment or use default
            mcp_port = int(os.getenv("ARCHON_MCP_PORT", "8051"))

            # Configuration for streamable-http mode with actual port
            config = {
                "host": os.getenv("ARCHON_HOST", "localhost"),
                "port": mcp_port,
                "transport": "streamable-http",
            }

            # Get only model choice from database (simplified)
            try:
                from ..services.credential_service import credential_service

                model_choice = await credential_service.get_credential("MODEL_CHOICE", "gpt-4o-mini")
                config["model_choice"] = model_choice
            except Exception:
                # Fallback to default model
                config["model_choice"] = "gpt-4o-mini"

            api_logger.info("MCP configuration (streamable-http mode)")
            safe_set_attribute(span, "host", config["host"])
            safe_set_attribute(span, "port", config["port"])
            safe_set_attribute(span, "transport", "streamable-http")
            safe_set_attribute(span, "model_choice", config.get("model_choice", "gpt-4o-mini"))

            return config
        except Exception as e:
            api_logger.error("Failed to get MCP configuration", exc_info=True)
            safe_set_attribute(span, "error", str(e))
            raise HTTPException(status_code=500, detail={"error": str(e)}) from e


@router.get("/clients")
async def get_mcp_clients():
    """Get connected MCP clients with type detection."""
    with safe_span("api_mcp_clients") as span:
        safe_set_attribute(span, "endpoint", "/api/mcp/clients")
        safe_set_attribute(span, "method", "GET")

        try:
            # TODO: Implement real client detection in the future
            # For now, return empty array as expected by frontend
            api_logger.debug("Getting MCP clients - returning empty array")

            return {"clients": [], "total": 0}
        except Exception as e:
            api_logger.error(f"Failed to get MCP clients - error={str(e)}")
            safe_set_attribute(span, "error", str(e))
            return {"clients": [], "total": 0, "error": str(e)}


@router.get("/sessions")
async def get_mcp_sessions():
    """Get MCP session information."""
    with safe_span("api_mcp_sessions") as span:
        safe_set_attribute(span, "endpoint", "/api/mcp/sessions")
        safe_set_attribute(span, "method", "GET")

        try:
            # Basic session info for now
            status = await get_container_status()

            session_info = {
                "active_sessions": 0,  # TODO: Implement real session tracking
                "session_timeout": 3600,  # 1 hour default
            }

            # Add uptime if server is running
            if status.get("status") == "running" and status.get("uptime"):
                session_info["server_uptime_seconds"] = status["uptime"]

            api_logger.debug(f"MCP session info - sessions={session_info.get('active_sessions')}")
            safe_set_attribute(span, "active_sessions", session_info.get("active_sessions"))

            return session_info
        except Exception as e:
            api_logger.error(f"Failed to get MCP sessions - error={str(e)}")
            safe_set_attribute(span, "error", str(e))
            raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/health")
async def mcp_health():
    """Health check for MCP API - used by bug report service and tests."""
    with safe_span("api_mcp_health") as span:
        safe_set_attribute(span, "endpoint", "/api/mcp/health")
        safe_set_attribute(span, "method", "GET")

        # Simple health check - no logging to reduce noise
        result = {"status": "healthy", "service": "mcp"}
        safe_set_attribute(span, "status", "healthy")

        return result
