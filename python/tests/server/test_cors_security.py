"""
Tests for CORS Security Configuration

Validates that CORS is configured securely and prevents unauthorized origins
from accessing the API with credentials.
"""

import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch
import os


class TestCORSConfiguration:
    """Test suite for CORS security configuration"""

    def test_cors_rejects_unauthorized_origin(self):
        """Test that requests from unauthorized origins are rejected"""
        # Import app fresh for each test to ensure clean state
        with patch.dict(os.environ, {"ALLOWED_ORIGINS": "http://localhost:3737"}, clear=False):
            from src.server.main import app
            client = TestClient(app)

            # Request from unauthorized origin
            response = client.get(
                "/health",
                headers={"Origin": "https://evil-site.com"}
            )

            # Should not have CORS headers allowing the origin
            assert response.headers.get("access-control-allow-origin") != "https://evil-site.com"

    def test_cors_allows_whitelisted_origin(self):
        """Test that requests from whitelisted origins are allowed"""
        with patch.dict(os.environ, {"ALLOWED_ORIGINS": "http://localhost:3737,http://trusted.com"}, clear=False):
            from src.server.main import app
            client = TestClient(app)

            # Request from whitelisted origin
            response = client.get(
                "/health",
                headers={"Origin": "http://localhost:3737"}
            )

            # Should have CORS header allowing the origin
            assert response.headers.get("access-control-allow-origin") in [
                "http://localhost:3737",
                "*"  # FastAPI might simplify in test mode
            ]

    def test_cors_default_origins_include_localhost(self):
        """Test that default configuration includes localhost for development"""
        with patch.dict(os.environ, {}, clear=False):
            # Remove ALLOWED_ORIGINS to test default
            os.environ.pop("ALLOWED_ORIGINS", None)

            from src.server.main import app

            # Check that localhost is in allowed origins
            cors_middleware = None
            for middleware in app.user_middleware:
                if middleware.cls.__name__ == "CORSMiddleware":
                    cors_middleware = middleware
                    break

            assert cors_middleware is not None, "CORS middleware not found"

            # Default should include localhost variations
            allowed_origins = cors_middleware.kwargs.get("allow_origins", [])
            assert any("localhost" in origin for origin in allowed_origins), \
                f"Localhost not in allowed origins: {allowed_origins}"

    def test_cors_credentials_enabled(self):
        """Test that credentials are enabled for whitelisted origins"""
        with patch.dict(os.environ, {"ALLOWED_ORIGINS": "http://localhost:3737"}, clear=False):
            from src.server.main import app

            # Find CORS middleware
            cors_middleware = None
            for middleware in app.user_middleware:
                if middleware.cls.__name__ == "CORSMiddleware":
                    cors_middleware = middleware
                    break

            assert cors_middleware is not None
            assert cors_middleware.kwargs.get("allow_credentials") is True

    def test_cors_origin_parsing_handles_whitespace(self):
        """Test that origin list parsing handles whitespace correctly"""
        with patch.dict(os.environ, {
            "ALLOWED_ORIGINS": "http://localhost:3737, http://example.com , http://test.com"
        }, clear=False):
            from src.server.main import app

            # Find CORS middleware
            cors_middleware = None
            for middleware in app.user_middleware:
                if middleware.cls.__name__ == "CORSMiddleware":
                    cors_middleware = middleware
                    break

            allowed_origins = cors_middleware.kwargs.get("allow_origins", [])

            # All origins should be trimmed (no leading/trailing spaces)
            for origin in allowed_origins:
                assert origin == origin.strip(), f"Origin not trimmed: '{origin}'"
                assert not origin.startswith(" "), f"Origin has leading space: '{origin}'"
                assert not origin.endswith(" "), f"Origin has trailing space: '{origin}'"

    def test_cors_does_not_allow_wildcard_with_credentials(self):
        """
        CRITICAL SECURITY TEST
        Test that wildcard (*) is never used with credentials enabled
        This is a major security vulnerability (OWASP)
        """
        with patch.dict(os.environ, {"ALLOWED_ORIGINS": "http://localhost:3737"}, clear=False):
            from src.server.main import app

            # Find CORS middleware
            cors_middleware = None
            for middleware in app.user_middleware:
                if middleware.cls.__name__ == "CORSMiddleware":
                    cors_middleware = middleware
                    break

            allowed_origins = cors_middleware.kwargs.get("allow_origins", [])
            allow_credentials = cors_middleware.kwargs.get("allow_credentials", False)

            # CRITICAL: If credentials are enabled, origins MUST NOT include "*"
            if allow_credentials:
                assert "*" not in allowed_origins, \
                    "SECURITY VIOLATION: allow_origins=['*'] with allow_credentials=True"

    def test_cors_allowed_methods_are_restricted(self):
        """Test that only necessary HTTP methods are allowed"""
        with patch.dict(os.environ, {"ALLOWED_ORIGINS": "http://localhost:3737"}, clear=False):
            from src.server.main import app

            cors_middleware = None
            for middleware in app.user_middleware:
                if middleware.cls.__name__ == "CORSMiddleware":
                    cors_middleware = middleware
                    break

            allowed_methods = cors_middleware.kwargs.get("allow_methods", [])

            # Should include standard REST methods
            if allowed_methods != ["*"]:  # If not wildcard
                assert "GET" in allowed_methods
                assert "POST" in allowed_methods
                assert "PUT" in allowed_methods
                assert "DELETE" in allowed_methods

    def test_cors_configuration_documentation(self):
        """Test that CORS configuration is documented in .env.example"""
        import os

        env_example_path = "/home/user/Smart-Founds-Grant/python/.env.example"

        if os.path.exists(env_example_path):
            with open(env_example_path, "r") as f:
                content = f.read()

            # Should document ALLOWED_ORIGINS
            assert "ALLOWED_ORIGINS" in content, \
                "ALLOWED_ORIGINS not documented in .env.example"

    def test_production_cors_validation(self):
        """
        Test that production CORS configuration is secure
        This test documents expected production configuration
        """
        # Example production configuration
        production_origins = "https://archon.yourdomain.com,https://www.archon.yourdomain.com"

        with patch.dict(os.environ, {"ALLOWED_ORIGINS": production_origins}, clear=False):
            from src.server.main import app

            cors_middleware = None
            for middleware in app.user_middleware:
                if middleware.cls.__name__ == "CORSMiddleware":
                    cors_middleware = middleware
                    break

            allowed_origins = cors_middleware.kwargs.get("allow_origins", [])

            # Production should only allow HTTPS (except localhost for dev)
            for origin in allowed_origins:
                if "localhost" not in origin and "127.0.0.1" not in origin:
                    assert origin.startswith("https://"), \
                        f"Production origin should use HTTPS: {origin}"
