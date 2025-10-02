"""
Fixed unit tests for migration_service.py
"""

import hashlib
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

from src.server.config.version import ARCHON_VERSION
from src.server.services.migration_service import (
    MigrationRecord,
    MigrationService,
    PendingMigration,
)


@pytest.fixture
def migration_service():
    """Create a migration service instance."""
    with patch("src.server.services.migration_service.Path.exists") as mock_exists:
        # Mock that migration directory exists locally
        mock_exists.return_value = False  # Docker path doesn't exist
        service = MigrationService()
        return service


@pytest.fixture
def mock_supabase_client():
    """Mock Supabase client."""
    client = MagicMock()
    return client


def test_pending_migration_init():
    """Test PendingMigration initialization and checksum calculation."""
    migration = PendingMigration(
        version="0.1.0",
        name="001_initial",
        sql_content="CREATE TABLE test (id INT);",
        file_path="migration/0.1.0/001_initial.sql"
    )

    assert migration.version == "0.1.0"
    assert migration.name == "001_initial"
    assert migration.sql_content == "CREATE TABLE test (id INT);"
    assert migration.file_path == "migration/0.1.0/001_initial.sql"
    assert migration.checksum == hashlib.md5("CREATE TABLE test (id INT);".encode()).hexdigest()


def test_migration_record_init():
    """Test MigrationRecord initialization from database data."""
    data = {
        "id": "123-456",
        "version": "0.1.0",
        "migration_name": "001_initial",
        "applied_at": "2025-01-01T00:00:00Z",
        "checksum": "abc123"
    }

    record = MigrationRecord(data)

    assert record.id == "123-456"
    assert record.version == "0.1.0"
    assert record.migration_name == "001_initial"
    assert record.applied_at == "2025-01-01T00:00:00Z"
    assert record.checksum == "abc123"


def test_migration_service_init_local():
    """Test MigrationService initialization with local path."""
    with patch("src.server.services.migration_service.Path.exists") as mock_exists:
        # Mock that Docker path doesn't exist
        mock_exists.return_value = False

        service = MigrationService()
        assert service._migrations_dir == Path("migration")


def test_migration_service_init_docker():
    """Test MigrationService initialization with Docker path."""
    with patch("src.server.services.migration_service.Path.exists") as mock_exists:
        # Mock that Docker path exists
        mock_exists.return_value = True

        service = MigrationService()
        assert service._migrations_dir == Path("/app/migration")


@pytest.mark.asyncio
async def test_get_applied_migrations_success(migration_service, mock_supabase_client):
    """Test successful retrieval of applied migrations."""
    mock_response = MagicMock()
    mock_response.data = [
        {
            "id": "123",
            "version": "0.1.0",
            "migration_name": "001_initial",
            "applied_at": "2025-01-01T00:00:00Z",
            "checksum": "abc123",
        },
    ]

    mock_supabase_client.table.return_value.select.return_value.order.return_value.execute.return_value = mock_response

    with patch.object(migration_service, '_get_supabase_client', return_value=mock_supabase_client):
        with patch.object(migration_service, 'check_migrations_table_exists', return_value=True):
            result = await migration_service.get_applied_migrations()

            assert len(result) == 1
            assert isinstance(result[0], MigrationRecord)
            assert result[0].version == "0.1.0"
            assert result[0].migration_name == "001_initial"


@pytest.mark.asyncio
async def test_get_applied_migrations_table_not_exists(migration_service, mock_supabase_client):
    """Test handling when migrations table doesn't exist."""
    with patch.object(migration_service, '_get_supabase_client', return_value=mock_supabase_client):
        with patch.object(migration_service, 'check_migrations_table_exists', return_value=False):
            result = await migration_service.get_applied_migrations()
            assert result == []


@pytest.mark.asyncio
async def test_get_pending_migrations_with_files(migration_service, mock_supabase_client):
    """Test getting pending migrations from filesystem."""
    # Mock scan_migration_directory to return test migrations
    mock_migrations = [
        PendingMigration(
            version="0.1.0",
            name="001_initial",
            sql_content="CREATE TABLE test;",
            file_path="migration/0.1.0/001_initial.sql"
        ),
        PendingMigration(
            version="0.1.0",
            name="002_update",
            sql_content="ALTER TABLE test ADD col TEXT;",
            file_path="migration/0.1.0/002_update.sql"
        )
    ]

    # Mock no applied migrations
    with patch.object(migration_service, 'scan_migration_directory', return_value=mock_migrations):
        with patch.object(migration_service, 'get_applied_migrations', return_value=[]):
            result = await migration_service.get_pending_migrations()

            assert len(result) == 2
            assert all(isinstance(m, PendingMigration) for m in result)
            assert result[0].name == "001_initial"
            assert result[1].name == "002_update"


@pytest.mark.asyncio
async def test_get_pending_migrations_some_applied(migration_service, mock_supabase_client):
    """Test getting pending migrations when some are already applied."""
    # Mock all migrations
    mock_all_migrations = [
        PendingMigration(
            version="0.1.0",
            name="001_initial",
            sql_content="CREATE TABLE test;",
            file_path="migration/0.1.0/001_initial.sql"
        ),
        PendingMigration(
            version="0.1.0",
            name="002_update",
            sql_content="ALTER TABLE test ADD col TEXT;",
            file_path="migration/0.1.0/002_update.sql"
        )
    ]

    # Mock first migration as applied
    mock_applied = [
        MigrationRecord({
            "version": "0.1.0",
            "migration_name": "001_initial",
            "applied_at": "2025-01-01T00:00:00Z",
            "checksum": None
        })
    ]

    with patch.object(migration_service, 'scan_migration_directory', return_value=mock_all_migrations):
        with patch.object(migration_service, 'get_applied_migrations', return_value=mock_applied):
            with patch.object(migration_service, 'check_migrations_table_exists', return_value=True):
                result = await migration_service.get_pending_migrations()

                assert len(result) == 1
                assert result[0].name == "002_update"


@pytest.mark.asyncio
async def test_get_migration_status_all_applied(migration_service, mock_supabase_client):
    """Test migration status when all migrations are applied."""
    # Mock one migration file
    mock_all_migrations = [
        PendingMigration(
            version="0.1.0",
            name="001_initial",
            sql_content="CREATE TABLE test;",
            file_path="migration/0.1.0/001_initial.sql"
        )
    ]

    # Mock migration as applied
    mock_applied = [
        MigrationRecord({
            "version": "0.1.0",
            "migration_name": "001_initial",
            "applied_at": "2025-01-01T00:00:00Z",
            "checksum": None
        })
    ]

    with patch.object(migration_service, 'scan_migration_directory', return_value=mock_all_migrations):
        with patch.object(migration_service, 'get_applied_migrations', return_value=mock_applied):
            with patch.object(migration_service, 'check_migrations_table_exists', return_value=True):
                result = await migration_service.get_migration_status()

                assert result["current_version"] == ARCHON_VERSION
                assert result["has_pending"] is False
                assert result["bootstrap_required"] is False
                assert result["pending_count"] == 0
                assert result["applied_count"] == 1


@pytest.mark.asyncio
async def test_get_migration_status_bootstrap_required(migration_service, mock_supabase_client):
    """Test migration status when bootstrap is required (table doesn't exist)."""
    # Mock migration files
    mock_all_migrations = [
        PendingMigration(
            version="0.1.0",
            name="001_initial",
            sql_content="CREATE TABLE test;",
            file_path="migration/0.1.0/001_initial.sql"
        ),
        PendingMigration(
            version="0.1.0",
            name="002_update",
            sql_content="ALTER TABLE test ADD col TEXT;",
            file_path="migration/0.1.0/002_update.sql"
        )
    ]

    with patch.object(migration_service, 'scan_migration_directory', return_value=mock_all_migrations):
        with patch.object(migration_service, 'get_applied_migrations', return_value=[]):
            with patch.object(migration_service, 'check_migrations_table_exists', return_value=False):
                result = await migration_service.get_migration_status()

                assert result["bootstrap_required"] is True
                assert result["has_pending"] is True
                assert result["pending_count"] == 2
                assert result["applied_count"] == 0
                assert len(result["pending_migrations"]) == 2


@pytest.mark.asyncio
async def test_get_migration_status_no_files(migration_service, mock_supabase_client):
    """Test migration status when no migration files exist."""
    with patch.object(migration_service, 'scan_migration_directory', return_value=[]):
        with patch.object(migration_service, 'get_applied_migrations', return_value=[]):
            with patch.object(migration_service, 'check_migrations_table_exists', return_value=True):
                result = await migration_service.get_migration_status()

                assert result["has_pending"] is False
                assert result["pending_count"] == 0
                assert len(result["pending_migrations"]) == 0