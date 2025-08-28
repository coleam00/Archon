"""
Comprehensive tests for type checking utilities and constraint validation.

This module tests the type constraint validation system including:
- Runtime type checking with custom constraints
- Entity protocol compliance validation  
- Repository type safety enforcement
- Constraint violation handling
- Type normalization and validation
"""

import pytest
from datetime import datetime
from typing import Dict, Any, List, Optional
from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

from src.server.repositories.type_utils import (
    TypeConstraintValidator, EntityProtocolChecker, RepositoryTypeChecker,
    ensure_entity_compliance, validate_repository_constraints,
    create_type_safe_repository_decorator
)
from src.server.repositories.exceptions import ValidationError
from src.server.repositories.interfaces.base_repository import (
    ValidatableEntity, TimestampedEntity, VersionedEntity
)


class TestTypeConstraintValidator:
    """Test type constraint validation functionality."""
    
    def test_validate_string_constraints(self):
        """Test string type constraint validation."""
        validator = TypeConstraintValidator()
        
        # Valid string with default constraints
        result = validator.validate_type_constraint(
            "valid string", str, "test_field"
        )
        assert result == "valid string"
        
        # String with whitespace trimming
        result = validator.validate_type_constraint(
            "  trimmed  ", str, "test_field",
            constraints={"strip_whitespace": True}
        )
        assert result == "trimmed"
        
        # Lowercase normalization
        result = validator.validate_type_constraint(
            "MiXeD CaSe", str, "test_field",
            constraints={"lowercase": True, "strip_whitespace": False}
        )
        assert result == "mixed case"
    
    def test_validate_string_constraint_violations(self):
        """Test string constraint violations."""
        validator = TypeConstraintValidator()
        
        # Empty string when not allowed
        with pytest.raises(ValidationError) as exc_info:
            validator.validate_type_constraint(
                "", str, "test_field",
                constraints={"allow_empty": False}
            )
        assert "Empty strings are not allowed" in str(exc_info.value.field_errors["test_field"])
        
        # String too short
        with pytest.raises(ValidationError) as exc_info:
            validator.validate_type_constraint(
                "ab", str, "test_field",
                constraints={"min_length": 5}
            )
        assert "Minimum length is 5" in str(exc_info.value.field_errors["test_field"])
        
        # String too long
        with pytest.raises(ValidationError) as exc_info:
            validator.validate_type_constraint(
                "very long string", str, "test_field",
                constraints={"max_length": 5}
            )
        assert "Maximum length is 5" in str(exc_info.value.field_errors["test_field"])
    
    def test_validate_integer_constraints(self):
        """Test integer type constraint validation."""
        validator = TypeConstraintValidator()
        
        # Valid integer
        result = validator.validate_type_constraint(42, int, "test_field")
        assert result == 42
        
        # Integer within range
        result = validator.validate_type_constraint(
            50, int, "test_field",
            constraints={"min_value": 10, "max_value": 100}
        )
        assert result == 50
        
        # Allowed value constraint
        result = validator.validate_type_constraint(
            2, int, "test_field",
            constraints={"allowed_values": [1, 2, 3]}
        )
        assert result == 2
    
    def test_validate_integer_constraint_violations(self):
        """Test integer constraint violations."""
        validator = TypeConstraintValidator()
        
        # Value too small
        with pytest.raises(ValidationError) as exc_info:
            validator.validate_type_constraint(
                5, int, "test_field",
                constraints={"min_value": 10}
            )
        assert "Minimum value is 10" in str(exc_info.value.field_errors["test_field"])
        
        # Value too large
        with pytest.raises(ValidationError) as exc_info:
            validator.validate_type_constraint(
                150, int, "test_field",
                constraints={"max_value": 100}
            )
        assert "Maximum value is 100" in str(exc_info.value.field_errors["test_field"])
        
        # Value not in allowed list
        with pytest.raises(ValidationError) as exc_info:
            validator.validate_type_constraint(
                5, int, "test_field",
                constraints={"allowed_values": [1, 2, 3]}
            )
        assert "Value must be one of [1, 2, 3]" in str(exc_info.value.field_errors["test_field"])
    
    def test_validate_float_constraints(self):
        """Test float type constraint validation."""
        validator = TypeConstraintValidator()
        
        # Valid float
        result = validator.validate_type_constraint(3.14, float, "test_field")
        assert result == 3.14
        
        # Float within range
        result = validator.validate_type_constraint(
            7.5, float, "test_field",
            constraints={"min_value": 0.0, "max_value": 10.0}
        )
        assert result == 7.5
    
    def test_validate_float_constraint_violations(self):
        """Test float constraint violations."""
        validator = TypeConstraintValidator()
        
        # NaN when not allowed
        with pytest.raises(ValidationError) as exc_info:
            validator.validate_type_constraint(
                float('nan'), float, "test_field",
                constraints={"allow_nan": False}
            )
        assert "NaN values are not allowed" in str(exc_info.value.field_errors["test_field"])
        
        # Infinity when not allowed
        with pytest.raises(ValidationError) as exc_info:
            validator.validate_type_constraint(
                float('inf'), float, "test_field",
                constraints={"allow_inf": False}
            )
        assert "Infinite values are not allowed" in str(exc_info.value.field_errors["test_field"])
        
        # Value out of range
        with pytest.raises(ValidationError) as exc_info:
            validator.validate_type_constraint(
                15.0, float, "test_field",
                constraints={"max_value": 10.0}
            )
        assert "Maximum value is 10.0" in str(exc_info.value.field_errors["test_field"])
    
    def test_validate_datetime_constraints(self):
        """Test datetime type constraint validation."""
        validator = TypeConstraintValidator()
        
        # Valid datetime
        test_datetime = datetime(2024, 6, 15, 12, 0, 0)
        result = validator.validate_type_constraint(
            test_datetime, datetime, "test_field"
        )
        assert result == test_datetime
        
        # Datetime within year range
        result = validator.validate_type_constraint(
            test_datetime, datetime, "test_field",
            constraints={"min_year": 2020, "max_year": 2030}
        )
        assert result == test_datetime
    
    def test_validate_datetime_constraint_violations(self):
        """Test datetime constraint violations."""
        validator = TypeConstraintValidator()
        
        # Year too early
        with pytest.raises(ValidationError) as exc_info:
            validator.validate_type_constraint(
                datetime(1800, 1, 1), datetime, "test_field",
                constraints={"min_year": 1900}
            )
        assert "Year must be >= 1900" in str(exc_info.value.field_errors["test_field"])
        
        # Year too late
        with pytest.raises(ValidationError) as exc_info:
            validator.validate_type_constraint(
                datetime(2200, 1, 1), datetime, "test_field",
                constraints={"max_year": 2100}
            )
        assert "Year must be <= 2100" in str(exc_info.value.field_errors["test_field"])
        
        # Timezone naive when not allowed
        with pytest.raises(ValidationError) as exc_info:
            validator.validate_type_constraint(
                datetime(2024, 1, 1), datetime, "test_field",
                constraints={"allow_timezone_naive": False}
            )
        assert "Timezone-aware datetime required" in str(exc_info.value.field_errors["test_field"])
    
    def test_validate_uuid_constraints(self):
        """Test UUID type constraint validation."""
        validator = TypeConstraintValidator()
        
        # Valid UUID
        test_uuid = uuid4()
        result = validator.validate_type_constraint(test_uuid, UUID, "test_field")
        assert result == test_uuid
        
        # UUID version 4 constraint
        result = validator.validate_type_constraint(
            test_uuid, UUID, "test_field",
            constraints={"version": 4}
        )
        assert result == test_uuid
    
    def test_validate_uuid_constraint_violations(self):
        """Test UUID constraint violations."""
        validator = TypeConstraintValidator()
        
        # Wrong UUID version
        uuid_v1 = UUID('12345678-1234-1234-1234-123456789012')  # Version 1
        with pytest.raises(ValidationError) as exc_info:
            validator.validate_type_constraint(
                uuid_v1, UUID, "test_field",
                constraints={"version": 4}
            )
        assert "UUID version 4 required" in str(exc_info.value.field_errors["test_field"])
        
        # Nil UUID when not allowed
        nil_uuid = UUID('00000000-0000-0000-0000-000000000000')
        with pytest.raises(ValidationError) as exc_info:
            validator.validate_type_constraint(
                nil_uuid, UUID, "test_field",
                constraints={"allow_nil": False}
            )
        assert "Nil UUID (all zeros) is not allowed" in str(exc_info.value.field_errors["test_field"])
    
    def test_validate_optional_types(self):
        """Test validation of Optional types."""
        validator = TypeConstraintValidator()
        
        # None value for Optional type
        result = validator.validate_type_constraint(
            None, Optional[str], "test_field"
        )
        assert result is None
        
        # Non-None value for Optional type
        result = validator.validate_type_constraint(
            "test", Optional[str], "test_field"
        )
        assert result == "test"
    
    def test_validate_type_mismatch(self):
        """Test type mismatch validation."""
        validator = TypeConstraintValidator()
        
        # Wrong type
        with pytest.raises(ValidationError) as exc_info:
            validator.validate_type_constraint(
                "not an int", int, "test_field"
            )
        assert "Expected int, got str" in str(exc_info.value.field_errors["test_field"])
        
        # None for non-Optional type
        with pytest.raises(ValidationError) as exc_info:
            validator.validate_type_constraint(
                None, str, "test_field"
            )
        assert "Required field cannot be None" in str(exc_info.value.field_errors["test_field"])


class TestEntityProtocolChecker:
    """Test entity protocol compliance checking."""
    
    def test_check_validatable_entity_valid(self):
        """Test valid ValidatableEntity implementation."""
        
        class MockValidatableEntity:
            def validate(self):
                return True
            
            def get_validation_errors(self):
                return {}
        
        checker = EntityProtocolChecker()
        result = checker.check_validatable_entity(MockValidatableEntity())
        assert result is True
    
    def test_check_validatable_entity_missing_validate(self):
        """Test ValidatableEntity missing validate method."""
        
        class IncompleteEntity:
            def get_validation_errors(self):
                return {}
        
        checker = EntityProtocolChecker()
        
        with pytest.raises(ValidationError) as exc_info:
            checker.check_validatable_entity(IncompleteEntity())
        
        assert "Missing validate() method" in str(exc_info.value.field_errors["entity"])
    
    def test_check_validatable_entity_missing_get_validation_errors(self):
        """Test ValidatableEntity missing get_validation_errors method."""
        
        class IncompleteEntity:
            def validate(self):
                return True
        
        checker = EntityProtocolChecker()
        
        with pytest.raises(ValidationError) as exc_info:
            checker.check_validatable_entity(IncompleteEntity())
        
        assert "Missing get_validation_errors() method" in str(exc_info.value.field_errors["entity"])
    
    def test_check_timestamped_entity_valid(self):
        """Test valid TimestampedEntity implementation."""
        
        class MockTimestampedEntity:
            created_at = datetime.now()
            updated_at = datetime.now()
        
        checker = EntityProtocolChecker()
        result = checker.check_timestamped_entity(MockTimestampedEntity())
        assert result is True
    
    def test_check_timestamped_entity_missing_attributes(self):
        """Test TimestampedEntity missing required attributes."""
        
        class IncompleteEntity:
            created_at = datetime.now()
            # Missing updated_at
        
        checker = EntityProtocolChecker()
        
        with pytest.raises(ValidationError) as exc_info:
            checker.check_timestamped_entity(IncompleteEntity())
        
        assert "Missing timestamp attributes" in str(exc_info.value.field_errors["entity"])
        assert "updated_at" in str(exc_info.value.field_errors["entity"])
    
    def test_check_versioned_entity_valid(self):
        """Test valid VersionedEntity implementation."""
        
        class MockVersionedEntity:
            version = "1.0"
            last_modified_by = "user123"
        
        checker = EntityProtocolChecker()
        result = checker.check_versioned_entity(MockVersionedEntity())
        assert result is True
    
    def test_check_versioned_entity_missing_attributes(self):
        """Test VersionedEntity missing required attributes."""
        
        class IncompleteEntity:
            version = "1.0"
            # Missing last_modified_by
        
        checker = EntityProtocolChecker()
        
        with pytest.raises(ValidationError) as exc_info:
            checker.check_versioned_entity(IncompleteEntity())
        
        assert "Missing version attributes" in str(exc_info.value.field_errors["entity"])
        assert "last_modified_by" in str(exc_info.value.field_errors["entity"])


class TestRepositoryTypeChecker:
    """Test repository type checking functionality."""
    
    def test_validate_method_signature_valid(self):
        """Test valid method signature validation."""
        
        class MockRepository:
            def test_method(self, param1: str, param2: int = 10):
                return "test"
        
        checker = RepositoryTypeChecker(MockRepository)
        
        # Valid call with positional args
        result = checker.validate_method_signature("test_method", "hello", 20)
        assert result is True
        
        # Valid call with keyword args
        result = checker.validate_method_signature("test_method", "hello", param2=30)
        assert result is True
        
        # Valid call with default parameter
        result = checker.validate_method_signature("test_method", "hello")
        assert result is True
    
    def test_validate_method_signature_invalid(self):
        """Test invalid method signature validation."""
        
        class MockRepository:
            def test_method(self, param1: str, param2: int = 10):
                return "test"
        
        checker = RepositoryTypeChecker(MockRepository)
        
        # Method not found
        with pytest.raises(ValidationError) as exc_info:
            checker.validate_method_signature("nonexistent_method", "hello")
        
        assert "Unknown method 'nonexistent_method'" in str(exc_info.value.field_errors["method"])
        
        # Wrong number of arguments
        with pytest.raises(ValidationError) as exc_info:
            checker.validate_method_signature("test_method")  # Missing required param1
        
        assert "Signature mismatch" in str(exc_info.value.field_errors["arguments"])
    
    def test_validate_return_type(self):
        """Test return type validation."""
        
        class MockRepository:
            def get_string(self) -> str:
                return "test"
            
            def get_int(self) -> int:
                return 42
        
        checker = RepositoryTypeChecker(MockRepository)
        
        # Valid return types
        assert checker.validate_return_type("get_string", "hello") is True
        assert checker.validate_return_type("get_int", 42) is True
        
        # Invalid return type (with warning, not exception)
        assert checker.validate_return_type("get_string", 123) is False
    
    def test_non_callable_attribute(self):
        """Test validation of non-callable attributes."""
        
        class MockRepository:
            test_attribute = "not a method"
        
        checker = RepositoryTypeChecker(MockRepository)
        
        with pytest.raises(ValidationError) as exc_info:
            checker.validate_method_signature("test_attribute", "arg")
        
        assert "is not a method" in str(exc_info.value.field_errors["method"])


class TestUtilityFunctions:
    """Test utility functions for type checking."""
    
    def test_ensure_entity_compliance(self):
        """Test entity protocol compliance enforcement."""
        
        class ValidEntity:
            created_at = datetime.now()
            updated_at = datetime.now()
            
            def validate(self):
                return True
            
            def get_validation_errors(self):
                return {}
        
        # Should not raise exception
        ensure_entity_compliance(ValidEntity(), [TimestampedEntity, ValidatableEntity])
    
    def test_ensure_entity_compliance_failure(self):
        """Test entity protocol compliance failure."""
        
        class InvalidEntity:
            pass
        
        with pytest.raises(ValidationError):
            ensure_entity_compliance(InvalidEntity(), [TimestampedEntity])
    
    def test_validate_repository_constraints(self):
        """Test repository constraint validation."""
        data = {
            "name": "test name",
            "age": 25,
            "email": "test@example.com"
        }
        
        field_constraints = {
            "name": {
                "type": str,
                "constraints": {"min_length": 5, "max_length": 50}
            },
            "age": {
                "type": int,
                "constraints": {"min_value": 0, "max_value": 120}
            }
        }
        
        result = validate_repository_constraints(data, field_constraints)
        
        assert result["name"] == "test name"
        assert result["age"] == 25
        assert result["email"] == "test@example.com"  # No constraints, passed through
    
    def test_validate_repository_constraints_failure(self):
        """Test repository constraint validation failure."""
        data = {
            "name": "ab",  # Too short
            "age": -5      # Too small
        }
        
        field_constraints = {
            "name": {
                "type": str,
                "constraints": {"min_length": 5}
            },
            "age": {
                "type": int,
                "constraints": {"min_value": 0}
            }
        }
        
        with pytest.raises(ValidationError) as exc_info:
            validate_repository_constraints(data, field_constraints)
        
        errors = exc_info.value.field_errors
        assert "name" in errors
        assert "age" in errors
    
    def test_create_type_safe_repository_decorator(self):
        """Test type-safe repository decorator creation."""
        
        class MockRepository:
            def test_method(self, param1: str) -> str:
                return f"processed: {param1}"
        
        # Create decorator
        decorator = create_type_safe_repository_decorator(MockRepository)
        
        # Mock repository instance
        repo_instance = MockRepository()
        
        # Wrap the method - must have same name as in MockRepository
        @decorator
        def test_method(self, param1: str) -> str:
            return f"processed: {param1}"
        
        # Test execution (this would normally validate types)
        result = test_method(repo_instance, "test")
        assert result == "processed: test"
    
    @patch('src.server.repositories.type_utils.RepositoryTypeChecker')
    def test_decorator_with_validation_failure(self, mock_checker_class):
        """Test decorator behavior when validation fails."""
        
        # Mock the type checker to raise an exception
        mock_checker = MagicMock()
        mock_checker.validate_method_signature.side_effect = ValidationError("Test validation error")
        mock_checker_class.return_value = mock_checker
        
        class MockRepository:
            def test_method(self, param1: str) -> str:
                return f"processed: {param1}"
        
        decorator = create_type_safe_repository_decorator(MockRepository)
        repo_instance = MockRepository()
        
        @decorator
        def wrapped_method(self, param1: str) -> str:
            return f"processed: {param1}"
        
        # Should raise validation error
        with pytest.raises(ValidationError):
            wrapped_method(repo_instance, "test")


class TestEdgeCases:
    """Test edge cases and error conditions."""
    
    def test_pattern_constraint_validation(self):
        """Test pattern constraint validation."""
        import re
        
        validator = TypeConstraintValidator()
        
        # Valid pattern match
        email_pattern = re.compile(r'^[\w\.-]+@[\w\.-]+\.\w+$')
        result = validator.validate_type_constraint(
            "test@example.com", str, "email_field",
            constraints={"pattern": email_pattern}
        )
        assert result == "test@example.com"
        
        # Invalid pattern match
        with pytest.raises(ValidationError) as exc_info:
            validator.validate_type_constraint(
                "not-an-email", str, "email_field",
                constraints={"pattern": email_pattern}
            )
        assert "does not match required pattern" in str(exc_info.value.field_errors["email_field"])
    
    def test_complex_nested_type_validation(self):
        """Test validation of complex nested types."""
        validator = TypeConstraintValidator()
        
        # Test with Union types (like Optional)
        from typing import Union
        
        # String value for Union[str, int]
        result = validator.validate_type_constraint(
            "test", Union[str, int], "union_field"
        )
        assert result == "test"
        
        # Integer value for Union[str, int]
        result = validator.validate_type_constraint(
            42, Union[str, int], "union_field"
        )
        assert result == 42
    
    def test_custom_constraint_combinations(self):
        """Test combinations of multiple constraints."""
        validator = TypeConstraintValidator()
        
        # Multiple string constraints
        result = validator.validate_type_constraint(
            "  HELLO WORLD  ", str, "test_field",
            constraints={
                "strip_whitespace": True,
                "lowercase": True,
                "min_length": 5,
                "max_length": 20
            }
        )
        assert result == "hello world"
        
        # Multiple integer constraints  
        result = validator.validate_type_constraint(
            50, int, "test_field",
            constraints={
                "min_value": 10,
                "max_value": 100,
                "allowed_values": [25, 50, 75]
            }
        )
        assert result == 50
    
    def test_constraint_override_precedence(self):
        """Test that custom constraints override defaults."""
        validator = TypeConstraintValidator()
        
        # Override default string constraints (allow_empty is False by default)
        result = validator.validate_type_constraint(
            "", str, "test_field",
            constraints={"allow_empty": True}  # Override default
        )
        assert result == ""
        
        # Override default integer constraints
        result = validator.validate_type_constraint(
            -10, int, "test_field",
            constraints={"min_value": -20}  # Override default
        )
        assert result == -10
    
    def test_type_hint_extraction_edge_cases(self):
        """Test edge cases in type hint extraction."""
        validator = TypeConstraintValidator()
        
        # Test _get_base_type with complex Union
        from typing import Union, List
        
        # Optional[str] -> str
        base_type = validator._get_base_type(Optional[str])
        assert base_type == str
        
        # Union[str, int, None] should return original (complex Union)
        complex_union = Union[str, int, List[str]]
        base_type = validator._get_base_type(complex_union)
        assert base_type == complex_union
        
        # Regular type should return as-is
        base_type = validator._get_base_type(str)
        assert base_type == str
    
    def test_boolean_strict_mode(self):
        """Test strict boolean validation mode."""
        validator = TypeConstraintValidator()
        
        # True boolean should pass
        result = validator.validate_type_constraint(
            True, bool, "test_field",
            constraints={"strict_boolean": True}
        )
        assert result is True
        
        # False boolean should pass
        result = validator.validate_type_constraint(
            False, bool, "test_field",
            constraints={"strict_boolean": True}
        )
        assert result is False
        
        # Non-boolean truthy value should fail in strict mode
        with pytest.raises(ValidationError) as exc_info:
            validator.validate_type_constraint(
                1, bool, "test_field",  # 1 is truthy but not bool
                constraints={"strict_boolean": True}
            )
        assert "Expected bool, got int" in str(exc_info.value.field_errors["test_field"])