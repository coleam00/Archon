"""
Internal API endpoints for inter-service communication.

These endpoints are meant to be called only by other services in the Archon system,
not by external clients. They provide internal functionality like credential sharing.
"""

import logging
import os
import ipaddress
from typing import Any, List

from fastapi import APIRouter, HTTPException, Request

from ..services.credential_service import credential_service

logger = logging.getLogger(__name__)

# Create router with internal prefix
router = APIRouter(prefix="/internal", tags=["internal"])

def _parse_cidrs(raw: str) -> List[ipaddress._BaseNetwork]:
    nets: List[ipaddress._BaseNetwork] = []
    for part in (raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            # accept single IPs too (will be normalized as /32 or /128)
            if "/" not in part:
                # interpret bare IP as single-host network
                ip = ipaddress.ip_address(part)
                cidr = f"{part}/32" if ip.version == 4 else f"{part}/128"
                nets.append(ipaddress.ip_network(cidr, strict=False))
            else:
                nets.append(ipaddress.ip_network(part, strict=False))
        except ValueError:
            logger.warning(f"Skipping invalid CIDR/IP in env: {part}")
    return nets

# Defaults: localhost + common container ranges (overlay/bridge)
_DEFAULT_ALLOWED = _parse_cidrs(
    "127.0.0.1/32,::1/128,"
    "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
)

# Extra allowed ranges via env
_ALLOWED_EXTRA = _parse_cidrs(os.getenv("INTERNAL_ALLOWED_CIDRS", ""))

# (Optional) proxies we trust for X-Forwarded-For
_TRUSTED_PROXIES = _parse_cidrs(os.getenv("TRUSTED_PROXY_CIDRS", ""))

def _in_any(ip: ipaddress._BaseAddress, nets: List[ipaddress._BaseNetwork]) -> bool:
    return any(ip in n for n in nets)

def _client_ip(request: Request) -> ipaddress._BaseAddress | None:
    """Return the true client IP. If peer is a trusted proxy, honor X-Forwarded-For."""
    peer = (request.client.host if request.client else None)
    if not peer:
        return None
    try:
        peer_ip = ipaddress.ip_address(peer)
    except ValueError:
        return None

    # If the direct peer is a trusted proxy (e.g., Traefik on overlay),
    # use the left-most X-Forwarded-For as the original client.
    if _TRUSTED_PROXIES and _in_any(peer_ip, _TRUSTED_PROXIES):
        xff = request.headers.get("x-forwarded-for", "")
        if xff:
            first = xff.split(",")[0].strip()
            try:
                return ipaddress.ip_address(first)
            except ValueError:
                pass  # fall back to peer_ip
    return peer_ip

def is_internal_request(request: Request) -> bool:
    """Check if request is from an internal source."""
    ip = _client_ip(request)
    if ip is None:
        return False
    # Allow if the IP is in default internal ranges or extra env ranges
    if _in_any(ip, _DEFAULT_ALLOWED) or _in_any(ip, _ALLOWED_EXTRA):
        logger.debug(f"Internal request allowed from {ip}")
        return True

    logger.warning(f"Blocked non-internal request from {ip}")
    return False


@router.get("/health")
async def internal_health():
    """Internal health check endpoint."""
    return {"status": "healthy", "service": "internal-api"}


@router.get("/credentials/agents")
async def get_agent_credentials(request: Request) -> dict[str, Any]:
    """
    Get credentials needed by the agents service.

    This endpoint is only accessible from internal services and provides
    the necessary credentials for AI agents to function.
    """
    # Check if request is from internal source
    if not is_internal_request(request):
        logger.warning(f"Unauthorized access to internal credentials from {request.client.host}")
        raise HTTPException(status_code=403, detail="Access forbidden")

    try:
        # Get credentials needed by agents
        credentials = {
            # OpenAI credentials
            "OPENAI_API_KEY": await credential_service.get_credential(
                "OPENAI_API_KEY", decrypt=True
            ),
            "OPENAI_MODEL": await credential_service.get_credential(
                "OPENAI_MODEL", default="gpt-4o-mini"
            ),
            # Model configurations
            "DOCUMENT_AGENT_MODEL": await credential_service.get_credential(
                "DOCUMENT_AGENT_MODEL", default="openai:gpt-4o"
            ),
            "RAG_AGENT_MODEL": await credential_service.get_credential(
                "RAG_AGENT_MODEL", default="openai:gpt-4o-mini"
            ),
            "TASK_AGENT_MODEL": await credential_service.get_credential(
                "TASK_AGENT_MODEL", default="openai:gpt-4o"
            ),
            # Rate limiting settings
            "AGENT_RATE_LIMIT_ENABLED": await credential_service.get_credential(
                "AGENT_RATE_LIMIT_ENABLED", default="true"
            ),
            "AGENT_MAX_RETRIES": await credential_service.get_credential(
                "AGENT_MAX_RETRIES", default="3"
            ),
            # MCP endpoint
            "MCP_SERVICE_URL": f"http://archon-mcp:{os.getenv('ARCHON_MCP_PORT')}",
            # Additional settings
            "LOG_LEVEL": await credential_service.get_credential("LOG_LEVEL", default="INFO"),
        }

        # Filter out None values
        logger.info(f"Provided credentials to agents service from {request.client.host}")
        return {k: v for k, v in credentials.items() if v is not None}
    except Exception as e:
        logger.error(f"Error retrieving agent credentials: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve credentials")


@router.get("/credentials/mcp")
async def get_mcp_credentials(request: Request) -> dict[str, Any]:
    """
    Get credentials needed by the MCP service.

    This endpoint provides credentials for the MCP service if needed in the future.
    """
    # Check if request is from internal source
    if not is_internal_request(request):
        logger.warning(f"Unauthorized access to internal credentials from {request.client.host}")
        raise HTTPException(status_code=403, detail="Access forbidden")

    try:
        logger.info(f"Provided credentials to MCP service from {request.client.host}")
        return {"LOG_LEVEL": await credential_service.get_credential("LOG_LEVEL", default="INFO")}
    except Exception as e:
        logger.error(f"Error retrieving MCP credentials: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve credentials")
