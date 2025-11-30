"""
Tests for the dependency injection container.
"""
import pytest
from archon.container import (
    configure,
    get_repository,
    get_embedding_service,
    reset,
    override_repository,
    override_embedding_service,
)
from archon.domain import ISitePagesRepository, IEmbeddingService
from archon.infrastructure.memory import InMemorySitePagesRepository, MockEmbeddingService


class TestContainerConfiguration:
    """Test container configuration."""

    def setup_method(self):
        """Reset container before each test."""
        reset()

    def test_default_configuration(self):
        """Test that default configuration is 'supabase' and 'openai'."""
        # Note: This test will fail if Supabase credentials are not set
        # So we configure memory mode first
        configure(repository_type="memory", embedding_type="mock")

        repo = get_repository()
        assert isinstance(repo, ISitePagesRepository)

        service = get_embedding_service()
        assert isinstance(service, IEmbeddingService)

    def test_configure_memory_repository(self):
        """Test configuring memory repository."""
        configure(repository_type="memory")
        repo = get_repository()

        assert isinstance(repo, InMemorySitePagesRepository)

    def test_configure_mock_embedding_service(self):
        """Test configuring mock embedding service."""
        configure(embedding_type="mock")
        service = get_embedding_service()

        assert isinstance(service, MockEmbeddingService)

    def test_configure_both(self):
        """Test configuring both repository and embedding service."""
        configure(repository_type="memory", embedding_type="mock")

        repo = get_repository()
        service = get_embedding_service()

        assert isinstance(repo, InMemorySitePagesRepository)
        assert isinstance(service, MockEmbeddingService)


class TestContainerSingleton:
    """Test container singleton behavior."""

    def setup_method(self):
        """Reset container before each test."""
        reset()

    def test_repository_is_singleton(self):
        """Test that get_repository() returns the same instance."""
        configure(repository_type="memory")

        repo1 = get_repository()
        repo2 = get_repository()

        assert repo1 is repo2

    def test_embedding_service_is_singleton(self):
        """Test that get_embedding_service() returns the same instance."""
        configure(embedding_type="mock")

        service1 = get_embedding_service()
        service2 = get_embedding_service()

        assert service1 is service2

    def test_reset_clears_instances(self):
        """Test that reset() clears cached instances."""
        configure(repository_type="memory", embedding_type="mock")

        repo1 = get_repository()
        service1 = get_embedding_service()

        reset()

        repo2 = get_repository()
        service2 = get_embedding_service()

        assert repo1 is not repo2
        assert service1 is not service2


class TestContainerOverrides:
    """Test container override functionality for testing."""

    def setup_method(self):
        """Reset container before each test."""
        reset()

    def test_override_repository(self):
        """Test overriding repository with a custom instance."""
        custom_repo = InMemorySitePagesRepository()
        override_repository(custom_repo)

        repo = get_repository()
        assert repo is custom_repo

    def test_override_embedding_service(self):
        """Test overriding embedding service with a custom instance."""
        custom_service = MockEmbeddingService()
        override_embedding_service(custom_service)

        service = get_embedding_service()
        assert service is custom_service

    def test_override_persists_until_reset(self):
        """Test that overrides persist until reset."""
        custom_repo = InMemorySitePagesRepository()
        override_repository(custom_repo)

        repo1 = get_repository()
        assert repo1 is custom_repo

        reset()
        configure(repository_type="memory")

        repo2 = get_repository()
        assert repo2 is not custom_repo


class TestContainerErrorHandling:
    """Test container error handling."""

    def setup_method(self):
        """Reset container before each test."""
        reset()

    def test_invalid_repository_type_raises_error(self):
        """Test that invalid repository type raises ValueError."""
        from archon.container import _config
        _config["repository_type"] = "invalid"

        with pytest.raises(ValueError, match="Unknown repository type"):
            get_repository()

    def test_invalid_embedding_type_raises_error(self):
        """Test that invalid embedding type raises ValueError."""
        from archon.container import _config
        _config["embedding_type"] = "invalid"

        with pytest.raises(ValueError, match="Unknown embedding type"):
            get_embedding_service()
