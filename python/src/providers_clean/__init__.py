"""
Clean Provider Integration for PydanticAI

A simplified approach to managing AI providers that leverages PydanticAI's
native model handling instead of building custom provider clients.

Key Components:
- ModelConfigService: Manages model selection per service
- APIKeyManager: Handles encrypted API key storage
- UsageTracker: Tracks costs and usage metrics
"""

from .services import (
    ModelConfig,
    ModelConfigService,
    APIKeyConfig,
    APIKeyManager,
    UsageMetrics,
    UsageSummary,
    UsageTracker,
)

__version__ = "1.0.0"

__all__ = [
    # Model Configuration
    'ModelConfig',
    'ModelConfigService',
    
    # API Key Management
    'APIKeyConfig',
    'APIKeyManager',
    
    # Usage Tracking
    'UsageMetrics',
    'UsageSummary',
    'UsageTracker',
]