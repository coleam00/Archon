"""
Service Discovery module for Docker and local development environments

This module provides service discovery capabilities that work seamlessly
across Docker Compose and local development environments.
"""

import os
from enum import Enum
from urllib.parse import urlparse

import httpx


class Environment(Enum):
    """Deployment environment types"""

    DOCKER_COMPOSE = "docker_compose"
    LOCAL = "local"


class ServiceDiscovery:
    """
    Service discovery that automatically adapts to the deployment environment.

    In Docker Compose: Uses container names
    In Local: Uses localhost with different ports
    """

    def __init__(self):
        # Get ports during initialization
        server_port = os.getenv("ARCHON_SERVER_PORT")
        mcp_port = os.getenv("ARCHON_MCP_PORT")
        agents_port = os.getenv("ARCHON_AGENTS_PORT")
        agent_work_orders_port = os.getenv("AGENT_WORK_ORDERS_PORT")

        # Required ports (core services)
        if not server_port:
            raise ValueError(
                "ARCHON_SERVER_PORT environment variable is required. "
                "Please set it in your .env file or environment. "
                "Default value: 8181"
            )
        if not mcp_port:
            raise ValueError(
                "ARCHON_MCP_PORT environment variable is required. "
                "Please set it in your .env file or environment. "
                "Default value: 8051"
            )
        if not agents_port:
            raise ValueError(
                "ARCHON_AGENTS_PORT environment variable is required. "
                "Please set it in your .env file or environment. "
                "Default value: 8052"
            )

        # Optional ports (agent_work_orders is an optional feature)
        # Store None if not configured to indicate feature is unavailable
        self.DEFAULT_PORTS = {
            "api": int(server_port),
            "mcp": int(mcp_port),
            "agents": int(agents_port),
            "agent_work_orders": int(agent_work_orders_port) if agent_work_orders_port else None,
        }

        self.environment = self._detect_environment()
        self._cache: dict[str, str] = {}

    # Service name mappings
    SERVICE_NAMES = {
        "api": "archon-server",
        "mcp": "archon-mcp",
        "agents": "archon-agents",
        "agent_work_orders": "archon-agent-work-orders",
        "archon-server": "archon-server",
        "archon-mcp": "archon-mcp",
        "archon-agents": "archon-agents",
        "archon-agent-work-orders": "archon-agent-work-orders",
    }

    @staticmethod
    def _detect_environment() -> Environment:
        """Detect the current deployment environment"""
        # Check for Docker environment
        if os.path.exists("/.dockerenv") or os.getenv("DOCKER_CONTAINER"):
            return Environment.DOCKER_COMPOSE

        # Default to local development
        return Environment.LOCAL

    def is_service_available(self, service: str) -> bool:
        """
        Check if a service is available (configured).

        Args:
            service: Service name (e.g., "api", "mcp", "agents", "agent_work_orders")

        Returns:
            True if service is configured, False otherwise
        """
        port = self.DEFAULT_PORTS.get(service)
        return port is not None

    def get_service_url(self, service: str, protocol: str = "http") -> str | None:
        """
        Get the URL for a service based on the current environment.

        Args:
            service: Service name (e.g., "api", "mcp", "agents")
            protocol: Protocol to use (default: "http")

        Returns:
            Full service URL (e.g., "http://archon-api:8080") or None if service not configured
        """
        cache_key = f"{protocol}://{service}"
        if cache_key in self._cache:
            return self._cache[cache_key]

        # Normalize service name
        service_name = self.SERVICE_NAMES.get(service, service)
        port = self.DEFAULT_PORTS.get(service)

        # Return None for unavailable services (e.g., optional features not configured)
        if port is None:
            return None

        if self.environment == Environment.DOCKER_COMPOSE:
            # Docker Compose uses service names directly
            # Check for override via environment variable
            host = os.getenv(f"{service_name.upper().replace('-', '_')}_HOST", service_name)
            url = f"{protocol}://{host}:{port}"

        else:
            # Local development - everything on localhost
            url = f"{protocol}://localhost:{port}"

        self._cache[cache_key] = url
        return url

    def get_service_host_port(self, service: str) -> tuple[str | None, int]:
        """
        Get host and port separately for a service.

        Returns:
            Tuple of (hostname, port). Hostname is None if service not configured.
        """
        url = self.get_service_url(service)
        if url is None:
            return None, 0
        parsed = urlparse(url)
        return parsed.hostname, parsed.port or 80

    async def health_check(self, service: str, timeout: float = 5.0) -> bool:
        """
        Check if a service is healthy.

        Args:
            service: Service name to check
            timeout: Timeout in seconds

        Returns:
            True if service is healthy, False otherwise
        """
        url = self.get_service_url(service)
        health_endpoint = f"{url}/health"

        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(health_endpoint)
                return response.status_code == 200
        except Exception:
            return False

    async def wait_for_service(
        self, service: str, max_attempts: int = 30, delay: float = 2.0
    ) -> bool:
        """
        Wait for a service to become healthy.

        Args:
            service: Service name to wait for
            max_attempts: Maximum number of attempts
            delay: Delay between attempts in seconds

        Returns:
            True if service became healthy, False if timeout
        """
        import asyncio

        for attempt in range(max_attempts):
            if await self.health_check(service):
                return True

            if attempt < max_attempts - 1:
                await asyncio.sleep(delay)

        return False

    def get_all_services(self) -> dict[str, str]:
        """Get URLs for all known services"""
        return {
            service: self.get_service_url(service)
            for service in self.SERVICE_NAMES.keys()
            if not service.startswith("archon-")  # Skip duplicates
        }

    @property
    def is_docker(self) -> bool:
        """Check if running in Docker"""
        return self.environment == Environment.DOCKER_COMPOSE

    @property
    def is_local(self) -> bool:
        """Check if running locally"""
        return self.environment == Environment.LOCAL


# Global instance for convenience - lazy loaded
_discovery = None


def get_discovery() -> ServiceDiscovery:
    """Get or create the global ServiceDiscovery instance"""
    global _discovery
    if _discovery is None:
        _discovery = ServiceDiscovery()
    return _discovery


# For backward compatibility - create a property that lazy-loads
class _LazyDiscovery:
    def __getattr__(self, name):
        return getattr(get_discovery(), name)


discovery = _LazyDiscovery()


# Convenience functions
def get_api_url() -> str:
    """Get the API service URL"""
    return get_discovery().get_service_url("api")


def get_mcp_url() -> str:
    """Get the MCP service URL"""
    return get_discovery().get_service_url("mcp")


def get_agents_url() -> str:
    """Get the Agents service URL"""
    return get_discovery().get_service_url("agents")


def get_agent_work_orders_url() -> str | None:
    """
    Get the Agent Work Orders service URL.

    Returns:
        Service URL or None if agent work orders feature is not configured.
    """
    return get_discovery().get_service_url("agent_work_orders")


def is_service_available(service: str) -> bool:
    """
    Check if a service is configured and available.

    Args:
        service: Service name (e.g., "api", "mcp", "agents", "agent_work_orders")

    Returns:
        True if service is configured, False otherwise
    """
    return get_discovery().is_service_available(service)


async def is_service_healthy(service: str) -> bool:
    """Check if a service is healthy"""
    return await get_discovery().health_check(service)


# Export key functions and classes
__all__ = [
    "ServiceDiscovery",
    "Environment",
    "discovery",
    "get_api_url",
    "get_mcp_url",
    "get_agents_url",
    "get_agent_work_orders_url",
    "is_service_available",
    "is_service_healthy",
]
