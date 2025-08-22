"""
Test utilities for database API functionality

Provides test helpers, mock factories, and assertion utilities
for comprehensive testing of database management API endpoints.
"""

import asyncio
import os
import tempfile
from collections.abc import Generator
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest
from fastapi import status
from fastapi.testclient import TestClient

from tests.fixtures.database_fixtures import (
    DATABASE_ERROR_SCENARIOS,
    FILE_SYSTEM_ERROR_SCENARIOS,
    TEST_ENVIRONMENTS,
)


class MockCredentialServiceFactory:
    """Factory for creating credential service mocks with different behaviors."""

    @staticmethod
    def create_successful_mock():
        """Create a credential service mock that successfully loads credentials."""
        mock = AsyncMock()
        mock.load_all_credentials = AsyncMock(return_value=None)
        mock._cache_initialized = True
        mock._cache = {"test": "credentials"}
        mock.database_tables_exist.return_value = True
        mock.is_supabase_configured.return_value = True
        return mock

    @staticmethod
    def create_not_initialized_mock():
        """Create a credential service mock that raises DatabaseNotInitializedException."""
        from src.server.services.database_exceptions import DatabaseNotInitializedException

        mock = AsyncMock()
        mock.load_all_credentials = AsyncMock(
            side_effect=DatabaseNotInitializedException(
                "Database tables not found - setup required", correlation_id="test-correlation-id"
            )
        )
        mock._cache_initialized = False
        mock._cache = {}
        mock.database_tables_exist.return_value = False
        mock.is_supabase_configured.return_value = True

        # Add new cache management methods
        mock.reset_cache = Mock()
        mock.force_database_reload = Mock()
        mock.get_cache_status = Mock(
            return_value={
                "cache_initialized": False,
                "cache_size": 0,
                "database_tables_exist": False,
                "supabase_client_initialized": True,
            }
        )

        return mock

    @staticmethod
    def create_error_mock(error_type: str):
        """Create a credential service mock that raises specific errors."""
        mock = AsyncMock()

        if error_type in DATABASE_ERROR_SCENARIOS:
            mock.load_all_credentials = AsyncMock(side_effect=DATABASE_ERROR_SCENARIOS[error_type])
        else:
            mock.load_all_credentials = AsyncMock(side_effect=Exception(f"Unknown error: {error_type}"))

        mock._cache_initialized = False
        mock._cache = {}
        mock.database_tables_exist.return_value = False
        mock.is_supabase_configured.return_value = True
        return mock

    @staticmethod
    def create_intermittent_mock(success_after: int = 3):
        """Create a credential service mock that fails initially then succeeds."""
        mock = AsyncMock()
        call_count = 0

        async def side_effect():
            nonlocal call_count
            call_count += 1
            if call_count <= success_after:
                from src.server.services.database_exceptions import DatabaseNotInitializedException

                raise DatabaseNotInitializedException(
                    "Tables not found", correlation_id=f"test-correlation-{call_count}"
                )
            return {}

        def database_tables_exist():
            return call_count > success_after

        mock.load_all_credentials = AsyncMock(side_effect=side_effect)
        mock._cache_initialized = False
        mock._cache = {}
        mock.database_tables_exist.side_effect = database_tables_exist
        mock.is_supabase_configured.return_value = True
        return mock

    @staticmethod
    def create_unconfigured_mock():
        """Create a credential service mock for when Supabase is not configured."""
        mock = AsyncMock()
        mock.load_all_credentials = AsyncMock(return_value={})
        mock._cache_initialized = True
        mock._cache = {}
        mock.database_tables_exist.return_value = False
        mock.is_supabase_configured.return_value = False
        return mock


class MockFileSystemFactory:
    """Factory for creating file system mocks with different behaviors."""

    @staticmethod
    def create_existing_file_mock(content: str = "-- Test SQL Content"):
        """Create a file system mock where the SQL file exists."""
        with (
            patch("pathlib.Path.exists", return_value=True) as mock_exists,
            patch("builtins.open", MagicMock()) as mock_open,
        ):
            mock_file = MagicMock()
            mock_file.read.return_value = content
            mock_file.__enter__.return_value = mock_file
            mock_file.__exit__.return_value = None
            mock_open.return_value = mock_file

            return {"exists": mock_exists, "open": mock_open, "file": mock_file}

    @staticmethod
    def create_missing_file_mock():
        """Create a file system mock where the SQL file doesn't exist."""
        with patch("pathlib.Path.exists", return_value=False) as mock_exists:
            return {"exists": mock_exists}

    @staticmethod
    def create_file_error_mock(error_type: str):
        """Create a file system mock that raises specific file errors."""
        with patch("pathlib.Path.exists", return_value=True) as mock_exists, patch("builtins.open") as mock_open:
            if error_type in FILE_SYSTEM_ERROR_SCENARIOS:
                mock_open.side_effect = FILE_SYSTEM_ERROR_SCENARIOS[error_type]
            else:
                mock_open.side_effect = Exception(f"Unknown file error: {error_type}")

            return {"exists": mock_exists, "open": mock_open}


class MockEnvironmentFactory:
    """Factory for creating environment variable mocks."""

    @staticmethod
    @contextmanager
    def create_environment(config_name: str) -> Generator[dict[str, str], None, None]:
        """Create a mock environment with specific configuration."""
        if config_name in TEST_ENVIRONMENTS:
            config = TEST_ENVIRONMENTS[config_name]
            with patch.dict(os.environ, config, clear=True):
                yield config
        else:
            raise ValueError(f"Unknown environment config: {config_name}")

    @staticmethod
    @contextmanager
    def create_custom_environment(env_vars: dict[str, str]) -> Generator[dict[str, str], None, None]:
        """Create a mock environment with custom variables."""
        with patch.dict(os.environ, env_vars, clear=True):
            yield env_vars


class HTTPTestUtilities:
    """Utilities for testing HTTP endpoints and responses."""

    @staticmethod
    def assert_status_code(response, expected_status: int):
        """Assert that response has expected status code."""
        assert response.status_code == expected_status, (
            f"Expected status {expected_status}, got {response.status_code}. Response: {response.text}"
        )

    @staticmethod
    def assert_json_response(response, expected_data: dict[str, Any]):
        """Assert that response JSON matches expected data."""
        HTTPTestUtilities.assert_status_code(response, status.HTTP_200_OK)
        response_data = response.json()

        for key, expected_value in expected_data.items():
            assert key in response_data, f"Missing key '{key}' in response"
            assert response_data[key] == expected_value, f"Expected {key}={expected_value}, got {response_data[key]}"

    @staticmethod
    def assert_error_response(response, expected_status: int, expected_detail: str | None = None):
        """Assert that response is an error with expected status and detail."""
        HTTPTestUtilities.assert_status_code(response, expected_status)

        if expected_detail:
            response_data = response.json()
            assert "detail" in response_data
            assert expected_detail in response_data["detail"]

    @staticmethod
    def assert_database_status_response(response, initialized: bool, setup_required: bool):
        """Assert that database status response has expected values."""
        HTTPTestUtilities.assert_status_code(response, status.HTTP_200_OK)
        data = response.json()

        assert data["initialized"] == initialized
        assert data["setup_required"] == setup_required
        assert "message" in data
        assert isinstance(data["message"], str)

    @staticmethod
    def assert_setup_sql_response(response, has_project_id: bool = True, has_sql_editor_url: bool = True):
        """Assert that setup SQL response has expected structure."""
        HTTPTestUtilities.assert_status_code(response, status.HTTP_200_OK)
        data = response.json()

        assert "sql_content" in data
        assert isinstance(data["sql_content"], str)
        assert len(data["sql_content"]) > 0

        if has_project_id:
            assert "project_id" in data
            assert data["project_id"] is not None

        if has_sql_editor_url:
            assert "sql_editor_url" in data
            assert data["sql_editor_url"] is not None
            assert "supabase.com/dashboard/project" in data["sql_editor_url"]

    @staticmethod
    def assert_verify_setup_response(response, success: bool):
        """Assert that verification response has expected success value."""
        HTTPTestUtilities.assert_status_code(response, status.HTTP_200_OK)
        data = response.json()

        assert "success" in data
        assert data["success"] == success
        assert "message" in data
        assert isinstance(data["message"], str)


class AsyncTestUtilities:
    """Utilities for testing asynchronous operations."""

    @staticmethod
    async def run_with_timeout(coro, timeout: float = 5.0):
        """Run a coroutine with a timeout."""
        try:
            return await asyncio.wait_for(coro, timeout=timeout)
        except TimeoutError:
            pytest.fail(f"Operation timed out after {timeout} seconds")

    @staticmethod
    @asynccontextmanager
    async def mock_async_context():
        """Create an async context for testing."""
        try:
            yield
        finally:
            pass

    @staticmethod
    def create_async_mock_with_delay(return_value: Any = None, delay: float = 0.1):
        """Create an async mock that returns after a delay."""

        async def delayed_return():
            await asyncio.sleep(delay)
            return return_value

        return AsyncMock(side_effect=delayed_return)

    @staticmethod
    def create_async_mock_with_retries(responses: list[Any], exceptions: list[Exception] | None = None):
        """Create an async mock that returns different responses on successive calls."""
        call_count = 0

        async def successive_returns():
            nonlocal call_count
            call_count += 1

            if exceptions and call_count <= len(exceptions):
                raise exceptions[call_count - 1]

            if call_count <= len(responses):
                return responses[call_count - 1]

            return responses[-1] if responses else None

        return AsyncMock(side_effect=successive_returns)


class FileSystemTestUtilities:
    """Utilities for testing file system operations."""

    @staticmethod
    def create_temporary_sql_file(content: str, suffix: str = ".sql") -> Path:
        """Create a temporary SQL file with given content."""
        temp_file = tempfile.NamedTemporaryFile(mode="w", suffix=suffix, delete=False)
        temp_file.write(content)
        temp_file.close()
        return Path(temp_file.name)

    @staticmethod
    @contextmanager
    def temporary_sql_file(content: str) -> Generator[Path, None, None]:
        """Context manager for a temporary SQL file."""
        temp_path = None
        try:
            temp_path = FileSystemTestUtilities.create_temporary_sql_file(content)
            yield temp_path
        finally:
            if temp_path and temp_path.exists():
                temp_path.unlink()

    @staticmethod
    def create_mock_sql_file_path(exists: bool = True, content: str = "-- Test SQL") -> MagicMock:
        """Create a mock Path object for SQL file testing."""
        mock_path = MagicMock(spec=Path)
        mock_path.exists.return_value = exists

        if exists:
            mock_file = MagicMock()
            mock_file.read.return_value = content
            mock_file.__enter__.return_value = mock_file
            mock_file.__exit__.return_value = None
            mock_path.open.return_value = mock_file

        return mock_path


class EnvironmentTestUtilities:
    """Utilities for testing environment-dependent functionality."""

    @staticmethod
    def extract_project_id_from_url(url: str) -> str | None:
        """Extract project ID from Supabase URL (for testing regex logic)."""
        import re

        match = re.search(r"https://([^.]+)\.supabase\.co", url)
        return match.group(1) if match else None

    @staticmethod
    def generate_sql_editor_url(project_id: str) -> str:
        """Generate SQL editor URL (for testing URL generation logic)."""
        return f"https://supabase.com/dashboard/project/{project_id}/sql/new"

    @staticmethod
    @contextmanager
    def mock_supabase_url(url: str) -> Generator[str, None, None]:
        """Context manager for mocking SUPABASE_URL environment variable."""
        with patch.dict(os.environ, {"SUPABASE_URL": url}):
            yield url

    @staticmethod
    @contextmanager
    def clear_environment() -> Generator[None, None, None]:
        """Context manager for clearing all environment variables."""
        with patch.dict(os.environ, {}, clear=True):
            yield


class DatabaseIntegrationTestUtilities:
    """Utilities for testing database integration scenarios."""

    @staticmethod
    def create_integration_test_scenario(
        initial_status: str, verification_sequence: list[str], expected_final_status: str
    ) -> dict[str, Any]:
        """Create a complete integration test scenario."""
        return {
            "initial_status": initial_status,
            "verification_sequence": verification_sequence,
            "expected_final_status": expected_final_status,
        }

    @staticmethod
    async def simulate_database_setup_flow(client: TestClient, scenario: dict[str, Any]) -> list[dict[str, Any]]:
        """Simulate a complete database setup flow."""
        responses = []

        status_response = client.get("/api/database/status")
        responses.append({"step": "initial_status", "response": status_response})

        if status_response.json().get("setup_required"):
            sql_response = client.get("/api/database/setup-sql")
            responses.append({"step": "get_setup_sql", "response": sql_response})

        for i, _expected_result in enumerate(scenario["verification_sequence"]):
            verify_response = client.post("/api/database/verify-setup")
            responses.append({"step": f"verify_attempt_{i + 1}", "response": verify_response})

            if verify_response.json().get("success"):
                break

        final_status_response = client.get("/api/database/status")
        responses.append({"step": "final_status", "response": final_status_response})

        return responses


class ErrorTestUtilities:
    """Utilities for testing error scenarios and edge cases."""

    @staticmethod
    def create_mock_that_raises(exception: Exception):
        """Create a mock that raises a specific exception."""
        mock = MagicMock()
        mock.side_effect = exception
        return mock

    @staticmethod
    def create_async_mock_that_raises(exception: Exception):
        """Create an async mock that raises a specific exception."""

        async def raise_exception():
            raise exception

        return AsyncMock(side_effect=raise_exception)

    @staticmethod
    def assert_exception_logged(mock_logger, expected_message: str):
        """Assert that an exception was logged with expected message."""
        mock_logger.error.assert_called()
        logged_message = mock_logger.error.call_args[0][0]
        assert expected_message in logged_message

    @staticmethod
    def simulate_network_errors(client: TestClient, endpoint: str, method: str = "GET"):
        """Simulate various network errors for an endpoint."""
        error_scenarios = [
            ("connection_error", Exception("Connection refused")),
            ("timeout_error", Exception("Request timeout")),
            ("dns_error", Exception("Name resolution failed")),
            ("ssl_error", Exception("SSL certificate verification failed")),
        ]

        results = {}
        for error_name, error in error_scenarios:
            with patch("requests.request", side_effect=error):
                try:
                    if method.upper() == "GET":
                        response = client.get(endpoint)
                    elif method.upper() == "POST":
                        response = client.post(endpoint)
                    else:
                        raise ValueError(f"Unsupported method: {method}")

                    results[error_name] = response
                except Exception:
                    results[error_name] = response

        return results


class PerformanceTestUtilities:
    """Utilities for testing performance and load scenarios."""

    @staticmethod
    def measure_endpoint_performance(client: TestClient, endpoint: str, iterations: int = 10):
        """Measure the performance of an endpoint over multiple calls."""
        import time

        times = []
        for _ in range(iterations):
            start_time = time.time()
            response = client.get(endpoint)
            end_time = time.time()

            times.append(
                {
                    "duration": end_time - start_time,
                    "status_code": response.status_code,
                    "response_size": len(response.content),
                }
            )

        return {
            "times": times,
            "average_duration": sum(t["duration"] for t in times) / len(times),
            "min_duration": min(t["duration"] for t in times),
            "max_duration": max(t["duration"] for t in times),
        }

    @staticmethod
    async def simulate_concurrent_requests(client: TestClient, endpoint: str, concurrency: int = 5):
        """Simulate concurrent requests to test race conditions."""

        async def make_request():
            return client.get(endpoint)

        tasks = [make_request() for _ in range(concurrency)]
        responses = await asyncio.gather(*tasks, return_exceptions=True)

        return {
            "responses": responses,
            "success_count": sum(1 for r in responses if not isinstance(r, Exception)),
            "error_count": sum(1 for r in responses if isinstance(r, Exception)),
        }


class ValidationTestUtilities:
    """Utilities for testing input validation and data sanitization."""

    @staticmethod
    def create_malicious_sql_inputs() -> list[str]:
        """Create a list of potentially malicious SQL inputs."""
        return [
            "'; DROP TABLE users; --",
            "' OR '1'='1",
            "'; INSERT INTO admin (username) VALUES ('hacker'); --",
            "' UNION SELECT * FROM sensitive_data; --",
            "\x00\x01\x02\x03",  # Binary data
            "A" * 10000,  # Very long string
            "'; EXEC xp_cmdshell('format c:'); --",  # Command injection attempt
            "<script>alert('xss')</script>",  # XSS attempt
            "../../etc/passwd",  # Path traversal attempt
        ]

    @staticmethod
    def test_sql_content_validation(client: TestClient, malicious_inputs: list[str]):
        """Test that SQL content is properly validated and sanitized."""
        results = {}

        for i, malicious_input in enumerate(malicious_inputs):
            with patch("builtins.open", MagicMock()) as mock_open:
                mock_file = MagicMock()
                mock_file.read.return_value = malicious_input
                mock_file.__enter__.return_value = mock_file
                mock_file.__exit__.return_value = None
                mock_open.return_value = mock_file

                response = client.get("/api/database/setup-sql")
                results[f"input_{i}"] = {
                    "input": malicious_input,
                    "response": response,
                    "sql_content": response.json().get("sql_content") if response.status_code == 200 else None,
                }

        return results

    @staticmethod
    def validate_url_generation(project_ids: list[str]) -> dict[str, dict[str, Any]]:
        """Validate URL generation with various project ID inputs."""
        results = {}

        for project_id in project_ids:
            try:
                url = EnvironmentTestUtilities.generate_sql_editor_url(project_id)
                results[project_id] = {
                    "success": True,
                    "url": url,
                    "is_valid_url": url.startswith("https://") and "supabase.com" in url,
                }
            except Exception as e:
                results[project_id] = {"success": False, "error": str(e), "url": None}

        return results


class LoggingTestUtilities:
    """Utilities for testing logging functionality."""

    @staticmethod
    def assert_log_contains(mock_logger, level: str, expected_message: str):
        """Assert that a log message was recorded at the specified level."""
        log_method = getattr(mock_logger, level.lower())
        log_method.assert_called()

        logged_messages = [call[0][0] for call in log_method.call_args_list]
        assert any(expected_message in msg for msg in logged_messages), (
            f"Expected log message '{expected_message}' not found in {logged_messages}"
        )

    @staticmethod
    def count_log_calls(mock_logger, level: str) -> int:
        """Count the number of log calls at a specific level."""
        log_method = getattr(mock_logger, level.lower())
        return int(log_method.call_count)

    @staticmethod
    def get_all_log_messages(mock_logger, level: str) -> list[str]:
        """Get all log messages at a specific level."""
        log_method = getattr(mock_logger, level.lower())
        return [call[0][0] for call in log_method.call_args_list]


class ComprehensiveTestRunner:
    """Utilities for running comprehensive test suites."""

    @staticmethod
    async def run_full_database_api_test_suite(client: TestClient) -> dict[str, Any]:
        """Run a comprehensive test suite for all database API endpoints."""
        results: dict[str, Any] = {
            "status_endpoint": {},
            "setup_sql_endpoint": {},
            "verify_setup_endpoint": {},
            "integration_tests": {},
            "error_scenarios": {},
            "performance_tests": {},
        }

        results["status_endpoint"]["normal"] = client.get("/api/database/status")

        results["setup_sql_endpoint"]["normal"] = client.get("/api/database/setup-sql")

        results["verify_setup_endpoint"]["normal"] = client.post("/api/database/verify-setup")

        error_utils = ErrorTestUtilities()
        results["error_scenarios"] = error_utils.simulate_network_errors(client, "/api/database/status")

        perf_utils = PerformanceTestUtilities()
        results["performance_tests"]["status"] = perf_utils.measure_endpoint_performance(client, "/api/database/status")

        return results
