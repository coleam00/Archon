"""
Provider Discovery Service

Discovers available models, checks provider health, and provides model specifications
for OpenAI, Google Gemini, Ollama, Anthropic, and Grok providers.
"""

import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import aiohttp
import openai

from ..config.logfire_config import get_logger
from .credential_service import credential_service

logger = get_logger(__name__)

# Provider capabilities and model specifications cache
_provider_cache: dict[str, tuple[Any, float]] = {}
_CACHE_TTL_SECONDS = 300  # 5 minutes

# Default Ollama instance URL (configurable via environment/settings)
DEFAULT_OLLAMA_URL = "http://host.docker.internal:11434"

# Model pattern detection for dynamic capabilities (no hardcoded model names)
CHAT_MODEL_PATTERNS = ["llama", "qwen", "mistral", "codellama", "phi", "gemma", "vicuna", "orca"]
EMBEDDING_MODEL_PATTERNS = ["embed", "embedding"]
VISION_MODEL_PATTERNS = ["vision", "llava", "moondream"]

# Context window estimates by model family (heuristics, not hardcoded requirements)
MODEL_CONTEXT_WINDOWS = {
    "llama3": 8192,
    "qwen": 32768,
    "mistral": 8192,
    "codellama": 16384,
    "phi": 4096,
    "gemma": 8192,
}

# Embedding dimensions for common models (heuristics)
EMBEDDING_DIMENSIONS = {
    "nomic-embed": 768,
    "mxbai-embed": 1024,
    "all-minilm": 384,
}

@dataclass
class ModelSpec:
    """Model specification with capabilities and constraints."""
    name: str
    provider: str
    context_window: int
    supports_tools: bool = False
    supports_vision: bool = False
    supports_embeddings: bool = False
    embedding_dimensions: int | None = None
    pricing_input: float | None = None  # Per million tokens
    pricing_output: float | None = None  # Per million tokens
    description: str = ""
    aliases: list[str] = None

    def __post_init__(self):
        if self.aliases is None:
            self.aliases = []

@dataclass
class ProviderStatus:
    """Provider health and connectivity status."""
    provider: str
    is_available: bool
    response_time_ms: float | None = None
    error_message: str | None = None
    models_available: int = 0
    base_url: str | None = None
    last_checked: float | None = None

class ProviderDiscoveryService:
    """Service for discovering models and checking provider health."""

    def __init__(self):
        self._session: aiohttp.ClientSession | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        """Get or create HTTP session for provider requests."""
        if self._session is None:
            timeout = aiohttp.ClientTimeout(total=30, connect=10)
            self._session = aiohttp.ClientSession(timeout=timeout)
        return self._session

    async def close(self):
        """Close HTTP session."""
        if self._session:
            await self._session.close()
            self._session = None

    def _get_cached_result(self, cache_key: str) -> Any | None:
        """Get cached result if not expired."""
        if cache_key in _provider_cache:
            result, timestamp = _provider_cache[cache_key]
            if time.time() - timestamp < _CACHE_TTL_SECONDS:
                return result
            else:
                del _provider_cache[cache_key]
        return None

    def _cache_result(self, cache_key: str, result: Any) -> None:
        """Cache result with current timestamp."""
        _provider_cache[cache_key] = (result, time.time())

    async def _test_tool_support(self, model_name: str, api_url: str) -> bool:
        """
        Test if a model supports function/tool calling by making an actual API call.
        
        Args:
            model_name: Name of the model to test
            api_url: Base URL of the Ollama instance
            
        Returns:
            True if tool calling is supported, False otherwise
        """
        try:
            import openai
            
            # Use OpenAI-compatible client for function calling test
            client = openai.AsyncOpenAI(
                base_url=f"{api_url}/v1",
                api_key="ollama"  # Dummy API key for Ollama
            )
            
            # Define a simple test function
            test_function = {
                "name": "test_function",
                "description": "A test function",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "test_param": {
                            "type": "string",
                            "description": "A test parameter"
                        }
                    },
                    "required": ["test_param"]
                }
            }
            
            # Try to make a function calling request
            response = await client.chat.completions.create(
                model=model_name,
                messages=[{"role": "user", "content": "Call the test function with parameter 'hello'"}],
                tools=[{"type": "function", "function": test_function}],
                max_tokens=50,
                timeout=5  # Short timeout for quick testing
            )
            
            # Check if the model attempted to use the function
            if response.choices and len(response.choices) > 0:
                choice = response.choices[0]
                if hasattr(choice.message, 'tool_calls') and choice.message.tool_calls:
                    logger.info(f"Model {model_name} supports tool calling")
                    return True
            
            return False
            
        except Exception as e:
            logger.debug(f"Tool support test failed for {model_name}: {e}")
            # Fall back to name-based heuristics for known models
            return any(pattern in model_name.lower() 
                      for pattern in CHAT_MODEL_PATTERNS)
        
        finally:
            if 'client' in locals():
                await client.close()

    async def discover_openai_models(self, api_key: str) -> list[ModelSpec]:
        """Discover available OpenAI models."""
        cache_key = f"openai_models_{hash(api_key)}"
        cached = self._get_cached_result(cache_key)
        if cached:
            return cached

        models = []
        try:
            client = openai.AsyncOpenAI(api_key=api_key)
            response = await client.models.list()

            # OpenAI model specifications
            model_specs = {
                "gpt-4o": ModelSpec("gpt-4o", "openai", 128000, True, True, False, None, 2.50, 10.00, "Most capable GPT-4 model with vision"),
                "gpt-4o-mini": ModelSpec("gpt-4o-mini", "openai", 128000, True, True, False, None, 0.15, 0.60, "Affordable GPT-4 model"),
                "gpt-4-turbo": ModelSpec("gpt-4-turbo", "openai", 128000, True, True, False, None, 10.00, 30.00, "GPT-4 Turbo with vision"),
                "gpt-3.5-turbo": ModelSpec("gpt-3.5-turbo", "openai", 16385, True, False, False, None, 0.50, 1.50, "Fast and efficient model"),
                "text-embedding-3-large": ModelSpec("text-embedding-3-large", "openai", 8191, False, False, True, 3072, 0.13, 0, "High-quality embedding model"),
                "text-embedding-3-small": ModelSpec("text-embedding-3-small", "openai", 8191, False, False, True, 1536, 0.02, 0, "Efficient embedding model"),
                "text-embedding-ada-002": ModelSpec("text-embedding-ada-002", "openai", 8191, False, False, True, 1536, 0.10, 0, "Legacy embedding model"),
            }

            for model in response.data:
                if model.id in model_specs:
                    models.append(model_specs[model.id])
                else:
                    # Create basic spec for unknown models
                    models.append(ModelSpec(
                        name=model.id,
                        provider="openai",
                        context_window=4096,  # Default assumption
                        description=f"OpenAI model {model.id}"
                    ))

            self._cache_result(cache_key, models)
            logger.info(f"Discovered {len(models)} OpenAI models")

        except Exception as e:
            logger.error(f"Error discovering OpenAI models: {e}")

        return models

    async def discover_google_models(self, api_key: str) -> list[ModelSpec]:
        """Discover available Google Gemini models."""
        cache_key = f"google_models_{hash(api_key)}"
        cached = self._get_cached_result(cache_key)
        if cached:
            return cached

        models = []
        try:
            # Google Gemini model specifications
            model_specs = [
                ModelSpec("gemini-1.5-pro", "google", 2097152, True, True, False, None, 1.25, 5.00, "Advanced reasoning and multimodal capabilities"),
                ModelSpec("gemini-1.5-flash", "google", 1048576, True, True, False, None, 0.075, 0.30, "Fast and versatile performance"),
                ModelSpec("gemini-1.0-pro", "google", 30720, True, False, False, None, 0.50, 1.50, "Efficient model for text tasks"),
                ModelSpec("text-embedding-004", "google", 2048, False, False, True, 768, 0.00, 0, "Google's latest embedding model"),
            ]

            # Test connectivity with a simple request
            session = await self._get_session()
            base_url = "https://generativelanguage.googleapis.com/v1beta/models"
            headers = {"Authorization": f"Bearer {api_key}"}

            async with session.get(f"{base_url}?key={api_key}", headers=headers) as response:
                if response.status == 200:
                    models = model_specs
                    self._cache_result(cache_key, models)
                    logger.info(f"Discovered {len(models)} Google models")
                else:
                    logger.warning(f"Google API returned status {response.status}")

        except Exception as e:
            logger.error(f"Error discovering Google models: {e}")

        return models

    async def discover_ollama_models(self, base_urls: list[str]) -> list[ModelSpec]:
        """Discover available Ollama models from multiple instances."""
        all_models = []

        for base_url in base_urls:
            cache_key = f"ollama_models_{base_url}"
            cached = self._get_cached_result(cache_key)
            if cached:
                all_models.extend(cached)
                continue

            try:
                # Clean up URL - remove /v1 suffix if present for raw Ollama API
                parsed = urlparse(base_url)
                if parsed.path.endswith('/v1'):
                    api_url = base_url.replace('/v1', '')
                else:
                    api_url = base_url

                session = await self._get_session()

                # Get installed models
                async with session.get(f"{api_url}/api/tags") as response:
                    if response.status == 200:
                        data = await response.json()
                        models = []

                        for model_info in data.get("models", []):
                            model_name = model_info.get("name", "").split(':')[0]  # Remove tag

                            # Determine model capabilities based on testing and name patterns
                            # Test for function calling capabilities via actual API calls
                            supports_tools = await self._test_tool_support(model_name, api_url)
                            # Vision support is typically indicated by name patterns (reliable indicator)
                            supports_vision = any(pattern in model_name.lower() for pattern in VISION_MODEL_PATTERNS)
                            # Embedding support is typically indicated by name patterns (reliable indicator)  
                            supports_embeddings = any(pattern in model_name.lower() for pattern in EMBEDDING_MODEL_PATTERNS)

                            # Estimate context window based on model family
                            context_window = 4096  # Default
                            for family, window_size in MODEL_CONTEXT_WINDOWS.items():
                                if family in model_name.lower():
                                    context_window = window_size
                                    break

                            # Set embedding dimensions for known embedding models
                            embedding_dims = None
                            for model_pattern, dims in EMBEDDING_DIMENSIONS.items():
                                if model_pattern in model_name.lower():
                                    embedding_dims = dims
                                    break

                            spec = ModelSpec(
                                name=model_info.get("name", model_name),
                                provider="ollama",
                                context_window=context_window,
                                supports_tools=supports_tools,
                                supports_vision=supports_vision,
                                supports_embeddings=supports_embeddings,
                                embedding_dimensions=embedding_dims,
                                description=f"Ollama model on {base_url}",
                                aliases=[model_name] if ':' in model_info.get("name", "") else []
                            )
                            models.append(spec)

                        self._cache_result(cache_key, models)
                        all_models.extend(models)
                        logger.info(f"Discovered {len(models)} Ollama models from {base_url}")

                    else:
                        logger.warning(f"Ollama instance at {base_url} returned status {response.status}")

            except Exception as e:
                logger.error(f"Error discovering Ollama models from {base_url}: {e}")

        return all_models

    async def discover_anthropic_models(self, api_key: str) -> list[ModelSpec]:
        """Discover available Anthropic Claude models."""
        cache_key = f"anthropic_models_{hash(api_key)}"
        cached = self._get_cached_result(cache_key)
        if cached:
            return cached

        models = []
        try:
            # Anthropic Claude model specifications
            model_specs = [
                ModelSpec("claude-3-5-sonnet-20241022", "anthropic", 200000, True, True, False, None, 3.00, 15.00, "Most intelligent Claude model"),
                ModelSpec("claude-3-5-haiku-20241022", "anthropic", 200000, True, False, False, None, 0.25, 1.25, "Fast and cost-effective Claude model"),
                ModelSpec("claude-3-opus-20240229", "anthropic", 200000, True, True, False, None, 15.00, 75.00, "Powerful model for complex tasks"),
                ModelSpec("claude-3-sonnet-20240229", "anthropic", 200000, True, True, False, None, 3.00, 15.00, "Balanced performance and cost"),
                ModelSpec("claude-3-haiku-20240307", "anthropic", 200000, True, False, False, None, 0.25, 1.25, "Fast responses and cost-effective"),
            ]

            # Test connectivity - Anthropic doesn't have a models list endpoint,
            # so we'll just return the known models if API key is provided
            if api_key:
                models = model_specs
                self._cache_result(cache_key, models)
                logger.info(f"Discovered {len(models)} Anthropic models")

        except Exception as e:
            logger.error(f"Error discovering Anthropic models: {e}")

        return models

    async def discover_grok_models(self, api_key: str) -> list[ModelSpec]:
        """Discover available Grok models."""
        cache_key = f"grok_models_{hash(api_key)}"
        cached = self._get_cached_result(cache_key)
        if cached:
            return cached

        models = []
        try:
            # Grok model specifications
            model_specs = [
                ModelSpec("grok-3-mini", "grok", 32768, True, True, False, None, 0.15, 0.60, "Fast and efficient Grok model"),
                ModelSpec("grok-3", "grok", 32768, True, True, False, None, 2.00, 10.00, "Standard Grok model"),
                ModelSpec("grok-4", "grok", 32768, True, True, False, None, 5.00, 25.00, "Advanced Grok model"),
                ModelSpec("grok-2-vision", "grok", 8192, True, True, True, None, 3.00, 15.00, "Grok model with vision capabilities"),
                ModelSpec("grok-2-latest", "grok", 8192, True, True, False, None, 2.00, 10.00, "Latest Grok 2 model"),
            ]

            # Test connectivity - Grok doesn't have a models list endpoint,
            # so we'll just return the known models if API key is provided
            if api_key:
                models = model_specs
                self._cache_result(cache_key, models)
                logger.info(f"Discovered {len(models)} Grok models")

        except Exception as e:
            logger.error(f"Error discovering Grok models: {e}")

        return models

    async def check_provider_health(self, provider: str, config: dict[str, Any]) -> ProviderStatus:
        """Check health and connectivity status of a provider."""
        start_time = time.time()

        try:
            if provider == "openai":
                api_key = config.get("api_key")
                if not api_key:
                    return ProviderStatus(provider, False, None, "API key not configured")

                client = openai.AsyncOpenAI(api_key=api_key)
                models = await client.models.list()
                response_time = (time.time() - start_time) * 1000

                return ProviderStatus(
                    provider="openai",
                    is_available=True,
                    response_time_ms=response_time,
                    models_available=len(models.data),
                    last_checked=time.time()
                )

            elif provider == "google":
                api_key = config.get("api_key")
                if not api_key:
                    return ProviderStatus(provider, False, None, "API key not configured")

                session = await self._get_session()
                base_url = "https://generativelanguage.googleapis.com/v1beta/models"

                async with session.get(f"{base_url}?key={api_key}") as response:
                    response_time = (time.time() - start_time) * 1000

                    if response.status == 200:
                        data = await response.json()
                        return ProviderStatus(
                            provider="google",
                            is_available=True,
                            response_time_ms=response_time,
                            models_available=len(data.get("models", [])),
                            base_url=base_url,
                            last_checked=time.time()
                        )
                    else:
                        return ProviderStatus(provider, False, response_time, f"HTTP {response.status}")

            elif provider == "ollama":
                base_urls = config.get("base_urls", [config.get("base_url", DEFAULT_OLLAMA_URL)])
                if isinstance(base_urls, str):
                    base_urls = [base_urls]

                # Check the first available Ollama instance
                for base_url in base_urls:
                    try:
                        # Clean up URL for raw Ollama API
                        parsed = urlparse(base_url)
                        if parsed.path.endswith('/v1'):
                            api_url = base_url.replace('/v1', '')
                        else:
                            api_url = base_url

                        session = await self._get_session()
                        async with session.get(f"{api_url}/api/tags") as response:
                            response_time = (time.time() - start_time) * 1000

                            if response.status == 200:
                                data = await response.json()
                                return ProviderStatus(
                                    provider="ollama",
                                    is_available=True,
                                    response_time_ms=response_time,
                                    models_available=len(data.get("models", [])),
                                    base_url=api_url,
                                    last_checked=time.time()
                                )
                    except Exception:
                        continue  # Try next URL

                return ProviderStatus(provider, False, None, "No Ollama instances available")

            elif provider == "anthropic":
                api_key = config.get("api_key")
                if not api_key:
                    return ProviderStatus(provider, False, None, "API key not configured")

                # Anthropic doesn't have a health check endpoint, so we'll assume it's available
                # if API key is provided. In a real implementation, you might want to make a
                # small test request to verify the key is valid.
                response_time = (time.time() - start_time) * 1000
                return ProviderStatus(
                    provider="anthropic",
                    is_available=True,
                    response_time_ms=response_time,
                    models_available=5,  # Known model count
                    last_checked=time.time()
                )

            elif provider == "grok":
                api_key = config.get("api_key")
                if not api_key:
                    return ProviderStatus(provider, False, None, "API key not configured")

                # Grok doesn't have a health check endpoint, so we'll assume it's available
                # if API key is provided. In a real implementation, you might want to make a
                # small test request to verify the key is valid.
                response_time = (time.time() - start_time) * 1000
                return ProviderStatus(
                    provider="grok",
                    is_available=True,
                    response_time_ms=response_time,
                    models_available=5,  # Known model count
                    last_checked=time.time()
                )

            else:
                return ProviderStatus(provider, False, None, f"Unknown provider: {provider}")

        except Exception as e:
            response_time = (time.time() - start_time) * 1000
            return ProviderStatus(
                provider=provider,
                is_available=False,
                response_time_ms=response_time,
                error_message=str(e),
                last_checked=time.time()
            )

    async def get_all_available_models(self) -> dict[str, list[ModelSpec]]:
        """Get all available models from all configured providers."""
        providers = {}

        try:
            # Get provider configurations
            rag_settings = await credential_service.get_credentials_by_category("rag_strategy")

            # OpenAI
            openai_key = await credential_service.get_credential("OPENAI_API_KEY")
            if openai_key:
                providers["openai"] = await self.discover_openai_models(openai_key)

            # Google
            google_key = await credential_service.get_credential("GOOGLE_API_KEY")
            if google_key:
                providers["google"] = await self.discover_google_models(google_key)

            # Ollama
            ollama_urls = [rag_settings.get("LLM_BASE_URL", DEFAULT_OLLAMA_URL)]
            providers["ollama"] = await self.discover_ollama_models(ollama_urls)

            # Anthropic
            anthropic_key = await credential_service.get_credential("ANTHROPIC_API_KEY")
            if anthropic_key:
                providers["anthropic"] = await self.discover_anthropic_models(anthropic_key)

            # Grok
            grok_key = await credential_service.get_credential("GROK_API_KEY")
            if grok_key:
                providers["grok"] = await self.discover_grok_models(grok_key)

        except Exception as e:
            logger.error(f"Error getting all available models: {e}")

        return providers

# Global instance
provider_discovery_service = ProviderDiscoveryService()
