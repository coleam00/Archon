"""Anthropic Claude service with prompt caching."""

from typing import Any, AsyncIterator, Dict, List, Optional

from anthropic import AsyncAnthropic

from ...config.logfire_config import get_logger
from ..credential_service import credential_service

logger = get_logger(__name__)


class ClaudeService:
    """Service for interacting with Anthropic Claude API with prompt caching support."""

    def __init__(self):
        self.client: Optional[AsyncAnthropic] = None
        self.available = False
        self._api_key: Optional[str] = None

    async def initialize(self) -> bool:
        """Initialize the Claude client with API key from credentials."""
        try:
            api_key = await credential_service._get_provider_api_key("anthropic")
            if api_key:
                self._api_key = api_key
                self.client = AsyncAnthropic(api_key=api_key)
                self.available = True
                logger.info("Claude service initialized successfully")
                return True
            else:
                logger.warning("ANTHROPIC_API_KEY not found, Claude unavailable")
                self.available = False
                return False
        except Exception as e:
            logger.error(f"Failed to initialize Claude service: {e}")
            self.available = False
            return False

    async def create_message(
        self,
        messages: List[Dict[str, str]],
        model: str = "claude-3-5-sonnet-20241022",
        system: Optional[str] = None,
        max_tokens: int = 4096,
        temperature: float = 1.0,
        use_caching: bool = True,
    ) -> Dict[str, Any]:
        """
        Create a message with Claude.

        Args:
            messages: List of message dicts with 'role' and 'content'
            model: Claude model to use
            system: System prompt (will be cached if use_caching=True)
            max_tokens: Maximum tokens to generate
            temperature: Sampling temperature
            use_caching: Whether to enable prompt caching

        Returns:
            Response dict with content, usage, etc.
        """
        if not self.available or not self.client:
            await self.initialize()
            if not self.available:
                raise ValueError("Claude service not available (missing API key)")

        system_messages = []
        if system:
            system_msg = {
                "type": "text",
                "text": system,
            }
            if use_caching:
                system_msg["cache_control"] = {"type": "ephemeral"}
            system_messages.append(system_msg)

        response = await self.client.messages.create(
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            system=system_messages if system_messages else None,
            messages=messages,
        )

        usage = response.usage
        logger.info(
            "Claude API call completed",
            extra={
                "model": model,
                "input_tokens": usage.input_tokens,
                "output_tokens": usage.output_tokens,
                "cache_creation_tokens": getattr(usage, "cache_creation_input_tokens", 0),
                "cache_read_tokens": getattr(usage, "cache_read_input_tokens", 0),
            },
        )

        return {
            "content": response.content[0].text,
            "model": response.model,
            "usage": {
                "input_tokens": usage.input_tokens,
                "output_tokens": usage.output_tokens,
                "cache_creation_tokens": getattr(usage, "cache_creation_input_tokens", 0),
                "cache_read_tokens": getattr(usage, "cache_read_input_tokens", 0),
            },
            "stop_reason": response.stop_reason,
        }

    async def create_message_stream(
        self,
        messages: List[Dict[str, str]],
        model: str = "claude-3-5-sonnet-20241022",
        system: Optional[str] = None,
        max_tokens: int = 4096,
        use_caching: bool = True,
    ) -> AsyncIterator[str]:
        """Stream a message from Claude."""
        if not self.available or not self.client:
            await self.initialize()
            if not self.available:
                raise ValueError("Claude service not available")

        system_messages = []
        if system:
            system_msg = {"type": "text", "text": system}
            if use_caching:
                system_msg["cache_control"] = {"type": "ephemeral"}
            system_messages.append(system_msg)

        async with self.client.messages.stream(
            model=model,
            max_tokens=max_tokens,
            system=system_messages if system_messages else None,
            messages=messages,
        ) as stream:
            async for text in stream.text_stream:
                yield text


_claude_service: Optional[ClaudeService] = None


def get_claude_service() -> ClaudeService:
    """Get or create Claude service instance."""
    global _claude_service
    if _claude_service is None:
        _claude_service = ClaudeService()
    return _claude_service
