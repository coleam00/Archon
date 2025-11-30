"""
Dependency Injection Container for Archon.

This module provides a container simple pour l'injection de dependances.
Il permet de:
- Configurer les implementations (Supabase, Memory, etc.)
- Obtenir des instances des repositories et services
- Faciliter les tests avec des implementations mock

Usage:
    from archon.container import get_repository, get_embedding_service

    repo = get_repository()  # ISitePagesRepository
    embedding = get_embedding_service()  # IEmbeddingService
"""
from typing import Optional
import logging
import os

from archon.domain import ISitePagesRepository, IEmbeddingService

logger = logging.getLogger("archon.container")

# Configuration globale - permet override via variable d'environnement
_default_repo_type = os.environ.get("REPOSITORY_TYPE", "supabase")

_config = {
    "repository_type": _default_repo_type,  # "supabase" | "postgres" | "memory"
    "embedding_type": "openai",              # "openai" | "mock"
}

# Instances singleton (lazy)
_repository_instance: Optional[ISitePagesRepository] = None
_embedding_instance: Optional[IEmbeddingService] = None


def configure(
    repository_type: Optional[str] = None,
    embedding_type: Optional[str] = None
) -> None:
    """
    Configure le container.

    Args:
        repository_type: "supabase", "postgres", ou "memory"
        embedding_type: "openai" ou "mock"
    """
    global _repository_instance, _embedding_instance

    if repository_type is not None:
        logger.info(f"Configuring repository_type: {repository_type}")
        _config["repository_type"] = repository_type
        _repository_instance = None  # Reset instance

    if embedding_type is not None:
        logger.info(f"Configuring embedding_type: {embedding_type}")
        _config["embedding_type"] = embedding_type
        _embedding_instance = None  # Reset instance


def get_repository() -> ISitePagesRepository:
    """
    Retourne l'instance du repository configure.

    Returns:
        ISitePagesRepository: Implementation selon la configuration

    Raises:
        ValueError: Si le type de repository est inconnu
    """
    global _repository_instance

    if _repository_instance is None:
        repo_type = _config["repository_type"]
        logger.debug(f"Creating repository instance: {repo_type}")

        if repo_type == "supabase":
            # Import lazy pour eviter les dependances circulaires
            from utils.utils import get_supabase_client
            from archon.infrastructure.supabase import SupabaseSitePagesRepository

            supabase_client = get_supabase_client()
            if supabase_client is None:
                raise ValueError(
                    "Supabase client not available. "
                    "Please configure SUPABASE_URL and SUPABASE_SERVICE_KEY in environment."
                )
            _repository_instance = SupabaseSitePagesRepository(supabase_client)
            logger.info("Created SupabaseSitePagesRepository instance")

        elif repo_type == "postgres":
            # PostgreSQL direct with asyncpg + pgvector
            import os
            from archon.infrastructure.postgres import PostgresSitePagesRepository, create_pool

            # Get PostgreSQL configuration from environment
            postgres_config = {
                "host": os.environ.get("POSTGRES_HOST", "localhost"),
                "port": int(os.environ.get("POSTGRES_PORT", "5432")),
                "database": os.environ.get("POSTGRES_DB", "archon"),
                "user": os.environ.get("POSTGRES_USER", "postgres"),
                "password": os.environ.get("POSTGRES_PASSWORD", ""),
            }

            # Create pool and repository synchronously
            # Note: Pool creation must be done in an async context
            # So we raise an error with instructions
            raise RuntimeError(
                "PostgreSQL repository requires async initialization. "
                "Use get_repository_async() instead, or initialize manually:\n\n"
                "  from archon.infrastructure.postgres import PostgresSitePagesRepository\n"
                "  repo = await PostgresSitePagesRepository.create(**config)\n"
                "  from archon.container import override_repository\n"
                "  override_repository(repo)\n"
            )

        elif repo_type == "memory":
            from archon.infrastructure.memory import InMemorySitePagesRepository

            _repository_instance = InMemorySitePagesRepository()
            logger.info("Created InMemorySitePagesRepository instance")

        else:
            raise ValueError(f"Unknown repository type: {repo_type}")

    return _repository_instance


async def get_repository_async() -> ISitePagesRepository:
    """
    Async version of get_repository for backends that require async initialization.

    Returns:
        ISitePagesRepository: Implementation selon la configuration

    Raises:
        ValueError: Si le type de repository est inconnu

    Example:
        >>> repo = await get_repository_async()
    """
    global _repository_instance

    if _repository_instance is None:
        repo_type = _config["repository_type"]
        logger.debug(f"Creating repository instance (async): {repo_type}")

        if repo_type == "postgres":
            # PostgreSQL direct with asyncpg + pgvector
            import os
            from archon.infrastructure.postgres import PostgresSitePagesRepository

            # Get PostgreSQL configuration from environment
            postgres_config = {
                "host": os.environ.get("POSTGRES_HOST", "localhost"),
                "port": int(os.environ.get("POSTGRES_PORT", "5432")),
                "database": os.environ.get("POSTGRES_DB", "archon"),
                "user": os.environ.get("POSTGRES_USER", "postgres"),
                "password": os.environ.get("POSTGRES_PASSWORD", ""),
            }

            _repository_instance = await PostgresSitePagesRepository.create(**postgres_config)
            logger.info(
                f"Created PostgresSitePagesRepository instance "
                f"({postgres_config['user']}@{postgres_config['host']}:{postgres_config['port']}/{postgres_config['database']})"
            )

        else:
            # For non-async backends, use the sync version
            return get_repository()

    return _repository_instance


def get_embedding_service() -> IEmbeddingService:
    """
    Retourne l'instance du service d'embedding configure.

    Returns:
        IEmbeddingService: Implementation selon la configuration

    Raises:
        ValueError: Si le type d'embedding est inconnu
    """
    global _embedding_instance

    if _embedding_instance is None:
        embed_type = _config["embedding_type"]
        logger.debug(f"Creating embedding service instance: {embed_type}")

        if embed_type == "openai":
            from utils.utils import get_openai_client
            from archon.infrastructure.openai import OpenAIEmbeddingService

            embedding_client = get_openai_client()
            if embedding_client is None:
                raise ValueError(
                    "OpenAI client not available. "
                    "Please configure EMBEDDING_API_KEY in environment."
                )
            _embedding_instance = OpenAIEmbeddingService(embedding_client)
            logger.info("Created OpenAIEmbeddingService instance")

        elif embed_type == "mock":
            # Pour les tests - retourne des embeddings factices
            from archon.infrastructure.memory import MockEmbeddingService

            _embedding_instance = MockEmbeddingService()
            logger.info("Created MockEmbeddingService instance")

        else:
            raise ValueError(f"Unknown embedding type: {embed_type}")

    return _embedding_instance


def get_documentation_service():
    """
    Retourne une instance du DocumentationService.

    Returns:
        DocumentationService: Service configure avec repository et embedding service

    Example:
        >>> from archon.container import get_documentation_service
        >>> service = get_documentation_service()
        >>> results = await service.search_documentation("agents")
    """
    from archon.services import DocumentationService

    logger.debug("Creating DocumentationService instance")
    return DocumentationService(
        repository=get_repository(),
        embedding_service=get_embedding_service()
    )


def reset() -> None:
    """
    Reset toutes les instances (utile pour les tests).
    """
    global _repository_instance, _embedding_instance

    logger.debug("Resetting container instances")
    _repository_instance = None
    _embedding_instance = None


# Pour les tests
def override_repository(repo: ISitePagesRepository) -> None:
    """
    Override le repository avec une instance specifique (pour tests).

    Args:
        repo: Instance de repository a utiliser
    """
    global _repository_instance

    logger.debug(f"Overriding repository with {type(repo).__name__}")
    _repository_instance = repo


def override_embedding_service(service: IEmbeddingService) -> None:
    """
    Override le service d'embedding avec une instance specifique (pour tests).

    Args:
        service: Instance de service d'embedding a utiliser
    """
    global _embedding_instance

    logger.debug(f"Overriding embedding service with {type(service).__name__}")
    _embedding_instance = service
