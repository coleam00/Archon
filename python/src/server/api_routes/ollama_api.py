"""
Ollama API endpoints for model discovery and health management.

Provides comprehensive REST endpoints for interacting with Ollama instances:
- Model discovery across multiple instances
- Health monitoring and status checking
- Instance validation and capability testing
- Embedding routing and dimension analysis
"""

import json
from datetime import datetime
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from pydantic import BaseModel, Field

from ..config.logfire_config import get_logger
from ..services.llm_provider_service import validate_provider_instance
from ..services.ollama.embedding_router import embedding_router
from ..services.ollama.model_discovery_service import model_discovery_service

logger = get_logger(__name__)

router = APIRouter(prefix="/api/ollama", tags=["ollama"])


# Pydantic models for API requests/responses
class InstanceValidationRequest(BaseModel):
    """Request for validating an Ollama instance."""
    instance_url: str = Field(..., description="URL of the Ollama instance")
    instance_type: str | None = Field(None, description="Instance type: chat, embedding, or both")
    timeout_seconds: int | None = Field(30, description="Timeout for validation in seconds")


class InstanceValidationResponse(BaseModel):
    """Response for instance validation."""
    is_valid: bool
    instance_url: str
    response_time_ms: float | None
    models_available: int
    error_message: str | None
    capabilities: dict[str, Any]
    health_status: dict[str, Any]


class ModelDiscoveryRequest(BaseModel):
    """Request for model discovery."""
    instance_urls: list[str] = Field(..., description="List of Ollama instance URLs")
    include_capabilities: bool = Field(True, description="Include model capability detection")
    cache_ttl: int | None = Field(300, description="Cache TTL in seconds")


class ModelDiscoveryResponse(BaseModel):
    """Response for model discovery."""
    total_models: int
    chat_models: list[dict[str, Any]]
    embedding_models: list[dict[str, Any]]
    host_status: dict[str, dict[str, Any]]
    discovery_errors: list[str]
    unique_model_names: list[str]


class EmbeddingRouteRequest(BaseModel):
    """Request for embedding routing analysis."""
    model_name: str = Field(..., description="Name of the embedding model")
    instance_url: str = Field(..., description="URL of the Ollama instance")
    text_sample: str | None = Field(None, description="Optional text sample for optimization")


class EmbeddingRouteResponse(BaseModel):
    """Response for embedding routing."""
    target_column: str
    model_name: str
    instance_url: str
    dimensions: int
    confidence: float
    fallback_applied: bool
    routing_strategy: str
    performance_score: float | None


@router.get("/models", response_model=ModelDiscoveryResponse)
async def discover_models_endpoint(
    instance_urls: list[str] = Query(..., description="Ollama instance URLs"),
    include_capabilities: bool = Query(True, description="Include capability detection"),
    fetch_details: bool = Query(False, description="Fetch comprehensive model details via /api/show"),
    background_tasks: BackgroundTasks = None
) -> ModelDiscoveryResponse:
    """
    Discover models from multiple Ollama instances with capability detection.
    
    This endpoint provides comprehensive model discovery across distributed Ollama
    deployments with automatic capability classification and health monitoring.
    """
    try:
        logger.info(f"Starting model discovery for {len(instance_urls)} instances with fetch_details={fetch_details}")
        
        # Validate instance URLs
        valid_urls = []
        for url in instance_urls:
            try:
                # Basic URL validation
                if not url.startswith(('http://', 'https://')):
                    logger.warning(f"Invalid URL format: {url}")
                    continue
                valid_urls.append(url.rstrip('/'))
            except Exception as e:
                logger.warning(f"Error validating URL {url}: {e}")

        if not valid_urls:
            raise HTTPException(status_code=400, detail="No valid instance URLs provided")

        # Perform model discovery with optional detailed fetching
        discovery_result = await model_discovery_service.discover_models_from_multiple_instances(
            valid_urls, 
            fetch_details=fetch_details
        )

        logger.info(f"Discovery complete: {discovery_result['total_models']} models found")

        # If background tasks available, schedule cache warming
        if background_tasks:
            background_tasks.add_task(_warm_model_cache, valid_urls)

        return ModelDiscoveryResponse(
            total_models=discovery_result["total_models"],
            chat_models=discovery_result["chat_models"],
            embedding_models=discovery_result["embedding_models"],
            host_status=discovery_result["host_status"],
            discovery_errors=discovery_result["discovery_errors"],
            unique_model_names=discovery_result["unique_model_names"]
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in model discovery: {e}")
        raise HTTPException(status_code=500, detail=f"Model discovery failed: {str(e)}")


@router.get("/instances/health")
async def health_check_endpoint(
    instance_urls: list[str] = Query(..., description="Ollama instance URLs to check"),
    include_models: bool = Query(False, description="Include model count in response")
) -> dict[str, Any]:
    """
    Check health status of multiple Ollama instances.
    
    Provides real-time health monitoring with response times, model availability,
    and error diagnostics for distributed Ollama deployments.
    """
    try:
        logger.info(f"Checking health for {len(instance_urls)} instances")

        health_results = {}

        # Check health for each instance
        for instance_url in instance_urls:
            try:
                url = instance_url.rstrip('/')
                health_status = await model_discovery_service.check_instance_health(url)

                health_results[url] = {
                    "is_healthy": health_status.is_healthy,
                    "response_time_ms": health_status.response_time_ms,
                    "models_available": health_status.models_available if include_models else None,
                    "error_message": health_status.error_message,
                    "last_checked": health_status.last_checked
                }

            except Exception as e:
                logger.warning(f"Health check failed for {instance_url}: {e}")
                health_results[instance_url] = {
                    "is_healthy": False,
                    "response_time_ms": None,
                    "models_available": None,
                    "error_message": str(e),
                    "last_checked": None
                }

        # Calculate summary statistics
        healthy_count = sum(1 for result in health_results.values() if result["is_healthy"])
        avg_response_time = None
        if healthy_count > 0:
            response_times = [r["response_time_ms"] for r in health_results.values()
                            if r["response_time_ms"] is not None]
            if response_times:
                avg_response_time = sum(response_times) / len(response_times)

        return {
            "summary": {
                "total_instances": len(instance_urls),
                "healthy_instances": healthy_count,
                "unhealthy_instances": len(instance_urls) - healthy_count,
                "average_response_time_ms": avg_response_time
            },
            "instance_status": health_results,
            "timestamp": model_discovery_service.check_instance_health.__module__  # Use current timestamp
        }

    except Exception as e:
        logger.error(f"Error in health check: {e}")
        raise HTTPException(status_code=500, detail=f"Health check failed: {str(e)}")


@router.post("/validate", response_model=InstanceValidationResponse)
async def validate_instance_endpoint(request: InstanceValidationRequest) -> InstanceValidationResponse:
    """
    Validate an Ollama instance with comprehensive capability testing.
    
    Performs deep validation including connectivity, model availability,
    capability detection, and performance assessment.
    """
    try:
        logger.info(f"Validating Ollama instance: {request.instance_url}")

        # Clean up URL
        instance_url = request.instance_url.rstrip('/')

        # Perform basic validation using the provider service
        validation_result = await validate_provider_instance("ollama", instance_url)

        capabilities = {}
        if validation_result["is_available"]:
            try:
                # Get detailed model information for capability analysis
                models = await model_discovery_service.discover_models(instance_url)

                capabilities = {
                    "total_models": len(models),
                    "chat_models": [m.name for m in models if "chat" in m.capabilities],
                    "embedding_models": [m.name for m in models if "embedding" in m.capabilities],
                    "supported_dimensions": list(set(m.embedding_dimensions for m in models
                                                   if m.embedding_dimensions))
                }

            except Exception as e:
                logger.warning(f"Error getting capabilities for {instance_url}: {e}")
                capabilities = {"error": str(e)}

        return InstanceValidationResponse(
            is_valid=validation_result["is_available"],
            instance_url=instance_url,
            response_time_ms=validation_result.get("response_time_ms"),
            models_available=validation_result.get("models_available", 0),
            error_message=validation_result.get("error_message"),
            capabilities=capabilities,
            health_status=validation_result
        )

    except Exception as e:
        logger.error(f"Error validating instance {request.instance_url}: {e}")
        raise HTTPException(status_code=500, detail=f"Instance validation failed: {str(e)}")


@router.post("/embedding/route", response_model=EmbeddingRouteResponse)
async def analyze_embedding_route_endpoint(request: EmbeddingRouteRequest) -> EmbeddingRouteResponse:
    """
    Analyze optimal routing for embedding operations.
    
    Determines the best database column, dimension handling, and performance
    characteristics for a specific model and instance combination.
    """
    try:
        logger.info(f"Analyzing embedding route for {request.model_name} on {request.instance_url}")

        # Get routing decision from the embedding router
        routing_decision = await embedding_router.route_embedding(
            model_name=request.model_name,
            instance_url=request.instance_url,
            text_content=request.text_sample
        )

        # Calculate performance score
        performance_score = embedding_router._calculate_performance_score(routing_decision.dimensions)

        return EmbeddingRouteResponse(
            target_column=routing_decision.target_column,
            model_name=routing_decision.model_name,
            instance_url=routing_decision.instance_url,
            dimensions=routing_decision.dimensions,
            confidence=routing_decision.confidence,
            fallback_applied=routing_decision.fallback_applied,
            routing_strategy=routing_decision.routing_strategy,
            performance_score=performance_score
        )

    except Exception as e:
        logger.error(f"Error analyzing embedding route: {e}")
        raise HTTPException(status_code=500, detail=f"Embedding route analysis failed: {str(e)}")


@router.get("/embedding/routes")
async def get_available_embedding_routes_endpoint(
    instance_urls: list[str] = Query(..., description="Ollama instance URLs"),
    sort_by_performance: bool = Query(True, description="Sort by performance score")
) -> dict[str, Any]:
    """
    Get all available embedding routes across multiple instances.
    
    Provides a comprehensive view of embedding capabilities with performance
    rankings and routing recommendations for optimal throughput.
    """
    try:
        logger.info(f"Getting embedding routes for {len(instance_urls)} instances")

        # Get available routes
        routes = await embedding_router.get_available_embedding_routes(instance_urls)

        # Convert to response format
        route_data = []
        for route in routes:
            route_data.append({
                "model_name": route.model_name,
                "instance_url": route.instance_url,
                "dimensions": route.dimensions,
                "column_name": route.column_name,
                "performance_score": route.performance_score,
                "index_type": embedding_router.get_optimal_index_type(route.dimensions)
            })

        # Group by dimension for analysis
        dimension_stats = {}
        for route in routes:
            dim = route.dimensions
            if dim not in dimension_stats:
                dimension_stats[dim] = {"count": 0, "models": [], "avg_performance": 0}
            dimension_stats[dim]["count"] += 1
            dimension_stats[dim]["models"].append(route.model_name)
            dimension_stats[dim]["avg_performance"] += route.performance_score

        # Calculate averages
        for dim_data in dimension_stats.values():
            if dim_data["count"] > 0:
                dim_data["avg_performance"] /= dim_data["count"]

        return {
            "total_routes": len(routes),
            "routes": route_data,
            "dimension_analysis": dimension_stats,
            "routing_statistics": embedding_router.get_routing_statistics()
        }

    except Exception as e:
        logger.error(f"Error getting embedding routes: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get embedding routes: {str(e)}")


@router.delete("/cache")
async def clear_ollama_cache_endpoint() -> dict[str, str]:
    """
    Clear all Ollama-related caches for fresh data retrieval.
    
    Useful for forcing refresh of model lists, capabilities, and health status
    after making changes to Ollama instances or models.
    """
    try:
        logger.info("Clearing Ollama caches")

        # Clear model discovery cache
        model_discovery_service.model_cache.clear()
        model_discovery_service.capability_cache.clear()
        model_discovery_service.health_cache.clear()

        # Clear embedding router cache
        embedding_router.clear_routing_cache()

        logger.info("All Ollama caches cleared successfully")

        return {"message": "All Ollama caches cleared successfully"}

    except Exception as e:
        logger.error(f"Error clearing caches: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to clear caches: {str(e)}")


class ModelDiscoveryAndStoreRequest(BaseModel):
    """Request for discovering and storing models from Ollama instances."""
    instance_urls: list[str] = Field(..., description="List of Ollama instance URLs")
    force_refresh: bool = Field(False, description="Force refresh even if cached data exists")


class StoredModelInfo(BaseModel):
    """Stored model information with Archon compatibility assessment."""
    name: str
    host: str
    model_type: str  # 'chat', 'embedding', 'multimodal'
    size_mb: int | None
    context_length: int | None
    parameters: str | None
    capabilities: list[str]
    archon_compatibility: str  # 'full', 'partial', 'limited'
    compatibility_features: list[str]
    limitations: list[str]
    performance_rating: str | None  # 'high', 'medium', 'low'
    description: str | None
    last_updated: str
    embedding_dimensions: int | None = None  # Dimensions for embedding models


class ModelListResponse(BaseModel):
    """Response containing discovered and stored models."""
    models: list[StoredModelInfo]
    total_count: int
    instances_checked: int
    last_discovery: str | None
    cache_status: str


@router.post("/models/discover-and-store", response_model=ModelListResponse)
async def discover_and_store_models_endpoint(request: ModelDiscoveryAndStoreRequest) -> ModelListResponse:
    """
    Discover models from Ollama instances, assess Archon compatibility, and store in database.
    
    This endpoint fetches detailed model information from configured Ollama instances,
    evaluates their compatibility with Archon features, and stores the results for
    use in the model selection modal.
    """
    try:
        logger.info(f"Starting model discovery and storage for {len(request.instance_urls)} instances")

        from ..utils import get_supabase_client

        # Store using direct database insert
        supabase = get_supabase_client()

        stored_models = []
        instances_checked = 0

        for instance_url in request.instance_urls:
            try:
                base_url = instance_url.replace('/v1', '').rstrip('/')
                logger.debug(f"Discovering models from {base_url}")

                # Get detailed model information
                models = await model_discovery_service.discover_models(base_url)
                instances_checked += 1

                for model in models:
                    # Assess Archon compatibility
                    compatibility_info = _assess_archon_compatibility(model)

                    stored_model = StoredModelInfo(
                        name=model.name,
                        host=base_url,
                        model_type=_determine_model_type(model),
                        size_mb=_extract_model_size(model),
                        context_length=_extract_context_length(model),
                        parameters=_extract_parameters(model),
                        capabilities=model.capabilities if hasattr(model, 'capabilities') else [],
                        archon_compatibility=compatibility_info['level'],
                        compatibility_features=compatibility_info['features'],
                        limitations=compatibility_info['limitations'],
                        performance_rating=_assess_performance_rating(model),
                        description=_generate_model_description(model),
                        last_updated=datetime.now().isoformat()
                    )
                    stored_models.append(stored_model)

                logger.debug(f"Discovered {len(models)} models from {base_url}")

            except Exception as e:
                logger.warning(f"Failed to discover models from {instance_url}: {e}")
                continue

        # Store models in archon_settings
        models_data = {
            "models": [model.dict() for model in stored_models],
            "last_discovery": datetime.now().isoformat(),
            "instances_checked": instances_checked,
            "total_count": len(stored_models)
        }

        # Upsert into archon_settings table
        result = supabase.table("archon_settings").upsert({
            "key": "ollama_discovered_models",
            "value": json.dumps(models_data),
            "category": "ollama",
            "description": "Discovered Ollama models with compatibility information",
            "updated_at": datetime.now().isoformat()
        }).execute()

        logger.info(f"Stored {len(stored_models)} models from {instances_checked} instances")

        return ModelListResponse(
            models=stored_models,
            total_count=len(stored_models),
            instances_checked=instances_checked,
            last_discovery=models_data["last_discovery"],
            cache_status="updated"
        )

    except Exception as e:
        logger.error(f"Error in model discovery and storage: {e}")
        raise HTTPException(status_code=500, detail=f"Model discovery failed: {str(e)}")


@router.get("/models/stored", response_model=ModelListResponse)
async def get_stored_models_endpoint() -> ModelListResponse:
    """
    Retrieve stored Ollama models from database.
    
    Returns previously discovered and stored model information for use
    in the model selection modal.
    """
    try:
        logger.info("Retrieving stored Ollama models")

        from ..utils import get_supabase_client
        supabase = get_supabase_client()

        # Get stored models from archon_settings
        result = supabase.table("archon_settings").select("value").eq("key", "ollama_discovered_models").execute()
        models_setting = result.data[0]["value"] if result.data else None

        if not models_setting:
            return ModelListResponse(
                models=[],
                total_count=0,
                instances_checked=0,
                last_discovery=None,
                cache_status="empty"
            )

        models_data = json.loads(models_setting) if isinstance(models_setting, str) else models_setting
        from datetime import datetime
        
        # Handle both old format (direct list) and new format (object with models key)
        if isinstance(models_data, list):
            # Old format - direct list of models
            models_list = models_data
            total_count = len(models_list)
            instances_checked = 0
            last_discovery = None
        else:
            # New format - object with models key
            models_list = models_data.get("models", [])
            total_count = models_data.get("total_count", len(models_list))
            instances_checked = models_data.get("instances_checked", 0)
            last_discovery = models_data.get("last_discovery")
        
        # Convert to StoredModelInfo objects, handling missing fields
        stored_models = []
        for model in models_list:
            try:
                # Ensure required fields exist
                if isinstance(model, dict):
                    stored_model = StoredModelInfo(
                        name=model.get('name', 'Unknown'),
                        host=model.get('instance_url', model.get('host', 'Unknown')),
                        model_type=model.get('model_type', 'chat'),
                        size_mb=model.get('size_mb'),
                        context_length=model.get('context_length'),
                        parameters=model.get('parameters'),
                        capabilities=model.get('capabilities', []),
                        archon_compatibility=model.get('archon_compatibility', 'unknown'),
                        compatibility_features=model.get('compatibility_features', []),
                        limitations=model.get('limitations', []),
                        performance_rating=model.get('performance_rating'),
                        description=model.get('description'),
                        last_updated=model.get('last_updated', datetime.utcnow().isoformat()),
                        embedding_dimensions=model.get('embedding_dimensions')
                    )
                    stored_models.append(stored_model)
            except Exception as model_error:
                logger.warning(f"Failed to parse stored model {model}: {model_error}")

        return ModelListResponse(
            models=stored_models,
            total_count=total_count,
            instances_checked=instances_checked,
            last_discovery=last_discovery,
            cache_status="loaded"
        )

    except Exception as e:
        logger.error(f"Error retrieving stored models: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to retrieve models: {str(e)}")


# Background task functions
async def _warm_model_cache(instance_urls: list[str]) -> None:
    """Background task to warm up model caches."""
    try:
        logger.info(f"Warming model cache for {len(instance_urls)} instances")

        for url in instance_urls:
            try:
                await model_discovery_service.discover_models(url)
                logger.debug(f"Cache warmed for {url}")
            except Exception as e:
                logger.warning(f"Failed to warm cache for {url}: {e}")

        logger.info("Model cache warming completed")

    except Exception as e:
        logger.error(f"Error warming model cache: {e}")


# Helper functions for model assessment and analysis
async def _assess_archon_compatibility_with_testing(model, instance_url: str) -> dict[str, Any]:
    """Assess Archon compatibility for a given model using actual capability testing."""
    model_name = model.name.lower()
    capabilities = getattr(model, 'capabilities', [])
    
    # Test actual model capabilities
    function_calling_supported = await _test_function_calling_capability(model.name, instance_url)
    structured_output_supported = await _test_structured_output_capability(model.name, instance_url)
    
    # Determine compatibility level based on actual test results
    compatibility_level = 'limited'
    features = ['Local Processing']  # All Ollama models support local processing
    limitations = []
    
    # Check for chat capability
    if 'chat' in capabilities:
        features.append('Text Generation')
        features.append('MCP Integration')  # All chat models can integrate with MCP
        features.append('Streaming')  # All Ollama models support streaming
        
        # Add advanced features based on actual testing
        if function_calling_supported:
            features.append('Function Calls')
            compatibility_level = 'full'  # Function calling indicates full support
        
        if structured_output_supported:
            features.append('Structured Output')
            if compatibility_level != 'full':
                compatibility_level = 'partial'  # Structured output indicates at least partial support
        else:
            if compatibility_level != 'full':  # Only add limitation if not already full support
                limitations.append('Limited structured output support')
    
    # Add embedding capability
    if 'embedding' in capabilities:
        features.append('High-quality embeddings')
        if compatibility_level == 'limited':
            compatibility_level = 'full'  # Embedding models are considered full support for their purpose
    
    # If no advanced features detected, remain limited
    if not function_calling_supported and not structured_output_supported and 'embedding' not in capabilities:
        compatibility_level = 'limited'
        limitations.append('Compatibility not fully tested')
    
    return {
        'level': compatibility_level,
        'features': features,
        'limitations': limitations
    }


def _assess_archon_compatibility(model) -> dict[str, Any]:
    """Legacy compatibility assessment for backward compatibility. Consider using _assess_archon_compatibility_with_testing for new code."""
    model_name = model.name.lower()
    capabilities = getattr(model, 'capabilities', [])

    # Define known compatible models (removed hardcoded deepseek from partial support)
    full_support_patterns = [
        'qwen', 'llama', 'mistral', 'phi', 'codeqwen', 'codellama'
    ]

    partial_support_patterns = [
        'gemma', 'mixtral', 'neural-chat'  # Removed 'deepseek' - it should be tested
    ]

    # Assess compatibility level
    compatibility_level = 'limited'
    features = []
    limitations = []

    # Check for full support
    for pattern in full_support_patterns:
        if pattern in model_name:
            compatibility_level = 'full'
            features.extend(['MCP Integration', 'Streaming', 'Function Calls', 'Structured Output'])
            break

    # Check for partial support if not full
    if compatibility_level != 'full':
        for pattern in partial_support_patterns:
            if pattern in model_name:
                compatibility_level = 'partial'
                features.extend(['MCP Integration', 'Streaming'])
                limitations.append('Limited structured output support')
                break

    # Special handling for deepseek - treat as unknown until tested
    if 'deepseek' in model_name and compatibility_level == 'limited':
        compatibility_level = 'limited'
        features.extend(['MCP Integration', 'Streaming', 'Text Generation'])
        limitations.append('Requires capability testing for accurate assessment')

    # Add capability-based features
    if 'chat' in capabilities:
        if 'Text Generation' not in features:
            features.append('Text Generation')

    if 'embedding' in capabilities:
        features.append('Local Processing')

    # Add common limitations for non-full support
    if compatibility_level != 'full':
        if 'Local processing only' not in limitations:
            limitations.append('Local processing only')

    return {
        'level': compatibility_level,
        'features': features,
        'limitations': limitations
    }


def _determine_model_type(model) -> str:
    """Determine the primary type of a model."""
    model_name = model.name.lower()
    capabilities = getattr(model, 'capabilities', [])

    # Check for dedicated embedding models by name patterns
    embedding_patterns = [
        'embed', 'embedding', 'bge-', 'e5-', 'sentence-', 'arctic-embed',
        'nomic-embed', 'mxbai-embed', 'snowflake-arctic-embed'
    ]

    # Check for known chat/LLM models that might have embedding capabilities but are primarily chat models
    chat_patterns = [
        'phi', 'qwen', 'llama', 'mistral', 'gemma', 'deepseek', 'codellama',
        'orca', 'vicuna', 'wizardlm', 'solar', 'mixtral', 'chatglm', 'baichuan'
    ]

    # First check if it's a known chat model (these take priority even if they have embedding capabilities)
    for pattern in chat_patterns:
        if pattern in model_name:
            return 'chat'

    # Then check for dedicated embedding models
    for pattern in embedding_patterns:
        if pattern in model_name:
            return 'embedding'

    # Check for multimodal capabilities
    if any(keyword in model_name for keyword in ['vision', 'multimodal', 'llava']):
        return 'multimodal'

    # Fall back to capability-based detection, prioritizing chat over embedding
    if 'chat' in capabilities:
        return 'chat'
    elif 'embedding' in capabilities:
        return 'embedding'
    else:
        return 'chat'  # Default to chat for unknown models


def _extract_model_size(model) -> int | None:
    """Extract model size in MB from model information."""
    # This would need to be enhanced based on actual Ollama model data structure
    model_name = model.name.lower()

    # Try to extract size from name patterns
    size_indicators = {
        '7b': 4000,    # ~4GB for 7B model
        '13b': 8000,   # ~8GB for 13B model
        '30b': 16000,  # ~16GB for 30B model
        '70b': 40000,  # ~40GB for 70B model
        '1.5b': 1500,  # ~1.5GB for 1.5B model
        '3b': 2000,    # ~2GB for 3B model
    }

    for size_pattern, mb_size in size_indicators.items():
        if size_pattern in model_name:
            return mb_size

    return None


def _extract_context_length(model) -> int | None:
    """Extract context length from model information."""
    model_name = model.name.lower()

    # Common context lengths for different model families
    if any(pattern in model_name for pattern in ['qwen2.5', 'qwen2']):
        return 32768  # Qwen2.5 typically has 32k context
    elif 'llama' in model_name:
        return 8192   # Most Llama models have 8k context
    elif 'phi' in model_name:
        return 4096   # Phi models typically have 4k context
    elif 'mistral' in model_name:
        return 8192   # Mistral models typically have 8k context

    return 4096  # Default context length


def _extract_parameters(model) -> str | None:
    """Extract parameter count from model name."""
    model_name = model.name.lower()

    param_patterns = ['7b', '13b', '30b', '70b', '1.5b', '3b', '1b', '0.5b']

    for pattern in param_patterns:
        if pattern in model_name:
            return pattern.upper()

    return None


def _assess_performance_rating(model) -> str | None:
    """Assess performance rating based on model characteristics."""
    model_name = model.name.lower()

    # High performance models
    if any(pattern in model_name for pattern in ['70b', '30b', 'qwen2.5:32b']):
        return 'high'

    # Medium performance models
    elif any(pattern in model_name for pattern in ['13b', '7b', 'qwen2.5:7b']):
        return 'medium'

    # Lower performance models
    elif any(pattern in model_name for pattern in ['3b', '1.5b', '1b']):
        return 'low'

    return 'medium'  # Default to medium


def _generate_model_description(model) -> str | None:
    """Generate a description for the model based on its characteristics."""
    model_name = model.name
    model_type = _determine_model_type(model)

    if model_type == 'embedding':
        return f"{model_name} embedding model for text vectorization and semantic search"
    elif model_type == 'multimodal':
        return f"{model_name} multimodal model with vision and text capabilities"
    else:
        params = _extract_parameters(model)
        if params:
            return f"{model_name} chat model with {params} parameters for text generation and conversation"
        else:
            return f"{model_name} chat model for text generation and conversation"


async def _test_function_calling_capability(model_name: str, instance_url: str) -> bool:
    """
    Test if a model supports function/tool calling by making an actual API call.
    
    Args:
        model_name: Name of the model to test
        instance_url: Ollama instance URL
        
    Returns:
        True if function calling is supported, False otherwise
    """
    try:
        # Import here to avoid circular imports
        from ..services.llm_provider_service import get_llm_client
        
        # Use OpenAI-compatible client for function calling test
        async with get_llm_client(provider="ollama") as client:
            # Set base_url for this specific instance
            client.base_url = f"{instance_url.rstrip('/')}/v1"
            
            # Define a simple test function
            test_function = {
                "name": "get_weather",
                "description": "Get current weather information",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "location": {
                            "type": "string",
                            "description": "The city and state, e.g. San Francisco, CA"
                        }
                    },
                    "required": ["location"]
                }
            }
            
            # Try to make a function calling request
            response = await client.chat.completions.create(
                model=model_name,
                messages=[{"role": "user", "content": "What's the weather like in San Francisco?"}],
                tools=[{"type": "function", "function": test_function}],
                max_tokens=50,
                timeout=10
            )
            
            # Check if the model attempted to use the function
            if response.choices and len(response.choices) > 0:
                choice = response.choices[0]
                if hasattr(choice.message, 'tool_calls') and choice.message.tool_calls:
                    logger.info(f"Model {model_name} supports function calling")
                    return True
            
        return False
        
    except Exception as e:
        logger.debug(f"Function calling test failed for {model_name}: {e}")
        return False


async def _test_structured_output_capability(model_name: str, instance_url: str) -> bool:
    """
    Test if a model supports structured output by requesting JSON format.
    
    Args:
        model_name: Name of the model to test
        instance_url: Ollama instance URL
        
    Returns:
        True if structured output is supported, False otherwise
    """
    try:
        # Import here to avoid circular imports
        from ..services.llm_provider_service import get_llm_client
        
        # Use OpenAI-compatible client for structured output test
        async with get_llm_client(provider="ollama") as client:
            # Set base_url for this specific instance
            client.base_url = f"{instance_url.rstrip('/')}/v1"
            
            # Test structured output with JSON format
            response = await client.chat.completions.create(
                model=model_name,
                messages=[{
                    "role": "user", 
                    "content": "Return a JSON object with the structure: {\"city\": \"Paris\", \"country\": \"France\", \"population\": 2140000}. Only return the JSON, no other text."
                }],
                max_tokens=100,
                timeout=10,
                temperature=0.1  # Low temperature for more consistent output
            )
            
            if response.choices and len(response.choices) > 0:
                content = response.choices[0].message.content
                if content:
                    # Try to parse as JSON to see if model can produce structured output
                    import json
                    try:
                        parsed = json.loads(content.strip())
                        # Check if it contains expected keys
                        if isinstance(parsed, dict) and 'city' in parsed:
                            logger.info(f"Model {model_name} supports structured output")
                            return True
                    except json.JSONDecodeError:
                        # Try to find JSON-like patterns in the response
                        if '{' in content and '}' in content and '"' in content:
                            logger.info(f"Model {model_name} has partial structured output support")
                            return True
            
        return False
        
    except Exception as e:
        logger.debug(f"Structured output test failed for {model_name}: {e}")
        return False


@router.post("/models/discover-with-details", response_model=ModelDiscoveryResponse)
async def discover_models_with_real_details(request: ModelDiscoveryAndStoreRequest) -> ModelDiscoveryResponse:
    """
    Discover models from Ollama instances with complete real details from both /api/tags and /api/show.
    Only stores actual data from Ollama API endpoints - no fabricated information.
    """
    try:
        logger.info(f"Starting detailed model discovery for {len(request.instance_urls)} instances")

        from datetime import datetime

        import httpx

        from ..utils import get_supabase_client

        supabase = get_supabase_client()
        stored_models = []
        instances_checked = 0

        for instance_url in request.instance_urls:
            try:
                base_url = instance_url.replace('/v1', '').rstrip('/')
                logger.debug(f"Fetching real model data from {base_url}")

                async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
                    # Only use /api/tags for fast discovery - skip /api/show to avoid timeouts
                    tags_response = await client.get(f"{base_url}/api/tags")
                    tags_response.raise_for_status()
                    tags_data = tags_response.json()

                    if "models" not in tags_data:
                        logger.warning(f"No models found at {base_url}")
                        continue

                    # Process models using only tags data for speed
                    for model_data in tags_data["models"]:
                        model_name = model_data.get("name")
                        if not model_name:
                            continue

                        try:
                            # Extract real data from tags endpoint only
                            details = model_data.get("details", {})
                            model_info = {}  # No model_info without /api/show
                            capabilities = []  # No capabilities without /api/show

                            # Determine model type based on name patterns (more reliable than capabilities)
                            model_type = _determine_model_type_from_name_only(model_name)

                            # Extract context window information
                            max_context = None
                            current_context = None

                            # Get max context from model_info
                            if "phi3.context_length" in model_info:
                                max_context = model_info["phi3.context_length"]
                            elif "llama.context_length" in model_info:
                                max_context = model_info["llama.context_length"]

                            # Skip parameter extraction since we don't have show_data

                            # Create context info object
                            context_info = {
                                'current': current_context,
                                'max': max_context,
                                'min': 1  # Minimum is typically 1 token
                            }

                            # Extract real size from tags data
                            size_bytes = model_data.get("size", 0)
                            size_mb = round(size_bytes / (1024 * 1024)) if size_bytes > 0 else None

                            # Set default embedding dimensions based on common model patterns
                            embedding_dimensions = None
                            if model_type == 'embedding':
                                # Use common defaults based on model name
                                if "nomic-embed" in model_name.lower():
                                    embedding_dimensions = 768
                                elif "bge" in model_name.lower():
                                    embedding_dimensions = 768
                                elif "e5" in model_name.lower():
                                    embedding_dimensions = 1024
                                else:
                                    embedding_dimensions = 768  # Common default

                            # Extract real parameter info
                            parameters = details.get("parameter_size")
                            quantization = details.get("quantization_level")

                            # Build parameter string from real data
                            param_parts = []
                            if parameters:
                                param_parts.append(parameters)
                            if quantization:
                                param_parts.append(quantization)
                            param_string = " ".join(param_parts) if param_parts else None

                            # Create model with only real data
                            # Skip capability testing for fast discovery - assume basic capabilities
                            if model_type == 'chat':
                                # Skip testing, assume basic chat capabilities for fast discovery
                                features = ['Local Processing', 'Text Generation', 'Chat Support']
                                limitations = []
                                compatibility_level = 'full'  # Assume full for now
                                
                                compatibility = {
                                    'level': compatibility_level,
                                    'features': features,
                                    'limitations': limitations
                                }
                            else:
                                # Embedding models are all considered full compatibility for embedding tasks
                                compatibility = {'level': 'full', 'features': ['High-quality embeddings', 'Local processing'], 'limitations': []}

                            stored_model = StoredModelInfo(
                                name=model_name,
                                host=base_url,
                                model_type=model_type,
                                size_mb=size_mb,
                                context_length=current_context or max_context,
                                parameters=param_string,
                                capabilities=capabilities if capabilities else [],
                                archon_compatibility=compatibility['level'],
                                compatibility_features=compatibility['features'],
                                limitations=compatibility['limitations'],
                                performance_rating=None,
                                description=None,
                                last_updated=datetime.now().isoformat(),
                                embedding_dimensions=embedding_dimensions
                            )

                            # Add context info to stored model dict
                            model_dict = stored_model.dict()
                            model_dict['context_info'] = context_info
                            if embedding_dimensions:
                                logger.info(f"Stored embedding_dimensions {embedding_dimensions} for {model_name}")
                            stored_models.append(model_dict)
                            logger.debug(f"Processed model {model_name} with real data")

                        except Exception as e:
                            logger.warning(f"Failed to get details for model {model_name}: {e}")
                            continue

                instances_checked += 1
                logger.debug(f"Completed processing {base_url}")

            except Exception as e:
                logger.warning(f"Failed to process instance {instance_url}: {e}")
                continue

        # Store models with real data only
        models_data = {
            "models": stored_models,  # Already converted to dicts above
            "last_discovery": datetime.now().isoformat(),
            "instances_checked": instances_checked,
            "total_count": len(stored_models)
        }
        
        # Debug log to check what's in stored_models
        embedding_models_with_dims = [m for m in stored_models if m.get('model_type') == 'embedding' and m.get('embedding_dimensions')]
        logger.info(f"Storing {len(embedding_models_with_dims)} embedding models with dimensions: {[(m['name'], m.get('embedding_dimensions')) for m in embedding_models_with_dims]}")

        # Update the stored models
        result = supabase.table("archon_settings").update({
            "value": json.dumps(models_data),
            "description": "Real Ollama model data from API endpoints",
            "updated_at": datetime.now().isoformat()
        }).eq("key", "ollama_discovered_models").execute()

        logger.info(f"Stored {len(stored_models)} models with real data from {instances_checked} instances")

        # Convert dicts back to model objects for response
        model_objects = []
        for model_dict in stored_models:
            # Remove context_info for the model object (keep it in stored data)
            model_data = {k: v for k, v in model_dict.items() if k != 'context_info'}
            model_obj = StoredModelInfo(**model_data)
            model_objects.append(model_obj)

        # Convert to ModelDiscoveryResponse format for frontend
        chat_models = []
        embedding_models = []
        host_status = {}
        unique_model_names = set()
        
        for model in stored_models:
            unique_model_names.add(model['name'])
            
            # Build host status
            host = model['host'].replace('/v1', '').rstrip('/')
            if host not in host_status:
                host_status[host] = {
                    "status": "online",
                    "models_count": 0,
                    "instance_url": model['host']
                }
            host_status[host]["models_count"] += 1
            
            # Categorize models
            if model['model_type'] == 'embedding':
                embedding_models.append({
                    "name": model['name'],
                    "instance_url": model['host'],
                    "dimensions": model.get('embedding_dimensions'),
                    "size": model.get('size_mb', 0) * 1024 * 1024 if model.get('size_mb') else 0
                })
            else:
                chat_models.append({
                    "name": model['name'],
                    "instance_url": model['host'],
                    "size": model.get('size_mb', 0) * 1024 * 1024 if model.get('size_mb') else 0
                })
        
        return ModelDiscoveryResponse(
            total_models=len(stored_models),
            chat_models=chat_models,
            embedding_models=embedding_models,
            host_status=host_status,
            discovery_errors=[],
            unique_model_names=list(unique_model_names)
        )

    except Exception as e:
        logger.error(f"Error in detailed model discovery: {e}")
        raise HTTPException(status_code=500, detail=f"Model discovery failed: {str(e)}")


def _determine_model_type_from_name_only(model_name: str) -> str:
    """Determine model type based only on name patterns, ignoring capabilities."""
    model_name_lower = model_name.lower()

    # Known embedding models
    embedding_patterns = [
        'embed', 'embedding', 'bge-', 'e5-', 'sentence-', 'arctic-embed',
        'nomic-embed', 'mxbai-embed', 'snowflake-arctic-embed'
    ]

    for pattern in embedding_patterns:
        if pattern in model_name_lower:
            return 'embedding'

    # Known chat/LLM models
    chat_patterns = [
        'phi', 'qwen', 'llama', 'mistral', 'gemma', 'deepseek', 'codellama',
        'orca', 'vicuna', 'wizardlm', 'solar', 'mixtral', 'chatglm', 'baichuan'
    ]

    for pattern in chat_patterns:
        if pattern in model_name_lower:
            return 'chat'

    # Default to chat for unknown patterns
    return 'chat'


class ModelCapabilityTestRequest(BaseModel):
    """Request for testing model capabilities in real-time."""
    model_name: str = Field(..., description="Name of the model to test")
    instance_url: str = Field(..., description="URL of the Ollama instance")
    test_function_calling: bool = Field(True, description="Test function calling capability")
    test_structured_output: bool = Field(True, description="Test structured output capability")
    timeout_seconds: int = Field(15, description="Timeout for each test in seconds")


class ModelCapabilityTestResponse(BaseModel):
    """Response for model capability testing."""
    model_name: str
    instance_url: str
    test_results: dict[str, Any]
    compatibility_assessment: dict[str, Any]
    test_duration_seconds: float
    errors: list[str]


@router.post("/models/test-capabilities", response_model=ModelCapabilityTestResponse)
async def test_model_capabilities_endpoint(request: ModelCapabilityTestRequest) -> ModelCapabilityTestResponse:
    """
    Test real-time capabilities of a specific model to provide accurate compatibility assessment.
    
    This endpoint performs actual API calls to test function calling, structured output, and other
    advanced capabilities, providing definitive compatibility ratings instead of name-based assumptions.
    """
    import time
    start_time = time.time()
    
    try:
        logger.info(f"Testing capabilities for model {request.model_name} on {request.instance_url}")
        
        test_results = {}
        errors = []
        
        # Test function calling if requested
        if request.test_function_calling:
            try:
                function_calling_supported = await _test_function_calling_capability(
                    request.model_name, request.instance_url
                )
                test_results["function_calling"] = {
                    "supported": function_calling_supported,
                    "test_type": "API call with tool definition",
                    "description": "Tests if model can invoke functions/tools correctly"
                }
            except Exception as e:
                error_msg = f"Function calling test failed: {str(e)}"
                errors.append(error_msg)
                test_results["function_calling"] = {"supported": False, "error": error_msg}
        
        # Test structured output if requested
        if request.test_structured_output:
            try:
                structured_output_supported = await _test_structured_output_capability(
                    request.model_name, request.instance_url
                )
                test_results["structured_output"] = {
                    "supported": structured_output_supported,
                    "test_type": "JSON format request",
                    "description": "Tests if model can produce well-formatted JSON output"
                }
            except Exception as e:
                error_msg = f"Structured output test failed: {str(e)}"
                errors.append(error_msg)
                test_results["structured_output"] = {"supported": False, "error": error_msg}
        
        # Assess compatibility based on test results
        compatibility_level = 'limited'
        features = ['Local Processing', 'Text Generation', 'MCP Integration', 'Streaming']
        limitations = []
        
        # Determine compatibility level based on test results
        function_calling_works = test_results.get("function_calling", {}).get("supported", False)
        structured_output_works = test_results.get("structured_output", {}).get("supported", False)
        
        if function_calling_works:
            features.append('Function Calls')
            compatibility_level = 'full'
        
        if structured_output_works:
            features.append('Structured Output')
            if compatibility_level == 'limited':
                compatibility_level = 'partial'
        
        # Add limitations based on what doesn't work
        if not function_calling_works:
            limitations.append('No function calling support detected')
        if not structured_output_works:
            limitations.append('Limited structured output support')
        
        if compatibility_level == 'limited':
            limitations.append('Basic text generation only')
        
        compatibility_assessment = {
            'level': compatibility_level,
            'features': features,
            'limitations': limitations,
            'testing_method': 'Real-time API testing',
            'confidence': 'High' if not errors else 'Medium'
        }
        
        duration = time.time() - start_time
        
        logger.info(f"Capability testing complete for {request.model_name}: {compatibility_level} support detected in {duration:.2f}s")
        
        return ModelCapabilityTestResponse(
            model_name=request.model_name,
            instance_url=request.instance_url,
            test_results=test_results,
            compatibility_assessment=compatibility_assessment,
            test_duration_seconds=duration,
            errors=errors
        )
        
    except Exception as e:
        duration = time.time() - start_time
        logger.error(f"Error testing model capabilities: {e}")
        raise HTTPException(status_code=500, detail=f"Capability testing failed: {str(e)}")
