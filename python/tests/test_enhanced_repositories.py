"""
Tests for enhanced repository implementations with type constraints and error handling.

This module tests the improved repository pattern implementation including:
- Comprehensive type safety and validation
- Custom exception handling and error classification
- Ordering guarantees and deterministic results
- Pagination with metadata
- Batch operations with detailed error tracking
"""

import pytest
import pytest_asyncio
from datetime import datetime
from typing import Dict, Any, List
from unittest.mock import MagicMock, AsyncMock, patch
from uuid import UUID, uuid4

from src.server.repositories.exceptions import (
    RepositoryError, ValidationError, EntityNotFoundError,
    DuplicateEntityError, ConcurrencyError, DatabaseConnectionError, 
    DatabaseOperationError, QueryError, ConstraintViolationError, 
    BatchOperationError
)
from src.server.repositories.validation import RepositoryValidator
from src.server.repositories.interfaces.base_repository import (
    SortDirection, OrderingField, PaginationParams,
    OperationResult, PaginatedResult
)


class TestRepositoryExceptions:
    """Test custom repository exception classes."""
    
    def test_repository_error_base(self):
        """Test base RepositoryError functionality."""
        error = RepositoryError(
            "Test error",
            operation="test_operation",
            entity_type="TestEntity",
            entity_id="test-id",
            error_code="TEST_ERROR"
        )
        
        assert error.message == "Test error"
        assert error.operation == "test_operation"
        assert error.entity_type == "TestEntity"
        assert error.entity_id == "test-id"
        assert error.error_code == "TEST_ERROR"
        assert isinstance(error.timestamp, datetime)
        
        # Test dictionary serialization
        error_dict = error.to_dict()
        assert error_dict["error_type"] == "RepositoryError"
        assert error_dict["message"] == "Test error"
        assert error_dict["operation"] == "test_operation"
        assert error_dict["entity_type"] == "TestEntity"
    
    def test_validation_error_with_field_errors(self):
        """Test ValidationError with field-specific errors."""
        field_errors = {
            "email": ["Invalid email format"],
            "age": ["Must be positive integer", "Cannot exceed 120"]
        }
        
        error = ValidationError(
            "Validation failed",
            field_errors=field_errors,
            operation="create_user"
        )
        
        assert error.field_errors == field_errors
        assert error.has_field_error("email")
        assert error.has_field_error("age")
        assert not error.has_field_error("name")
        
        email_errors = error.get_field_errors()["email"]
        assert "Invalid email format" in email_errors
    
    def test_entity_not_found_error(self):
        """Test EntityNotFoundError with search criteria."""
        search_criteria = {"email": "test@example.com", "active": True}
        
        error = EntityNotFoundError(
            "User not found",
            search_criteria=search_criteria,
            entity_type="User",
            operation="get_user_by_email"
        )
        
        assert error.search_criteria == search_criteria
        assert "Check if the User exists" in error.get_suggested_action()
    
    def test_duplicate_entity_error(self):
        """Test DuplicateEntityError with conflicting fields."""
        error = DuplicateEntityError(
            "User already exists",
            conflicting_fields=["email", "username"],
            existing_entity_id="existing-user-123",
            entity_type="User",
            operation="create_user"
        )
        
        assert error.conflicting_fields == ["email", "username"]
        assert error.existing_entity_id == "existing-user-123"
        assert "email, username" in error.get_suggested_action()
    
    def test_concurrency_error_retryable(self):
        """Test ConcurrencyError is marked as retryable."""
        error = ConcurrencyError(
            "Concurrent modification detected",
            expected_version="v1",
            actual_version="v2",
            entity_type="Document",
            operation="update_document"
        )
        
        assert error.is_retryable()
        assert error.expected_version == "v1"
        assert error.actual_version == "v2"
        assert "latest version" in error.get_suggested_action()
    
    def test_batch_operation_error(self):
        """Test BatchOperationError with item details."""
        item_errors = [
            {"item_index": 0, "error": "Invalid email"},
            {"item_index": 2, "error": "Duplicate username"}
        ]
        
        error = BatchOperationError(
            "Batch operation partially failed",
            total_items=5,
            successful_items=3,
            failed_items=2,
            item_errors=item_errors,
            operation="create_users_batch"
        )
        
        assert error.total_items == 5
        assert error.successful_items == 3
        assert error.failed_items == 2
        assert error.get_success_rate() == 60.0  # 3/5 * 100
        assert error.is_partial_success()


class TestRepositoryValidator:
    """Test repository validation utilities."""
    
    def test_validate_id_uuid(self):
        """Test UUID validation and conversion."""
        # Test UUID object
        test_uuid = uuid4()
        result = RepositoryValidator.validate_id(test_uuid)
        assert result == test_uuid
        assert isinstance(result, UUID)
        
        # Test UUID string
        uuid_str = str(test_uuid)
        result = RepositoryValidator.validate_id(uuid_str)
        assert result == test_uuid
        assert isinstance(result, UUID)
    
    def test_validate_id_string(self):
        """Test string ID validation."""
        # Valid string ID
        result = RepositoryValidator.validate_id("valid-string-id")
        assert result == "valid-string-id"
        
        # String with whitespace (should be trimmed)
        result = RepositoryValidator.validate_id("  trimmed-id  ")
        assert result == "trimmed-id"
    
    def test_validate_id_integer(self):
        """Test integer ID validation."""
        result = RepositoryValidator.validate_id(12345)
        assert result == 12345
        assert isinstance(result, int)
    
    def test_validate_id_invalid_cases(self):
        """Test invalid ID validation cases."""
        # None ID
        with pytest.raises(ValidationError) as exc_info:
            RepositoryValidator.validate_id(None)
        assert "cannot be None" in str(exc_info.value)
        
        # Empty string
        with pytest.raises(ValidationError) as exc_info:
            RepositoryValidator.validate_id("")
        assert "cannot be empty" in str(exc_info.value)
        
        # Negative integer
        with pytest.raises(ValidationError) as exc_info:
            RepositoryValidator.validate_id(-1)
        assert "must be positive" in str(exc_info.value)
        
        # Invalid type
        with pytest.raises(ValidationError) as exc_info:
            RepositoryValidator.validate_id({"invalid": "type"})
        assert "must be UUID, string, or integer" in str(exc_info.value)
    
    def test_validate_pagination(self):
        """Test pagination parameter validation."""
        # Valid pagination
        valid_pagination = {"limit": 50, "offset": 100}
        result = RepositoryValidator.validate_pagination(valid_pagination)
        assert result == valid_pagination
        
        # None pagination (should pass)
        result = RepositoryValidator.validate_pagination(None)
        assert result is None
        
        # Invalid limit
        with pytest.raises(ValidationError) as exc_info:
            RepositoryValidator.validate_pagination({"limit": 0})
        assert exc_info.value.has_field_error("limit")
        assert "must be positive" in " ".join(exc_info.value.field_errors["limit"])
        
        # Limit too large
        with pytest.raises(ValidationError) as exc_info:
            RepositoryValidator.validate_pagination({"limit": 20000})
        assert exc_info.value.has_field_error("limit")
        assert "exceeds maximum" in " ".join(exc_info.value.field_errors["limit"])
        
        # Negative offset
        with pytest.raises(ValidationError) as exc_info:
            RepositoryValidator.validate_pagination({"offset": -1})
        assert exc_info.value.has_field_error("offset")
        assert "cannot be negative" in " ".join(exc_info.value.field_errors["offset"])
    
    def test_validate_ordering(self):
        """Test ordering parameter validation."""
        # Valid ordering
        valid_ordering = [
            {"field": "created_at", "direction": SortDirection.DESC},
            {"field": "name", "direction": SortDirection.ASC, "nulls_first": True}
        ]
        
        result = RepositoryValidator.validate_ordering(
            valid_ordering, 
            valid_fields=["created_at", "name", "id"]
        )
        assert result == valid_ordering
        
        # Invalid field name
        with pytest.raises(ValidationError) as exc_info:
            RepositoryValidator.validate_ordering(
                [{"field": "invalid-field-name!"}],
                valid_fields=["name", "id"]
            )
        errors = exc_info.value.field_errors
        assert any("not valid" in " ".join(field_errors) for field_errors in errors.values())
        
        # Field not in valid list
        with pytest.raises(ValidationError) as exc_info:
            RepositoryValidator.validate_ordering(
                [{"field": "unknown_field"}],
                valid_fields=["name", "id"]
            )
        errors = exc_info.value.field_errors
        assert any("not valid" in " ".join(field_errors) for field_errors in errors.values())
    
    def test_validate_filters(self):
        """Test filter parameter validation."""
        # Valid simple filters
        valid_filters = {
            "name": "John Doe",
            "age": 25,
            "active": True
        }
        
        result = RepositoryValidator.validate_filters(
            valid_filters,
            valid_fields=["name", "age", "active", "email"]
        )
        assert result == valid_filters
        
        # Complex filter conditions
        complex_filters = {
            "age": {
                "operator": "gte",
                "value": 18
            },
            "name": {
                "operator": "like",
                "value": "%John%"
            }
        }
        
        result = RepositoryValidator.validate_filters(
            complex_filters,
            valid_fields=["name", "age"]
        )
        assert result == complex_filters
        
        # Invalid field name
        with pytest.raises(ValidationError) as exc_info:
            RepositoryValidator.validate_filters(
                {"invalid-field!": "value"},
                valid_fields=["name", "age"]
            )
        errors = exc_info.value.field_errors
        assert any("Invalid field name" in " ".join(field_errors) for field_errors in errors.values())
    
    def test_validate_entity_data(self):
        """Test entity data validation."""
        # Valid entity data
        valid_data = {
            "name": "Test Entity",
            "email": "test@example.com",
            "age": 25
        }
        
        result = RepositoryValidator.validate_entity_data(
            valid_data,
            required_fields=["name", "email"],
            operation="create"
        )
        assert result == valid_data
        
        # Missing required fields
        with pytest.raises(ValidationError) as exc_info:
            RepositoryValidator.validate_entity_data(
                {"name": "Test"},
                required_fields=["name", "email"],
                operation="create"
            )
        assert exc_info.value.has_field_error("email")
        assert "Required field 'email' is missing" in " ".join(exc_info.value.field_errors["email"])
        
        # Invalid data type
        with pytest.raises(ValidationError) as exc_info:
            RepositoryValidator.validate_entity_data(
                "not a dictionary",
                operation="create"
            )
        assert "must be dictionary" in str(exc_info.value)
    
    def test_ensure_deterministic_ordering(self):
        """Test deterministic ordering guarantee."""
        # Custom ordering - should add defaults
        custom_ordering = [
            {"field": "name", "direction": SortDirection.ASC}
        ]
        
        result = RepositoryValidator.ensure_deterministic_ordering(custom_ordering)
        
        # Should have original plus defaults
        assert len(result) == 3  # name + created_at + id
        assert result[0]["field"] == "name"
        assert result[1]["field"] == "created_at"
        assert result[2]["field"] == "id"
        
        # Verify default directions
        assert result[1]["direction"] == SortDirection.DESC  # created_at DESC
        assert result[2]["direction"] == SortDirection.ASC   # id ASC
        
        # No duplicates if fields already exist
        existing_ordering = [
            {"field": "created_at", "direction": SortDirection.ASC},
            {"field": "id", "direction": SortDirection.DESC}
        ]
        
        result = RepositoryValidator.ensure_deterministic_ordering(existing_ordering)
        assert len(result) == 2  # No additions needed


class TestEnhancedTypeConstraints:
    """Test enhanced type constraints in repository operations."""
    
    @pytest.mark.asyncio
    async def test_typed_overloads(self):
        """Test that method overloads provide proper type hints."""
        # This is more of a compile-time test, but we can verify the structure
        from src.server.repositories.interfaces.base_repository import IBaseRepository
        
        # Check that overloads exist (these would be caught by type checker)
        assert hasattr(IBaseRepository, 'get_by_id')
        assert hasattr(IBaseRepository, 'list')
        
        # The actual type checking happens at static analysis time with mypy
        # But we can verify the method signatures are callable
    
    @pytest.mark.asyncio 
    async def test_paginated_result_structure(self):
        """Test PaginatedResult type structure."""
        # Mock some entity data
        mock_entities = [
            {"id": "1", "name": "Entity 1"},
            {"id": "2", "name": "Entity 2"}
        ]
        
        # Create paginated result
        paginated_result: PaginatedResult[Dict[str, Any]] = {
            "entities": mock_entities,
            "total_count": 10,
            "page_size": 2,
            "current_offset": 0,
            "has_more": True,
            "metadata": {
                "ordering_fields": ["created_at", "id"],
                "filter_count": 1
            }
        }
        
        # Verify structure
        assert len(paginated_result["entities"]) == 2
        assert paginated_result["total_count"] == 10
        assert paginated_result["has_more"] is True
        assert "ordering_fields" in paginated_result.get("metadata", {})
    
    @pytest.mark.asyncio
    async def test_operation_result_structure(self):
        """Test OperationResult type structure."""
        # Successful batch operation result
        success_result: OperationResult[Dict[str, Any]] = {
            "success": True,
            "entities": [{"id": "1", "name": "Created Entity"}],
            "affected_count": 1,
            "metadata": {"batch_size": 1, "processing_time_ms": 150}
        }
        
        assert success_result["success"] is True
        assert len(success_result["entities"]) == 1
        assert success_result["affected_count"] == 1
        
        # Failed operation result
        error_result: OperationResult[Dict[str, Any]] = {
            "success": False,
            "error": "Validation failed for batch items",
            "affected_count": 0,
            "metadata": {"failed_items": [{"index": 0, "error": "Missing required field"}]}
        }
        
        assert error_result["success"] is False
        assert "error" in error_result
        assert error_result["affected_count"] == 0


class TestOrderingGuarantees:
    """Test ordering guarantees in repository operations."""
    
    def test_sort_direction_enum(self):
        """Test SortDirection enum values."""
        assert SortDirection.ASC == "asc"
        assert SortDirection.DESC == "desc"
        assert SortDirection.ASCENDING == "ascending"
        assert SortDirection.DESCENDING == "descending"
        
        # Test enum membership
        assert SortDirection.ASC in SortDirection
        assert "invalid_direction" not in [d.value for d in SortDirection]
    
    def test_ordering_field_structure(self):
        """Test OrderingField TypedDict structure."""
        # Required fields only
        basic_ordering: OrderingField = {
            "field": "created_at",
            "direction": SortDirection.DESC
        }
        
        assert basic_ordering["field"] == "created_at"
        assert basic_ordering["direction"] == SortDirection.DESC
        
        # With optional nulls_first
        extended_ordering: OrderingField = {
            "field": "name",
            "direction": SortDirection.ASC,
            "nulls_first": True
        }
        
        assert extended_ordering.get("nulls_first") is True
    
    def test_deterministic_ordering_logic(self):
        """Test that ordering is always deterministic."""
        validator = RepositoryValidator()
        
        # Empty ordering should get defaults
        result = validator.ensure_deterministic_ordering(None)
        assert len(result) == 2  # created_at + id
        assert result[0]["field"] == "created_at"
        assert result[1]["field"] == "id"
        
        # Custom ordering should preserve order and add missing defaults
        custom = [{"field": "name", "direction": SortDirection.ASC}]
        result = validator.ensure_deterministic_ordering(custom)
        
        # Should have: name (custom), created_at (default), id (default)
        assert len(result) == 3
        assert result[0]["field"] == "name"
        assert result[1]["field"] == "created_at"
        assert result[2]["field"] == "id"
        
        # Verify final ordering is always deterministic (ends with unique field)
        final_field = result[-1]["field"]
        assert final_field == "id"  # Should be unique identifier


@pytest.mark.integration
class TestRepositoryIntegration:
    """Integration tests for enhanced repository functionality."""
    
    @pytest.mark.asyncio
    async def test_comprehensive_error_handling_flow(self):
        """Test comprehensive error handling in a realistic flow."""
        # This would require actual database setup for full integration testing
        # For now, we test the error classification logic
        
        validator = RepositoryValidator()
        
        # Test validation error flow
        try:
            validator.validate_entity_data(
                {"invalid_email": "not-an-email"},
                required_fields=["name", "email"],
                operation="create"
            )
            assert False, "Should have raised ValidationError"
        except ValidationError as e:
            assert e.operation == "create"
            assert e.has_field_error("name")
            assert "Required field 'name' is missing" in " ".join(e.field_errors["name"])
    
    @pytest.mark.asyncio
    async def test_batch_operation_error_tracking(self):
        """Test batch operation error tracking."""
        # Simulate batch operation with mixed success/failure
        total_items = 5
        successful_items = 3  
        failed_items = 2
        
        item_errors = [
            {"item_index": 1, "error": "Duplicate key violation", "field": "email"},
            {"item_index": 4, "error": "Invalid data format", "field": "phone"}
        ]
        
        batch_error = BatchOperationError(
            "Batch create operation partially failed",
            total_items=total_items,
            successful_items=successful_items,
            failed_items=failed_items,
            item_errors=item_errors,
            operation="batch_create_users"
        )
        
        # Test batch error analysis
        assert batch_error.get_success_rate() == 60.0  # 3/5 * 100
        assert batch_error.is_partial_success()
        assert len(batch_error.item_errors) == 2
        
        # Test error serialization for logging/reporting
        error_dict = batch_error.to_dict()
        assert error_dict["error_type"] == "BatchOperationError"
        assert error_dict["context"]["success_rate"] == 60.0
        assert error_dict["context"]["item_errors"] == item_errors