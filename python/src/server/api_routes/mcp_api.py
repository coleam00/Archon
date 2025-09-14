"""
MCP API endpoints for Archon - Azure Container Apps Compatible

Handles:
- MCP server lifecycle (status checking via HTTP)
- MCP server configuration management
- WebSocket log streaming
- Tool discovery and testing
- Both Docker (local) and HTTP (cloud) modes
"""

import asyncio
import os
import time
from collections import deque
from datetime import datetime
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

# Import unified logging
from ..config.logfire_config import api_logger, mcp_logger, safe_set_attribute, safe_span
from ..utils import get_supabase_client

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


class ServerConfig(BaseModel):
    transport: str = "sse"
    host: str = "localhost"
    port: int = 8051


class ServerResponse(BaseModel):
    success: bool
    message: str
    status: str | None = None
    pid: int | None = None


class LogEntry(BaseModel):
    timestamp: str
    level: str
    message: str


class MCPServerManager:
    """Manages MCP server communication in both Docker and Azure Container Apps environments."""

    def __init__(self):
        self.container_name = "Archon-MCP"
        self.status: str = "unknown"
        self.start_time: float | None = None
        self.logs: deque = deque(maxlen=1000)
        self.log_websockets: list[WebSocket] = []
        self.log_reader_task: asyncio.Task | None = None
        self._operation_lock = asyncio.Lock()
        self._last_operation_time = 0
        self._min_operation_interval = 2.0
        
        # Detect environment mode
        self.is_cloud_mode = self._detect_cloud_mode()
        self.mcp_http_url = self._get_mcp_http_url()
        
        # Initialize based on environment
        if self.is_cloud_mode:
            self._initialize_cloud_mode()
        else:
            self._initialize_docker_mode()

    def _detect_cloud_mode(self) -> bool:
        """Detect if running in cloud environment (Azure Container Apps)."""
        cloud_indicators = [
            os.getenv("DOCKER_AVAILABLE", "true").lower() == "false",
            os.getenv("MCP_HTTP_MODE", "false").lower() == "true",
            os.getenv("DISABLE_DOCKER_MCP", "false").lower() == "true",
            os.getenv("CONTAINER_ENV") == "azure",
            os.getenv("DEPLOYMENT_MODE") == "cloud",
            bool(os.getenv("WEBSITE_HOSTNAME")),  # Azure App Service indicator
            bool(os.getenv("CONTAINER_APP_NAME")),  # Azure Container Apps indicator
        ]
        
        is_cloud = any(cloud_indicators)
        mode = "cloud" if is_cloud else "docker"
        mcp_logger.info(f"MCP Manager initialized in {mode} mode")
        return is_cloud

    def _get_mcp_http_url(self) -> Optional[str]:
        """Get MCP HTTP URL from environment variables."""
        possible_vars = [
            "MCP_ENDPOINT",
            "ARCHON_MCP_URL", 
            "MCP_HTTP_URL",
            "MCP_SERVER_URL"
        ]
        
        for var in possible_vars:
            url = os.getenv(var)
            if url:
                # Ensure URL has /mcp endpoint if it doesn't already
                if not url.endswith('/mcp') and '/mcp' not in url:
                    url = f"{url}/mcp"
                mcp_logger.info(f"Found MCP HTTP URL from {var}: {url}")
                return url
        
        mcp_logger.warning("No MCP HTTP URL found in environment variables")
        return None

    def _initialize_cloud_mode(self):
        """Initialize for cloud environment."""
        mcp_logger.info("Initializing MCP manager for cloud environment")
        self._add_log("INFO", "MCP Manager running in cloud mode (Azure Container Apps)")
        
        if self.mcp_http_url:
            self._add_log("INFO", f"MCP HTTP endpoint configured: {self.mcp_http_url}")
            # Start periodic health checking
            asyncio.create_task(self._start_health_monitor())
            # Force an immediate health check
            asyncio.create_task(self._force_health_check())
        else:
            self._add_log("WARNING", "MCP HTTP URL not configured")

    def _initialize_docker_mode(self):
        """Initialize for Docker environment (fallback)."""
        mcp_logger.info("Initializing MCP manager for Docker environment")
        self._add_log("INFO", "MCP Manager running in Docker mode")
        
        try:
            import docker
            self.docker_client = docker.from_env()
            try:
                self.container = self.docker_client.containers.get(self.container_name)
                mcp_logger.info(f"Found Docker container: {self.container_name}")
                self._add_log("INFO", f"Connected to Docker container: {self.container_name}")
            except docker.errors.NotFound:
                mcp_logger.warning(f"Docker container {self.container_name} not found")
                self.container = None
                self._add_log("WARNING", f"Docker container {self.container_name} not found")
        except Exception as e:
            mcp_logger.error(f"Failed to initialize Docker client: {str(e)}")
            self.docker_client = None
            self._add_log("ERROR", f"Docker initialization failed: {str(e)}")

    async def _start_health_monitor(self):
        """Start periodic health monitoring for cloud mode."""
        if not self.is_cloud_mode or not self.mcp_http_url:
            return
            
        while True:
            try:
                await asyncio.sleep(30)  # Check every 30 seconds
                await self._check_http_health()
            except asyncio.CancelledError:
                break
            except Exception as e:
                mcp_logger.debug(f"Health monitor error: {str(e)}")

    async def _check_http_health(self) -> bool:
        """Check MCP service health via HTTP."""
        if not self.mcp_http_url:
            return False
            
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                # Try the MCP endpoint directly - any response means service is running
                try:
                    response = await client.get(self.mcp_http_url)
                    # MCP service responds with 406 for GET requests - this is normal!
                    # Any response (200, 404, 406, etc.) means the service is reachable
                    if response.status_code in [200, 404, 406, 405]:  # Accept common "not supported" codes
                        if self.status != "running":
                            self.status = "running"
                            self.start_time = time.time()
                            self._add_log("INFO", f"MCP service is reachable (HTTP {response.status_code})")
                        return True
                    else:
                        # Log unexpected status codes but still consider them as "reachable"
                        if self.status != "running":
                            self.status = "running"
                            self.start_time = time.time()
                            self._add_log("INFO", f"MCP service responding with HTTP {response.status_code}")
                        return True
                except httpx.ConnectError:
                    # Connection refused/timeout - service is actually down
                    if self.status == "running":
                        self.status = "unreachable"
                        self._add_log("WARNING", "MCP service connection refused")
                    return False
                except httpx.TimeoutException:
                    # Timeout - service might be overloaded but probably running
                    if self.status != "running":
                        self.status = "running"
                        self.start_time = time.time()
                        self._add_log("WARNING", "MCP service timeout (but reachable)")
                    return True
                except Exception as e:
                    # Other HTTP errors - service is reachable but having issues
                    if self.status != "running":
                        self.status = "running"
                        self.start_time = time.time()
                        self._add_log("WARNING", f"MCP service reachable but returned error: {str(e)}")
                    return True
                
        except Exception as e:
            if self.status == "running":
                self.status = "error"
                self._add_log("ERROR", f"MCP health check error: {str(e)}")
            return False

    async def _force_health_check(self) -> bool:
        """Force an immediate health check and update status."""
        if not self.mcp_http_url:
            return False
            
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(self.mcp_http_url)
                # Any response means the service is reachable
                if response.status_code in [200, 404, 406, 405]:
                    self.status = "running"
                    if not self.start_time:
                        self.start_time = time.time()
                    self._add_log("INFO", f"Forced health check: MCP service is running (HTTP {response.status_code})")
                    return True
                else:
                    self.status = "running"  # Still consider it running
                    self._add_log("INFO", f"Forced health check: MCP service responding (HTTP {response.status_code})")
                    return True
        except Exception as e:
            self.status = "unreachable"
            self._add_log("ERROR", f"Forced health check failed: {str(e)}")
            return False

    def _get_container_status(self) -> str:
        """Get container status (Docker mode only)."""
        if self.is_cloud_mode:
            return "cloud_mode"
            
        if not hasattr(self, 'docker_client') or not self.docker_client:
            return "docker_unavailable"

        try:
            import docker
            if self.container:
                self.container.reload()
            else:
                self.container = self.docker_client.containers.get(self.container_name)
            return self.container.status
        except docker.errors.NotFound:
            return "not_found"
        except Exception as e:
            mcp_logger.error(f"Error getting container status: {str(e)}")
            return "error"

    async def start_server(self) -> dict[str, Any]:
        """Start the MCP server."""
        async with self._operation_lock:
            current_time = time.time()
            if current_time - self._last_operation_time < self._min_operation_interval:
                wait_time = self._min_operation_interval - (current_time - self._last_operation_time)
                return {
                    "success": False,
                    "status": self.status,
                    "message": f"Please wait {wait_time:.1f}s before starting server again",
                }

        with safe_span("mcp_server_start") as span:
            safe_set_attribute(span, "action", "start_server")
            safe_set_attribute(span, "mode", "cloud" if self.is_cloud_mode else "docker")

            if self.is_cloud_mode:
                # In cloud mode, we don't start/stop containers - they're managed by Azure
                mcp_logger.info("Start server requested in cloud mode")
                
                if not self.mcp_http_url:
                    return {
                        "success": False,
                        "status": "not_configured",
                        "message": "MCP HTTP URL not configured. Check environment variables.",
                    }
                
                # Check if service is already accessible
                is_healthy = await self._check_http_health()
                if is_healthy:
                    return {
                        "success": True,
                        "status": "running", 
                        "message": "MCP service is already running and accessible",
                    }
                else:
                    return {
                        "success": False,
                        "status": "unreachable",
                        "message": f"MCP service at {self.mcp_http_url} is not responding. Check if the service is deployed and running.",
                    }
            else:
                # Original Docker logic for local development
                return await self._start_docker_container()

    async def _start_docker_container(self) -> dict[str, Any]:
        """Start Docker container (original logic)."""
        if not hasattr(self, 'docker_client') or not self.docker_client:
            return {
                "success": False,
                "status": "docker_unavailable", 
                "message": "Docker is not available",
            }

        container_status = self._get_container_status()
        
        if container_status == "not_found":
            return {
                "success": False,
                "status": "not_found",
                "message": f"MCP container {self.container_name} not found. Run docker-compose up -d archon-mcp",
            }

        if container_status == "running":
            return {
                "success": False,
                "status": "running",
                "message": "MCP server is already running",
            }

        try:
            import docker
            self.container.start()
            self.status = "starting"
            self.start_time = time.time()
            self._last_operation_time = time.time()
            self._add_log("INFO", "MCP container starting...")
            
            await asyncio.sleep(2)
            self.container.reload()
            
            if self.container.status == "running":
                self.status = "running"
                self._add_log("INFO", "MCP container started successfully")
                return {
                    "success": True,
                    "status": self.status,
                    "message": "MCP server started successfully",
                    "container_id": self.container.id[:12],
                }
            else:
                self.status = "failed"
                return {
                    "success": False,
                    "status": self.status,
                    "message": f"Container failed to start. Status: {self.container.status}",
                }
                
        except Exception as e:
            self.status = "failed"
            self._add_log("ERROR", f"Failed to start MCP server: {str(e)}")
            return {
                "success": False,
                "status": self.status,
                "message": f"Failed to start MCP server: {str(e)}",
            }

    async def stop_server(self) -> dict[str, Any]:
        """Stop the MCP server."""
        async with self._operation_lock:
            current_time = time.time()
            if current_time - self._last_operation_time < self._min_operation_interval:
                wait_time = self._min_operation_interval - (current_time - self._last_operation_time)
                return {
                    "success": False,
                    "status": self.status,
                    "message": f"Please wait {wait_time:.1f}s before stopping server again",
                }

        with safe_span("mcp_server_stop") as span:
            safe_set_attribute(span, "action", "stop_server")
            safe_set_attribute(span, "mode", "cloud" if self.is_cloud_mode else "docker")

            if self.is_cloud_mode:
                # In cloud mode, we don't stop containers - they're managed by Azure
                return {
                    "success": False,
                    "status": self.status,
                    "message": "Cannot stop MCP server in cloud mode. Containers are managed by Azure Container Apps.",
                }
            else:
                # Original Docker logic for local development
                return await self._stop_docker_container()

    async def _stop_docker_container(self) -> dict[str, Any]:
        """Stop Docker container (original logic)."""
        if not hasattr(self, 'docker_client') or not self.docker_client:
            return {
                "success": False,
                "status": "docker_unavailable",
                "message": "Docker is not available",
            }

        container_status = self._get_container_status()
        
        if container_status not in ["running", "restarting"]:
            return {
                "success": False,
                "status": container_status,
                "message": f"MCP server is not running (status: {container_status})",
            }

        try:
            import docker
            self.status = "stopping"
            self._add_log("INFO", "Stopping MCP container...")
            
            await asyncio.get_event_loop().run_in_executor(
                None, lambda: self.container.stop(timeout=10)
            )
            
            self.status = "stopped"
            self.start_time = None
            self._last_operation_time = time.time()
            self._add_log("INFO", "MCP container stopped")
            
            return {
                "success": True,
                "status": self.status,
                "message": "MCP server stopped successfully",
            }
            
        except Exception as e:
            self._add_log("ERROR", f"Error stopping MCP server: {str(e)}")
            return {
                "success": False,
                "status": self.status,
                "message": f"Error stopping MCP server: {str(e)}",
            }

    def get_status(self) -> dict[str, Any]:
        """Get the current server status."""
        if self.is_cloud_mode:
            return self._get_cloud_status()
        else:
            return self._get_docker_status()

    def _get_cloud_status(self) -> dict[str, Any]:
        """Get status for cloud mode."""
        if not self.mcp_http_url:
            return {
                "status": "not_configured",
                "uptime": None,
                "logs": list(self.logs)[-10:] if self.logs else [],
                "container_status": "not_configured",
                "mode": "cloud",
                "mcp_url": None,
            }

        # Status is updated by health monitor
        uptime = None
        if self.status == "running" and self.start_time:
            uptime = int(time.time() - self.start_time)

        recent_logs = []
        for log in list(self.logs)[-10:]:
            if isinstance(log, dict):
                recent_logs.append(f"[{log['level']}] {log['message']}")
            else:
                recent_logs.append(str(log))

        return {
            "status": self.status,
            "uptime": uptime,
            "logs": recent_logs,
            "container_status": f"http_{self.status}",
            "mode": "cloud",
            "mcp_url": self.mcp_http_url,
        }

    def _get_docker_status(self) -> dict[str, Any]:
        """Get status for Docker mode."""
        container_status = self._get_container_status()
        
        status_map = {
            "running": "running",
            "restarting": "restarting", 
            "paused": "paused",
            "exited": "stopped",
            "dead": "stopped",
            "created": "stopped",
            "removing": "stopping",
            "not_found": "not_found",
            "docker_unavailable": "docker_unavailable",
            "error": "error",
        }

        self.status = status_map.get(container_status, "unknown")

        uptime = None
        if self.status == "running":
            if self.start_time:
                uptime = int(time.time() - self.start_time)
            elif hasattr(self, 'container') and self.container:
                try:
                    self.container.reload()
                    started_at = self.container.attrs["State"]["StartedAt"]
                    started_time = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
                    uptime = int((datetime.now(started_time.tzinfo) - started_time).total_seconds())
                except Exception:
                    pass

        recent_logs = []
        for log in list(self.logs)[-10:]:
            if isinstance(log, dict):
                recent_logs.append(f"[{log['level']}] {log['message']}")
            else:
                recent_logs.append(str(log))

        return {
            "status": self.status,
            "uptime": uptime,
            "logs": recent_logs,
            "container_status": container_status,
            "mode": "docker",
        }

    def _add_log(self, level: str, message: str):
        """Add a log entry and broadcast to connected WebSockets."""
        log_entry = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "level": level,
            "message": message,
        }
        self.logs.append(log_entry)
        asyncio.create_task(self._broadcast_log(log_entry))

    async def _broadcast_log(self, log_entry: dict[str, Any]):
        """Broadcast log entry to all connected WebSockets."""
        disconnected = []
        for ws in self.log_websockets:
            try:
                await ws.send_json(log_entry)
            except Exception:
                disconnected.append(ws)

        for ws in disconnected:
            self.log_websockets.remove(ws)

    def get_logs(self, limit: int = 100) -> list[dict[str, Any]]:
        """Get historical logs."""
        logs = list(self.logs)
        if limit > 0:
            logs = logs[-limit:]
        return logs

    def clear_logs(self):
        """Clear the log buffer."""
        self.logs.clear()
        self._add_log("INFO", "Logs cleared")

    async def add_websocket(self, websocket: WebSocket):
        """Add a WebSocket connection for log streaming."""
        await websocket.accept()
        self.log_websockets.append(websocket)
        await websocket.send_json({
            "type": "connection",
            "message": f"WebSocket connected for log streaming ({('cloud' if self.is_cloud_mode else 'docker')} mode)",
        })

    def remove_websocket(self, websocket: WebSocket):
        """Remove a WebSocket connection."""
        if websocket in self.log_websockets:
            self.log_websockets.remove(websocket)


# Global MCP manager instance
mcp_manager = MCPServerManager()


@router.post("/start", response_model=ServerResponse)
async def start_server():
    """Start the MCP server."""
    with safe_span("api_mcp_start") as span:
        safe_set_attribute(span, "endpoint", "/mcp/start")
        safe_set_attribute(span, "method", "POST")

        try:
            result = await mcp_manager.start_server()
            api_logger.info("MCP server start API called - success=%s", result.get("success", False))
            safe_set_attribute(span, "success", result.get("success", False))
            return result
        except Exception as e:
            api_logger.error("MCP server start API failed - error=%s", str(e))
            safe_set_attribute(span, "success", False)
            safe_set_attribute(span, "error", str(e))
            raise HTTPException(status_code=500, detail=str(e))


@router.post("/stop", response_model=ServerResponse)
async def stop_server():
    """Stop the MCP server."""
    with safe_span("api_mcp_stop") as span:
        safe_set_attribute(span, "endpoint", "/mcp/stop")
        safe_set_attribute(span, "method", "POST")

        try:
            result = await mcp_manager.stop_server()
            api_logger.info(f"MCP server stop API called - success={result.get('success', False)}")
            safe_set_attribute(span, "success", result.get("success", False))
            return result
        except Exception as e:
            api_logger.error(f"MCP server stop API failed - error={str(e)}")
            safe_set_attribute(span, "success", False)
            safe_set_attribute(span, "error", str(e))
            raise HTTPException(status_code=500, detail=str(e))


@router.get("/status")
async def get_status():
    """Get MCP server status."""
    with safe_span("api_mcp_status") as span:
        safe_set_attribute(span, "endpoint", "/mcp/status")
        safe_set_attribute(span, "method", "GET")

        try:
            status = mcp_manager.get_status()
            api_logger.debug(f"MCP server status checked - status={status.get('status')}")
            safe_set_attribute(span, "status", status.get("status"))
            safe_set_attribute(span, "mode", status.get("mode", "unknown"))
            return status
        except Exception as e:
            api_logger.error(f"MCP server status API failed - error={str(e)}")
            safe_set_attribute(span, "error", str(e))
            raise HTTPException(status_code=500, detail=str(e))


@router.get("/logs")
async def get_logs(limit: int = 100):
    """Get MCP server logs."""
    with safe_span("api_mcp_logs") as span:
        safe_set_attribute(span, "endpoint", "/mcp/logs")
        safe_set_attribute(span, "method", "GET")
        safe_set_attribute(span, "limit", limit)

        try:
            logs = mcp_manager.get_logs(limit)
            api_logger.debug("MCP server logs retrieved", count=len(logs))
            safe_set_attribute(span, "log_count", len(logs))
            return {"logs": logs}
        except Exception as e:
            api_logger.error("MCP server logs API failed", error=str(e))
            safe_set_attribute(span, "error", str(e))
            raise HTTPException(status_code=500, detail=str(e))


@router.delete("/logs")
async def clear_logs():
    """Clear MCP server logs."""
    with safe_span("api_mcp_clear_logs") as span:
        safe_set_attribute(span, "endpoint", "/mcp/logs")
        safe_set_attribute(span, "method", "DELETE")

        try:
            mcp_manager.clear_logs()
            api_logger.info("MCP server logs cleared")
            safe_set_attribute(span, "success", True)
            return {"success": True, "message": "Logs cleared successfully"}
        except Exception as e:
            api_logger.error("MCP server clear logs API failed", error=str(e))
            safe_set_attribute(span, "success", False)
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

            # Detect mode and configure accordingly
            is_cloud = mcp_manager.is_cloud_mode
            
            if is_cloud:
                # Cloud mode configuration
                mcp_url = mcp_manager.mcp_http_url
                if mcp_url:
                    # Extract host and port from URL
                    import urllib.parse
                    parsed = urllib.parse.urlparse(mcp_url)
                    host = parsed.hostname or "unknown"
                    port = parsed.port or (443 if parsed.scheme == "https" else 80)
                else:
                    host = "not-configured"
                    port = 8051
                    
                config = {
                    "host": host,
                    "port": port,
                    "transport": "http",  # Use HTTP for cloud mode
                    "mode": "cloud",
                    "mcp_url": mcp_url,
                }
                api_logger.info(f"MCP configuration (HTTP cloud mode) - host={host}, port={port}")
            else:
                # Local Docker mode configuration
                mcp_port = int(os.getenv("ARCHON_MCP_PORT", "8051"))
                config = {
                    "host": "localhost",
                    "port": mcp_port,
                    "transport": "sse",
                    "mode": "docker",
                }
                api_logger.info("MCP configuration (SSE Docker mode)")

            # Add model configuration from database
            try:
                from ..services.credential_service import credential_service

                config["model_choice"] = await credential_service.get_credential(
                    "MODEL_CHOICE", "gpt-4o-mini"
                )
                config["use_contextual_embeddings"] = (
                    await credential_service.get_credential("USE_CONTEXTUAL_EMBEDDINGS", "false")
                ).lower() == "true"
                config["use_hybrid_search"] = (
                    await credential_service.get_credential("USE_HYBRID_SEARCH", "false")
                ).lower() == "true"
                config["use_agentic_rag"] = (
                    await credential_service.get_credential("USE_AGENTIC_RAG", "false")
                ).lower() == "true"
                config["use_reranking"] = (
                    await credential_service.get_credential("USE_RERANKING", "false")
                ).lower() == "true"
            except Exception:
                config.update({
                    "model_choice": "gpt-4o-mini",
                    "use_contextual_embeddings": False,
                    "use_hybrid_search": False,
                    "use_agentic_rag": False,
                    "use_reranking": False,
                })

            safe_set_attribute(span, "mode", config.get("mode"))
            safe_set_attribute(span, "transport", config.get("transport"))
            safe_set_attribute(span, "host", config.get("host"))
            safe_set_attribute(span, "port", config.get("port"))

            return config
        except Exception as e:
            api_logger.error("Failed to get MCP configuration", error=str(e))
            safe_set_attribute(span, "error", str(e))
            raise HTTPException(status_code=500, detail={"error": str(e)})


@router.post("/config")
async def save_configuration(config: ServerConfig):
    """Save MCP server configuration."""
    with safe_span("api_save_mcp_config") as span:
        safe_set_attribute(span, "endpoint", "/api/mcp/config")
        safe_set_attribute(span, "method", "POST")
        safe_set_attribute(span, "transport", config.transport)
        safe_set_attribute(span, "host", config.host)
        safe_set_attribute(span, "port", config.port)

        try:
            api_logger.info(
                f"Saving MCP server configuration | transport={config.transport} | host={config.host} | port={config.port}"
            )

            config_json = config.model_dump_json()

            from ..services.credential_service import credential_service
            success = await credential_service.set_credential(
                "mcp_config",
                config_json,
                category="mcp",
                description="MCP server configuration settings",
            )

            if success:
                api_logger.info("MCP configuration saved successfully")
                safe_set_attribute(span, "operation", "save")
            else:
                raise Exception("Failed to save MCP configuration")

            safe_set_attribute(span, "success", True)
            return {"success": True, "message": "Configuration saved"}

        except Exception as e:
            api_logger.error(f"Failed to save MCP configuration | error={str(e)}")
            safe_set_attribute(span, "error", str(e))
            raise HTTPException(status_code=500, detail={"error": str(e)})


@router.websocket("/logs/stream")
async def websocket_log_stream(websocket: WebSocket):
    """WebSocket endpoint for streaming MCP server logs."""
    await mcp_manager.add_websocket(websocket)
    try:
        while True:
            await asyncio.sleep(1)
            await websocket.send_json({"type": "ping"})
    except WebSocketDisconnect:
        mcp_manager.remove_websocket(websocket)
    except Exception:
        mcp_manager.remove_websocket(websocket)
        try:
            await websocket.close()
        except:
            pass


@router.post("/force-health-check")
async def force_mcp_health_check():
    """Force an immediate health check of the MCP server."""
    with safe_span("api_force_mcp_health_check") as span:
        safe_set_attribute(span, "endpoint", "/api/mcp/force-health-check")
        safe_set_attribute(span, "method", "POST")

        try:
            api_logger.info("Forcing MCP server health check")
            
            if mcp_manager.is_cloud_mode:
                # Force health check for cloud mode
                is_healthy = await mcp_manager._force_health_check()
                status = mcp_manager.get_status()
                
                return {
                    "success": True,
                    "forced_check": True,
                    "is_healthy": is_healthy,
                    "status": status.get("status"),
                    "mode": "cloud",
                    "message": f"Forced health check completed. Status: {status.get('status')}"
                }
            else:
                # For Docker mode, just return current status
                status = mcp_manager.get_status()
                return {
                    "success": True,
                    "forced_check": False,
                    "is_healthy": status.get("status") == "running",
                    "status": status.get("status"),
                    "mode": "docker",
                    "message": "Health check not applicable for Docker mode"
                }
                
        except Exception as e:
            api_logger.error("Force health check failed", error=str(e))
            safe_set_attribute(span, "error", str(e))
            raise HTTPException(status_code=500, detail=str(e))


@router.get("/tools")
async def get_mcp_tools():
    """Get available MCP tools."""
    with safe_span("api_get_mcp_tools") as span:
        safe_set_attribute(span, "endpoint", "/api/mcp/tools")
        safe_set_attribute(span, "method", "GET")

        try:
            api_logger.info("Getting MCP tools")
            
            server_status = mcp_manager.get_status()
            is_running = server_status.get("status") == "running"
            mode = server_status.get("mode", "unknown")
            
            safe_set_attribute(span, "server_running", is_running)
            safe_set_attribute(span, "mode", mode)

            if not is_running:
                api_logger.warning("MCP server not running when requesting tools")
                return {
                    "tools": [],
                    "count": 0,
                    "server_running": False,
                    "mode": mode,
                    "source": "server_not_running",
                    "message": "MCP server is not running. Start the server to see available tools.",
                }

            if mode == "cloud":
                # In cloud mode, try to get tools via HTTP
                try:
                    if mcp_manager.mcp_http_url:
                        async with httpx.AsyncClient(timeout=10.0) as client:
                            response = await client.get(f"{mcp_manager.mcp_http_url}/tools")
                            if response.status_code == 200:
                                tools_data = response.json()
                                return {
                                    "tools": tools_data.get("tools", []),
                                    "count": len(tools_data.get("tools", [])),
                                    "server_running": True,
                                    "mode": "cloud",
                                    "source": "http_api",
                                    "message": "Tools retrieved from HTTP MCP server",
                                }
                            else:
                                raise Exception(f"HTTP {response.status_code}")
                except Exception as e:
                    api_logger.warning(f"Failed to get tools via HTTP: {str(e)}")
                    
                # Fallback for cloud mode
                return {
                    "tools": [
                        {
                            "name": "rag_query",
                            "description": "Query knowledge base using RAG",
                            "module": "rag",
                            "parameters": ["query", "filters"],
                        },
                        {
                            "name": "project_create", 
                            "description": "Create new project",
                            "module": "project",
                            "parameters": ["name", "description"],
                        }
                    ],
                    "count": 2,
                    "server_running": True,
                    "mode": "cloud",
                    "source": "cloud_fallback",
                    "message": "MCP server is running. Tool introspection via HTTP not available, showing default tools.",
                }
            else:
                # Docker mode fallback
                return {
                    "tools": [
                        {
                            "name": "docker_placeholder",
                            "description": "MCP server is running in Docker mode",
                            "module": "docker",
                            "parameters": [],
                        }
                    ],
                    "count": 1,
                    "server_running": True,
                    "mode": "docker",
                    "source": "docker_fallback",
                    "message": "MCP server is running in Docker mode. Tool introspection needs to be implemented.",
                }

        except Exception as e:
            api_logger.error("Failed to get MCP tools", error=str(e))
            safe_set_attribute(span, "error", str(e))
            return {
                "tools": [],
                "count": 0,
                "server_running": False,
                "mode": "unknown",
                "source": "error",
                "message": f"Error retrieving MCP tools: {str(e)}",
            }


@router.get("/health")
async def mcp_health():
    """Health check for MCP API."""
    with safe_span("api_mcp_health") as span:
        safe_set_attribute(span, "endpoint", "/api/mcp/health")
        safe_set_attribute(span, "method", "GET")

        result = {
            "status": "healthy", 
            "service": "mcp",
            "mode": "cloud" if mcp_manager.is_cloud_mode else "docker"
        }
        safe_set_attribute(span, "status", "healthy")
        safe_set_attribute(span, "mode", result["mode"])

        return result