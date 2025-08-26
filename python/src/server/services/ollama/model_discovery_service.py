"""
Ollama Model Discovery Service

Provides comprehensive model discovery, validation, and capability detection for Ollama instances.
Supports multi-instance configurations with automatic dimension detection and health monitoring.
"""

import asyncio
import time
from dataclasses import dataclass
from typing import Any, cast

import httpx

from ...config.logfire_config import get_logger
from ..llm_provider_service import get_llm_client

logger = get_logger(__name__)


@dataclass
class OllamaModel:
    """Represents a discovered Ollama model with capabilities."""

    name: str
    tag: str
    size: int
    digest: str
    capabilities: list[str]  # 'chat', 'embedding', or both
    embedding_dimensions: int | None = None
    parameters: dict[str, Any] | None = None
    instance_url: str = ""
    last_updated: str | None = None


@dataclass
class ModelCapabilities:
    """Model capability analysis results."""

    supports_chat: bool = False
    supports_embedding: bool = False
    supports_function_calling: bool = False
    supports_structured_output: bool = False
    embedding_dimensions: int | None = None
    parameter_count: str | None = None
    model_family: str | None = None
    quantization: str | None = None


@dataclass
class InstanceHealthStatus:
    """Health status for an Ollama instance."""

    is_healthy: bool
    response_time_ms: float | None = None
    models_available: int = 0
    error_message: str | None = None
    last_checked: str | None = None


class ModelDiscoveryService:
    """Service for discovering and validating Ollama models across multiple instances."""

    def __init__(self):
        self.model_cache: dict[str, list[OllamaModel]] = {}
        self.capability_cache: dict[str, ModelCapabilities] = {}
        self.health_cache: dict[str, InstanceHealthStatus] = {}
        self.cache_ttl = 300  # 5 minutes TTL
        self.discovery_timeout = 30  # 30 seconds timeout for discovery

    def _get_cached_models(self, instance_url: str) -> list[OllamaModel] | None:
        """Get cached models if not expired."""
        cache_key = f"models_{instance_url}"
        cached_data = self.model_cache.get(cache_key)
        if cached_data:
            # Check if any model in cache is still valid (simple TTL check)
            first_model = cached_data[0] if cached_data else None
            if first_model and first_model.last_updated:
                cache_time = float(first_model.last_updated)
                if time.time() - cache_time < self.cache_ttl:
                    logger.debug(f"Using cached models for {instance_url}")
                    return cached_data
                else:
                    # Expired, remove from cache
                    del self.model_cache[cache_key]
        return None

    def _cache_models(self, instance_url: str, models: list[OllamaModel]) -> None:
        """Cache models with current timestamp."""
        cache_key = f"models_{instance_url}"
        # Set timestamp for cache expiry
        current_time = str(time.time())
        for model in models:
            model.last_updated = current_time
        self.model_cache[cache_key] = models
        logger.debug(f"Cached {len(models)} models for {instance_url}")

    async def discover_models(self, instance_url: str) -> list[OllamaModel]:
        """
        Discover all available models from an Ollama instance.

        Args:
            instance_url: Base URL of the Ollama instance

        Returns:
            List of OllamaModel objects with discovered capabilities
        """
        # Check cache first
        cached_models = self._get_cached_models(instance_url)
        if cached_models:
            return cached_models

        try:
            logger.info(f"Discovering models from Ollama instance: {instance_url}")

            # Use direct HTTP client for /api/tags endpoint (not OpenAI-compatible)
            async with httpx.AsyncClient(timeout=httpx.Timeout(self.discovery_timeout)) as client:
                # Ollama API endpoint for listing models
                tags_url = f"{instance_url.rstrip('/')}/api/tags"

                response = await client.get(tags_url)
                response.raise_for_status()
                data = response.json()

                models = []
                if "models" in data:
                    for model_data in data["models"]:
                        # Extract basic model information
                        model = OllamaModel(
                            name=model_data.get("name", "unknown"),
                            tag=model_data.get("name", "unknown"),  # Ollama uses name as tag
                            size=model_data.get("size", 0),
                            digest=model_data.get("digest", ""),
                            capabilities=[],  # Will be filled by capability detection
                            instance_url=instance_url
                        )

                        # Extract additional model details if available
                        details = model_data.get("details", {})
                        if details:
                            model.parameters = {
                                "family": details.get("family", ""),
                                "parameter_size": details.get("parameter_size", ""),
                                "quantization": details.get("quantization_level", "")
                            }

                        models.append(model)

                logger.info(f"Discovered {len(models)} models from {instance_url}")

                # Enrich models with capability information
                enriched_models = await self._enrich_model_capabilities(models, instance_url)

                # Cache the results
                self._cache_models(instance_url, enriched_models)

                return enriched_models

        except httpx.TimeoutException as e:
            logger.error(f"Timeout discovering models from {instance_url}")
            raise Exception(f"Timeout connecting to Ollama instance at {instance_url}") from e
        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error discovering models from {instance_url}: {e.response.status_code}")
            raise Exception(f"HTTP {e.response.status_code} error from {instance_url}") from e
        except Exception as e:
            logger.error(f"Error discovering models from {instance_url}: {e}")
            raise Exception(f"Failed to discover models: {str(e)}") from e

    async def _enrich_model_capabilities(self, models: list[OllamaModel], instance_url: str) -> list[OllamaModel]:
        """
        Enrich models with capability information by testing each model.

        Args:
            models: List of basic model information
            instance_url: Ollama instance URL

        Returns:
            Models enriched with capability information
        """
        enriched_models = []

        # Process models in batches to avoid overwhelming the instance
        batch_size = 3
        for i in range(0, len(models), batch_size):
            batch = models[i:i + batch_size]

            # Process batch concurrently with limited concurrency
            tasks = [
                self._detect_model_capabilities(model.name, instance_url)
                for model in batch
            ]

            try:
                capabilities_batch = await asyncio.gather(*tasks, return_exceptions=True)

                for _j, (model, capabilities) in enumerate(zip(batch, capabilities_batch, strict=False)):
                    if isinstance(capabilities, Exception):
                        logger.warning(f"Failed to detect capabilities for {model.name}: {capabilities}")
                        # Set basic capabilities as fallback
                        model.capabilities = ["chat"]  # Default assumption
                    else:
                        # Use cast to tell type checker this is ModelCapabilities
                        caps = cast(ModelCapabilities, capabilities)
                        # Apply detected capabilities
                        model.capabilities = []
                        if caps.supports_chat:
                            model.capabilities.append("chat")
                            # Add advanced capabilities for chat models
                            if caps.supports_function_calling:
                                model.capabilities.append("function_calling")
                            if caps.supports_structured_output:
                                model.capabilities.append("structured_output")
                        if caps.supports_embedding:
                            model.capabilities.append("embedding")
                            model.embedding_dimensions = caps.embedding_dimensions

                        # Update parameters if available
                        if caps.parameter_count:
                            if not model.parameters:
                                model.parameters = {}
                            model.parameters["parameter_count"] = caps.parameter_count

                    enriched_models.append(model)

            except Exception as e:
                logger.error(f"Error enriching model batch: {e}")
                # Add models with basic capabilities as fallback
                for model in batch:
                    model.capabilities = ["chat"]
                    enriched_models.append(model)

        return enriched_models

    async def _detect_model_capabilities(self, model_name: str, instance_url: str) -> ModelCapabilities:
        """
        Detect capabilities of a specific model by testing its endpoints.

        Args:
            model_name: Name of the model to test
            instance_url: Ollama instance URL

        Returns:
            ModelCapabilities object with detected capabilities
        """
        # Check cache first
        cache_key = f"{model_name}@{instance_url}"
        if cache_key in self.capability_cache:
            cached_caps = self.capability_cache[cache_key]
            logger.debug(f"Using cached capabilities for {model_name}")
            return cached_caps

        capabilities = ModelCapabilities()

        try:
            # Test embedding capability first (more specific)
            embedding_dims = await self._test_embedding_capability(model_name, instance_url)
            if embedding_dims:
                capabilities.supports_embedding = True
                capabilities.embedding_dimensions = embedding_dims
                logger.debug(f"Model {model_name} supports embeddings with {embedding_dims} dimensions")

            # Test chat capability
            chat_supported = await self._test_chat_capability(model_name, instance_url)
            if chat_supported:
                capabilities.supports_chat = True
                logger.debug(f"Model {model_name} supports chat")
                
                # Test advanced capabilities for chat models
                function_calling_supported = await self._test_function_calling_capability(model_name, instance_url)
                if function_calling_supported:
                    capabilities.supports_function_calling = True
                    logger.debug(f"Model {model_name} supports function calling")
                
                structured_output_supported = await self._test_structured_output_capability(model_name, instance_url)
                if structured_output_supported:
                    capabilities.supports_structured_output = True
                    logger.debug(f"Model {model_name} supports structured output")

            # Get additional model information
            model_info = await self._get_model_details(model_name, instance_url)
            if model_info:
                capabilities.parameter_count = model_info.get("parameter_count")
                capabilities.model_family = model_info.get("family")
                capabilities.quantization = model_info.get("quantization")

            # Cache the results
            self.capability_cache[cache_key] = capabilities

        except Exception as e:
            logger.warning(f"Error detecting capabilities for {model_name}: {e}")
            # Default to chat capability if detection fails
            capabilities.supports_chat = True

        return capabilities

    async def _test_embedding_capability(self, model_name: str, instance_url: str) -> int | None:
        """
        Test if a model supports embeddings and detect dimensions.

        Returns:
            Embedding dimensions if supported, None otherwise
        """
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(10)) as client:
                embed_url = f"{instance_url.rstrip('/')}/api/embeddings"

                payload = {
                    "model": model_name,
                    "prompt": "test embedding"
                }

                response = await client.post(embed_url, json=payload)

                if response.status_code == 200:
                    data = response.json()
                    embedding = data.get("embedding", [])
                    if embedding:
                        dimensions = len(embedding)
                        logger.debug(f"Model {model_name} embedding dimensions: {dimensions}")
                        return dimensions

        except Exception as e:
            logger.debug(f"Model {model_name} does not support embeddings: {e}")

        return None

    async def _test_chat_capability(self, model_name: str, instance_url: str) -> bool:
        """
        Test if a model supports chat completions.

        Returns:
            True if chat is supported, False otherwise
        """
        try:
            # Use OpenAI-compatible client for chat testing
            async with get_llm_client(provider="ollama") as client:
                # Set base_url for this specific instance
                client.base_url = f"{instance_url.rstrip('/')}/v1"

                response = await client.chat.completions.create(
                    model=model_name,
                    messages=[{"role": "user", "content": "Hi"}],
                    max_tokens=1,
                    timeout=10
                )

                if response.choices and len(response.choices) > 0:
                    return True

        except Exception as e:
            logger.debug(f"Model {model_name} does not support chat: {e}")

        return False

    async def _get_model_details(self, model_name: str, instance_url: str) -> dict[str, Any] | None:
        """
        Get detailed information about a model from Ollama /api/show endpoint.

        Returns:
            Model details dictionary or None if failed
        """
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(10)) as client:
                show_url = f"{instance_url.rstrip('/')}/api/show"

                payload = {"name": model_name}
                response = await client.post(show_url, json=payload)

                if response.status_code == 200:
                    data = response.json()
                    # Extract relevant details
                    details = {
                        "family": data.get("details", {}).get("family"),
                        "parameter_count": data.get("details", {}).get("parameter_size"),
                        "quantization": data.get("details", {}).get("quantization_level")
                    }
                    return details

        except Exception as e:
            logger.debug(f"Could not get details for model {model_name}: {e}")

        return None

    async def _test_function_calling_capability(self, model_name: str, instance_url: str) -> bool:
        """
        Test if a model supports function/tool calling.

        Returns:
            True if function calling is supported, False otherwise
        """
        try:
            async with get_llm_client(provider="ollama") as client:
                # Set base_url for this specific instance
                client.base_url = f"{instance_url.rstrip('/')}/v1"

                # Define a simple test function
                test_function = {
                    "name": "get_current_time",
                    "description": "Get the current time",
                    "parameters": {
                        "type": "object",
                        "properties": {},
                        "required": []
                    }
                }

                response = await client.chat.completions.create(
                    model=model_name,
                    messages=[{"role": "user", "content": "What time is it? Use the available function to get the current time."}],
                    tools=[{"type": "function", "function": test_function}],
                    max_tokens=50,
                    timeout=8
                )

                # Check if the model attempted to use the function
                if response.choices and len(response.choices) > 0:
                    choice = response.choices[0]
                    if hasattr(choice.message, 'tool_calls') and choice.message.tool_calls:
                        return True

        except Exception as e:
            logger.debug(f"Function calling test failed for {model_name}: {e}")

        return False

    async def _test_structured_output_capability(self, model_name: str, instance_url: str) -> bool:
        """
        Test if a model can produce structured output.

        Returns:
            True if structured output is supported, False otherwise
        """
        try:
            async with get_llm_client(provider="ollama") as client:
                # Set base_url for this specific instance
                client.base_url = f"{instance_url.rstrip('/')}/v1"

                # Test structured JSON output
                response = await client.chat.completions.create(
                    model=model_name,
                    messages=[{
                        "role": "user", 
                        "content": "Return exactly this JSON structure with no additional text: {\"name\": \"test\", \"value\": 42, \"active\": true}"
                    }],
                    max_tokens=100,
                    timeout=8,
                    temperature=0.1
                )

                if response.choices and len(response.choices) > 0:
                    content = response.choices[0].message.content
                    if content:
                        # Try to parse as JSON
                        import json
                        try:
                            parsed = json.loads(content.strip())
                            if isinstance(parsed, dict) and 'name' in parsed and 'value' in parsed:
                                return True
                        except json.JSONDecodeError:
                            # Look for JSON-like patterns
                            if '{' in content and '}' in content and '"name"' in content:
                                return True

        except Exception as e:
            logger.debug(f"Structured output test failed for {model_name}: {e}")

        return False

    async def validate_model_capabilities(self, model_name: str, instance_url: str, required_capability: str) -> bool:
        """
        Validate that a model supports a required capability.

        Args:
            model_name: Name of the model to validate
            instance_url: Ollama instance URL
            required_capability: 'chat' or 'embedding'

        Returns:
            True if model supports the capability, False otherwise
        """
        try:
            capabilities = await self._detect_model_capabilities(model_name, instance_url)

            if required_capability == "chat":
                return capabilities.supports_chat
            elif required_capability == "embedding":
                return capabilities.supports_embedding
            elif required_capability == "function_calling":
                return capabilities.supports_function_calling
            elif required_capability == "structured_output":
                return capabilities.supports_structured_output
            else:
                logger.warning(f"Unknown capability requirement: {required_capability}")
                return False

        except Exception as e:
            logger.error(f"Error validating model {model_name} for {required_capability}: {e}")
            return False

    async def get_model_info(self, model_name: str, instance_url: str) -> OllamaModel | None:
        """
        Get comprehensive information about a specific model.

        Args:
            model_name: Name of the model
            instance_url: Ollama instance URL

        Returns:
            OllamaModel object with complete information or None if not found
        """
        try:
            models = await self.discover_models(instance_url)

            for model in models:
                if model.name == model_name:
                    return model

            logger.warning(f"Model {model_name} not found on instance {instance_url}")
            return None

        except Exception as e:
            logger.error(f"Error getting model info for {model_name}: {e}")
            return None

    async def check_instance_health(self, instance_url: str) -> InstanceHealthStatus:
        """
        Check the health status of an Ollama instance.

        Args:
            instance_url: Base URL of the Ollama instance

        Returns:
            InstanceHealthStatus with current health information
        """
        # Check cache first (shorter TTL for health checks)
        cache_key = f"health_{instance_url}"
        if cache_key in self.health_cache:
            cached_health = self.health_cache[cache_key]
            if cached_health.last_checked:
                cache_time = float(cached_health.last_checked)
                # Use shorter cache for health (30 seconds)
                if time.time() - cache_time < 30:
                    return cached_health

        start_time = time.time()
        status = InstanceHealthStatus(is_healthy=False)

        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(10)) as client:
                # Try to ping the Ollama API
                ping_url = f"{instance_url.rstrip('/')}/api/tags"

                response = await client.get(ping_url)
                response.raise_for_status()

                data = response.json()
                models_count = len(data.get("models", []))

                status.is_healthy = True
                status.response_time_ms = (time.time() - start_time) * 1000
                status.models_available = models_count
                status.last_checked = str(time.time())

                logger.debug(f"Instance {instance_url} is healthy: {models_count} models, {status.response_time_ms:.0f}ms")

        except httpx.TimeoutException:
            status.error_message = "Connection timeout"
            logger.warning(f"Health check timeout for {instance_url}")
        except httpx.HTTPStatusError as e:
            status.error_message = f"HTTP {e.response.status_code}"
            logger.warning(f"Health check HTTP error for {instance_url}: {e.response.status_code}")
        except Exception as e:
            status.error_message = str(e)
            logger.warning(f"Health check failed for {instance_url}: {e}")

        # Cache the result
        self.health_cache[cache_key] = status

        return status

    async def discover_models_from_multiple_instances(self, instance_urls: list[str]) -> dict[str, Any]:
        """
        Discover models from multiple Ollama instances concurrently.

        Args:
            instance_urls: List of Ollama instance URLs

        Returns:
            Dictionary with discovery results and aggregated information
        """
        if not instance_urls:
            return {
                "total_models": 0,
                "chat_models": [],
                "embedding_models": [],
                "host_status": {},
                "discovery_errors": []
            }

        logger.info(f"Discovering models from {len(instance_urls)} Ollama instances")

        # Discover models from all instances concurrently
        tasks = [self.discover_models(url) for url in instance_urls]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Aggregate results
        all_models: list[OllamaModel] = []
        chat_models = []
        embedding_models = []
        host_status = {}
        discovery_errors = []

        for _i, (url, result) in enumerate(zip(instance_urls, results, strict=False)):
            if isinstance(result, Exception):
                error_msg = f"Failed to discover models from {url}: {str(result)}"
                discovery_errors.append(error_msg)
                host_status[url] = {"status": "error", "error": str(result)}
                logger.error(error_msg)
            else:
                # Use cast to tell type checker this is list[OllamaModel]
                models = cast(list[OllamaModel], result)
                all_models.extend(models)
                host_status[url] = {
                    "status": "online",
                    "models_count": str(len(models)),
                    "instance_url": url
                }

                # Categorize models
                for model in models:
                    if "chat" in model.capabilities:
                        chat_models.append({
                            "name": model.name,
                            "instance_url": model.instance_url,
                            "size": model.size,
                            "parameters": model.parameters
                        })

                    if "embedding" in model.capabilities:
                        embedding_models.append({
                            "name": model.name,
                            "instance_url": model.instance_url,
                            "dimensions": model.embedding_dimensions,
                            "size": model.size
                        })

        # Remove duplicates (same model on multiple instances)
        unique_models = {}
        for model in all_models:
            key = f"{model.name}@{model.instance_url}"
            unique_models[key] = model

        discovery_result = {
            "total_models": len(unique_models),
            "chat_models": chat_models,
            "embedding_models": embedding_models,
            "host_status": host_status,
            "discovery_errors": discovery_errors,
            "unique_model_names": list({model.name for model in unique_models.values()})
        }

        logger.info(f"Discovery complete: {discovery_result['total_models']} total models, "
                   f"{len(chat_models)} chat, {len(embedding_models)} embedding")

        return discovery_result


# Global service instance
model_discovery_service = ModelDiscoveryService()
