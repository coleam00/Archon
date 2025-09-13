"""
Provider-agnostic error handling for LLM embedding services.

Supports OpenAI, Google AI, Anthropic, Ollama, and future providers
with unified error handling and sanitization patterns.
"""

import re
from abc import ABC, abstractmethod

from .embedding_exceptions import (
    EmbeddingAPIError,
    EmbeddingAuthenticationError,
    EmbeddingQuotaExhaustedError,
    EmbeddingRateLimitError,
)


class ProviderErrorAdapter(ABC):
    """Abstract base class for provider-specific error handling."""

    @abstractmethod
    def get_provider_name(self) -> str:
        pass

    @abstractmethod
    def sanitize_error_message(self, message: str) -> str:
        pass


class OpenAIErrorAdapter(ProviderErrorAdapter):
    def get_provider_name(self) -> str:
        return "openai"

    def sanitize_error_message(self, message: str) -> str:
        if not isinstance(message, str) or not message.strip() or len(message) > 2000:
            return "OpenAI API encountered an error. Please verify your API key and quota."

        sanitized = message
        
        # Comprehensive OpenAI patterns with case-insensitive matching
        patterns = [
            (r'sk-[a-zA-Z0-9]{48}', '[REDACTED_KEY]'),                 # OpenAI API keys
            (r'https?://[^\s]*openai\.com[^\s]*', '[REDACTED_URL]'),   # OpenAI URLs
            (r'org-[a-zA-Z0-9]{20,}', '[REDACTED_ORG]'),              # Organization IDs
            (r'proj_[a-zA-Z0-9]{10,}', '[REDACTED_PROJECT]'),         # Project IDs
            (r'req_[a-zA-Z0-9]{10,}', '[REDACTED_REQUEST]'),          # Request IDs
            (r'Bearer\s+[a-zA-Z0-9._-]+', 'Bearer [REDACTED_TOKEN]'), # Bearer tokens
        ]

        for pattern, replacement in patterns:
            sanitized = re.sub(pattern, replacement, sanitized, flags=re.IGNORECASE)

        # Check for sensitive words after sanitization
        sensitive_words = ['internal', 'server', 'endpoint']
        if any(word in sanitized.lower() for word in sensitive_words):
            return "OpenAI API encountered an error. Please verify your API key and quota."

        return sanitized


class GoogleAIErrorAdapter(ProviderErrorAdapter):
    def get_provider_name(self) -> str:
        return "google"

    def sanitize_error_message(self, message: str) -> str:
        if not isinstance(message, str) or not message.strip() or len(message) > 2000:
            return "Google AI API encountered an error. Please verify your API key."

        sanitized = message
        
        # Comprehensive Google AI patterns
        patterns = [
            (r'AIza[a-zA-Z0-9_-]{35}', '[REDACTED_KEY]'),                     # Google AI API keys
            (r'https?://[^\s]*googleapis\.com[^\s]*', '[REDACTED_URL]'),      # Google API URLs
            (r'https?://[^\s]*googleusercontent\.com[^\s]*', '[REDACTED_URL]'), # Google content URLs
            (r'projects/[a-zA-Z0-9_-]+', 'projects/[REDACTED_PROJECT]'),      # GCP project paths
            (r'ya29\.[a-zA-Z0-9_-]+', '[REDACTED_TOKEN]'),                   # OAuth tokens
            (r'Bearer\s+[a-zA-Z0-9._-]+', 'Bearer [REDACTED_TOKEN]'),        # Bearer tokens
        ]

        for pattern, replacement in patterns:
            sanitized = re.sub(pattern, replacement, sanitized, flags=re.IGNORECASE)

        # Check for sensitive words
        sensitive_words = ['internal', 'server', 'endpoint', 'project']
        if any(word in sanitized.lower() for word in sensitive_words):
            return "Google AI API encountered an error. Please verify your API key."

        return sanitized


class AnthropicErrorAdapter(ProviderErrorAdapter):
    def get_provider_name(self) -> str:
        return "anthropic"

    def sanitize_error_message(self, message: str) -> str:
        if not isinstance(message, str) or not message.strip() or len(message) > 2000:
            return "Anthropic API encountered an error. Please verify your API key."

        sanitized = message
        
        # Comprehensive Anthropic patterns
        patterns = [
            (r'sk-ant-[a-zA-Z0-9_-]{10,}', '[REDACTED_KEY]'),                 # Anthropic API keys
            (r'https?://[^\s]*anthropic\.com[^\s]*', '[REDACTED_URL]'),        # Anthropic URLs
            (r'Bearer\s+[a-zA-Z0-9._-]+', 'Bearer [REDACTED_TOKEN]'),         # Bearer tokens
        ]

        for pattern, replacement in patterns:
            sanitized = re.sub(pattern, replacement, sanitized, flags=re.IGNORECASE)

        # Check for sensitive words
        sensitive_words = ['internal', 'server', 'endpoint']
        if any(word in sanitized.lower() for word in sensitive_words):
            return "Anthropic API encountered an error. Please verify your API key."

        return sanitized


class ProviderErrorFactory:
    """Factory for provider-agnostic error handling."""

    _adapters = {
        "openai": OpenAIErrorAdapter(),
        "google": GoogleAIErrorAdapter(),
        "anthropic": AnthropicErrorAdapter(),
    }

    @classmethod
    def get_adapter(cls, provider: str) -> ProviderErrorAdapter:
        return cls._adapters.get(provider.lower(), cls._adapters["openai"])

    @classmethod
    def sanitize_provider_error(cls, message: str, provider: str) -> str:
        adapter = cls.get_adapter(provider)
        return adapter.sanitize_error_message(message)

    @classmethod
    def detect_provider_from_error(cls, error_str: str) -> str:
        """Detect provider from error message with comprehensive pattern matching."""
        if not error_str:
            return "openai"
            
        error_lower = error_str.lower()
        
        # Case-insensitive provider detection with multiple patterns
        if ("anthropic" in error_lower or 
            re.search(r'sk-ant-[a-zA-Z0-9_-]+', error_str, re.IGNORECASE) or
            "claude" in error_lower):
            return "anthropic"
        elif ("google" in error_lower or 
              re.search(r'AIza[a-zA-Z0-9_-]+', error_str, re.IGNORECASE) or
              "googleapis" in error_lower or 
              "vertex" in error_lower):
            return "google"
        elif ("openai" in error_lower or 
              re.search(r'sk-[a-zA-Z0-9]{48}', error_str, re.IGNORECASE) or
              "gpt" in error_lower):
            return "openai"
        else:
            return "openai"  # Safe default