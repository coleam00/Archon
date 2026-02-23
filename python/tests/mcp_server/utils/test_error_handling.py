"""Unit tests for MCPErrorFormatter utility."""

import json
from unittest.mock import MagicMock

import httpx

from src.mcp_server.utils.error_handling import MCPErrorFormatter


def test_format_error_basic():
    """Test basic error formatting."""
    result = MCPErrorFormatter.format_error(
        error_type="validation_error",
        message="Invalid input",
    )

    result_data = json.loads(result)
    assert result_data["success"] is False
    assert result_data["error"]["type"] == "validation_error"
    assert result_data["error"]["message"] == "Invalid input"
    assert "details" not in result_data["error"]
    assert "suggestion" not in result_data["error"]


def test_format_error_with_all_fields():
    """Test error formatting with all optional fields."""
    result = MCPErrorFormatter.format_error(
        error_type="connection_timeout",
        message="Connection timed out",
        details={"url": "http://api.example.com", "timeout": 30},
        suggestion="Check network connectivity",
        http_status=504,
    )

    result_data = json.loads(result)
    assert result_data["success"] is False
    assert result_data["error"]["type"] == "connection_timeout"
    assert result_data["error"]["message"] == "Connection timed out"
    assert result_data["error"]["details"]["url"] == "http://api.example.com"
    assert result_data["error"]["suggestion"] == "Check network connectivity"
    assert result_data["error"]["http_status"] == 504


def test_from_http_error_with_json_body():
    """Test formatting from HTTP response with JSON error body."""
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 400
    mock_response.json.return_value = {
        "detail": {"error": "Field is required"},
        "message": "Validation failed",
    }

    result = MCPErrorFormatter.from_http_error(mock_response, "create item")

    result_data = json.loads(result)
    assert result_data["success"] is False
    # When JSON body has error details, it returns api_error, not http_error
    assert result_data["error"]["type"] == "api_error"
    assert "Field is required" in result_data["error"]["message"]
    assert result_data["error"]["http_status"] == 400


def test_from_http_error_with_text_body():
    """Test formatting from HTTP response with text error body."""
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 404
    mock_response.json.side_effect = json.JSONDecodeError("msg", "doc", 0)
    mock_response.text = "Resource not found"

    result = MCPErrorFormatter.from_http_error(mock_response, "get item")

    result_data = json.loads(result)
    assert result_data["success"] is False
    assert result_data["error"]["type"] == "http_error"
    # The message format is "Failed to {operation}: HTTP {status_code}"
    assert "Failed to get item: HTTP 404" == result_data["error"]["message"]
    assert result_data["error"]["http_status"] == 404


def test_from_exception_timeout():
    """Test formatting from timeout exception."""
    # httpx.TimeoutException is a subclass of httpx.RequestError
    exception = httpx.TimeoutException("Request timed out after 30s")

    result = MCPErrorFormatter.from_exception(
        exception, "fetch data", {"url": "http://api.example.com"}
    )

    result_data = json.loads(result)
    assert result_data["success"] is False
    # TimeoutException is categorized as request_error since it's a RequestError subclass
    assert result_data["error"]["type"] == "request_error"
    assert "Request timed out" in result_data["error"]["message"]
    assert result_data["error"]["details"]["context"]["url"] == "http://api.example.com"
    assert "network connectivity" in result_data["error"]["suggestion"].lower()


def test_from_exception_connection():
    """Test formatting from connection exception."""
    exception = httpx.ConnectError("Failed to connect to host")

    result = MCPErrorFormatter.from_exception(exception, "connect to API")

    result_data = json.loads(result)
    assert result_data["success"] is False
    assert result_data["error"]["type"] == "connection_error"
    assert "Failed to connect" in result_data["error"]["message"]
    # The actual suggestion is "Ensure the Archon server is running on the correct port"
    assert "archon server" in result_data["error"]["suggestion"].lower()


def test_from_exception_request_error():
    """Test formatting from generic request error."""
    exception = httpx.RequestError("Network error")

    result = MCPErrorFormatter.from_exception(exception, "make request")

    result_data = json.loads(result)
    assert result_data["success"] is False
    assert result_data["error"]["type"] == "request_error"
    assert "Network error" in result_data["error"]["message"]
    assert "network connectivity" in result_data["error"]["suggestion"].lower()


def test_from_exception_generic():
    """Test formatting from generic exception."""
    exception = ValueError("Invalid value")

    result = MCPErrorFormatter.from_exception(exception, "process data")

    result_data = json.loads(result)
    assert result_data["success"] is False
    # ValueError is specifically categorized as validation_error
    assert result_data["error"]["type"] == "validation_error"
    assert "process data" in result_data["error"]["message"]
    assert "Invalid value" in result_data["error"]["details"]["exception_message"]


def test_from_exception_connect_timeout():
    """Test formatting from connect timeout exception."""
    exception = httpx.ConnectTimeout("Connection timed out")

    result = MCPErrorFormatter.from_exception(exception, "connect to API")

    result_data = json.loads(result)
    assert result_data["success"] is False
    assert result_data["error"]["type"] == "connection_timeout"
    assert "Connection timed out" in result_data["error"]["message"]
    assert "server is running" in result_data["error"]["suggestion"].lower()


def test_from_exception_read_timeout():
    """Test formatting from read timeout exception."""
    exception = httpx.ReadTimeout("Read timed out")

    result = MCPErrorFormatter.from_exception(exception, "read data")

    result_data = json.loads(result)
    assert result_data["success"] is False
    assert result_data["error"]["type"] == "read_timeout"
    assert "Read timed out" in result_data["error"]["message"]
    assert "taking longer than expected" in result_data["error"]["suggestion"].lower()
