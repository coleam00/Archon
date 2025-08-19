"""
Health Status Models

Pydantic models for vector database provider health monitoring.
Used by ProviderHealthMonitor for optional connectivity validation.
"""

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class HealthStatus(str, Enum):
    """Health status enumeration"""

    HEALTHY = "healthy"
    UNHEALTHY = "unhealthy"
    DEGRADED = "degraded"
    UNKNOWN = "unknown"


class ProviderHealthStatus(BaseModel):
    """
    Health status for a specific vector database provider.

    Contains detailed health information including connectivity,
    response times, and error details when applicable.
    """

    provider_name: str = Field(..., description="Name of the vector database provider")
    status: HealthStatus = Field(..., description="Overall health status")
    connected: bool = Field(default=False, description="Whether provider is reachable")
    response_time_ms: float | None = Field(None, description="Response time in milliseconds")
    checked_at: datetime = Field(default_factory=datetime.utcnow, description="When health check was performed")

    # Error details (when status is not healthy)
    error_message: str | None = Field(None, description="Error message if unhealthy")
    error_code: str | None = Field(None, description="Error code/type if applicable")

    # Additional diagnostic info
    endpoint_url: str | None = Field(None, description="Endpoint that was checked")
    config_valid: bool = Field(default=True, description="Whether configuration is valid")
    last_successful_check: datetime | None = Field(None, description="Last time provider was healthy")

    # Provider-specific metadata
    metadata: dict[str, Any] = Field(default_factory=dict, description="Provider-specific health data")

    def sanitize(self) -> "ProviderHealthStatus":
        """
        Create a sanitized copy of this health status for public consumption.

        Removes sensitive information like internal URLs, detailed error traces,
        and configuration details that could be used for reconnaissance.

        Returns:
            New ProviderHealthStatus with sensitive data redacted
        """
        from ..middleware.security_middleware import sanitize_health_response

        # Convert to dict, sanitize, then recreate object
        data = self.model_dump()
        sanitized_data = sanitize_health_response(data)

        return ProviderHealthStatus(**sanitized_data)


class HealthSummary(BaseModel):
    """
    Overall health summary for all vector database providers.

    Provides aggregated health status and individual provider details.
    """

    overall_status: HealthStatus = Field(..., description="Aggregated health status")
    total_providers: int = Field(..., description="Total number of registered providers")
    healthy_providers: int = Field(..., description="Number of healthy providers")
    checked_at: datetime = Field(default_factory=datetime.utcnow, description="When summary was generated")

    # Individual provider statuses
    providers: dict[str, ProviderHealthStatus] = Field(
        default_factory=dict, description="Health status for each provider"
    )

    # Summary statistics
    average_response_time_ms: float | None = Field(None, description="Average response time across healthy providers")
    fastest_provider: str | None = Field(None, description="Provider with fastest response time")
    slowest_provider: str | None = Field(None, description="Provider with slowest response time")

    def sanitize(self) -> "HealthSummary":
        """
        Create a sanitized copy of this health summary for public consumption.

        Sanitizes all individual provider health statuses while preserving
        aggregate statistics that are safe for public consumption.

        Returns:
            New HealthSummary with sensitive data redacted
        """
        # Sanitize individual provider statuses
        sanitized_providers = {name: status.sanitize() for name, status in self.providers.items()}

        # Create sanitized copy with same aggregate data
        return HealthSummary(
            overall_status=self.overall_status,
            total_providers=self.total_providers,
            healthy_providers=self.healthy_providers,
            checked_at=self.checked_at,
            providers=sanitized_providers,
            average_response_time_ms=self.average_response_time_ms,
            fastest_provider=self.fastest_provider,
            slowest_provider=self.slowest_provider,
        )


class HealthCheckRequest(BaseModel):
    """Request model for health check operations"""

    provider_name: str | None = Field(None, description="Specific provider to check (all if None)")
    include_metadata: bool = Field(default=False, description="Include provider-specific metadata")
    timeout_seconds: float = Field(default=10.0, description="Timeout for health checks")


class HealthCheckResponse(BaseModel):
    """Response model for health check API endpoints"""

    success: bool = Field(..., description="Whether health check operation succeeded")
    message: str = Field(..., description="Human-readable message")
    data: ProviderHealthStatus | HealthSummary = Field(..., description="Health check results")
    timestamp: datetime = Field(default_factory=datetime.utcnow, description="Response timestamp")
