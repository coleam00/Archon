"""
Unit tests for settings_api.py
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from src.server.main import app


@pytest.fixture
def client(mock_supabase_client):
    """Create test client with mocked database."""
    with patch("src.server.utils.get_supabase_client", return_value=mock_supabase_client):
        return TestClient(app)


@pytest.fixture
def mock_credential():
    """Mock credential data."""
    return {
        "key": "TEST_KEY",
        "value": "test-value",
        "encrypted_value": None,
        "is_encrypted": False,
        "category": "test",
        "description": "Test credential"
    }


def test_list_credentials_success(client, mock_credential):
    """Test listing all credentials."""
    with patch("src.server.api_routes.settings_api.credential_service") as mock_service:
        mock_cred_obj = MagicMock()
        mock_cred_obj.key = mock_credential["key"]
        mock_cred_obj.value = mock_credential["value"]
        mock_cred_obj.encrypted_value = None
        mock_cred_obj.is_encrypted = False
        mock_cred_obj.category = mock_credential["category"]
        mock_cred_obj.description = mock_credential["description"]

        mock_service.list_all_credentials = AsyncMock(return_value=[mock_cred_obj])

        response = client.get("/api/credentials")

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) == 1
        assert data[0]["key"] == "TEST_KEY"


def test_list_credentials_by_category(client, mock_credential):
    """Test listing credentials filtered by category."""
    with patch("src.server.api_routes.settings_api.credential_service") as mock_service:
        mock_cred_obj = MagicMock()
        mock_cred_obj.key = mock_credential["key"]
        mock_cred_obj.value = mock_credential["value"]
        mock_cred_obj.encrypted_value = None
        mock_cred_obj.is_encrypted = False
        mock_cred_obj.category = "test"
        mock_cred_obj.description = mock_credential["description"]

        mock_service.list_all_credentials = AsyncMock(return_value=[mock_cred_obj])

        response = client.get("/api/credentials?category=test")

        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1


def test_get_credentials_by_category(client):
    """Test getting credentials by category endpoint."""
    with patch("src.server.api_routes.settings_api.credential_service") as mock_service:
        mock_service.get_credentials_by_category = AsyncMock(return_value=[
            {"key": "KEY1", "value": "value1"}
        ])

        response = client.get("/api/credentials/categories/test")

        assert response.status_code == 200
        data = response.json()
        assert "credentials" in data
        assert len(data["credentials"]) == 1


def test_create_credential_success(client):
    """Test creating a new credential."""
    with patch("src.server.api_routes.settings_api.credential_service") as mock_service:
        mock_service.set_credential = AsyncMock(return_value=True)

        response = client.post(
            "/api/credentials",
            json={
                "key": "NEW_KEY",
                "value": "new-value",
                "is_encrypted": False,
                "category": "test",
                "description": "New credential"
            }
        )

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert "NEW_KEY" in data["message"]


def test_create_encrypted_credential(client):
    """Test creating an encrypted credential."""
    with patch("src.server.api_routes.settings_api.credential_service") as mock_service:
        mock_service.set_credential = AsyncMock(return_value=True)

        response = client.post(
            "/api/credentials",
            json={
                "key": "SECRET_KEY",
                "value": "secret-value",
                "is_encrypted": True,
                "category": "secrets"
            }
        )

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert "encrypted" in data["message"]


def test_create_credential_failure(client):
    """Test credential creation failure."""
    with patch("src.server.api_routes.settings_api.credential_service") as mock_service:
        mock_service.set_credential = AsyncMock(return_value=False)

        response = client.post(
            "/api/credentials",
            json={
                "key": "FAIL_KEY",
                "value": "value"
            }
        )

        assert response.status_code == 500


def test_get_credential_success(client):
    """Test getting a specific credential."""
    with patch("src.server.api_routes.settings_api.credential_service") as mock_service:
        mock_service.get_credential = AsyncMock(return_value="test-value")

        response = client.get("/api/credentials/TEST_KEY")

        assert response.status_code == 200
        data = response.json()
        assert data["key"] == "TEST_KEY"
        assert data["value"] == "test-value"


def test_get_encrypted_credential(client):
    """Test getting an encrypted credential (should not decrypt)."""
    with patch("src.server.api_routes.settings_api.credential_service") as mock_service:
        mock_service.get_credential = AsyncMock(return_value={
            "is_encrypted": True,
            "encrypted_value": "encrypted-data",
            "category": "secrets"
        })

        response = client.get("/api/credentials/SECRET_KEY")

        assert response.status_code == 200
        data = response.json()
        assert data["value"] == "[ENCRYPTED]"
        assert data["is_encrypted"] is True
        assert data["has_value"] is True


def test_get_credential_not_found(client):
    """Test getting non-existent credential."""
    with patch("src.server.api_routes.settings_api.credential_service") as mock_service:
        mock_service.get_credential = AsyncMock(return_value=None)

        response = client.get("/api/credentials/NONEXISTENT")

        assert response.status_code == 404


def test_get_optional_setting_default(client):
    """Test getting optional setting returns default value."""
    with patch("src.server.api_routes.settings_api.credential_service") as mock_service:
        mock_service.get_credential = AsyncMock(return_value=None)

        response = client.get("/api/credentials/PROJECTS_ENABLED")

        assert response.status_code == 200
        data = response.json()
        assert data["is_default"] is True
        assert "value" in data


def test_update_credential_success(client):
    """Test updating an existing credential."""
    with patch("src.server.api_routes.settings_api.credential_service") as mock_service:
        # Mock existing credential
        existing_cred = MagicMock()
        existing_cred.key = "TEST_KEY"
        existing_cred.is_encrypted = False
        existing_cred.category = "test"
        existing_cred.description = "Test"

        mock_service.list_all_credentials = AsyncMock(return_value=[existing_cred])
        mock_service.set_credential = AsyncMock(return_value=True)

        response = client.put(
            "/api/credentials/TEST_KEY",
            json={"value": "updated-value"}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True


def test_delete_credential_success(client):
    """Test deleting a credential."""
    with patch("src.server.api_routes.settings_api.credential_service") as mock_service:
        mock_service.delete_credential = AsyncMock(return_value=True)

        response = client.delete("/api/credentials/TEST_KEY")

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True


def test_delete_credential_failure(client):
    """Test credential deletion failure."""
    with patch("src.server.api_routes.settings_api.credential_service") as mock_service:
        mock_service.delete_credential = AsyncMock(return_value=False)

        response = client.delete("/api/credentials/TEST_KEY")

        assert response.status_code == 500


def test_initialize_credentials_success(client):
    """Test reloading credentials from database."""
    with patch("src.server.api_routes.settings_api.initialize_credentials") as mock_init:
        mock_init.return_value = None

        response = client.post("/api/credentials/initialize")

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True


def test_database_metrics_success(client, mock_supabase_client):
    """Test getting database metrics."""
    # Mock count responses
    mock_execute = MagicMock()
    mock_execute.count = 10
    mock_select = MagicMock()
    mock_select.execute.return_value = mock_execute
    mock_supabase_client.table.return_value.select.return_value = mock_select

    response = client.get("/api/database/metrics")

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert "tables" in data
    assert "total_records" in data


def test_settings_health(client):
    """Test settings health check."""
    response = client.get("/api/settings/health")

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["service"] == "settings"


def test_check_credential_status_success(client):
    """Test checking credential status."""
    with patch("src.server.api_routes.settings_api.credential_service") as mock_service:
        mock_service.get_credential = AsyncMock(return_value="test-api-key")

        response = client.post(
            "/api/credentials/status-check",
            json={"keys": ["OPENAI_API_KEY"]}
        )

        assert response.status_code == 200
        data = response.json()
        assert "OPENAI_API_KEY" in data
        assert data["OPENAI_API_KEY"]["has_value"] is True


def test_check_credential_status_missing(client):
    """Test checking status of missing credential."""
    with patch("src.server.api_routes.settings_api.credential_service") as mock_service:
        mock_service.get_credential = AsyncMock(return_value=None)

        response = client.post(
            "/api/credentials/status-check",
            json={"keys": ["MISSING_KEY"]}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["MISSING_KEY"]["has_value"] is False
