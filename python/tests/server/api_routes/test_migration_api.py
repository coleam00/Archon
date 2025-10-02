"""
Unit tests for migration_api.py
"""

from datetime import datetime
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from src.server.config.version import ARCHON_VERSION
from src.server.main import app
from src.server.services.migration_service import MigrationRecord, PendingMigration


@pytest.fixture
def client():
    """Create test client."""
    return TestClient(app)


@pytest.fixture
def mock_applied_migrations():
    """Mock applied migration data."""
    return [
        MigrationRecord({
            "version": "0.1.0",
            "migration_name": "001_initial",
            "applied_at": datetime(2025, 1, 1, 0, 0, 0),
            "checksum": "abc123",
        }),
        MigrationRecord({
            "version": "0.1.0",
            "migration_name": "002_add_column",
            "applied_at": datetime(2025, 1, 2, 0, 0, 0),
            "checksum": "def456",
        }),
    ]


@pytest.fixture
def mock_pending_migrations():
    """Mock pending migration data."""
    return [
        PendingMigration(
            version="0.1.0",
            name="003_add_index",
            sql_content="CREATE INDEX idx_test ON test_table(name);",
            file_path="migration/0.1.0/003_add_index.sql"
        ),
        PendingMigration(
            version="0.1.0",
            name="004_add_table",
            sql_content="CREATE TABLE new_table (id INT);",
            file_path="migration/0.1.0/004_add_table.sql"
        ),
    ]


@pytest.fixture
def mock_migration_status(mock_applied_migrations, mock_pending_migrations):
    """Mock complete migration status."""
    return {
        "pending_migrations": [
            {"version": m.version, "name": m.name, "sql_content": m.sql_content, "file_path": m.file_path, "checksum": m.checksum}
            for m in mock_pending_migrations
        ],
        "applied_migrations": [
            {"version": m.version, "migration_name": m.migration_name, "applied_at": m.applied_at, "checksum": m.checksum}
            for m in mock_applied_migrations
        ],
        "has_pending": True,
        "bootstrap_required": False,
        "current_version": ARCHON_VERSION,
        "pending_count": 2,
        "applied_count": 2,
    }


def test_get_migration_status_success(client, mock_migration_status):
    """Test successful migration status retrieval."""
    with patch("src.server.api_routes.migration_api.migration_service") as mock_service:
        mock_service.get_migration_status = AsyncMock(return_value=mock_migration_status)

        response = client.get("/api/migrations/status")

        assert response.status_code == 200
        data = response.json()
        assert data["current_version"] == ARCHON_VERSION
        assert data["has_pending"] is True
        assert data["bootstrap_required"] is False
        assert data["pending_count"] == 2
        assert data["applied_count"] == 2
        assert len(data["pending_migrations"]) == 2
        assert len(data["applied_migrations"]) == 2


def test_get_migration_status_bootstrap_required(client):
    """Test migration status when bootstrap is required."""
    mock_status = {
        "pending_migrations": [],
        "applied_migrations": [],
        "has_pending": True,
        "bootstrap_required": True,
        "current_version": ARCHON_VERSION,
        "pending_count": 5,
        "applied_count": 0,
    }

    with patch("src.server.api_routes.migration_api.migration_service") as mock_service:
        mock_service.get_migration_status = AsyncMock(return_value=mock_status)

        response = client.get("/api/migrations/status")

        assert response.status_code == 200
        data = response.json()
        assert data["bootstrap_required"] is True
        assert data["applied_count"] == 0


def test_get_migration_status_error(client):
    """Test error handling in migration status."""
    with patch("src.server.api_routes.migration_api.migration_service") as mock_service:
        mock_service.get_migration_status = AsyncMock(side_effect=Exception("Database error"))

        response = client.get("/api/migrations/status")

        assert response.status_code == 500
        assert "Failed to get migration status" in response.json()["detail"]


def test_get_migration_history_success(client, mock_applied_migrations):
    """Test successful migration history retrieval."""
    with patch("src.server.api_routes.migration_api.migration_service") as mock_service:
        mock_service.get_applied_migrations = AsyncMock(return_value=mock_applied_migrations)

        response = client.get("/api/migrations/history")

        assert response.status_code == 200
        data = response.json()
        assert data["total_count"] == 2
        assert data["current_version"] == ARCHON_VERSION
        assert len(data["migrations"]) == 2
        assert data["migrations"][0]["migration_name"] == "001_initial"


def test_get_migration_history_empty(client):
    """Test migration history when no migrations applied."""
    with patch("src.server.api_routes.migration_api.migration_service") as mock_service:
        mock_service.get_applied_migrations = AsyncMock(return_value=[])

        response = client.get("/api/migrations/history")

        assert response.status_code == 200
        data = response.json()
        assert data["total_count"] == 0
        assert len(data["migrations"]) == 0


def test_get_migration_history_error(client):
    """Test error handling in migration history."""
    with patch("src.server.api_routes.migration_api.migration_service") as mock_service:
        mock_service.get_applied_migrations = AsyncMock(side_effect=Exception("Database error"))

        response = client.get("/api/migrations/history")

        assert response.status_code == 500
        assert "Failed to get migration history" in response.json()["detail"]


def test_get_pending_migrations_success(client, mock_pending_migrations):
    """Test successful pending migrations retrieval."""
    with patch("src.server.api_routes.migration_api.migration_service") as mock_service:
        mock_service.get_pending_migrations = AsyncMock(return_value=mock_pending_migrations)

        response = client.get("/api/migrations/pending")

        assert response.status_code == 200
        data = response.json()
        assert len(data) == 2
        assert data[0]["name"] == "003_add_index"
        assert data[0]["sql_content"] == "CREATE INDEX idx_test ON test_table(name);"
        assert data[1]["name"] == "004_add_table"


def test_get_pending_migrations_none(client):
    """Test when no pending migrations exist."""
    with patch("src.server.api_routes.migration_api.migration_service") as mock_service:
        mock_service.get_pending_migrations = AsyncMock(return_value=[])

        response = client.get("/api/migrations/pending")

        assert response.status_code == 200
        data = response.json()
        assert len(data) == 0


def test_get_pending_migrations_error(client):
    """Test error handling in pending migrations."""
    with patch("src.server.api_routes.migration_api.migration_service") as mock_service:
        mock_service.get_pending_migrations = AsyncMock(side_effect=Exception("File error"))

        response = client.get("/api/migrations/pending")

        assert response.status_code == 500
        assert "Failed to get pending migrations" in response.json()["detail"]