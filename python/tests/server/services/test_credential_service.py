"""
Tests for Credential Service

Tests credential encryption, storage, and retrieval functionality.
"""

import pytest
from unittest.mock import Mock, AsyncMock, patch
from src.server.services.credential_service import CredentialService


class TestCredentialService:
    """Test suite for CredentialService"""

    @pytest.fixture
    def mock_supabase(self):
        """Create mock Supabase client"""
        mock = Mock()
        mock.table = Mock(return_value=mock)
        mock.select = Mock(return_value=mock)
        mock.insert = Mock(return_value=mock)
        mock.update = Mock(return_value=mock)
        mock.delete = Mock(return_value=mock)
        mock.eq = Mock(return_value=mock)
        mock.execute = Mock()
        return mock

    @pytest.fixture
    def credential_service(self, mock_supabase):
        """Create CredentialService instance with mocked dependencies"""
        with patch('src.server.services.credential_service.get_supabase_client', return_value=mock_supabase):
            service = CredentialService(supabase_client=mock_supabase)
            return service

    def test_init_creates_encryption_key(self, credential_service):
        """Test that service initializes with encryption key"""
        assert credential_service.cipher_suite is not None
        assert credential_service._cache == {}
        assert credential_service._cache_initialized is False

    def test_encrypt_decrypt_value(self, credential_service):
        """Test encryption and decryption roundtrip"""
        original_value = "test_api_key_12345"

        # Encrypt
        encrypted = credential_service._encrypt_value(original_value)
        assert encrypted != original_value
        assert isinstance(encrypted, str)

        # Decrypt
        decrypted = credential_service._decrypt_value(encrypted)
        assert decrypted == original_value

    def test_encrypt_empty_string(self, credential_service):
        """Test encrypting empty string"""
        encrypted = credential_service._encrypt_value("")
        assert encrypted != ""
        decrypted = credential_service._decrypt_value(encrypted)
        assert decrypted == ""

    @pytest.mark.asyncio
    async def test_store_encrypted_credential(self, credential_service, mock_supabase):
        """Test storing encrypted credential"""
        mock_supabase.execute.return_value = Mock(data=[{"key": "API_KEY", "value": "encrypted"}])

        result = await credential_service.store_credential("API_KEY", "secret_value", encrypted=True)

        assert result is True
        mock_supabase.table.assert_called_with("archon_credentials")
        # Verify insert was called (upsert pattern)
        assert mock_supabase.insert.called or mock_supabase.update.called

    @pytest.mark.asyncio
    async def test_store_plain_credential(self, credential_service, mock_supabase):
        """Test storing plain (non-encrypted) credential"""
        mock_supabase.execute.return_value = Mock(data=[{"key": "FEATURE_FLAG", "value": "true"}])

        result = await credential_service.store_credential("FEATURE_FLAG", "true", encrypted=False)

        assert result is True

    @pytest.mark.asyncio
    async def test_get_credential_from_cache(self, credential_service):
        """Test retrieving credential from cache"""
        # Setup cache
        credential_service._cache = {"TEST_KEY": "cached_value"}
        credential_service._cache_initialized = True

        value = await credential_service.get_credential("TEST_KEY")

        assert value == "cached_value"

    @pytest.mark.asyncio
    async def test_get_encrypted_credential(self, credential_service, mock_supabase):
        """Test retrieving and decrypting encrypted credential"""
        original_value = "my_secret_key"
        encrypted_value = credential_service._encrypt_value(original_value)

        mock_supabase.execute.return_value = Mock(
            data=[{"key": "SECRET_KEY", "encrypted_value": encrypted_value, "is_encrypted": True}]
        )
        credential_service._cache_initialized = True

        value = await credential_service.get_credential("SECRET_KEY")

        assert value == original_value

    @pytest.mark.asyncio
    async def test_get_plain_credential(self, credential_service, mock_supabase):
        """Test retrieving plain (non-encrypted) credential"""
        mock_supabase.execute.return_value = Mock(
            data=[{"key": "CONFIG_VALUE", "value": "true", "is_encrypted": False}]
        )
        credential_service._cache_initialized = True

        value = await credential_service.get_credential("CONFIG_VALUE")

        assert value == "true"

    @pytest.mark.asyncio
    async def test_get_credential_not_found(self, credential_service, mock_supabase):
        """Test retrieving non-existent credential returns None"""
        mock_supabase.execute.return_value = Mock(data=[])
        credential_service._cache_initialized = True

        value = await credential_service.get_credential("NONEXISTENT")

        assert value is None

    @pytest.mark.asyncio
    async def test_delete_credential(self, credential_service, mock_supabase):
        """Test deleting credential"""
        mock_supabase.execute.return_value = Mock(data=[])
        credential_service._cache = {"TEST_KEY": "value"}
        credential_service._cache_initialized = True

        result = await credential_service.delete_credential("TEST_KEY")

        assert result is True
        assert "TEST_KEY" not in credential_service._cache
        mock_supabase.delete.assert_called()

    @pytest.mark.asyncio
    async def test_get_all_credentials(self, credential_service, mock_supabase):
        """Test retrieving all credentials"""
        mock_supabase.execute.return_value = Mock(
            data=[
                {"key": "KEY1", "value": "value1", "is_encrypted": False},
                {"key": "KEY2", "encrypted_value": "enc_value", "is_encrypted": True}
            ]
        )

        credentials = await credential_service.get_all_credentials()

        assert len(credentials) == 2
        assert credentials[0]["key"] == "KEY1"
        assert credentials[1]["key"] == "KEY2"

    def test_get_bool_setting(self, credential_service):
        """Test boolean setting parsing"""
        credential_service._cache = {
            "BOOL_TRUE": "true",
            "BOOL_FALSE": "false",
            "BOOL_ONE": "1",
            "BOOL_ZERO": "0",
        }
        credential_service._cache_initialized = True

        assert credential_service.get_bool_setting("BOOL_TRUE", False) is True
        assert credential_service.get_bool_setting("BOOL_FALSE", True) is False
        assert credential_service.get_bool_setting("BOOL_ONE", False) is True
        assert credential_service.get_bool_setting("BOOL_ZERO", True) is False
        assert credential_service.get_bool_setting("NONEXISTENT", True) is True

    def test_encryption_key_consistency(self, credential_service):
        """Test that encryption key remains consistent for instance"""
        value1 = credential_service._encrypt_value("test")
        value2 = credential_service._encrypt_value("test")

        # Different encrypted values (due to random IV)
        assert value1 != value2

        # But both decrypt to same value
        assert credential_service._decrypt_value(value1) == "test"
        assert credential_service._decrypt_value(value2) == "test"

    @pytest.mark.asyncio
    async def test_store_credential_handles_errors(self, credential_service, mock_supabase):
        """Test error handling in store_credential"""
        mock_supabase.execute.side_effect = Exception("Database error")

        result = await credential_service.store_credential("KEY", "value")

        assert result is False

    @pytest.mark.asyncio
    async def test_load_cache_on_first_access(self, credential_service, mock_supabase):
        """Test that cache is loaded on first access"""
        mock_supabase.execute.return_value = Mock(
            data=[{"key": "CACHED_KEY", "value": "cached_value", "is_encrypted": False}]
        )

        assert credential_service._cache_initialized is False

        value = await credential_service.get_credential("CACHED_KEY")

        assert credential_service._cache_initialized is True
        assert value == "cached_value"
        assert "CACHED_KEY" in credential_service._cache
