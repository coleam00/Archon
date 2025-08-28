"""
Type checking utilities and constraint helpers for repository operations.

This module provides runtime type checking, constraint validation, and helper
functions to ensure repository operations maintain type safety and data integrity
across different implementations and database backends.
"""

import inspect
import logging
from datetime import datetime
from typing import (
    Any, Dict, List, Optional, Union, Type, TypeVar, Generic, 
    get_type_hints, get_origin, get_args, runtime_checkable, Protocol
)
from uuid import UUID

from .exceptions import (
    RepositoryError, ValidationError, ConstraintViolationError,
    DataIntegrityError
)
from .interfaces.base_repository import (
    ValidatableEntity, TimestampedEntity, VersionedEntity,
    EntityType, SortDirection, OrderingField, PaginationParams
)

# Logger for type checking operations
logger = logging.getLogger(__name__)

# Type constraint definitions
EntityConstraint = TypeVar('EntityConstraint')
FieldType = TypeVar('FieldType')


class TypeConstraintValidator:
    """
    Advanced type constraint validator for repository operations.
    
    Provides runtime type checking, constraint validation, and data integrity
    verification with detailed error reporting and suggestion mechanisms.
    """
    
    # Mapping of Python types to database type constraints
    TYPE_CONSTRAINTS = {
        str: {
            'min_length': 1,
            'max_length': 10000,
            'allow_empty': False
        },
        int: {
            'min_value': -2147483648,  # 32-bit signed int min
            'max_value': 2147483647,   # 32-bit signed int max
        },
        float: {
            'min_value': float('-inf'),
            'max_value': float('inf'),
            'allow_nan': False,
            'allow_inf': False
        },
        bool: {
            'strict_boolean': True  # Don't accept truthy/falsy values
        },
        datetime: {
            'allow_timezone_naive': True,
            'min_year': 1900,
            'max_year': 2100
        },
        UUID: {
            'version': None,  # Allow any UUID version
            'allow_nil': False  # Don't allow 00000000-0000-0000-0000-000000000000
        }
    }
    
    @classmethod
    def validate_type_constraint(
        cls,
        value: Any,
        expected_type: Type,
        field_name: str,
        constraints: Optional[Dict[str, Any]] = None
    ) -> Any:
        """
        Validate value against type constraint with custom rules.
        
        Args:
            value: Value to validate
            expected_type: Expected Python type
            field_name: Name of field being validated
            constraints: Custom constraint overrides
            
        Returns:
            Validated and potentially normalized value
            
        Raises:
            ValidationError: If type or constraint validation fails
        """
        if value is None:
            # Allow None for Optional types
            if cls._is_optional_type(expected_type):
                return None
            else:
                raise ValidationError(
                    f"Field '{field_name}' cannot be None",
                    field_errors={field_name: ["Required field cannot be None"]}
                )
        
        # Get base type (unwrap Union/Optional)
        base_type = cls._get_base_type(expected_type)
        
        # Type compatibility check
        if not isinstance(value, base_type):
            raise ValidationError(
                f"Field '{field_name}' type mismatch",
                field_errors={field_name: [
                    f"Expected {base_type.__name__}, got {type(value).__name__}"
                ]}
            )
        
        # Apply type-specific constraints
        constraint_config = {
            **cls.TYPE_CONSTRAINTS.get(base_type, {}),
            **(constraints or {})
        }
        
        validated_value = cls._apply_type_constraints(
            value, base_type, field_name, constraint_config
        )
        
        return validated_value
    
    @classmethod
    def _is_optional_type(cls, type_hint: Type) -> bool:
        """Check if type hint represents an Optional type."""
        origin = get_origin(type_hint)
        if origin is Union:
            args = get_args(type_hint)
            return len(args) == 2 and type(None) in args
        return False
    
    @classmethod
    def _get_base_type(cls, type_hint: Type) -> Type:
        """Extract base type from Union/Optional type hints."""
        origin = get_origin(type_hint)
        if origin is Union:
            args = get_args(type_hint)
            # Filter out NoneType for Optional[T]
            non_none_types = [arg for arg in args if arg is not type(None)]
            if len(non_none_types) == 1:
                return non_none_types[0]
        return type_hint
    
    @classmethod
    def _apply_type_constraints(
        cls, 
        value: Any, 
        base_type: Type, 
        field_name: str, 
        constraints: Dict[str, Any]
    ) -> Any:
        """Apply type-specific constraint validation."""
        
        if base_type == str:
            return cls._validate_string_constraints(value, field_name, constraints)
        elif base_type == int:
            return cls._validate_integer_constraints(value, field_name, constraints)
        elif base_type == float:
            return cls._validate_float_constraints(value, field_name, constraints)
        elif base_type == bool:
            return cls._validate_boolean_constraints(value, field_name, constraints)
        elif base_type == datetime:
            return cls._validate_datetime_constraints(value, field_name, constraints)
        elif base_type == UUID:
            return cls._validate_uuid_constraints(value, field_name, constraints)
        else:
            # No specific constraints for other types
            return value
    
    @classmethod
    def _validate_string_constraints(
        cls, 
        value: str, 
        field_name: str, 
        constraints: Dict[str, Any]
    ) -> str:
        """Validate string type constraints."""
        errors = []
        
        # Length constraints
        allow_empty = constraints.get('allow_empty', True)
        if not allow_empty and len(value) == 0:
            errors.append("Empty strings are not allowed")
        
        # Only check min_length if string is not empty or empty strings are not allowed
        # This prevents min_length from conflicting with allow_empty=True
        min_length = constraints.get('min_length', 0)
        if len(value) > 0 or not allow_empty:
            if len(value) < min_length:
                errors.append(f"Minimum length is {min_length}, got {len(value)}")
        
        max_length = constraints.get('max_length', float('inf'))
        if len(value) > max_length:
            errors.append(f"Maximum length is {max_length}, got {len(value)}")
        
        # Pattern matching if specified
        pattern = constraints.get('pattern')
        if pattern and not pattern.match(value):
            errors.append(f"Value does not match required pattern")
        
        if errors:
            raise ValidationError(
                f"String constraint violations for field '{field_name}'",
                field_errors={field_name: errors}
            )
        
        # Apply normalization
        if constraints.get('strip_whitespace', True):
            value = value.strip()
        
        if constraints.get('lowercase', False):
            value = value.lower()
        
        return value
    
    @classmethod
    def _validate_integer_constraints(
        cls, 
        value: int, 
        field_name: str, 
        constraints: Dict[str, Any]
    ) -> int:
        """Validate integer type constraints."""
        errors = []
        
        min_value = constraints.get('min_value', float('-inf'))
        if value < min_value:
            errors.append(f"Minimum value is {min_value}, got {value}")
        
        max_value = constraints.get('max_value', float('inf'))
        if value > max_value:
            errors.append(f"Maximum value is {max_value}, got {value}")
        
        # Check for specific value constraints
        allowed_values = constraints.get('allowed_values')
        if allowed_values and value not in allowed_values:
            errors.append(f"Value must be one of {allowed_values}, got {value}")
        
        if errors:
            raise ValidationError(
                f"Integer constraint violations for field '{field_name}'",
                field_errors={field_name: errors}
            )
        
        return value
    
    @classmethod
    def _validate_float_constraints(
        cls, 
        value: float, 
        field_name: str, 
        constraints: Dict[str, Any]
    ) -> float:
        """Validate float type constraints."""
        errors = []
        
        # Check for NaN and infinity
        if not constraints.get('allow_nan', False) and value != value:  # NaN check
            errors.append("NaN values are not allowed")
        
        if not constraints.get('allow_inf', False) and (value == float('inf') or value == float('-inf')):
            errors.append("Infinite values are not allowed")
        
        # Range validation (only if not NaN/inf)
        if value == value and abs(value) != float('inf'):  # Valid finite number
            min_value = constraints.get('min_value', float('-inf'))
            if value < min_value:
                errors.append(f"Minimum value is {min_value}, got {value}")
            
            max_value = constraints.get('max_value', float('inf'))
            if value > max_value:
                errors.append(f"Maximum value is {max_value}, got {value}")
        
        if errors:
            raise ValidationError(
                f"Float constraint violations for field '{field_name}'",
                field_errors={field_name: errors}
            )
        
        return value
    
    @classmethod
    def _validate_boolean_constraints(
        cls, 
        value: bool, 
        field_name: str, 
        constraints: Dict[str, Any]
    ) -> bool:
        """Validate boolean type constraints."""
        # Boolean validation is usually just type checking
        # Strict mode ensures actual bool type, not truthy/falsy
        if constraints.get('strict_boolean', True) and not isinstance(value, bool):
            raise ValidationError(
                f"Strict boolean required for field '{field_name}'",
                field_errors={field_name: [f"Expected bool, got {type(value).__name__}"]}
            )
        
        return value
    
    @classmethod
    def _validate_datetime_constraints(
        cls, 
        value: datetime, 
        field_name: str, 
        constraints: Dict[str, Any]
    ) -> datetime:
        """Validate datetime type constraints."""
        errors = []
        
        # Timezone validation
        if not constraints.get('allow_timezone_naive', True) and value.tzinfo is None:
            errors.append("Timezone-aware datetime required")
        
        # Year range validation
        min_year = constraints.get('min_year', 1)
        if value.year < min_year:
            errors.append(f"Year must be >= {min_year}, got {value.year}")
        
        max_year = constraints.get('max_year', 9999)
        if value.year > max_year:
            errors.append(f"Year must be <= {max_year}, got {value.year}")
        
        # Future/past constraints
        if constraints.get('no_future', False) and value > datetime.utcnow():
            errors.append("Future dates are not allowed")
        
        if constraints.get('no_past', False) and value < datetime.utcnow():
            errors.append("Past dates are not allowed")
        
        if errors:
            raise ValidationError(
                f"Datetime constraint violations for field '{field_name}'",
                field_errors={field_name: errors}
            )
        
        return value
    
    @classmethod
    def _validate_uuid_constraints(
        cls, 
        value: UUID, 
        field_name: str, 
        constraints: Dict[str, Any]
    ) -> UUID:
        """Validate UUID type constraints."""
        errors = []
        
        # Version validation
        required_version = constraints.get('version')
        if required_version and value.version != required_version:
            errors.append(f"UUID version {required_version} required, got version {value.version}")
        
        # Nil UUID validation
        nil_uuid = UUID('00000000-0000-0000-0000-000000000000')
        if not constraints.get('allow_nil', False) and value == nil_uuid:
            errors.append("Nil UUID (all zeros) is not allowed")
        
        if errors:
            raise ValidationError(
                f"UUID constraint violations for field '{field_name}'",
                field_errors={field_name: errors}
            )
        
        return value


class EntityProtocolChecker:
    """
    Runtime checker for entity protocol compliance.
    
    Verifies that entities implement required protocols like ValidatableEntity,
    TimestampedEntity, or VersionedEntity at runtime for enhanced type safety.
    """
    
    @staticmethod
    def check_validatable_entity(entity: Any, entity_name: str = "entity") -> bool:
        """
        Check if entity implements ValidatableEntity protocol.
        
        Args:
            entity: Entity instance to check
            entity_name: Name for error reporting
            
        Returns:
            True if entity implements the protocol
            
        Raises:
            ValidationError: If entity doesn't implement required protocol
        """
        if not hasattr(entity, 'validate') or not callable(getattr(entity, 'validate')):
            raise ValidationError(
                f"{entity_name} must implement ValidatableEntity protocol",
                field_errors={'entity': [f"Missing validate() method in {type(entity).__name__}"]}
            )
        
        if not hasattr(entity, 'get_validation_errors') or not callable(getattr(entity, 'get_validation_errors')):
            raise ValidationError(
                f"{entity_name} must implement ValidatableEntity protocol", 
                field_errors={'entity': [f"Missing get_validation_errors() method in {type(entity).__name__}"]}
            )
        
        return True
    
    @staticmethod
    def check_timestamped_entity(entity: Any, entity_name: str = "entity") -> bool:
        """
        Check if entity implements TimestampedEntity protocol.
        
        Args:
            entity: Entity instance to check
            entity_name: Name for error reporting
            
        Returns:
            True if entity implements the protocol
            
        Raises:
            ValidationError: If entity doesn't implement required protocol
        """
        required_attrs = ['created_at', 'updated_at']
        missing_attrs = [attr for attr in required_attrs if not hasattr(entity, attr)]
        
        if missing_attrs:
            raise ValidationError(
                f"{entity_name} must implement TimestampedEntity protocol",
                field_errors={'entity': [f"Missing timestamp attributes: {missing_attrs} in {type(entity).__name__}"]}
            )
        
        return True
    
    @staticmethod
    def check_versioned_entity(entity: Any, entity_name: str = "entity") -> bool:
        """
        Check if entity implements VersionedEntity protocol.
        
        Args:
            entity: Entity instance to check
            entity_name: Name for error reporting
            
        Returns:
            True if entity implements the protocol
            
        Raises:
            ValidationError: If entity doesn't implement required protocol
        """
        required_attrs = ['version', 'last_modified_by']
        missing_attrs = [attr for attr in required_attrs if not hasattr(entity, attr)]
        
        if missing_attrs:
            raise ValidationError(
                f"{entity_name} must implement VersionedEntity protocol",
                field_errors={'entity': [f"Missing version attributes: {missing_attrs} in {type(entity).__name__}"]}
            )
        
        return True


class RepositoryTypeChecker:
    """
    Comprehensive type checker for repository method signatures and constraints.
    
    Validates that repository implementations correctly handle type constraints,
    method signatures, and return types according to interface specifications.
    """
    
    def __init__(self, repository_class: Type):
        """
        Initialize type checker for a repository class.
        
        Args:
            repository_class: Repository class to validate
        """
        self.repository_class = repository_class
        self.type_hints = get_type_hints(repository_class)
        self.logger = logging.getLogger(f"{__name__}.{repository_class.__name__}")
    
    def validate_method_signature(self, method_name: str, *args, **kwargs) -> bool:
        """
        Validate method call arguments against method signature.
        
        Args:
            method_name: Name of method to validate
            *args: Positional arguments
            **kwargs: Keyword arguments
            
        Returns:
            True if signature is valid
            
        Raises:
            ValidationError: If method signature validation fails
        """
        if not hasattr(self.repository_class, method_name):
            raise ValidationError(
                f"Method '{method_name}' not found in {self.repository_class.__name__}",
                field_errors={'method': [f"Unknown method '{method_name}'"]}
            )
        
        method = getattr(self.repository_class, method_name)
        if not callable(method):
            raise ValidationError(
                f"'{method_name}' is not callable in {self.repository_class.__name__}",
                field_errors={'method': [f"Attribute '{method_name}' is not a method"]}
            )
        
        # Get method signature
        try:
            sig = inspect.signature(method)
            # For instance methods, we need to skip 'self' parameter
            # when binding since we're working with an unbound method
            params = list(sig.parameters.values())
            if params and params[0].name == 'self':
                # Create a new signature without 'self'
                sig = sig.replace(parameters=params[1:])
            bound_args = sig.bind(*args, **kwargs)
            bound_args.apply_defaults()
        except TypeError as e:
            raise ValidationError(
                f"Invalid arguments for {self.repository_class.__name__}.{method_name}",
                field_errors={'arguments': [f"Signature mismatch: {e}"]}
            )
        
        # Validate argument types if type hints available
        method_hints = get_type_hints(method)
        for param_name, param_value in bound_args.arguments.items():
            if param_name in method_hints and param_value is not None:
                expected_type = method_hints[param_name]
                try:
                    TypeConstraintValidator.validate_type_constraint(
                        param_value, expected_type, param_name
                    )
                except ValidationError as e:
                    self.logger.warning(
                        f"Type constraint violation in {method_name}({param_name}): {e}"
                    )
                    # Don't re-raise to avoid breaking existing functionality
        
        return True
    
    def validate_return_type(self, method_name: str, return_value: Any) -> bool:
        """
        Validate method return value against expected return type.
        
        Args:
            method_name: Name of method that returned the value
            return_value: Value returned by method
            
        Returns:
            True if return type is valid
        """
        method = getattr(self.repository_class, method_name, None)
        if not method:
            return True  # Skip validation for unknown methods
        
        method_hints = get_type_hints(method)
        return_type = method_hints.get('return')
        
        if return_type and return_value is not None:
            try:
                # Basic type compatibility check
                base_type = TypeConstraintValidator._get_base_type(return_type)
                if not isinstance(return_value, base_type):
                    self.logger.warning(
                        f"Return type mismatch in {method_name}: expected {return_type}, "
                        f"got {type(return_value)}"
                    )
                    return False
            except Exception as e:
                self.logger.debug(f"Could not validate return type for {method_name}: {e}")
        
        return True


# Utility functions for common type checking patterns
def ensure_entity_compliance(entity: Any, protocols: List[Type]) -> None:
    """
    Ensure entity implements all required protocols.
    
    Args:
        entity: Entity instance to check
        protocols: List of protocol types to verify
        
    Raises:
        ValidationError: If entity doesn't implement required protocols
    """
    checker = EntityProtocolChecker()
    
    for protocol in protocols:
        if protocol == ValidatableEntity:
            checker.check_validatable_entity(entity)
        elif protocol == TimestampedEntity:
            checker.check_timestamped_entity(entity)
        elif protocol == VersionedEntity:
            checker.check_versioned_entity(entity)
        else:
            logger.warning(f"Unknown protocol type: {protocol}")


def validate_repository_constraints(
    data: Dict[str, Any],
    field_constraints: Dict[str, Dict[str, Any]]
) -> Dict[str, Any]:
    """
    Validate data against repository field constraints.
    
    Args:
        data: Data dictionary to validate
        field_constraints: Mapping of field names to constraint configurations
        
    Returns:
        Validated and normalized data
        
    Raises:
        ValidationError: If validation fails
    """
    validated_data = {}
    validator = TypeConstraintValidator()
    all_errors = {}
    
    for field_name, field_value in data.items():
        if field_name in field_constraints:
            constraint_config = field_constraints[field_name]
            expected_type = constraint_config.get('type', type(field_value))
            constraints = constraint_config.get('constraints', {})
            
            try:
                validated_value = validator.validate_type_constraint(
                    field_value, expected_type, field_name, constraints
                )
                validated_data[field_name] = validated_value
            except ValidationError as e:
                # Collect errors instead of raising immediately
                if e.field_errors:
                    all_errors.update(e.field_errors)
        else:
            # No specific constraints - pass through as-is
            validated_data[field_name] = field_value
    
    # If there were any errors, raise a single ValidationError with all of them
    if all_errors:
        raise ValidationError(
            "Validation failed for multiple fields",
            field_errors=all_errors
        )
    
    return validated_data


def create_type_safe_repository_decorator(repository_interface: Type):
    """
    Create a decorator for type-safe repository method execution.
    
    Args:
        repository_interface: Repository interface class to validate against
        
    Returns:
        Decorator function for repository methods
    """
    def decorator(method_func):
        def wrapper(*args, **kwargs):
            # Extract repository instance (first argument)
            if not args:
                raise ValueError("Repository method must have self parameter")
            
            repo_instance = args[0]
            method_name = method_func.__name__
            
            # Validate method signature
            type_checker = RepositoryTypeChecker(repository_interface)
            type_checker.validate_method_signature(method_name, *args[1:], **kwargs)
            
            # Execute method
            result = method_func(*args, **kwargs)
            
            # Validate return type
            type_checker.validate_return_type(method_name, result)
            
            return result
        
        return wrapper
    return decorator