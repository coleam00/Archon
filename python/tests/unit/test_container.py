"""
Unit tests for the DI Container.
"""

import os
import pytest

from src.server.container import Container, container
from src.server.infrastructure.memory import (
    InMemoryCrawledPagesRepository,
    InMemorySourcesRepository,
    InMemoryCodeExamplesRepository,
)


@pytest.fixture(autouse=True)
def reset_container():
    """Reset container before and after each test."""
    Container.reset()
    from src.server.infrastructure.repository_factory import reset_repositories_sync
    reset_repositories_sync()
    yield
    Container.reset()
    reset_repositories_sync()


@pytest.fixture
def memory_env():
    """Set REPOSITORY_TYPE to memory for testing."""
    original = os.environ.get("REPOSITORY_TYPE")
    os.environ["REPOSITORY_TYPE"] = "memory"
    yield
    if original is not None:
        os.environ["REPOSITORY_TYPE"] = original
    else:
        os.environ.pop("REPOSITORY_TYPE", None)


class TestContainerSingleton:
    """Tests for singleton behavior."""

    def test_container_is_singleton(self):
        """Container should be a singleton."""
        c1 = Container()
        c2 = Container()

        assert c1 is c2

    def test_global_container_is_singleton(self, memory_env):
        """Global container should be the same instance after creation."""
        # Create fresh container after reset
        c1 = Container()
        c2 = Container()

        assert c1 is c2

    def test_reset_creates_new_instance(self):
        """Reset should allow creating new instance."""
        c1 = Container()
        Container.reset()
        c2 = Container()

        assert c1 is not c2


class TestContainerInitialization:
    """Tests for container initialization."""

    @pytest.mark.asyncio
    async def test_initialize_with_memory(self, memory_env):
        """Container should initialize with memory backend."""
        c = Container()
        await c.initialize()

        assert c.is_initialized
        assert c.storage_type == "memory"

    @pytest.mark.asyncio
    async def test_initialize_twice_is_safe(self, memory_env):
        """Initializing twice should be safe."""
        c = Container()
        await c.initialize()
        await c.initialize()  # Should not raise

        assert c.is_initialized

    @pytest.mark.asyncio
    async def test_shutdown_without_init(self, memory_env):
        """Shutdown without init should be safe."""
        c = Container()
        await c.shutdown()  # Should not raise

        assert not c.is_initialized


class TestContainerRepositories:
    """Tests for repository access."""

    @pytest.mark.asyncio
    async def test_crawled_pages_repository(self, memory_env):
        """Container should provide crawled pages repository."""
        c = Container()
        await c.initialize()

        repo = c.crawled_pages_repository

        assert repo is not None
        assert isinstance(repo, InMemoryCrawledPagesRepository)

    @pytest.mark.asyncio
    async def test_sources_repository(self, memory_env):
        """Container should provide sources repository."""
        c = Container()
        await c.initialize()

        repo = c.sources_repository

        assert repo is not None
        assert isinstance(repo, InMemorySourcesRepository)

    @pytest.mark.asyncio
    async def test_code_examples_repository(self, memory_env):
        """Container should provide code examples repository."""
        c = Container()
        await c.initialize()

        repo = c.code_examples_repository

        assert repo is not None
        assert isinstance(repo, InMemoryCodeExamplesRepository)

    @pytest.mark.asyncio
    async def test_repositories_are_cached(self, memory_env):
        """Repositories should be cached (same instance)."""
        c = Container()
        await c.initialize()

        repo1 = c.crawled_pages_repository
        repo2 = c.crawled_pages_repository

        assert repo1 is repo2


class TestContainerHealthCheck:
    """Tests for health check functionality."""

    @pytest.mark.asyncio
    async def test_health_check_when_initialized(self, memory_env):
        """Health check should work when initialized."""
        c = Container()
        await c.initialize()

        health = await c.health_check()

        assert health["storage_type"] == "memory"
        assert health["initialized"] is True
        assert health["healthy"] is True

    @pytest.mark.asyncio
    async def test_health_check_when_not_initialized(self, memory_env):
        """Health check should report not initialized."""
        c = Container()

        health = await c.health_check()

        assert health["initialized"] is False
        assert health["healthy"] is False
        assert "error" in health


class TestConvenienceFunctions:
    """Tests for convenience functions."""

    @pytest.mark.asyncio
    async def test_get_crawled_pages_repository(self, memory_env):
        """get_crawled_pages_repository should work."""
        from src.server.container import get_crawled_pages_repository

        c = Container()
        await c.initialize()

        repo = get_crawled_pages_repository()

        assert repo is not None

    @pytest.mark.asyncio
    async def test_get_sources_repository(self, memory_env):
        """get_sources_repository should work."""
        from src.server.container import get_sources_repository

        c = Container()
        await c.initialize()

        repo = get_sources_repository()

        assert repo is not None

    @pytest.mark.asyncio
    async def test_get_code_examples_repository(self, memory_env):
        """get_code_examples_repository should work."""
        from src.server.container import get_code_examples_repository

        c = Container()
        await c.initialize()

        repo = get_code_examples_repository()

        assert repo is not None
