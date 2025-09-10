"""
Unit tests for Supabase key validation functionality.
Tests the JWT-based validation of anon vs service keys.
"""

import pytest
from jose import jwt
from unittest.mock import patch, MagicMock

from src.server.config.config import (
    validate_supabase_key,
    ConfigurationError,
    load_environment_config,
)


def test_validate_anon_key():
    """Test validation detects anon key correctly."""
    # Create mock anon key JWT
    anon_payload = {"role": "anon", "iss": "supabase"}
    anon_token = jwt.encode(anon_payload, "secret", algorithm="HS256")

    is_valid, msg = validate_supabase_key(anon_token)

    assert is_valid == False
    assert msg == "ANON_KEY_DETECTED"


def test_validate_service_key():
    """Test validation detects service key correctly."""
    # Create mock service key JWT
    service_payload = {"role": "service_role", "iss": "supabase"}
    service_token = jwt.encode(service_payload, "secret", algorithm="HS256")

    is_valid, msg = validate_supabase_key(service_token)

    assert is_valid == True
    assert msg == "VALID_SERVICE_KEY"


def test_validate_unknown_key():
    """Test validation handles unknown key roles."""
    # Create mock key with unknown role
    unknown_payload = {"role": "custom", "iss": "supabase"}
    unknown_token = jwt.encode(unknown_payload, "secret", algorithm="HS256")

    is_valid, msg = validate_supabase_key(unknown_token)

    assert is_valid == False
    assert "UNKNOWN_KEY_TYPE" in msg
    assert "custom" in msg


def test_validate_invalid_jwt():
    """Test validation handles invalid JWT format gracefully."""
    is_valid, msg = validate_supabase_key("not-a-jwt")

    # Should allow invalid JWT to proceed (might be new format)
    assert is_valid == True
    assert msg == "UNABLE_TO_VALIDATE"


def test_validate_empty_key():
    """Test validation handles empty key."""
    is_valid, msg = validate_supabase_key("")

    assert is_valid == False
    assert msg == "EMPTY_KEY"


def test_config_raises_on_anon_key():
    """Test that configuration loading raises error when anon key detected."""
    # Create a mock anon key JWT
    anon_payload = {"role": "anon", "iss": "supabase"}
    mock_anon_key = jwt.encode(anon_payload, "secret", algorithm="HS256")

    with patch.dict(
        "os.environ",
        {
            "SUPABASE_URL": "https://test.supabase.co", 
            "SUPABASE_SERVICE_KEY": mock_anon_key,
            "OPENAI_API_KEY": ""  # Clear any existing key
        }
    ):
        with pytest.raises(ConfigurationError) as exc_info:
            load_environment_config()

        error_message = str(exc_info.value)
        assert "CRITICAL: You are using a Supabase ANON key" in error_message
        assert "service_role" in error_message
        assert "permission denied" in error_message


def test_config_accepts_service_key():
    """Test that configuration loading accepts service key."""
    # Create a mock service key JWT
    service_payload = {"role": "service_role", "iss": "supabase"}
    mock_service_key = jwt.encode(service_payload, "secret", algorithm="HS256")

    with patch.dict(
        "os.environ",
        {
            "SUPABASE_URL": "https://test.supabase.co", 
            "SUPABASE_SERVICE_KEY": mock_service_key,
            "PORT": "8051",  # Required for config
            "OPENAI_API_KEY": ""  # Clear any existing key
        }
    ):
        # Should not raise an exception
        config = load_environment_config()
        assert config.supabase_service_key == mock_service_key


def test_config_handles_invalid_jwt():
    """Test that configuration loading handles invalid JWT gracefully."""
    with patch.dict(
        "os.environ",
        {
            "SUPABASE_URL": "https://test.supabase.co", 
            "SUPABASE_SERVICE_KEY": "invalid-jwt-key",
            "PORT": "8051",  # Required for config
            "OPENAI_API_KEY": ""  # Clear any existing key
        }
    ):
        with patch("builtins.print") as mock_print:
            # Should not raise an exception for invalid JWT
            config = load_environment_config()
            assert config.supabase_service_key == "invalid-jwt-key"


def test_config_fails_on_unknown_role():
    """Test that configuration loading fails fast for unknown roles."""
    # Create a mock key with unknown role
    unknown_payload = {"role": "custom_role", "iss": "supabase"}
    mock_unknown_key = jwt.encode(unknown_payload, "secret", algorithm="HS256")

    with patch.dict(
        "os.environ",
        {
            "SUPABASE_URL": "https://test.supabase.co", 
            "SUPABASE_SERVICE_KEY": mock_unknown_key,
            "PORT": "8051",  # Required for config
            "OPENAI_API_KEY": ""  # Clear any existing key
        }
    ):
        # Should raise ConfigurationError for unknown role
        with pytest.raises(ConfigurationError) as exc_info:
            load_environment_config()

        error_message = str(exc_info.value)
        assert "Unknown Supabase key role 'custom_role'" in error_message
        assert "Expected 'service_role'" in error_message


def test_config_raises_on_anon_key_with_port():
    """Test that anon key detection works properly with all required env vars."""
    # Create a mock anon key JWT
    anon_payload = {"role": "anon", "iss": "supabase"}
    mock_anon_key = jwt.encode(anon_payload, "secret", algorithm="HS256")

    with patch.dict(
        "os.environ",
        {
            "SUPABASE_URL": "https://test.supabase.co", 
            "SUPABASE_SERVICE_KEY": mock_anon_key,
            "PORT": "8051",
            "OPENAI_API_KEY": "sk-test123"  # Valid OpenAI key
        },
    ):
        # Should still raise ConfigurationError for anon key even with valid OpenAI key
        with pytest.raises(ConfigurationError) as exc_info:
            load_environment_config()

        error_message = str(exc_info.value)
        assert "CRITICAL: You are using a Supabase ANON key" in error_message


def test_jwt_decoding_with_real_structure():
    """Test JWT decoding with realistic Supabase JWT structure."""
    # More realistic Supabase JWT payload structure
    realistic_anon_payload = {
        "aud": "authenticated",
        "exp": 1999999999,
        "iat": 1234567890,
        "iss": "supabase",
        "ref": "abcdefghij",
        "role": "anon",
    }

    realistic_service_payload = {
        "aud": "authenticated",
        "exp": 1999999999,
        "iat": 1234567890,
        "iss": "supabase",
        "ref": "abcdefghij",
        "role": "service_role",
    }

    anon_token = jwt.encode(realistic_anon_payload, "secret", algorithm="HS256")
    service_token = jwt.encode(realistic_service_payload, "secret", algorithm="HS256")

    # Test anon key detection
    is_valid_anon, msg_anon = validate_supabase_key(anon_token)
    assert is_valid_anon == False
    assert msg_anon == "ANON_KEY_DETECTED"

    # Test service key detection
    is_valid_service, msg_service = validate_supabase_key(service_token)
    assert is_valid_service == True
    assert msg_service == "VALID_SERVICE_KEY"
