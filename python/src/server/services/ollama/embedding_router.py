"""
Ollama Embedding Router

Provides intelligent routing for embeddings based on model capabilities and dimensions.
Integrates with ModelDiscoveryService for real-time dimension detection and supports
automatic fallback strategies for optimal performance across distributed Ollama instances.
"""

from dataclasses import dataclass
from typing import Any

from ...config.logfire_config import get_logger
from ..embeddings.multi_dimensional_embedding_service import multi_dimensional_embedding_service
from .model_discovery_service import model_discovery_service

logger = get_logger(__name__)


@dataclass
class RoutingDecision:
    """Represents a routing decision for embedding generation."""

    target_column: str
    model_name: str
    instance_url: str
    dimensions: int
    confidence: float  # 0.0 to 1.0
    fallback_applied: bool = False
    routing_strategy: str = "auto-detect"  # auto-detect, model-mapping, fallback


@dataclass
class EmbeddingRoute:
    """Configuration for embedding routing."""

    model_name: str
    instance_url: str
    dimensions: int
    column_name: str
    performance_score: float = 1.0  # Higher is better


class EmbeddingRouter:
    """
    Intelligent router for Ollama embedding operations with dimension-aware routing.

    Features:
    - Automatic dimension detection from model capabilities
    - Intelligent routing to appropriate database columns
    - Fallback strategies for unknown models
    - Performance optimization for different vector sizes
    - Multi-instance load balancing consideration
    """

    # Database column mapping for different dimensions
    DIMENSION_COLUMNS = {
        768: "embedding_768",
        1024: "embedding_1024",
        1536: "embedding_1536",
        3072: "embedding_3072"
    }

    # Index type preferences for performance optimization
    INDEX_PREFERENCES = {
        768: "ivfflat",   # Good for smaller dimensions
        1024: "ivfflat",  # Good for medium dimensions
        1536: "ivfflat",  # Good for standard OpenAI dimensions
        3072: "hnsw"      # Better for high dimensions
    }

    def __init__(self):
        self.routing_cache: dict[str, RoutingDecision] = {}
        self.cache_ttl = 300  # 5 minutes cache TTL

    async def route_embedding(self, model_name: str, instance_url: str,
                            text_content: str | None = None) -> RoutingDecision:
        """
        Determine the optimal routing for an embedding operation.

        Args:
            model_name: Name of the embedding model to use
            instance_url: URL of the Ollama instance
            text_content: Optional text content for dynamic optimization

        Returns:
            RoutingDecision with target column and routing information
        """
        # Check cache first
        cache_key = f"{model_name}@{instance_url}"
        if cache_key in self.routing_cache:
            cached_decision = self.routing_cache[cache_key]
            logger.debug(f"Using cached routing decision for {model_name}")
            return cached_decision

        try:
            logger.info(f"Determining routing for model {model_name} on {instance_url}")

            # Step 1: Auto-detect dimensions from model capabilities
            dimensions = await self._detect_model_dimensions(model_name, instance_url)

            if dimensions:
                # Step 2: Route to appropriate column based on detected dimensions
                decision = await self._route_by_dimensions(
                    model_name, instance_url, dimensions, strategy="auto-detect"
                )
                logger.info(f"Auto-detected routing: {model_name} -> {decision.target_column} ({dimensions}D)")

            else:
                # Step 3: Fallback to model name mapping
                decision = await self._route_by_model_mapping(model_name, instance_url)
                logger.warning(f"Fallback routing applied for {model_name} -> {decision.target_column}")

            # Cache the decision
            self.routing_cache[cache_key] = decision

            return decision

        except Exception as e:
            logger.error(f"Error routing embedding for {model_name}: {e}")

            # Emergency fallback to largest supported dimension
            return RoutingDecision(
                target_column="embedding_3072",
                model_name=model_name,
                instance_url=instance_url,
                dimensions=3072,
                confidence=0.1,
                fallback_applied=True,
                routing_strategy="emergency-fallback"
            )

    async def _detect_model_dimensions(self, model_name: str, instance_url: str) -> int | None:
        """
        Detect embedding dimensions using the ModelDiscoveryService.

        Args:
            model_name: Name of the model
            instance_url: Ollama instance URL

        Returns:
            Detected dimensions or None if detection failed
        """
        try:
            # Get model info from discovery service
            model_info = await model_discovery_service.get_model_info(model_name, instance_url)

            if model_info and model_info.embedding_dimensions:
                dimensions = model_info.embedding_dimensions
                logger.debug(f"Detected {dimensions} dimensions for {model_name}")
                return dimensions

            # Try capability detection if model info doesn't have dimensions
            capabilities = await model_discovery_service._detect_model_capabilities(
                model_name, instance_url
            )

            if capabilities.embedding_dimensions:
                dimensions = capabilities.embedding_dimensions
                logger.debug(f"Detected {dimensions} dimensions via capabilities for {model_name}")
                return dimensions

            logger.warning(f"Could not detect dimensions for {model_name}")
            return None

        except Exception as e:
            logger.error(f"Error detecting dimensions for {model_name}: {e}")
            return None

    async def _route_by_dimensions(self, model_name: str, instance_url: str,
                                 dimensions: int, strategy: str) -> RoutingDecision:
        """
        Route embedding based on detected dimensions.

        Args:
            model_name: Name of the model
            instance_url: Ollama instance URL
            dimensions: Detected embedding dimensions
            strategy: Routing strategy used

        Returns:
            RoutingDecision for the detected dimensions
        """
        # Get target column for dimensions
        target_column = self._get_target_column(dimensions)

        # Calculate confidence based on exact dimension match
        confidence = 1.0 if dimensions in self.DIMENSION_COLUMNS else 0.7

        # Check if fallback was applied
        fallback_applied = dimensions not in self.DIMENSION_COLUMNS

        if fallback_applied:
            logger.warning(f"Model {model_name} dimensions {dimensions} not directly supported, "
                          f"using {target_column} with padding/truncation")

        return RoutingDecision(
            target_column=target_column,
            model_name=model_name,
            instance_url=instance_url,
            dimensions=dimensions,
            confidence=confidence,
            fallback_applied=fallback_applied,
            routing_strategy=strategy
        )

    async def _route_by_model_mapping(self, model_name: str, instance_url: str) -> RoutingDecision:
        """
        Route embedding based on model name mapping when auto-detection fails.

        Args:
            model_name: Name of the model
            instance_url: Ollama instance URL

        Returns:
            RoutingDecision based on model name mapping
        """
        # Use the existing multi-dimensional service for model mapping
        dimensions = multi_dimensional_embedding_service.get_dimension_for_model(model_name)
        target_column = multi_dimensional_embedding_service.get_embedding_column_name(dimensions)

        logger.info(f"Model mapping: {model_name} -> {dimensions}D -> {target_column}")

        return RoutingDecision(
            target_column=target_column,
            model_name=model_name,
            instance_url=instance_url,
            dimensions=dimensions,
            confidence=0.8,  # Medium confidence for model mapping
            fallback_applied=True,
            routing_strategy="model-mapping"
        )

    def _get_target_column(self, dimensions: int) -> str:
        """
        Get the appropriate database column for the given dimensions.

        Args:
            dimensions: Embedding dimensions

        Returns:
            Target column name for storage
        """
        # Direct mapping if supported
        if dimensions in self.DIMENSION_COLUMNS:
            return self.DIMENSION_COLUMNS[dimensions]

        # Fallback logic for unsupported dimensions
        if dimensions <= 768:
            logger.warning(f"Dimensions {dimensions} ≤ 768, using embedding_768 with padding")
            return "embedding_768"
        elif dimensions <= 1024:
            logger.warning(f"Dimensions {dimensions} ≤ 1024, using embedding_1024 with padding")
            return "embedding_1024"
        elif dimensions <= 1536:
            logger.warning(f"Dimensions {dimensions} ≤ 1536, using embedding_1536 with padding")
            return "embedding_1536"
        else:
            logger.warning(f"Dimensions {dimensions} > 1536, using embedding_3072 (may truncate)")
            return "embedding_3072"

    def get_optimal_index_type(self, dimensions: int) -> str:
        """
        Get the optimal index type for the given dimensions.

        Args:
            dimensions: Embedding dimensions

        Returns:
            Recommended index type (ivfflat or hnsw)
        """
        return self.INDEX_PREFERENCES.get(dimensions, "hnsw")

    async def get_available_embedding_routes(self, instance_urls: list[str]) -> list[EmbeddingRoute]:
        """
        Get all available embedding routes across multiple instances.

        Args:
            instance_urls: List of Ollama instance URLs to check

        Returns:
            List of available embedding routes with performance scores
        """
        routes = []

        try:
            # Discover models from all instances
            discovery_result = await model_discovery_service.discover_models_from_multiple_instances(
                instance_urls
            )

            # Process embedding models
            for embedding_model in discovery_result["embedding_models"]:
                model_name = embedding_model["name"]
                instance_url = embedding_model["instance_url"]
                dimensions = embedding_model.get("dimensions")

                if dimensions:
                    target_column = self._get_target_column(dimensions)

                    # Calculate performance score based on dimension efficiency
                    performance_score = self._calculate_performance_score(dimensions)

                    route = EmbeddingRoute(
                        model_name=model_name,
                        instance_url=instance_url,
                        dimensions=dimensions,
                        column_name=target_column,
                        performance_score=performance_score
                    )

                    routes.append(route)

            # Sort by performance score (highest first)
            routes.sort(key=lambda r: r.performance_score, reverse=True)

            logger.info(f"Found {len(routes)} embedding routes across {len(instance_urls)} instances")

        except Exception as e:
            logger.error(f"Error getting embedding routes: {e}")

        return routes

    def _calculate_performance_score(self, dimensions: int) -> float:
        """
        Calculate performance score for embedding dimensions.

        Args:
            dimensions: Embedding dimensions

        Returns:
            Performance score (0.0 to 1.0, higher is better)
        """
        # Base score on standard dimensions (exact matches get higher scores)
        if dimensions in self.DIMENSION_COLUMNS:
            base_score = 1.0
        else:
            base_score = 0.7  # Penalize non-standard dimensions

        # Adjust based on index performance characteristics
        if dimensions <= 1536:
            # IVFFlat performs well for smaller dimensions
            index_bonus = 0.0
        else:
            # HNSW needed for larger dimensions, slight penalty for complexity
            index_bonus = -0.1

        # Dimension efficiency (smaller = faster, but less semantic information)
        if dimensions == 1536:
            # Sweet spot for most applications
            dimension_bonus = 0.1
        elif dimensions == 768:
            # Good balance of speed and quality
            dimension_bonus = 0.05
        else:
            dimension_bonus = 0.0

        final_score = max(0.0, min(1.0, base_score + index_bonus + dimension_bonus))

        logger.debug(f"Performance score for {dimensions}D: {final_score}")

        return final_score

    async def validate_routing_decision(self, decision: RoutingDecision) -> bool:
        """
        Validate that a routing decision is still valid.

        Args:
            decision: RoutingDecision to validate

        Returns:
            True if decision is valid, False otherwise
        """
        try:
            # Check if the model still supports embeddings
            is_valid = await model_discovery_service.validate_model_capabilities(
                decision.model_name,
                decision.instance_url,
                "embedding"
            )

            if not is_valid:
                logger.warning(f"Routing decision invalid: {decision.model_name} no longer supports embeddings")
                # Remove from cache if invalid
                cache_key = f"{decision.model_name}@{decision.instance_url}"
                if cache_key in self.routing_cache:
                    del self.routing_cache[cache_key]

            return is_valid

        except Exception as e:
            logger.error(f"Error validating routing decision: {e}")
            return False

    def clear_routing_cache(self) -> None:
        """Clear the routing decision cache."""
        self.routing_cache.clear()
        logger.info("Routing cache cleared")

    def get_routing_statistics(self) -> dict[str, Any]:
        """
        Get statistics about current routing decisions.

        Returns:
            Dictionary with routing statistics
        """
        # Use explicit counters with proper types
        auto_detect_routes = 0
        model_mapping_routes = 0
        fallback_routes = 0
        dimension_distribution: dict[str, int] = {}
        confidence_high = 0
        confidence_medium = 0
        confidence_low = 0

        for decision in self.routing_cache.values():
            # Count routing strategies
            if decision.routing_strategy == "auto-detect":
                auto_detect_routes += 1
            elif decision.routing_strategy == "model-mapping":
                model_mapping_routes += 1
            else:
                fallback_routes += 1

            # Count dimensions
            dim_key = f"{decision.dimensions}D"
            dimension_distribution[dim_key] = dimension_distribution.get(dim_key, 0) + 1

            # Count confidence levels
            if decision.confidence >= 0.9:
                confidence_high += 1
            elif decision.confidence >= 0.7:
                confidence_medium += 1
            else:
                confidence_low += 1

        return {
            "total_cached_routes": len(self.routing_cache),
            "auto_detect_routes": auto_detect_routes,
            "model_mapping_routes": model_mapping_routes,
            "fallback_routes": fallback_routes,
            "dimension_distribution": dimension_distribution,
            "confidence_distribution": {
                "high": confidence_high,
                "medium": confidence_medium,
                "low": confidence_low
            }
        }


# Global service instance
embedding_router = EmbeddingRouter()
