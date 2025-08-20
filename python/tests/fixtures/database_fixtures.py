"""
Test fixtures for database API functionality

Contains mock data, test utilities, and fixtures for comprehensive
testing of the database management API endpoints.
"""

import os
import tempfile
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, mock_open, patch

import pytest
from fastapi.testclient import TestClient

DB_STATUS_READY = {"initialized": True, "setup_required": False, "message": "Database is properly initialized"}

DB_STATUS_NEEDS_SETUP = {
    "initialized": False,
    "setup_required": True,
    "message": "Database tables are missing and need to be created",
}

DB_STATUS_CONNECTION_ERROR = {
    "error": "Database connection failed: Connection refused",
    "context": {
        "supabase_url_configured": True,
        "service_key_configured": True,
        "network_accessible": False,
        "error_type": "DatabaseConnectionError",
        "correlation_id": "test-correlation-id",
    },
    "remediation": "Check database connectivity",
}

DB_STATUS_CREDENTIAL_ERROR = {
    "error": "Database connection failed: Authentication failed",
    "context": {
        "supabase_url_configured": True,
        "service_key_configured": True,
        "error_type": "DatabaseConnectionError",
        "correlation_id": "test-correlation-id",
    },
    "remediation": "Verify database credentials",
}

DB_STATUS_TIMEOUT_ERROR = {
    "error": "Database connection failed: Network timeout",
    "context": {
        "supabase_url_configured": True,
        "service_key_configured": True,
        "network_accessible": False,
        "error_type": "DatabaseConnectionError",
        "correlation_id": "test-correlation-id",
    },
    "remediation": "Check network connectivity and server status",
}

DB_STATUS_PERMISSION_ERROR = {
    "error": "Database connection failed: Permission denied",
    "context": {
        "supabase_url_configured": True,
        "service_key_configured": True,
        "error_type": "DatabaseConnectionError",
        "correlation_id": "test-correlation-id",
    },
    "remediation": "Check database user permissions",
}

SAMPLE_SQL_CONTENT = """-- =====================================================
-- Archon Complete Database Setup
-- =====================================================
-- This script combines all migrations into a single file
-- for easy one-time database initialization

-- Enable required PostgreSQL extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Create the main settings table
CREATE TABLE IF NOT EXISTS archon_settings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    key VARCHAR(255) UNIQUE NOT NULL,
    value TEXT,
    encrypted_value TEXT,
    is_encrypted BOOLEAN DEFAULT FALSE,
    category VARCHAR(100),
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_archon_settings_key ON archon_settings(key);
CREATE INDEX IF NOT EXISTS idx_archon_settings_category ON archon_settings(category);

-- Create the sources table
CREATE TABLE IF NOT EXISTS archon_sources (
    source_id TEXT PRIMARY KEY,
    summary TEXT,
    total_word_count INTEGER DEFAULT 0,
    title TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Create the documentation chunks table
CREATE TABLE IF NOT EXISTS archon_crawled_pages (
    id BIGSERIAL PRIMARY KEY,
    url VARCHAR NOT NULL,
    chunk_number INTEGER NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_id TEXT NOT NULL,
    embedding VECTOR(1536),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(url, chunk_number),
    FOREIGN KEY (source_id) REFERENCES archon_sources(source_id)
);

-- Create the code_examples table
CREATE TABLE IF NOT EXISTS archon_code_examples (
    id BIGSERIAL PRIMARY KEY,
    url VARCHAR NOT NULL,
    chunk_number INTEGER NOT NULL,
    content TEXT NOT NULL,
    summary TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_id TEXT NOT NULL,
    embedding VECTOR(1536),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(url, chunk_number),
    FOREIGN KEY (source_id) REFERENCES archon_sources(source_id)
);

-- Enable Row Level Security (RLS) for all tables
ALTER TABLE archon_crawled_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_code_examples ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_settings ENABLE ROW LEVEL SECURITY;

-- Create policies that allow service role full access
CREATE POLICY "Allow service role full access to archon_settings" ON archon_settings
    FOR ALL USING (auth.role() = 'service_role');

-- Setup complete
"""

MINIMAL_SQL_CONTENT = """-- Minimal SQL setup
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS archon_settings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    key VARCHAR(255) UNIQUE NOT NULL
);
"""

EMPTY_SQL_CONTENT = ""

MALFORMED_SQL_CONTENT = """-- Malformed SQL with syntax errors
CREATE TABLE IF NOT EXISTS malformed_table (
    id UUUID DEFAULT gen_random_uuid() PRIMARY KEY, -- Invalid type
    key VARCHAR(255) UNIQUE NOT NULL,
    FOREIGN KEY (nonexistent_id) REFERENCES nonexistent_table(id) -- Invalid reference
);
"""

VERY_LONG_SQL_CONTENT = (
    """-- Very long SQL content for testing large payloads
"""
    + "\n".join([f"-- Comment line {i}" for i in range(1000)])
    + """
CREATE TABLE IF NOT EXISTS large_test_table (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY
);
"""
)

SQL_WITH_SPECIAL_CHARACTERS = """-- SQL with special characters and unicode
CREATE TABLE IF NOT EXISTS "test-table" (
    "column-name" TEXT,
    'single_quotes' VARCHAR(255),
    "unicode_∀∃∈∉" JSONB DEFAULT '{}'::jsonb,
    "emoji_🚀_column" TEXT,
    "percent%column" INTEGER,
    "at@symbol" VARCHAR(100),
    "hash#tag" TEXT
);
"""

SETUP_SQL_RESPONSE_COMPLETE = {
    "sql_content": SAMPLE_SQL_CONTENT,
    "project_id": "abc123def456",
    "sql_editor_url": "https://supabase.com/dashboard/project/abc123def456/sql/new",
}

SETUP_SQL_RESPONSE_MINIMAL = {
    "sql_content": MINIMAL_SQL_CONTENT,
    "project_id": "minimal123",
    "sql_editor_url": "https://supabase.com/dashboard/project/minimal123/sql/new",
}

SETUP_SQL_RESPONSE_NO_PROJECT_ID = {"sql_content": SAMPLE_SQL_CONTENT, "project_id": None, "sql_editor_url": None}

SETUP_SQL_RESPONSE_EMPTY_SQL = {
    "sql_content": EMPTY_SQL_CONTENT,
    "project_id": "empty123",
    "sql_editor_url": "https://supabase.com/dashboard/project/empty123/sql/new",
}

SETUP_SQL_RESPONSE_SPECIAL_CHARS = {
    "sql_content": SQL_WITH_SPECIAL_CHARACTERS,
    "project_id": "special-chars-123",
    "sql_editor_url": "https://supabase.com/dashboard/project/special-chars-123/sql/new",
}

SETUP_SQL_RESPONSE_LONG_CONTENT = {
    "sql_content": VERY_LONG_SQL_CONTENT,
    "project_id": "longproject123",
    "sql_editor_url": "https://supabase.com/dashboard/project/longproject123/sql/new",
}


VERIFY_SETUP_SUCCESS = {
    "success": True,
    "message": "Database setup verified successfully",
    "verification_duration": 0.1,
    "correlation_id": "test-correlation-id",
}

VERIFY_SETUP_FAILURE = {
    "success": False,
    "message": "Database tables still not found - please run the setup SQL",
    "correlation_id": "test-correlation-id",
    "remediation": "Execute the provided SQL in your Supabase SQL editor",
}

VERIFY_SETUP_NETWORK_ERROR = {
    "success": False,
    "message": "Database verification failed: Connection refused",
    "error_details": {
        "error_type": "DatabaseConnectionError",
    },
    "correlation_id": "test-correlation-id",
    "remediation": "Check database connectivity",
}

VERIFY_SETUP_PERMISSION_ERROR = {
    "success": False,
    "message": "Database verification failed: Permission denied",
    "error_details": {
        "error_type": "DatabaseConnectionError",
    },
    "correlation_id": "test-correlation-id",
    "remediation": "Check database user permissions",
}

VERIFY_SETUP_TIMEOUT_ERROR = {
    "success": False,
    "message": "Database verification failed: Network timeout",
    "error_details": {
        "error_type": "DatabaseConnectionError",
    },
    "correlation_id": "test-correlation-id",
    "remediation": "Check network connectivity",
}

VERIFY_SETUP_CREDENTIAL_ERROR = {
    "success": False,
    "message": "Database verification failed: Authentication failed",
    "error_details": {
        "error_type": "DatabaseConnectionError",
    },
    "correlation_id": "test-correlation-id",
    "remediation": "Verify database credentials",
}

VERIFY_SETUP_CONNECTION_ERROR = {
    "success": False,
    "message": "Database verification failed: Connection refused",
    "error_details": {
        "error_type": "DatabaseConnectionError",
    },
    "correlation_id": "test-correlation-id",
    "remediation": "Check database connectivity",
}


TEST_ENVIRONMENTS = {
    "with_supabase_url": {
        "SUPABASE_URL": "https://abc123def456.supabase.co",
        "SUPABASE_SERVICE_KEY": "test-service-key",
    },
    "without_supabase_url": {"SUPABASE_SERVICE_KEY": "test-service-key"},
    "invalid_supabase_url": {"SUPABASE_URL": "invalid-url-format", "SUPABASE_SERVICE_KEY": "test-service-key"},
    "malformed_supabase_url": {
        "SUPABASE_URL": "https://malformed.url.com/not/supabase",
        "SUPABASE_SERVICE_KEY": "test-service-key",
    },
    "localhost_supabase_url": {"SUPABASE_URL": "http://localhost:54321", "SUPABASE_SERVICE_KEY": "test-service-key"},
    "missing_credentials": {},
    "unicode_project_id": {
        "SUPABASE_URL": "https://测试项目🚀.supabase.co",
        "SUPABASE_SERVICE_KEY": "test-service-key",
    },
    "very_long_project_id": {
        "SUPABASE_URL": f"https://{'a' * 100}.supabase.co",
        "SUPABASE_SERVICE_KEY": "test-service-key",
    },
}


def get_database_error_scenarios():
    """Get database error scenarios using the new structured exceptions."""
    from src.server.services.database_exceptions import (
        DatabaseConnectionError,
        DatabaseConfigurationError,
        DatabaseNotInitializedException,
        gather_diagnostic_context,
    )

    # Use realistic diagnostic context for tests
    test_context = gather_diagnostic_context()
    test_context.update(
        {
            "test_mode": True,
            "correlation_id": "test-correlation-id",
        }
    )

    return {
        "connection_refused": DatabaseConnectionError(
            "Connection refused", context=test_context, remediation="Check database connectivity"
        ),
        "authentication_failed": DatabaseConnectionError(
            "Authentication failed", context=test_context, remediation="Verify database credentials"
        ),
        "permission_denied": DatabaseConnectionError(
            "Permission denied", context=test_context, remediation="Check database user permissions"
        ),
        "network_timeout": DatabaseConnectionError(
            "Network timeout", context=test_context, remediation="Check network connectivity"
        ),
        "invalid_credentials": DatabaseConnectionError(
            "Invalid credentials", context=test_context, remediation="Verify SUPABASE_SERVICE_KEY"
        ),
        "database_not_found": DatabaseConnectionError(
            "Database not found", context=test_context, remediation="Verify SUPABASE_URL"
        ),
        "ssl_certificate_error": DatabaseConnectionError(
            "SSL certificate verification failed", context=test_context, remediation="Check SSL configuration"
        ),
        "host_unreachable": DatabaseConnectionError(
            "Host unreachable", context=test_context, remediation="Check network connectivity"
        ),
        "service_unavailable": DatabaseConnectionError(
            "Service temporarily unavailable", context=test_context, remediation="Retry after delay"
        ),
        "rate_limit_exceeded": DatabaseConnectionError(
            "Rate limit exceeded", context=test_context, remediation="Wait before retrying"
        ),
        "malformed_response": DatabaseConnectionError(
            "Malformed response from server", context=test_context, remediation="Check server status"
        ),
        "unexpected_error": DatabaseConnectionError(
            "An unexpected error occurred", context=test_context, remediation="Check server logs"
        ),
    }


# For backwards compatibility, create the scenarios at module level
DATABASE_ERROR_SCENARIOS = get_database_error_scenarios()

FILE_SYSTEM_ERROR_SCENARIOS = {
    "file_not_found": FileNotFoundError("SQL file not found"),
    "permission_denied": PermissionError("Permission denied reading SQL file"),
    "io_error": OSError("I/O error reading SQL file"),
    "unicode_decode_error": UnicodeDecodeError("utf-8", b"", 0, 1, "invalid start byte"),
    "disk_full": OSError("No space left on device"),
    "file_too_large": OSError("File too large"),
}

REGEX_ERROR_SCENARIOS = {
    "invalid_pattern": Exception("Invalid regex pattern"),
    "malformed_url": Exception("Malformed URL cannot be parsed"),
    "unicode_error": Exception("Unicode error in regex matching"),
}


EDGE_CASE_RESPONSES = {
    "null_values": {"sql_content": None, "project_id": None, "sql_editor_url": None},
    "empty_strings": {"sql_content": "", "project_id": "", "sql_editor_url": ""},
    "whitespace_only": {
        "sql_content": "   \n\t   \n   ",
        "project_id": "   project123   ",
        "sql_editor_url": "   https://example.com   ",
    },
    "sql_injection_attempt": {
        "sql_content": "'; DROP TABLE users; --",
        "project_id": "safe-project-123",
        "sql_editor_url": "https://supabase.com/dashboard/project/safe-project-123/sql/new",
    },
    "binary_content": {
        "sql_content": "\x00\x01\x02\x03\x04\x05",
        "project_id": "binary123",
        "sql_editor_url": "https://supabase.com/dashboard/project/binary123/sql/new",
    },
    "very_long_strings": {
        "sql_content": "-- " + "A" * 10000,
        "project_id": "B" * 1000,
        "sql_editor_url": "https://supabase.com/dashboard/project/" + "C" * 1000 + "/sql/new",
    },
}


@pytest.fixture
def mock_credential_service():
    """Mock credential service for database API tests."""
    with patch("src.server.api_routes.database_api.credential_service") as mock:
        mock.load_all_credentials = AsyncMock()
        mock._cache_initialized = False
        mock._cache = {}
        yield mock


@pytest.fixture
def mock_file_system():
    """Mock file system operations for SQL file reading."""
    with (
        patch("pathlib.Path.exists") as mock_exists,
        patch("builtins.open", mock_open(read_data=SAMPLE_SQL_CONTENT)) as mock_file,
    ):
        mock_exists.return_value = True
        yield {"exists": mock_exists, "open": mock_file}


@pytest.fixture
def mock_file_system_missing():
    """Mock file system with missing SQL file."""
    with patch("pathlib.Path.exists") as mock_exists:
        mock_exists.return_value = False
        yield mock_exists


@pytest.fixture
def mock_environment(request):
    """Mock environment variables with different configurations."""
    env_config = getattr(request, "param", TEST_ENVIRONMENTS["with_supabase_url"])

    with patch.dict(os.environ, env_config, clear=True):
        yield env_config


@pytest.fixture
def mock_regex_operations():
    """Mock regex operations for URL parsing."""
    with patch("re.search") as mock_search:
        mock_match = MagicMock()
        mock_match.group.return_value = "abc123def456"
        mock_search.return_value = mock_match
        yield mock_search


@pytest.fixture
def mock_logger():
    """Mock logger for testing log outputs."""
    with patch("src.server.api_routes.database_api.logger") as mock:
        yield mock


@pytest.fixture
def mock_database_initialized_update():
    """Mock the global database initialization flag update."""
    with patch("src.server.api_routes.database_api.update_database_initialized") as mock:
        yield mock


def create_mock_credential_service_with_error(error_type: str):
    """Factory function to create credential service mocks with specific errors."""
    mock = AsyncMock()

    if error_type == "database_not_initialized":
        from src.server.services.credential_service import DatabaseNotInitializedException

        mock.load_all_credentials.side_effect = DatabaseNotInitializedException("Tables not found")
    elif error_type in DATABASE_ERROR_SCENARIOS:
        mock.load_all_credentials.side_effect = DATABASE_ERROR_SCENARIOS[error_type]
    else:
        mock.load_all_credentials.side_effect = Exception(f"Unknown error: {error_type}")

    return mock


def create_mock_file_system_with_error(error_type: str):
    """Factory function to create file system mocks with specific errors."""
    mocks = {}

    with patch("pathlib.Path.exists") as mock_exists:
        if error_type == "file_not_found":
            mock_exists.return_value = False
        else:
            mock_exists.return_value = True
        mocks["exists"] = mock_exists

    if error_type != "file_not_found" and error_type in FILE_SYSTEM_ERROR_SCENARIOS:
        with patch("builtins.open") as mock_open_file:
            mock_open_file.side_effect = FILE_SYSTEM_ERROR_SCENARIOS[error_type]
            mocks["open"] = mock_open_file

    return mocks


def create_temporary_sql_file(content: str) -> Path:
    """Creates a temporary SQL file for testing file-based operations."""
    temp_file = tempfile.NamedTemporaryFile(mode="w", suffix=".sql", delete=False)
    temp_file.write(content)
    temp_file.close()
    return Path(temp_file.name)


def assert_database_status_response(response_data: dict[str, Any], expected: dict[str, Any]):
    """Assert that a database status response matches expected values."""
    assert response_data["initialized"] == expected["initialized"]
    assert response_data["setup_required"] == expected["setup_required"]
    assert response_data["message"] == expected["message"]


def assert_setup_sql_response(response_data: dict[str, Any], expected: dict[str, Any]):
    """Assert that a setup SQL response matches expected values."""
    assert response_data["sql_content"] == expected["sql_content"]
    assert response_data["project_id"] == expected["project_id"]
    assert response_data["sql_editor_url"] == expected["sql_editor_url"]


def assert_verify_setup_response(response_data: dict[str, Any], expected: dict[str, Any]):
    """Assert that a verification response matches expected values."""
    assert response_data["success"] == expected["success"]
    assert response_data["message"] == expected["message"]


def create_test_client_with_mocks(**mock_overrides) -> TestClient:
    """Create a test client with specific mock configurations."""
    raise NotImplementedError("This function needs to be implemented")


DATABASE_STATUS_SCENARIOS = [
    ("ready", DB_STATUS_READY, "database_initialized"),
    ("needs_setup", DB_STATUS_NEEDS_SETUP, "database_not_initialized"),
    ("connection_error", DB_STATUS_CONNECTION_ERROR, "connection_refused"),
    ("credential_error", DB_STATUS_CREDENTIAL_ERROR, "authentication_failed"),
    ("timeout_error", DB_STATUS_TIMEOUT_ERROR, "network_timeout"),
    ("permission_error", DB_STATUS_PERMISSION_ERROR, "permission_denied"),
]

ENVIRONMENT_SCENARIOS = [
    ("with_supabase_url", TEST_ENVIRONMENTS["with_supabase_url"], "abc123def456"),
    ("without_supabase_url", TEST_ENVIRONMENTS["without_supabase_url"], None),
    ("invalid_supabase_url", TEST_ENVIRONMENTS["invalid_supabase_url"], None),
    ("malformed_supabase_url", TEST_ENVIRONMENTS["malformed_supabase_url"], None),
]

SQL_CONTENT_SCENARIOS = [
    ("complete", SAMPLE_SQL_CONTENT, "Complete SQL setup"),
    ("minimal", MINIMAL_SQL_CONTENT, "Minimal SQL setup"),
    ("empty", EMPTY_SQL_CONTENT, "Empty SQL content"),
    ("special_chars", SQL_WITH_SPECIAL_CHARACTERS, "SQL with special characters"),
    ("very_long", VERY_LONG_SQL_CONTENT, "Very long SQL content"),
    ("malformed", MALFORMED_SQL_CONTENT, "Malformed SQL content"),
]

FILE_SYSTEM_SCENARIOS = [
    ("file_exists", True, SAMPLE_SQL_CONTENT, None),
    ("file_missing", False, None, "file_not_found"),
    ("permission_denied", True, None, "permission_denied"),
    ("io_error", True, None, "io_error"),
    ("unicode_error", True, None, "unicode_decode_error"),
    ("disk_full", True, None, "disk_full"),
]

VERIFICATION_SCENARIOS = [
    ("success", VERIFY_SETUP_SUCCESS, "database_initialized"),
    ("failure", VERIFY_SETUP_FAILURE, "database_not_initialized"),
    ("network_error", VERIFY_SETUP_NETWORK_ERROR, "connection_refused"),
    ("permission_error", VERIFY_SETUP_PERMISSION_ERROR, "permission_denied"),
    ("timeout_error", VERIFY_SETUP_TIMEOUT_ERROR, "network_timeout"),
    ("credential_error", VERIFY_SETUP_CREDENTIAL_ERROR, "authentication_failed"),
]


INTEGRATION_TEST_SCENARIOS = {
    "complete_setup_flow": {
        "initial_status": DB_STATUS_NEEDS_SETUP,
        "setup_sql": SETUP_SQL_RESPONSE_COMPLETE,
        "verification_attempts": [VERIFY_SETUP_FAILURE, VERIFY_SETUP_FAILURE, VERIFY_SETUP_SUCCESS],
        "final_status": DB_STATUS_READY,
    },
    "immediate_success": {
        "initial_status": DB_STATUS_NEEDS_SETUP,
        "setup_sql": SETUP_SQL_RESPONSE_COMPLETE,
        "verification_attempts": [VERIFY_SETUP_SUCCESS],
        "final_status": DB_STATUS_READY,
    },
    "persistent_failure": {
        "initial_status": DB_STATUS_NEEDS_SETUP,
        "setup_sql": SETUP_SQL_RESPONSE_COMPLETE,
        "verification_attempts": [
            VERIFY_SETUP_FAILURE,
            VERIFY_SETUP_FAILURE,
            VERIFY_SETUP_FAILURE,
            VERIFY_SETUP_FAILURE,
            VERIFY_SETUP_FAILURE,
        ],
        "final_status": DB_STATUS_NEEDS_SETUP,
    },
    "network_recovery": {
        "initial_status": DB_STATUS_NEEDS_SETUP,
        "setup_sql": SETUP_SQL_RESPONSE_COMPLETE,
        "verification_attempts": [
            VERIFY_SETUP_NETWORK_ERROR,
            VERIFY_SETUP_NETWORK_ERROR,
            VERIFY_SETUP_FAILURE,
            VERIFY_SETUP_SUCCESS,
        ],
        "final_status": DB_STATUS_READY,
    },
}
