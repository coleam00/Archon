"""Unit Tests for RepositoryConfigRepository

Tests all CRUD operations for configured repositories.
"""

from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest

from src.agent_work_orders.models import ConfiguredRepository, SandboxType, WorkflowStep
from src.agent_work_orders.state_manager.repository_config_repository import RepositoryConfigRepository


@pytest.fixture
def mock_supabase_client():
    """Mock Supabase client with chainable methods"""
    mock = MagicMock()

    # Set up method chaining: table().select().order().execute()
    mock.table.return_value = mock
    mock.select.return_value = mock
    mock.order.return_value = mock
    mock.insert.return_value = mock
    mock.update.return_value = mock
    mock.delete.return_value = mock
    mock.eq.return_value = mock

    # Execute returns response with data attribute
    mock.execute.return_value = MagicMock(data=[])

    return mock


@pytest.fixture
def repository_instance(mock_supabase_client):
    """Create RepositoryConfigRepository instance with mocked client"""
    with patch('src.agent_work_orders.state_manager.repository_config_repository.get_supabase_client', return_value=mock_supabase_client):
        return RepositoryConfigRepository()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_list_repositories_returns_all_repositories(repository_instance, mock_supabase_client):
    """Test listing all repositories"""
    # Mock response data
    mock_data = [
        {
            "id": "repo-1",
            "repository_url": "https://github.com/test/repo1",
            "display_name": "test/repo1",
            "owner": "test",
            "default_branch": "main",
            "is_verified": True,
            "last_verified_at": datetime.now().isoformat(),
            "default_sandbox_type": "git_worktree",
            "default_commands": ["create-branch", "planning", "execute"],
            "created_at": datetime.now().isoformat(),
            "updated_at": datetime.now().isoformat(),
        }
    ]
    mock_supabase_client.execute.return_value = MagicMock(data=mock_data)

    # Call method
    repositories = await repository_instance.list_repositories()

    # Assertions
    assert len(repositories) == 1
    assert isinstance(repositories[0], ConfiguredRepository)
    assert repositories[0].id == "repo-1"
    assert repositories[0].repository_url == "https://github.com/test/repo1"

    # Verify Supabase client methods called correctly
    mock_supabase_client.table.assert_called_once_with("archon_configured_repositories")
    mock_supabase_client.select.assert_called_once()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_list_repositories_with_empty_result(repository_instance, mock_supabase_client):
    """Test listing repositories when database is empty"""
    mock_supabase_client.execute.return_value = MagicMock(data=[])

    repositories = await repository_instance.list_repositories()

    assert repositories == []
    assert isinstance(repositories, list)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_get_repository_success(repository_instance, mock_supabase_client):
    """Test getting a single repository by ID"""
    mock_data = [{
        "id": "repo-1",
        "repository_url": "https://github.com/test/repo1",
        "display_name": "test/repo1",
        "owner": "test",
        "default_branch": "main",
        "is_verified": True,
        "last_verified_at": datetime.now().isoformat(),
        "default_sandbox_type": "git_worktree",
        "default_commands": ["create-branch", "planning"],
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
    }]
    mock_supabase_client.execute.return_value = MagicMock(data=mock_data)

    repository = await repository_instance.get_repository("repo-1")

    assert repository is not None
    assert isinstance(repository, ConfiguredRepository)
    assert repository.id == "repo-1"
    mock_supabase_client.eq.assert_called_with("id", "repo-1")


@pytest.mark.unit
@pytest.mark.asyncio
async def test_get_repository_not_found(repository_instance, mock_supabase_client):
    """Test getting a repository that doesn't exist"""
    mock_supabase_client.execute.return_value = MagicMock(data=[])

    repository = await repository_instance.get_repository("nonexistent-id")

    assert repository is None


@pytest.mark.unit
@pytest.mark.asyncio
async def test_create_repository_success(repository_instance, mock_supabase_client):
    """Test creating a new repository"""
    mock_data = [{
        "id": "new-repo-id",
        "repository_url": "https://github.com/test/newrepo",
        "display_name": "test/newrepo",
        "owner": "test",
        "default_branch": "main",
        "is_verified": True,
        "last_verified_at": datetime.now().isoformat(),
        "default_sandbox_type": "git_worktree",
        "default_commands": ["create-branch", "planning", "execute", "commit", "create-pr"],
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
    }]
    mock_supabase_client.execute.return_value = MagicMock(data=mock_data)

    repository = await repository_instance.create_repository(
        repository_url="https://github.com/test/newrepo",
        display_name="test/newrepo",
        owner="test",
        default_branch="main",
        is_verified=True,
    )

    assert repository is not None
    assert repository.id == "new-repo-id"
    assert repository.repository_url == "https://github.com/test/newrepo"
    assert repository.is_verified is True
    mock_supabase_client.insert.assert_called_once()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_create_repository_with_verification(repository_instance, mock_supabase_client):
    """Test creating a repository with is_verified=True sets last_verified_at"""
    mock_data = [{
        "id": "verified-repo",
        "repository_url": "https://github.com/test/verified",
        "display_name": None,
        "owner": None,
        "default_branch": None,
        "is_verified": True,
        "last_verified_at": datetime.now().isoformat(),
        "default_sandbox_type": "git_worktree",
        "default_commands": ["create-branch", "planning", "execute", "commit", "create-pr"],
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
    }]
    mock_supabase_client.execute.return_value = MagicMock(data=mock_data)

    repository = await repository_instance.create_repository(
        repository_url="https://github.com/test/verified",
        is_verified=True,
    )

    assert repository.is_verified is True
    assert repository.last_verified_at is not None


@pytest.mark.unit
@pytest.mark.asyncio
async def test_update_repository_success(repository_instance, mock_supabase_client):
    """Test updating a repository"""
    mock_data = [{
        "id": "repo-1",
        "repository_url": "https://github.com/test/repo1",
        "display_name": "test/repo1",
        "owner": "test",
        "default_branch": "main",
        "is_verified": True,
        "last_verified_at": datetime.now().isoformat(),
        "default_sandbox_type": "git_branch",  # Updated value (valid enum)
        "default_commands": ["create-branch", "execute"],  # Updated value
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
    }]
    mock_supabase_client.execute.return_value = MagicMock(data=mock_data)

    repository = await repository_instance.update_repository(
        "repo-1",
        default_sandbox_type=SandboxType.GIT_BRANCH,
        default_commands=[WorkflowStep.CREATE_BRANCH, WorkflowStep.EXECUTE],
    )

    assert repository is not None
    assert repository.id == "repo-1"
    mock_supabase_client.update.assert_called_once()
    mock_supabase_client.eq.assert_called_with("id", "repo-1")


@pytest.mark.unit
@pytest.mark.asyncio
async def test_update_repository_not_found(repository_instance, mock_supabase_client):
    """Test updating a repository that doesn't exist"""
    mock_supabase_client.execute.return_value = MagicMock(data=[])

    repository = await repository_instance.update_repository(
        "nonexistent-id",
        default_sandbox_type=SandboxType.GIT_WORKTREE,
    )

    assert repository is None


@pytest.mark.unit
@pytest.mark.asyncio
async def test_delete_repository_success(repository_instance, mock_supabase_client):
    """Test deleting a repository"""
    mock_data = [{"id": "repo-1"}]  # Supabase returns deleted row
    mock_supabase_client.execute.return_value = MagicMock(data=mock_data)

    deleted = await repository_instance.delete_repository("repo-1")

    assert deleted is True
    mock_supabase_client.delete.assert_called_once()
    mock_supabase_client.eq.assert_called_with("id", "repo-1")


@pytest.mark.unit
@pytest.mark.asyncio
async def test_delete_repository_not_found(repository_instance, mock_supabase_client):
    """Test deleting a repository that doesn't exist"""
    mock_supabase_client.execute.return_value = MagicMock(data=[])

    deleted = await repository_instance.delete_repository("nonexistent-id")

    assert deleted is False


# =====================================================
# Additional Error Handling Tests
# =====================================================


@pytest.mark.unit
@pytest.mark.asyncio
async def test_row_to_model_with_invalid_workflow_step(repository_instance):
    """Test _row_to_model raises ValueError for invalid workflow step"""
    invalid_row = {
        "id": "test-id",
        "repository_url": "https://github.com/test/repo",
        "display_name": "test/repo",
        "owner": "test",
        "default_branch": "main",
        "is_verified": True,
        "last_verified_at": datetime.now().isoformat(),
        "default_sandbox_type": "git_worktree",
        "default_commands": ["invalid-command", "planning"],  # Invalid command
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
    }

    with pytest.raises(ValueError) as exc_info:
        repository_instance._row_to_model(invalid_row)

    assert "invalid workflow steps" in str(exc_info.value).lower()
    assert "test-id" in str(exc_info.value)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_row_to_model_with_invalid_sandbox_type(repository_instance):
    """Test _row_to_model raises ValueError for invalid sandbox type"""
    invalid_row = {
        "id": "test-id",
        "repository_url": "https://github.com/test/repo",
        "display_name": "test/repo",
        "owner": "test",
        "default_branch": "main",
        "is_verified": True,
        "last_verified_at": datetime.now().isoformat(),
        "default_sandbox_type": "invalid_type",  # Invalid type
        "default_commands": ["create-branch", "planning"],
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
    }

    with pytest.raises(ValueError) as exc_info:
        repository_instance._row_to_model(invalid_row)

    assert "invalid sandbox type" in str(exc_info.value).lower()
    assert "test-id" in str(exc_info.value)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_create_repository_with_all_fields(repository_instance, mock_supabase_client):
    """Test creating a repository with all optional fields populated"""
    mock_data = [{
        "id": "full-repo-id",
        "repository_url": "https://github.com/test/fullrepo",
        "display_name": "test/fullrepo",
        "owner": "test",
        "default_branch": "develop",
        "is_verified": True,
        "last_verified_at": datetime.now().isoformat(),
        "default_sandbox_type": "git_worktree",
        "default_commands": ["create-branch", "planning", "execute", "commit", "create-pr"],
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
    }]
    mock_supabase_client.execute.return_value = MagicMock(data=mock_data)

    repository = await repository_instance.create_repository(
        repository_url="https://github.com/test/fullrepo",
        display_name="test/fullrepo",
        owner="test",
        default_branch="develop",
        is_verified=True,
    )

    assert repository.id == "full-repo-id"
    assert repository.display_name == "test/fullrepo"
    assert repository.owner == "test"
    assert repository.default_branch == "develop"
    assert repository.is_verified is True
    assert repository.last_verified_at is not None


@pytest.mark.unit
@pytest.mark.asyncio
async def test_update_repository_with_multiple_fields(repository_instance, mock_supabase_client):
    """Test updating repository with multiple fields at once"""
    mock_data = [{
        "id": "repo-1",
        "repository_url": "https://github.com/test/repo1",
        "display_name": "updated-name",
        "owner": "updated-owner",
        "default_branch": "updated-branch",
        "is_verified": True,
        "last_verified_at": datetime.now().isoformat(),
        "default_sandbox_type": "git_worktree",
        "default_commands": ["create-branch"],
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
    }]
    mock_supabase_client.execute.return_value = MagicMock(data=mock_data)

    repository = await repository_instance.update_repository(
        "repo-1",
        display_name="updated-name",
        owner="updated-owner",
        default_branch="updated-branch",
        is_verified=True,
    )

    assert repository is not None
    assert repository.display_name == "updated-name"
    assert repository.owner == "updated-owner"
    assert repository.default_branch == "updated-branch"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_list_repositories_with_multiple_items(repository_instance, mock_supabase_client):
    """Test listing multiple repositories"""
    mock_data = [
        {
            "id": f"repo-{i}",
            "repository_url": f"https://github.com/test/repo{i}",
            "display_name": f"test/repo{i}",
            "owner": "test",
            "default_branch": "main",
            "is_verified": i % 2 == 0,  # Alternate verified status
            "last_verified_at": datetime.now().isoformat() if i % 2 == 0 else None,
            "default_sandbox_type": "git_worktree",
            "default_commands": ["create-branch", "planning", "execute"],
            "created_at": datetime.now().isoformat(),
            "updated_at": datetime.now().isoformat(),
        }
        for i in range(5)
    ]
    mock_supabase_client.execute.return_value = MagicMock(data=mock_data)

    repositories = await repository_instance.list_repositories()

    assert len(repositories) == 5
    assert all(isinstance(repo, ConfiguredRepository) for repo in repositories)
    # Check verification status alternates
    assert repositories[0].is_verified is True
    assert repositories[1].is_verified is False


@pytest.mark.unit
@pytest.mark.asyncio
async def test_create_repository_database_error(repository_instance, mock_supabase_client):
    """Test create_repository handles database errors properly"""
    mock_supabase_client.execute.side_effect = Exception("Database connection failed")

    with pytest.raises(Exception) as exc_info:
        await repository_instance.create_repository(
            repository_url="https://github.com/test/repo",
            is_verified=False,
        )

    assert "Database connection failed" in str(exc_info.value)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_get_repository_with_minimal_data(repository_instance, mock_supabase_client):
    """Test getting repository with minimal fields (all optionals null)"""
    mock_data = [{
        "id": "minimal-repo",
        "repository_url": "https://github.com/test/minimal",
        "display_name": None,
        "owner": None,
        "default_branch": None,
        "is_verified": False,
        "last_verified_at": None,
        "default_sandbox_type": "git_worktree",
        "default_commands": ["create-branch"],
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
    }]
    mock_supabase_client.execute.return_value = MagicMock(data=mock_data)

    repository = await repository_instance.get_repository("minimal-repo")

    assert repository is not None
    assert repository.display_name is None
    assert repository.owner is None
    assert repository.default_branch is None
    assert repository.is_verified is False
    assert repository.last_verified_at is None
