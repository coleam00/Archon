"""
Comprehensive test suite for database API endpoints

This file contains tests for database API endpoints including:
- /api/database/status: Checks database initialization status
- /api/database/setup-sql: Retrieves SQL setup script content
- /api/database/verify-setup: Verifies database setup was completed successfully

Tests cover success cases, error handling, edge cases, and integration scenarios.
"""

from pathlib import Path
from unittest.mock import AsyncMock, Mock, mock_open, patch

import pytest
from fastapi import status

from tests.fixtures.database_fixtures import (
    DATABASE_STATUS_SCENARIOS,
    ENVIRONMENT_SCENARIOS,
    SAMPLE_SQL_CONTENT,
    VERIFICATION_SCENARIOS,
)
from tests.utils.database_test_utils import (
    HTTPTestUtilities,
    MockCredentialServiceFactory,
    MockEnvironmentFactory,
    ValidationTestUtilities,
)


class TestDatabaseStatusEndpoint:
    """Test suite for /api/database/status endpoint"""

    def test_database_status_initialized_success(self, client):
        """Test status endpoint when database is properly initialized"""
        mock_service = MockCredentialServiceFactory.create_successful_mock()

        with patch("src.server.api_routes.database_api.credential_service", mock_service):
            response = client.get("/api/database/status")

            HTTPTestUtilities.assert_database_status_response(response, initialized=True, setup_required=False)

            data = response.json()
            assert data["message"] == "Database is properly initialized"
            mock_service.load_all_credentials.assert_called_once()

    def test_database_status_needs_setup(self, client):
        """Test status endpoint when database needs setup"""
        mock_service = MockCredentialServiceFactory.create_not_initialized_mock()

        with patch("src.server.api_routes.database_api.credential_service", mock_service):
            response = client.get("/api/database/status")

            HTTPTestUtilities.assert_database_status_response(response, initialized=False, setup_required=True)

            data = response.json()
            assert data["message"] == "Database tables are missing and need to be created"
            mock_service.load_all_credentials.assert_called_once()

    @pytest.mark.parametrize("scenario_name,expected_response,error_type", DATABASE_STATUS_SCENARIOS)
    def test_database_status_error_scenarios(self, client, scenario_name, expected_response, error_type):
        """Test status endpoint with various error scenarios"""
        if error_type == "database_initialized":
            mock_service = MockCredentialServiceFactory.create_successful_mock()
        elif error_type == "database_not_initialized":
            mock_service = MockCredentialServiceFactory.create_not_initialized_mock()
        else:
            mock_service = MockCredentialServiceFactory.create_error_mock(error_type)

        with patch("src.server.api_routes.database_api.credential_service", mock_service):
            response = client.get("/api/database/status")

            if error_type in ["database_initialized", "database_not_initialized"]:
                HTTPTestUtilities.assert_status_code(response, status.HTTP_200_OK)
                data = response.json()
                assert data["initialized"] == expected_response["initialized"]
                assert data["setup_required"] == expected_response["setup_required"]
                assert expected_response["message"] in data["message"]
            else:
                HTTPTestUtilities.assert_status_code(response, status.HTTP_500_INTERNAL_SERVER_ERROR)
                data = response.json()
                # Check for new structured error format
                error_data = data["detail"]
                if isinstance(error_data, dict):
                    assert "Database connection failed" in error_data["error"]
                    assert "context" in error_data
                else:
                    assert "Database connection failed" in str(error_data)


class TestSetupSQLEndpoint:
    """Test suite for /api/database/setup-sql endpoint"""

    def test_setup_sql_file_based_success(self, client):
        """Test setup SQL endpoint when file exists"""
        with (
            patch("pathlib.Path.exists", return_value=True),
            patch("builtins.open", mock_open(read_data=SAMPLE_SQL_CONTENT)),
            MockEnvironmentFactory.create_environment("with_supabase_url"),
        ):
            response = client.get("/api/database/setup-sql")

            HTTPTestUtilities.assert_setup_sql_response(response, has_project_id=True, has_sql_editor_url=True)

            data = response.json()
            assert data["sql_content"] == SAMPLE_SQL_CONTENT
            assert data["project_id"] == "abc123def456"
            assert "https://supabase.com/dashboard/project/abc123def456/sql/new" == data["sql_editor_url"]

    def test_setup_sql_project_id_extraction(self, client):
        """Test project ID extraction from various SUPABASE_URL formats"""
        test_cases = [
            ("https://abc123.supabase.co", "abc123"),
            ("https://test-project-123.supabase.co", "test-project-123"),
            ("https://verylongprojectidhere.supabase.co", "verylongprojectidhere"),
        ]

        for supabase_url, expected_project_id in test_cases:
            with (
                patch("pathlib.Path.exists", return_value=True),
                patch("builtins.open", mock_open(read_data=SAMPLE_SQL_CONTENT)),
                MockEnvironmentFactory.create_custom_environment(
                    {"SUPABASE_URL": supabase_url, "SUPABASE_SERVICE_KEY": "test-key"}
                ),
            ):
                response = client.get("/api/database/setup-sql")

                HTTPTestUtilities.assert_status_code(response, status.HTTP_200_OK)
                data = response.json()
                assert data["project_id"] == expected_project_id
                assert f"https://supabase.com/dashboard/project/{expected_project_id}/sql/new" == data["sql_editor_url"]

    def test_setup_sql_no_supabase_url(self, client):
        """Test setup SQL endpoint without SUPABASE_URL"""
        mock_service = MockCredentialServiceFactory.create_unconfigured_mock()

        with (
            patch("pathlib.Path.exists", return_value=True),
            patch("builtins.open", mock_open(read_data=SAMPLE_SQL_CONTENT)),
            MockEnvironmentFactory.create_environment("without_supabase_url"),
        ):
            response = client.get("/api/database/setup-sql")

            HTTPTestUtilities.assert_status_code(response, status.HTTP_200_OK)
            data = response.json()
            assert data["project_id"] is None
            assert data["sql_editor_url"] is None
            assert len(data["sql_content"]) > 0

    def test_setup_sql_invalid_supabase_url(self, client):
        """Test setup SQL endpoint with invalid SUPABASE_URL"""
        with (
            patch("pathlib.Path.exists", return_value=True),
            patch("builtins.open", mock_open(read_data=SAMPLE_SQL_CONTENT)),
            MockEnvironmentFactory.create_environment("invalid_supabase_url"),
        ):
            response = client.get("/api/database/setup-sql")

            HTTPTestUtilities.assert_status_code(response, status.HTTP_200_OK)
            data = response.json()
            assert data["project_id"] is None
            assert data["sql_editor_url"] is None

    def test_setup_sql_file_not_found_error(self, client):
        """Test error when SQL file doesn't exist"""
        with (
            patch("pathlib.Path.exists", return_value=False),
            MockEnvironmentFactory.create_environment("with_supabase_url"),
        ):
            response = client.get("/api/database/setup-sql")

            HTTPTestUtilities.assert_status_code(response, status.HTTP_500_INTERNAL_SERVER_ERROR)
            data = response.json()
            assert "Setup SQL file not found" in data["detail"]

    def test_setup_sql_file_permission_error(self, client):
        """Test setup SQL endpoint with file permission error"""
        with (
            patch("pathlib.Path.exists", return_value=True),
            patch("builtins.open", side_effect=PermissionError("Permission denied")),
        ):
            response = client.get("/api/database/setup-sql")

            HTTPTestUtilities.assert_status_code(response, status.HTTP_500_INTERNAL_SERVER_ERROR)
            data = response.json()
            assert "Failed to get setup SQL" in data["detail"]

    def test_setup_sql_file_io_error(self, client):
        """Test setup SQL endpoint with file I/O error"""
        with patch("pathlib.Path.exists", return_value=True), patch("builtins.open", side_effect=OSError("I/O error")):
            response = client.get("/api/database/setup-sql")

            HTTPTestUtilities.assert_status_code(response, status.HTTP_500_INTERNAL_SERVER_ERROR)
            data = response.json()
            assert "Failed to get setup SQL" in data["detail"]

    @pytest.mark.parametrize("env_name,env_config,expected_project_id", ENVIRONMENT_SCENARIOS)
    def test_setup_sql_environment_scenarios(self, client, env_name, env_config, expected_project_id):
        """Test setup SQL endpoint with different environment configurations"""
        with (
            patch("pathlib.Path.exists", return_value=True),
            patch("builtins.open", mock_open(read_data=SAMPLE_SQL_CONTENT)),
            MockEnvironmentFactory.create_custom_environment(env_config),
        ):
            response = client.get("/api/database/setup-sql")

            HTTPTestUtilities.assert_status_code(response, status.HTTP_200_OK)
            data = response.json()

            if expected_project_id:
                assert data["project_id"] == expected_project_id
                if expected_project_id not in ["测试项目🚀"]:  # Skip URL generation for unicode
                    assert data["sql_editor_url"] is not None
            else:
                assert data["project_id"] is None
                assert data["sql_editor_url"] is None

    def test_setup_sql_regex_failure_handling(self, client):
        """Test setup SQL endpoint with regex extraction failure"""
        with (
            patch("pathlib.Path.exists", return_value=True),
            patch("builtins.open", mock_open(read_data=SAMPLE_SQL_CONTENT)),
            patch("re.search", return_value=None),
            MockEnvironmentFactory.create_environment("with_supabase_url"),
        ):
            response = client.get("/api/database/setup-sql")

            HTTPTestUtilities.assert_status_code(response, status.HTTP_200_OK)
            data = response.json()
            assert data["project_id"] is None
            assert data["sql_editor_url"] is None

    def test_setup_sql_matches_migration_file(self, client):
        """Test that SQL content returned matches complete_setup.sql"""
        # Read the actual migration file using repository-relative path
        migration_file = Path(__file__).parent.parent.parent / "migration" / "complete_setup.sql"
        with open(migration_file, encoding="utf-8") as f:
            expected_sql = f.read()

        with (
            patch("pathlib.Path.exists", return_value=True),
            patch("builtins.open", mock_open(read_data=expected_sql)),
            MockEnvironmentFactory.create_environment("with_supabase_url"),
        ):
            response = client.get("/api/database/setup-sql")

            HTTPTestUtilities.assert_status_code(response, status.HTTP_200_OK)
            data = response.json()
            assert data["sql_content"] == expected_sql
            assert "-- Archon Complete Database Setup" in data["sql_content"]
            assert "CREATE EXTENSION IF NOT EXISTS vector;" in data["sql_content"]
            assert "CREATE TABLE IF NOT EXISTS archon_settings" in data["sql_content"]


class TestVerifySetupEndpoint:
    """Test suite for /api/database/verify-setup endpoint"""

    def test_verify_setup_success(self, client):
        """Test verification endpoint when setup is successful"""
        mock_service = MockCredentialServiceFactory.create_successful_mock()

        with (
            patch("src.server.api_routes.database_api.credential_service", mock_service),
            patch("src.server.main.update_database_initialized") as mock_update,
        ):
            response = client.post("/api/database/verify-setup")

            HTTPTestUtilities.assert_verify_setup_response(response, success=True)

            data = response.json()
            assert data["message"] == "Database setup verified successfully"

            # Verify new cache management methods were called
            mock_service.reset_cache.assert_called_once()
            mock_service.force_database_reload.assert_called_once()
            mock_service.load_all_credentials.assert_called_once()
            mock_update.assert_called_once_with(True)

    def test_verify_setup_failure_tables_not_found(self, client):
        """Test verification endpoint when tables are not found"""
        mock_service = MockCredentialServiceFactory.create_not_initialized_mock()

        with patch("src.server.api_routes.database_api.credential_service", mock_service):
            response = client.post("/api/database/verify-setup")

            HTTPTestUtilities.assert_verify_setup_response(response, success=False)

            data = response.json()
            # The message format changed with the new error handling
            assert "Database tables" in data["message"] and "not found" in data["message"]

            # Verify new cache management methods were called
            mock_service.reset_cache.assert_called_once()
            mock_service.force_database_reload.assert_called_once()

    def test_verify_setup_global_state_update(self, client):
        """Test that verification updates global database initialization flag"""
        mock_service = MockCredentialServiceFactory.create_successful_mock()

        with (
            patch("src.server.api_routes.database_api.credential_service", mock_service),
            patch("src.server.main.update_database_initialized") as mock_update,
        ):
            response = client.post("/api/database/verify-setup")

            HTTPTestUtilities.assert_verify_setup_response(response, success=True)
            mock_update.assert_called_once_with(True)

    @pytest.mark.parametrize("scenario_name,expected_response,error_type", VERIFICATION_SCENARIOS)
    def test_verify_setup_scenarios(self, client, scenario_name, expected_response, error_type):
        """Test verification endpoint with various scenarios"""
        if error_type == "database_initialized":
            mock_service = MockCredentialServiceFactory.create_successful_mock()
        elif error_type == "database_not_initialized":
            mock_service = MockCredentialServiceFactory.create_not_initialized_mock()
        else:
            mock_service = MockCredentialServiceFactory.create_error_mock(error_type)

        with (
            patch("src.server.api_routes.database_api.credential_service", mock_service),
            patch("src.server.main.update_database_initialized"),
        ):
            response = client.post("/api/database/verify-setup")

            HTTPTestUtilities.assert_status_code(response, status.HTTP_200_OK)
            data = response.json()

            assert data["success"] == expected_response["success"]
            if expected_response["success"]:
                assert "verified successfully" in data["message"]
            else:
                assert "failed" in data["message"] or "not found" in data["message"]

    def test_verify_setup_exception_handling(self, client):
        """Test verification endpoint exception handling"""
        mock_service = AsyncMock()
        mock_service.load_all_credentials.side_effect = Exception("Unexpected error")

        # Add the required cache management methods
        mock_service.reset_cache = Mock()
        mock_service.force_database_reload = Mock()
        mock_service.get_cache_status = Mock(
            return_value={
                "cache_initialized": False,
                "cache_size": 0,
                "database_tables_exist": None,
                "supabase_client_initialized": False,
            }
        )

        with patch("src.server.api_routes.database_api.credential_service", mock_service):
            response = client.post("/api/database/verify-setup")

            HTTPTestUtilities.assert_verify_setup_response(response, success=False)

            data = response.json()
            assert "Database verification failed" in data["message"]
            assert "Unexpected error" in data["message"]


class TestDatabaseAPIIntegration:
    """Integration tests for database API endpoints"""

    def test_complete_database_setup_flow(self, client):
        """Test complete database setup flow from status check to verification"""
        mock_service_not_init = MockCredentialServiceFactory.create_not_initialized_mock()

        with patch("src.server.api_routes.database_api.credential_service", mock_service_not_init):
            status_response = client.get("/api/database/status")
            HTTPTestUtilities.assert_database_status_response(status_response, initialized=False, setup_required=True)

        with (
            patch("pathlib.Path.exists", return_value=True),
            patch("builtins.open", mock_open(read_data=SAMPLE_SQL_CONTENT)),
            MockEnvironmentFactory.create_environment("with_supabase_url"),
        ):
            sql_response = client.get("/api/database/setup-sql")
            HTTPTestUtilities.assert_setup_sql_response(sql_response, has_project_id=True, has_sql_editor_url=True)

        mock_service_success = MockCredentialServiceFactory.create_successful_mock()

        with (
            patch("src.server.api_routes.database_api.credential_service", mock_service_success),
            patch("src.server.main.update_database_initialized"),
        ):
            verify_response = client.post("/api/database/verify-setup")
            HTTPTestUtilities.assert_verify_setup_response(verify_response, success=True)

        with patch("src.server.api_routes.database_api.credential_service", mock_service_success):
            final_status_response = client.get("/api/database/status")
            HTTPTestUtilities.assert_database_status_response(
                final_status_response, initialized=True, setup_required=False
            )

    def test_retry_verification_flow(self, client):
        """Test verification flow with multiple retry attempts"""
        mock_service = MockCredentialServiceFactory.create_intermittent_mock(success_after=2)

        with (
            patch("src.server.api_routes.database_api.credential_service", mock_service),
            patch("src.server.main.update_database_initialized"),
        ):
            response1 = client.post("/api/database/verify-setup")
            HTTPTestUtilities.assert_verify_setup_response(response1, success=False)

            response2 = client.post("/api/database/verify-setup")
            HTTPTestUtilities.assert_verify_setup_response(response2, success=False)

            response3 = client.post("/api/database/verify-setup")
            HTTPTestUtilities.assert_verify_setup_response(response3, success=True)

    def test_error_recovery_scenarios(self, client):
        """Test error recovery in various scenarios"""
        network_error_service = MockCredentialServiceFactory.create_error_mock("connection_refused")
        success_service = MockCredentialServiceFactory.create_successful_mock()

        with patch("src.server.api_routes.database_api.credential_service", network_error_service):
            response1 = client.get("/api/database/status")
            HTTPTestUtilities.assert_status_code(response1, status.HTTP_500_INTERNAL_SERVER_ERROR)

        with patch("src.server.api_routes.database_api.credential_service", success_service):
            response2 = client.get("/api/database/status")
            HTTPTestUtilities.assert_database_status_response(response2, initialized=True, setup_required=False)


class TestDatabaseAPISecurityAndValidation:
    """Security and validation tests for database API endpoints"""

    def test_security_and_edge_cases(self, client):
        """Test key security scenarios and edge cases"""
        # Test a few representative malicious inputs
        malicious_inputs = [
            "'; DROP TABLE users; --",
            "<script>alert('xss')</script>",
            "../../../etc/passwd",
        ]

        for malicious_input in malicious_inputs:
            with (
                patch("pathlib.Path.exists", return_value=True),
                patch("builtins.open", mock_open(read_data=malicious_input)),
            ):
                response = client.get("/api/database/setup-sql")
                HTTPTestUtilities.assert_status_code(response, status.HTTP_200_OK)
                data = response.json()
                assert data["sql_content"] == malicious_input

        # Test error handling provides useful debugging information
        mock_service = AsyncMock()
        mock_service.load_all_credentials.side_effect = Exception("Database connection timeout")

        with patch("src.server.api_routes.database_api.credential_service", mock_service):
            response = client.get("/api/database/status")

            HTTPTestUtilities.assert_status_code(response, status.HTTP_500_INTERNAL_SERVER_ERROR)
            data = response.json()
            # Check for new structured error format
            error_data = data["detail"]
            error_message = error_data["error"] if isinstance(error_data, dict) else str(error_data)

            # Verify error is useful for debugging (alpha principle: detailed errors)
            assert "Unexpected database status check failure" in error_message
            assert "Database connection timeout" in error_message

            # Verify correlation_id is present for tracing
            if isinstance(error_data, dict):
                assert "correlation_id" in error_data.get("context", {})

        # Test empty file case (should error)
        with patch("pathlib.Path.exists", return_value=True), patch("builtins.open", mock_open(read_data="")):
            response = client.get("/api/database/setup-sql")
            HTTPTestUtilities.assert_status_code(response, status.HTTP_500_INTERNAL_SERVER_ERROR)
            data = response.json()
            assert "Setup SQL file is empty" in data["detail"]


class TestDatabaseAPIPerformanceAndEdgeCases:
    """Performance and edge case tests for database API endpoints"""

    def test_unicode_content_handling(self, client):
        """Test handling of unicode content in SQL files"""
        unicode_test_cases = [
            "-- Unicode: café, naïve, résumé",
            "-- Emoji and Asian: 🚀 你好 こんにちは",
        ]

        for unicode_content in unicode_test_cases:
            with (
                patch("pathlib.Path.exists", return_value=True),
                patch("builtins.open", mock_open(read_data=unicode_content)),
            ):
                response = client.get("/api/database/setup-sql")

                HTTPTestUtilities.assert_status_code(response, status.HTTP_200_OK)
                data = response.json()
                assert data["sql_content"] == unicode_content

    def test_endpoint_response_structure(self, client):
        """Test that endpoints return expected response structure"""
        mock_service = MockCredentialServiceFactory.create_successful_mock()

        with (
            patch("src.server.api_routes.database_api.credential_service", mock_service),
            patch("pathlib.Path.exists", return_value=True),
            patch("builtins.open", mock_open(read_data=SAMPLE_SQL_CONTENT)),
            MockEnvironmentFactory.create_environment("with_supabase_url"),
            patch("src.server.main.update_database_initialized"),
        ):
            # Test status endpoint structure
            response = client.get("/api/database/status")
            HTTPTestUtilities.assert_status_code(response, status.HTTP_200_OK)
            data = response.json()
            assert set(data.keys()) == {"initialized", "setup_required", "message"}

            # Test setup-sql endpoint structure
            response = client.get("/api/database/setup-sql")
            HTTPTestUtilities.assert_status_code(response, status.HTTP_200_OK)
            data = response.json()
            assert set(data.keys()) == {"sql_content", "project_id", "sql_editor_url"}

            # Test verify-setup endpoint structure
            response = client.post("/api/database/verify-setup")
            HTTPTestUtilities.assert_status_code(response, status.HTTP_200_OK)
            data = response.json()
            # Check for core response fields plus new fields we added
            expected_keys = {"success", "message"}
            actual_keys = set(data.keys())

            # Core fields must be present
            assert expected_keys.issubset(actual_keys)

            # Additional fields are acceptable (correlation_id, verification_duration, etc.)
            allowed_additional_keys = {"correlation_id", "verification_duration", "remediation"}
            unexpected_keys = actual_keys - expected_keys - allowed_additional_keys
            assert len(unexpected_keys) == 0, f"Unexpected keys in response: {unexpected_keys}"


class TestDatabaseAPILoggingAndObservability:
    """Test logging and observability for database API endpoints"""

    def test_error_logging_coverage(self, client):
        """Test that errors are properly logged"""
        mock_service = MockCredentialServiceFactory.create_error_mock("connection_refused")

        with (
            patch("src.server.api_routes.database_api.credential_service", mock_service),
            patch("src.server.api_routes.database_api.logger") as mock_logger,
        ):
            response = client.get("/api/database/status")

            HTTPTestUtilities.assert_status_code(response, status.HTTP_500_INTERNAL_SERVER_ERROR)
            mock_logger.error.assert_called_once()

            logged_message = mock_logger.error.call_args[0][0]
            assert "Database status check failed with connection error" in logged_message

    def test_setup_sql_error_logging(self, client):
        """Test error logging for setup SQL endpoint"""
        with (
            patch("pathlib.Path.exists", return_value=True),
            patch("builtins.open", side_effect=PermissionError("Permission denied")),
            patch("src.server.api_routes.database_api.logger") as mock_logger,
        ):
            response = client.get("/api/database/setup-sql")

            HTTPTestUtilities.assert_status_code(response, status.HTTP_500_INTERNAL_SERVER_ERROR)
            assert mock_logger.error.call_count == 2

            # Check that both expected error messages are logged
            call_args = [call[0][0] for call in mock_logger.error.call_args_list]
            assert any("Failed to read setup SQL file" in msg for msg in call_args)
            assert any("Failed to get setup SQL" in msg for msg in call_args)

    def test_verification_error_logging(self, client):
        """Test error logging for verification endpoint"""
        mock_service = MockCredentialServiceFactory.create_error_mock("network_timeout")

        with (
            patch("src.server.api_routes.database_api.credential_service", mock_service),
            patch("src.server.api_routes.database_api.logger") as mock_logger,
        ):
            response = client.post("/api/database/verify-setup")

            HTTPTestUtilities.assert_status_code(response, status.HTTP_200_OK)
            mock_logger.error.assert_called_once()

            logged_message = mock_logger.error.call_args[0][0]
            assert "Database verification failed with connection error" in logged_message
