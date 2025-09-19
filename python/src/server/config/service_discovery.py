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

        self.DEFAULT_PORTS = {
            "api": int(server_port),
            "mcp": int(mcp_port),
            "agents": int(agents_port),
        }

        self.environment = self._detect_environment()
        self._cache: dict[str, str] = {}

    # Service name mappings
    SERVICE_NAMES = {
        "api": "archon-server",
        "mcp": "archon-mcp",
        "agents": "archon-agents",
        "archon-server": "archon-server",
        "archon-mcp": "archon-mcp",
        "archon-agents": "archon-agents",
    }

    @staticmethod
    def _detect_environment() -> Environment:
        """Detect the current deployment environment"""
        # Check for Docker environment
        if os.path.exists("/.dockerenv") or os.getenv("DOCKER_CONTAINER"):
            return Environment.DOCKER_COMPOSE

        # Default to local development
        return Environment.LOCAL

    def get_service_url(self, service: str, protocol: str = "http") -> str:
        """
        Get the URL for a service based on the current environment.

        Args:
            service: Service name (e.g., "api", "mcp", "agents")
            protocol: Protocol to use (default: "http")

        Returns:
            Full service URL (e.g., "http://archon-api:8080")
        """
        cache_key = f"{protocol}://{service}"
        if cache_key in self._cache:
            return self._cache[cache_key]

        # Normalize service name
        service_name = self.SERVICE_NAMES.get(service, service)
        port = self.DEFAULT_PORTS.get(service)
        if port is None:
            raise ValueError(
                f"Unknown service: {service}. Valid services are: {list(self.DEFAULT_PORTS.keys())}"
            )

        if self.environment == Environment.DOCKER_COMPOSE:
            # For MCP service, check if proxy mode is enabled for external access
            if service == "mcp" and os.getenv("VITE_MCP_USE_PROXY", "false").lower() == "true":
                # Use external host and protocol for proxy mode
                external_host = os.getenv("HOST", "localhost")
                external_protocol = os.getenv("VITE_MCP_PROTOCOL", protocol)
                url = f"{external_protocol}://{external_host}:{port}"
            else:
                # Docker Compose uses service names directly
                # Check for override via environment variable
                host = os.getenv(f"{service_name.upper().replace('-', '_')}_HOST", service_name)
                url = f"{protocol}://{host}:{port}"

        else:
            # Local development - everything on localhost
            # Use environment variables if available
            host = os.getenv("HOST", "localhost")
            # For MCP in local mode, respect the protocol setting
            if service == "mcp":
                protocol = os.getenv("VITE_MCP_PROTOCOL", protocol)
            url = f"{protocol}://{host}:{port}"

        self._cache[cache_key] = url
        return url

    def get_service_host_port(self, service: str) -> tuple[str, int]:
        """Get host and port separately for a service"""
        url = self.get_service_url(service)
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
    protocol = os.getenv("VITE_MCP_PROTOCOL", "http")
    return get_discovery().get_service_url("mcp", protocol)


def get_agents_url() -> str:
    """Get the Agents service URL"""
    return get_discovery().get_service_url("agents")


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
    "is_service_healthy",
]
