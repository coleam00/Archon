"""
MCP API endpoints for Archon

Provides status and configuration endpoints for the MCP service.
The MCP container is managed by docker-compose, not by this API.
"""

import os
from typing import Any

import socket
import asyncio
from urllib.parse import urlparse

# Docker SDK is imported lazily inside get_container_status() when MCP_USE_DOCKER_SDK=true
from fastapi import APIRouter, HTTPException

# Import unified logging
from ..config.logfire_config import api_logger, safe_set_attribute, safe_span

def _env(name: str, default: str | None = None) -> str | None:
    v = os.getenv(name)
    return v if v not in (None, "") else default

def _resolve_all(host: str) -> list[str]:
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
        return sorted({info[4][0] for info in infos})
    except socket.gaierror:
        return []

def _discovery_host(host: str, dns_mode: str) -> str:
    return f"tasks.{host}" if (dns_mode or "service").lower() == "tasks" else host

async def _tcp_open(host: str, port: int, timeout: float = 2.5) -> bool:
    """Non-blocking TCP connect (runs in a threadpool so we never block the event loop)."""
    def _connect():
        with socket.create_connection((host, port), timeout=timeout):
            return True
    try:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, _connect)
    except Exception:
        return False

router = APIRouter(prefix="/api/mcp", tags=["mcp"])

# get_container_status() must be ASYNC:
async def get_container_status() -> dict[str, Any]:
    """
    Portable status:
    - If MCP_USE_DOCKER_SDK=true and docker.sock is present, try Docker API
      (useful for local dev/compose).
    - Otherwise, use DNS + non-blocking TCP reachability to the MCP service (works in Swarm).
    """
    # ------------- Config -------------
    use_sdk = (_env("MCP_USE_DOCKER_SDK", "false") or "false").lower() in ("1", "true", "yes")
    container_name = _env("MCP_CONTAINER_NAME", "archon-mcp") or "archon-mcp"
    mcp_host = _env("MCP_HOST", _env("ARCHON_MCP_HOST", "archon-mcp")) or "archon-mcp"
    mcp_port = int(_env("ARCHON_MCP_PORT", "8051") or "8051")
    dns_mode = (_env("MCP_DNS_MODE", "service") or "service").lower()  # "service" | "tasks"

    # ------------- Try Docker SDK (opt-in) -------------
    if use_sdk:
        try:
            import docker  # lazy import so module loads without docker installed
            from docker.errors import NotFound  # noqa: F401
        except Exception:
            api_logger.warning("MCP_USE_DOCKER_SDK=true but 'docker' package not available; skipping SDK path.")
        else:
            docker_client = None
            try:
                docker_client = docker.from_env()
                container = docker_client.containers.get(container_name)
                container_status = container.status  # "running", "exited", etc.
                if container_status == "running":
                    status = "running"
                    try:
                        from datetime import datetime
                        started_at = container.attrs["State"]["StartedAt"]
                        started_time = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
                        uptime = int((datetime.now(started_time.tzinfo) - started_time).total_seconds())
                    except Exception:
                        uptime = None
                else:
                    status, uptime = "stopped", None

                return {
                    "status": status,
                    "uptime": uptime,
                    "logs": [],
                    "container_status": container_status
                }
            except docker.errors.NotFound:  # type: ignore[attr-defined]
                # Fall through to DNS/TCP for Swarm where names differ
                pass
            except Exception:
                api_logger.warning("Docker SDK status failed; falling back to DNS/TCP", exc_info=True)
            finally:
                if docker_client is not None:
                    try:
                        docker_client.close()
                    except Exception:
                        pass

    # ------------- DNS/TCP (Swarm/Compose safe) -------------
    try:
        host_for_discovery = _discovery_host(mcp_host, dns_mode)
        addrs = _resolve_all(host_for_discovery)
        replicas = len(addrs)

        tcp_ok = await _tcp_open(mcp_host, mcp_port, timeout=2.5)

        if replicas == 0 and not tcp_ok:
            return {
                "status": "not_found",
                "uptime": None,
                "logs": [],
                "container_status": "not_found",
                "message": "MCP service not resolvable/reachable"
            }

        status = "running" if tcp_ok else "stopped"
        return {
            "status": status,
            "uptime": None,
            "logs": [],
            "container_status": status,
            "replicas": replicas,
            "addresses": addrs
        }
    except Exception as e:
        api_logger.error("Failed to determine MCP status via DNS/TCP", exc_info=True)
        return {
            "status": "error",
            "uptime": None,
            "logs": [],
            "container_status": "error",
            "error": str(e)
        }


@router.get("/status")
async def get_status():
    """Get MCP server status."""
    with safe_span("api_mcp_status") as span:
        safe_set_attribute(span, "endpoint", "/api/mcp/status")
        safe_set_attribute(span, "method", "GET")

        try:
            status = await get_container_status()   # <-- await
            api_logger.debug(f"MCP server status checked - status={status.get('status')}")
            safe_set_attribute(span, "status", status.get("status"))
            safe_set_attribute(span, "uptime", status.get("uptime"))
            return status
        except Exception as e:
            api_logger.error(f"MCP server status API failed - error={str(e)}")
            safe_set_attribute(span, "error", str(e))
            raise HTTPException(status_code=500, detail=str(e))


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

                model_choice = await credential_service.get_credential(
                    "MODEL_CHOICE", "gpt-4o-mini"
                )
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
            raise HTTPException(status_code=500, detail={"error": str(e)})


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

            return {
                "clients": [],
                "total": 0
            }
        except Exception as e:
            api_logger.error(f"Failed to get MCP clients - error={str(e)}")
            safe_set_attribute(span, "error", str(e))
            return {
                "clients": [],
                "total": 0,
                "error": str(e)
            }


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
            raise HTTPException(status_code=500, detail=str(e))


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
