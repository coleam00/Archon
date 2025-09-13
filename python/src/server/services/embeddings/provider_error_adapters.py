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
        
        # Safe API key detection using string operations
        if 'sk-' in sanitized:
            words = sanitized.split()
            for i, word in enumerate(words):
                if word.startswith('sk-') and len(word) == 51:
                    words[i] = '[REDACTED_KEY]'
            sanitized = ' '.join(words)
        
        # Essential patterns only
        patterns = [
            (r'https?://[a-zA-Z0-9.-]+/[^\s]*', '[REDACTED_URL]'),
            (r'org-[a-zA-Z0-9]{24}', '[REDACTED_ORG]'),
        ]

        for pattern, replacement in patterns:
            sanitized = re.sub(pattern, replacement, sanitized, flags=re.IGNORECASE)

        return sanitized


class GoogleAIErrorAdapter(ProviderErrorAdapter):
    def get_provider_name(self) -> str:
        return "google"

    def sanitize_error_message(self, message: str) -> str:
        if not isinstance(message, str) or not message.strip() or len(message) > 2000:
            return "Google AI API encountered an error. Please verify your API key."

        sanitized = message
        
        # Google AI key format: AIzaSy...
        if 'AIza' in sanitized:
            words = sanitized.split()
            for i, word in enumerate(words):
                if word.startswith('AIza') and len(word) == 39:
                    words[i] = '[REDACTED_KEY]'
            sanitized = ' '.join(words)
        
        return sanitized


class AnthropicErrorAdapter(ProviderErrorAdapter):
    def get_provider_name(self) -> str:
        return "anthropic"

    def sanitize_error_message(self, message: str) -> str:
        if not isinstance(message, str) or not message.strip() or len(message) > 2000:
            return "Anthropic API encountered an error. Please verify your API key."

        sanitized = message
        
        # Anthropic key format: sk-ant-...
        if 'sk-ant-' in sanitized:
            words = sanitized.split()
            for i, word in enumerate(words):
                if word.startswith('sk-ant-') and len(word) > 20:
                    words[i] = '[REDACTED_KEY]'
            sanitized = ' '.join(words)
        
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
        error_lower = error_str.lower()
        
        if "anthropic" in error_lower or "sk-ant-" in error_str:
            return "anthropic"
        elif "google" in error_lower or "AIza" in error_str:
            return "google"
        else:
            return "openai"