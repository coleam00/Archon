"""Shared request/response schemas for provider API routes."""

from typing import Any, Dict, List, Optional
from datetime import datetime
from pydantic import BaseModel, Field, SecretStr


class ModelSelectionRequest(BaseModel):
    """Request to update model selection"""
    service_name: str = Field(...,
                              description="Service name (e.g., 'rag_agent')")
    model_string: str = Field(...,
                              description="Model string (e.g., 'openai:gpt-4o')")
    temperature: Optional[float] = Field(None, ge=0.0, le=2.0)
    max_tokens: Optional[int] = Field(None, gt=0)


class APIKeyRequest(BaseModel):
    """Request to set an API key"""
    provider: str = Field(..., description="Provider name (e.g., 'openai')")
    api_key: SecretStr = Field(..., description="API key to store")
    base_url: Optional[str] = Field(None, description="Optional base URL")


class AvailableModel(BaseModel):
    """Available model information"""
    provider: str
    model: str
    model_string: str
    display_name: str
    has_api_key: bool
    cost_tier: Optional[str] = None
    estimated_cost_per_1m: Optional[Dict[str, float]] = None
    is_embedding: bool = False
    model_id: Optional[str] = None
    description: Optional[str] = None
    context_length: Optional[int] = None
    input_cost: Optional[float] = None
    output_cost: Optional[float] = None
    supports_vision: bool = False
    supports_tools: bool = False
    supports_reasoning: bool = False


class ServiceStatus(BaseModel):
    """Service configuration status"""
    service_name: str
    model_string: str
    provider: str
    model: str
    api_key_configured: bool
    temperature: float
    max_tokens: Optional[int]


class TopModelInfo(BaseModel):
    """Basic information for a top model preview."""
    model_id: str
    display_name: str
    context_length: int
    input_cost: float
    is_free: bool


class ProviderMetadata(BaseModel):
    """Aggregate metadata for a provider across its models."""
    provider: str
    model_count: int
    max_context_length: int
    min_input_cost: Optional[float]
    max_input_cost: Optional[float]
    has_free_models: bool
    supports_vision: bool
    supports_tools: bool
    last_sync: Optional[datetime] = None


class ProviderDetailMetadata(ProviderMetadata):
    """Detailed provider metadata including preview of top models."""
    top_models: List[TopModelInfo]


class MonthlyCostEstimate(BaseModel):
    """Response schema for monthly cost estimate."""
    estimated_monthly_cost: float
    based_on_days: int = 7


class UsageTrackRequest(BaseModel):
    """Request to track usage for a service"""
    service_name: str = Field(...,
                              description="Service name (e.g., 'rag_agent')")
    model_string: str = Field(...,
                              description="Model string (e.g., 'openai:gpt-4o')")
    input_tokens: int = Field(..., description="Number of input tokens", gt=0)
    output_tokens: int = Field(...,
                               description="Number of output tokens", gt=0)
    metadata: Optional[Dict[str, Any]] = Field(
        None, description="Optional metadata dictionary")
