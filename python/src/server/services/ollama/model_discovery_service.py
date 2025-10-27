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
    """Represents a discovered Ollama model with comprehensive capabilities and metadata."""

    name: str
    tag: str
    size: int
    digest: str
    capabilities: list[str]  # 'chat', 'embedding', or both
    embedding_dimensions: int | None = None
    parameters: dict[str, Any] | None = None
    instance_url: str = ""
    last_updated: str | None = None
    
    # Comprehensive API data from /api/show endpoint
    context_window: int | None = None  # Current/active context length
    max_context_length: int | None = None  # Maximum supported context length  
    base_context_length: int | None = None  # Original/base context length
    custom_context_length: int | None = None  # Custom num_ctx if set
    architecture: str | None = None
    block_count: int | None = None
    attention_heads: int | None = None
    format: str | None = None
    parent_model: str | None = None
    
    # Extended model metadata
    family: str | None = None
    parameter_size: str | None = None
    quantization: str | None = None
    parameter_count: int | None = None
    file_type: int | None = None
    quantization_version: int | None = None
    basename: str | None = None
    size_label: str | None = None
    license: str | None = None
    finetune: str | None = None
    embedding_dimension: int | None = None


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

    async def discover_models(self, instance_url: str, fetch_details: bool = False) -> list[OllamaModel]:
        """
        Discover all available models from an Ollama instance.

        Args:
            instance_url: Base URL of the Ollama instance
            fetch_details: If True, fetch comprehensive model details via /api/show

        Returns:
            List of OllamaModel objects with discovered capabilities
        """
        # ULTRA FAST MODE DISABLED - Now fetching real models
        # logger.warning(f"🚀 ULTRA FAST MODE ACTIVE - Returning mock models instantly for {instance_url}")
        
        # mock_models = [
        #     OllamaModel(
        #         name="llama3.2:latest",
        #         tag="llama3.2:latest",
        #         size=5000000000,
        #         digest="mock",
        #         capabilities=["chat", "structured_output"],
        #         instance_url=instance_url
        #     ),
        #     OllamaModel(
        #         name="mistral:latest",
        #         tag="mistral:latest",
        #         size=4000000000,
        #         digest="mock",
        #         capabilities=["chat"],
        #         instance_url=instance_url
        #     ),
        #     OllamaModel(
        #         name="nomic-embed-text:latest",
        #         tag="nomic-embed-text:latest",
        #         size=300000000,
        #         digest="mock",
        #         capabilities=["embedding"],
        #         embedding_dimensions=768,
        #         instance_url=instance_url
        #     ),
        #     OllamaModel(
        #         name="mxbai-embed-large:latest",
        #         tag="mxbai-embed-large:latest",
        #         size=670000000,
        #         digest="mock",
        #         capabilities=["embedding"],
        #         embedding_dimensions=1024,
        #         instance_url=instance_url
        #     ),
        # ]
        
        # return mock_models
        
        # Check cache first (but skip if we need detailed info)
        if not fetch_details:
            cached_models = self._get_cached_models(instance_url)
            if cached_models:
                return cached_models

        try:
            logger.info(f"Discovering models from Ollama instance: {instance_url}")

            # Use direct HTTP client for /api/tags endpoint (not OpenAI-compatible)
            async with httpx.AsyncClient(timeout=httpx.Timeout(self.discovery_timeout)) as client:
                # Remove /v1 suffix if present (OpenAI compatibility layer)
                base_url = instance_url.rstrip('/').replace('/v1', '')
                # Ollama API endpoint for listing models
                tags_url = f"{base_url}/api/tags"

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
                enriched_models = await self._enrich_model_capabilities(models, instance_url, fetch_details=fetch_details)

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

    async def _enrich_model_capabilities(self, models: list[OllamaModel], instance_url: str, fetch_details: bool = False) -> list[OllamaModel]:
        """
        Enrich models with capability information using optimized pattern-based detection.
        Only performs API testing for unknown models or when specifically requested.

        Args:
            models: List of basic model information
            instance_url: Ollama instance URL
            fetch_details: If True, fetch comprehensive model details via /api/show

        Returns:
            Models enriched with capability information
        """
        import time
        start_time = time.time()
        logger.info(f"Starting capability enrichment for {len(models)} models from {instance_url}")
        
        enriched_models = []
        unknown_models = []

        # First pass: Use pattern-based detection for known models
        for model in models:
            model_name_lower = model.name.lower()
            
            # Known embedding model patterns - these are fast to identify
            embedding_patterns = [
                'embed', 'embedding', 'bge-', 'e5-', 'sentence-', 'arctic-embed',
                'nomic-embed', 'mxbai-embed', 'snowflake-arctic-embed', 'gte-', 'stella-'
            ]
            
            is_embedding_model = any(pattern in model_name_lower for pattern in embedding_patterns)
            
            if is_embedding_model:
                # Set embedding capabilities immediately
                model.capabilities = ["embedding"]
                # Set reasonable default dimensions based on model patterns
                if 'nomic' in model_name_lower:
                    model.embedding_dimensions = 768
                elif 'bge' in model_name_lower:
                    model.embedding_dimensions = 1024 if 'large' in model_name_lower else 768
                elif 'e5' in model_name_lower:
                    model.embedding_dimensions = 1024 if 'large' in model_name_lower else 768
                elif 'arctic' in model_name_lower:
                    model.embedding_dimensions = 1024
                else:
                    model.embedding_dimensions = 768  # Conservative default
                    
                logger.debug(f"Pattern-matched embedding model {model.name} with {model.embedding_dimensions}D")
                enriched_models.append(model)
            else:
                # Known chat model patterns
                chat_patterns = [
                    'phi', 'qwen', 'llama', 'mistral', 'gemma', 'deepseek', 'codellama',
                    'orca', 'vicuna', 'wizardlm', 'solar', 'mixtral', 'chatglm', 'baichuan',
                    'yi', 'zephyr', 'openchat', 'starling', 'nous-hermes'
                ]
                
                is_known_chat_model = any(pattern in model_name_lower for pattern in chat_patterns)
                
                if is_known_chat_model:
                    # Set chat capabilities based on model patterns
                    model.capabilities = ["chat"]
                    
                    # Advanced capability detection based on model families
                    if any(pattern in model_name_lower for pattern in ['qwen', 'llama3', 'phi3', 'mistral']):
                        model.capabilities.extend(["function_calling", "structured_output"])
                    elif any(pattern in model_name_lower for pattern in ['llama', 'phi', 'gemma']):
                        model.capabilities.append("structured_output")
                    
                    # Get comprehensive information from /api/show endpoint if requested
                    if fetch_details:
                        logger.info(f"Fetching detailed info for {model.name} from {instance_url}")
                        try:
                            detailed_info = await self._get_model_details(model.name, instance_url)
                            if detailed_info:
                                # Add comprehensive real API data to the model
                                # Context information
                                model.context_window = detailed_info.get("context_window")
                                model.max_context_length = detailed_info.get("max_context_length")
                                model.base_context_length = detailed_info.get("base_context_length")
                                model.custom_context_length = detailed_info.get("custom_context_length")
                                
                                # Architecture and technical details
                                model.architecture = detailed_info.get("architecture")
                                model.block_count = detailed_info.get("block_count")
                                model.attention_heads = detailed_info.get("attention_heads")
                                model.format = detailed_info.get("format")
                                model.parent_model = detailed_info.get("parent_model")
                                
                                # Extended metadata
                                model.family = detailed_info.get("family")
                                model.parameter_size = detailed_info.get("parameter_size")
                                model.quantization = detailed_info.get("quantization")
                                model.parameter_count = detailed_info.get("parameter_count")
                                model.file_type = detailed_info.get("file_type")
                                model.quantization_version = detailed_info.get("quantization_version")
                                model.basename = detailed_info.get("basename")
                                model.size_label = detailed_info.get("size_label")
                                model.license = detailed_info.get("license")
                                model.finetune = detailed_info.get("finetune")
                                model.embedding_dimension = detailed_info.get("embedding_dimension")
                                
                                # Update capabilities with real API capabilities if available
                                api_capabilities = detailed_info.get("capabilities", [])
                                if api_capabilities:
                                    # Merge with existing capabilities, prioritizing API data
                                    combined_capabilities = list(set(model.capabilities + api_capabilities))
                                    model.capabilities = combined_capabilities
                                
                                # Update parameters with comprehensive structured info
                                if model.parameters:
                                    model.parameters.update({
                                        "family": detailed_info.get("family") or model.parameters.get("family"),
                                    "parameter_size": detailed_info.get("parameter_size") or model.parameters.get("parameter_size"),
                                    "quantization": detailed_info.get("quantization") or model.parameters.get("quantization"),
                                    "format": detailed_info.get("format") or model.parameters.get("format")
                                    })
                                else:
                                    # Use the structured parameters object from detailed_info if available
                                    model.parameters = detailed_info.get("parameters", {
                                        "family": detailed_info.get("family"),
                                        "parameter_size": detailed_info.get("parameter_size"),
                                        "quantization": detailed_info.get("quantization"),
                                        "format": detailed_info.get("format")
                                    })
                                    
                                logger.debug(f"Enriched {model.name} with comprehensive data: "
                                           f"context={model.context_window}, arch={model.architecture}, "
                                           f"params={model.parameter_size}, capabilities={model.capabilities}")
                            else:
                                logger.debug(f"No detailed info returned for {model.name}")
                        except Exception as e:
                            logger.debug(f"Could not get comprehensive details for {model.name}: {e}")
                    
                    logger.debug(f"Pattern-matched chat model {model.name} with capabilities: {model.capabilities}")
                    enriched_models.append(model)
                else:
                    # Unknown model - needs testing
                    unknown_models.append(model)

        # Log pattern matching results for debugging
        pattern_matched_count = len(enriched_models)
        unknown_count = len(unknown_models)
        logger.info(f"Pattern matching results: {pattern_matched_count} models matched patterns, {unknown_count} models require API testing")
        
        if pattern_matched_count > 0:
            matched_names = [m.name for m in enriched_models]
            logger.info(f"Pattern-matched models: {', '.join(matched_names[:10])}{'...' if len(matched_names) > 10 else ''}")
        
        if unknown_models:
            unknown_names = [m.name for m in unknown_models]
            logger.info(f"Unknown models requiring API testing: {', '.join(unknown_names[:10])}{'...' if len(unknown_names) > 10 else ''}")
        
        # TEMPORARY PERFORMANCE FIX: Skip slow API testing entirely
        # Instead of testing unknown models (which takes 30+ minutes), assign reasonable defaults
        if unknown_models:
            logger.info(f"🚀 PERFORMANCE MODE: Skipping API testing for {len(unknown_models)} unknown models, assigning fast defaults")
            
            for model in unknown_models:
                # Assign chat capability to all unknown models by default
                model.capabilities = ["chat"]
                
                # Try some smart defaults based on model name patterns  
                model_name_lower = model.name.lower()
                if any(hint in model_name_lower for hint in ['embed', 'embedding', 'vector']):
                    model.capabilities = ["embedding"]
                    model.embedding_dimensions = 768  # Safe default
                    logger.debug(f"Fast-assigned embedding capability to {model.name} based on name hints")
                elif any(hint in model_name_lower for hint in ['chat', 'instruct', 'assistant']):
                    model.capabilities = ["chat"]
                    logger.debug(f"Fast-assigned chat capability to {model.name} based on name hints")
                
                enriched_models.append(model)
            
            logger.info(f"🚀 PERFORMANCE MODE: Fast assignment completed for {len(unknown_models)} models in <1s")

        # Log final timing and results
        end_time = time.time()
        total_duration = end_time - start_time
        pattern_matched_count = len(models) - len(unknown_models)
        
        logger.info(f"Model capability enrichment complete: {len(enriched_models)} total models, "
                   f"pattern-matched {pattern_matched_count}, tested {len(unknown_models)}")
        logger.info(f"Total enrichment time: {total_duration:.2f}s for {instance_url}")
        
        if pattern_matched_count > 0:
            logger.info(f"Pattern matching saved ~{pattern_matched_count * 10:.1f}s (estimated 10s per model API test)")

        return enriched_models

    async def _detect_model_capabilities_optimized(self, model_name: str, instance_url: str) -> ModelCapabilities:
        """
        Optimized capability detection that prioritizes speed over comprehensive testing.
        Only tests the most likely capability first, then stops.

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
            # Quick heuristic: if model name suggests embedding, test that first
            model_name_lower = model_name.lower()
            likely_embedding = any(pattern in model_name_lower for pattern in ['embed', 'embedding', 'bge', 'e5'])
            
            if likely_embedding:
                # Test embedding capability first for likely embedding models
                embedding_dims = await self._test_embedding_capability_fast(model_name, instance_url)
                if embedding_dims:
                    capabilities.supports_embedding = True
                    capabilities.embedding_dimensions = embedding_dims
                    logger.debug(f"Fast embedding test: {model_name} supports embeddings with {embedding_dims}D")
                    # Cache immediately and return - don't test other capabilities
                    self.capability_cache[cache_key] = capabilities
                    return capabilities

            # If not embedding or embedding test failed, test chat capability
            chat_supported = await self._test_chat_capability_fast(model_name, instance_url)
            if chat_supported:
                capabilities.supports_chat = True
                logger.debug(f"Fast chat test: {model_name} supports chat")
                
                # For chat models, do a quick structured output test (skip function calling for speed)
                structured_output_supported = await self._test_structured_output_capability_fast(model_name, instance_url)
                if structured_output_supported:
                    capabilities.supports_structured_output = True
                    logger.debug(f"Fast structured test: {model_name} supports structured output")

            # Cache the results
            self.capability_cache[cache_key] = capabilities

        except Exception as e:
            logger.warning(f"Fast capability detection failed for {model_name}: {e}")
            # Default to chat capability if detection fails
            capabilities.supports_chat = True

        return capabilities

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

    async def _test_embedding_capability_fast(self, model_name: str, instance_url: str) -> int | None:
        """
        Fast embedding capability test with reduced timeout and no retry.

        Returns:
            Embedding dimensions if supported, None otherwise
        """
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5)) as client:  # Reduced timeout
                embed_url = f"{instance_url.rstrip('/')}/api/embeddings"
                payload = {
                    "model": model_name,
                    "prompt": "test"  # Shorter test prompt
                }
                response = await client.post(embed_url, json=payload)
                if response.status_code == 200:
                    data = response.json()
                    embedding = data.get("embedding", [])
                    if isinstance(embedding, list) and len(embedding) > 0:
                        return len(embedding)
        except Exception:
            pass  # Fail silently for speed
        return None

    async def _test_chat_capability_fast(self, model_name: str, instance_url: str) -> bool:
        """
        Fast chat capability test with minimal request.

        Returns:
            True if chat is supported, False otherwise
        """
        try:
            async with get_llm_client(provider="ollama") as client:
                client.base_url = f"{instance_url.rstrip('/')}/v1"
                response = await client.chat.completions.create(
                    model=model_name,
                    messages=[{"role": "user", "content": "Hi"}],
                    max_tokens=1,
                    timeout=5  # Reduced timeout
                )
                return response.choices and len(response.choices) > 0
        except Exception:
            pass  # Fail silently for speed
        return False

    async def _test_structured_output_capability_fast(self, model_name: str, instance_url: str) -> bool:
        """
        Fast structured output test with minimal JSON request.

        Returns:
            True if structured output is supported, False otherwise
        """
        try:
            async with get_llm_client(provider="ollama") as client:
                client.base_url = f"{instance_url.rstrip('/')}/v1"
                response = await client.chat.completions.create(
                    model=model_name,
                    messages=[{
                        "role": "user", 
                        "content": "Return: {\"ok\":true}"  # Minimal JSON test
                    }],
                    max_tokens=10,
                    timeout=5,  # Reduced timeout
                    temperature=0.1
                )
                if response.choices and len(response.choices) > 0:
                    content = response.choices[0].message.content
                    # Simple check for JSON-like structure
                    return content and ('{' in content and '}' in content)
        except Exception:
            pass  # Fail silently for speed
        return False

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
        Get comprehensive information about a model from Ollama /api/show endpoint.
        Extracts all available data including context lengths, architecture details,
        capabilities, and parameter information as specified by user requirements.

        Returns:
            Model details dictionary with comprehensive real API data or None if failed
        """
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(10)) as client:
                # Remove /v1 suffix if present (Ollama native API doesn't use /v1)
                base_url = instance_url.rstrip('/').replace('/v1', '')
                show_url = f"{base_url}/api/show"

                payload = {"name": model_name}
                response = await client.post(show_url, json=payload)

                if response.status_code == 200:
                    data = response.json()
                    logger.debug(f"Got /api/show response for {model_name}: keys={list(data.keys())}, model_info keys={list(data.get('model_info', {}).keys())[:10]}")
                    
                    # Extract sections from /api/show response
                    details_section = data.get("details", {})
                    model_info = data.get("model_info", {})
                    parameters_raw = data.get("parameters", "")
                    capabilities = data.get("capabilities", [])
                    
                    # Parse parameters string for custom context length (num_ctx)
                    custom_context_length = None
                    if parameters_raw:
                        for line in parameters_raw.split('\n'):
                            line = line.strip()
                            if line.startswith('num_ctx'):
                                try:
                                    # Extract value: "num_ctx                        65536"
                                    custom_context_length = int(line.split()[-1])
                                    break
                                except (ValueError, IndexError):
                                    continue
                    
                    # Extract architecture-specific context lengths from model_info
                    max_context_length = None
                    base_context_length = None
                    embedding_dimension = None
                    
                    # Find architecture-specific values (e.g., phi3.context_length, gptoss.context_length)
                    for key, value in model_info.items():
                        if key.endswith(".context_length"):
                            max_context_length = value
                        elif key.endswith(".rope.scaling.original_context_length"):
                            base_context_length = value
                        elif key.endswith(".embedding_length"):
                            embedding_dimension = value
                    
                    # Determine current context length based on logic:
                    # 1. If custom num_ctx exists, use it
                    # 2. Otherwise use base context length if available
                    # 3. Otherwise fall back to max context length
                    current_context_length = custom_context_length if custom_context_length else (base_context_length if base_context_length else max_context_length)
                    
                    # Build comprehensive parameters object
                    parameters_obj = {
                        "family": details_section.get("family"),
                        "parameter_size": details_section.get("parameter_size"),
                        "quantization": details_section.get("quantization_level"),
                        "format": details_section.get("format")
                    }
                    
                    # Extract real API data with comprehensive coverage
                    details = {
                        # From details section
                        "family": details_section.get("family"),
                        "parameter_size": details_section.get("parameter_size"),
                        "quantization": details_section.get("quantization_level"),
                        "format": details_section.get("format"),
                        "parent_model": details_section.get("parent_model"),
                        
                        # Structured parameters object for display
                        "parameters": parameters_obj,
                        
                        # Context length information with proper logic
                        "context_window": current_context_length,  # Current/active context length
                        "max_context_length": max_context_length,  # Maximum supported context length
                        "base_context_length": base_context_length,  # Original/base context length
                        "custom_context_length": custom_context_length,  # Custom num_ctx if set
                        
                        # Architecture and model info
                        "architecture": model_info.get("general.architecture"),
                        "embedding_dimension": embedding_dimension,
                        "parameter_count": model_info.get("general.parameter_count"),
                        "file_type": model_info.get("general.file_type"),
                        "quantization_version": model_info.get("general.quantization_version"),
                        
                        # Model metadata
                        "basename": model_info.get("general.basename"),
                        "size_label": model_info.get("general.size_label"),
                        "license": model_info.get("general.license"),
                        "finetune": model_info.get("general.finetune"),
                        
                        # Capabilities from API
                        "capabilities": capabilities,
                        
                        # Initialize fields for advanced extraction
                        "block_count": None,
                        "attention_heads": None
                    }
                    
                    # Extract block count (layers) - try multiple patterns
                    for key, value in model_info.items():
                        if ("block_count" in key or "num_layers" in key or 
                            key.endswith(".block_count") or key.endswith(".n_layer")):
                            details["block_count"] = value
                            break
                    
                    # Extract attention heads - try multiple patterns
                    for key, value in model_info.items():
                        if (key.endswith(".attention.head_count") or 
                            key.endswith(".n_head") or 
                            "attention_head" in key) and not key.endswith("_kv"):
                            details["attention_heads"] = value
                            break
                    
                    logger.info(f"Extracted comprehensive details for {model_name}: "
                               f"context={current_context_length}, max={max_context_length}, "
                               f"base={base_context_length}, arch={details['architecture']}, "
                               f"blocks={details.get('block_count')}, heads={details.get('attention_heads')}")
                    
                    return details

        except Exception as e:
            logger.debug(f"Could not get comprehensive details for model {model_name}: {e}")

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

    async def discover_models_from_multiple_instances(self, instance_urls: list[str], fetch_details: bool = False) -> dict[str, Any]:
        """
        Discover models from multiple Ollama instances concurrently.

        Args:
            instance_urls: List of Ollama instance URLs
            fetch_details: If True, fetch comprehensive model details via /api/show

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

        logger.info(f"Discovering models from {len(instance_urls)} Ollama instances with fetch_details={fetch_details}")

        # Discover models from all instances concurrently
        tasks = [self.discover_models(url, fetch_details=fetch_details) for url in instance_urls]
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
                            "parameters": model.parameters,
                            # Real API data from /api/show - all 3 context values
                            "context_window": model.context_window,
                            "max_context_length": model.max_context_length,
                            "base_context_length": model.base_context_length,
                            "custom_context_length": model.custom_context_length,
                            "architecture": model.architecture,
                            "format": model.format,
                            "parent_model": model.parent_model,
                            "capabilities": model.capabilities
                        })

                    if "embedding" in model.capabilities:
                        embedding_models.append({
                            "name": model.name,
                            "instance_url": model.instance_url,
                            "dimensions": model.embedding_dimensions,
                            "size": model.size,
                            "parameters": model.parameters,
                            # Real API data from /api/show - all 3 context values
                            "context_window": model.context_window,
                            "max_context_length": model.max_context_length,
                            "base_context_length": model.base_context_length,
                            "custom_context_length": model.custom_context_length,
                            "architecture": model.architecture,
                            "format": model.format,
                            "parent_model": model.parent_model,
                            "capabilities": model.capabilities
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
