"""
Repository validation utilities and type checking functions.

This module provides comprehensive validation utilities for repository operations,
including parameter validation, type checking, constraint verification, and
data integrity validation with detailed error reporting.
"""

import re
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Union, Type, get_type_hints, get_origin, get_args
from uuid import UUID

from .exceptions import (
    ValidationError, ConstraintViolationError, DataIntegrityError
)
from .interfaces.base_repository import (
    SortDirection, OrderingField, PaginationParams, FilterCondition,
    FilterOperator, ValidatableEntity, TimestampedEntity, VersionedEntity
)


class RepositoryValidator:
    """
    Comprehensive validator for repository operations with detailed error reporting.
    
    Provides validation for IDs, pagination parameters, ordering fields, filters,
    and entity data with support for custom validation rules and constraints.
    """
    
    # ID validation patterns
    UUID_PATTERN = re.compile(
        r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    )
    
    # Pagination limits for safety
    MAX_LIMIT = 10000
    MAX_OFFSET = 1000000
    
    # Field name validation (allows alphanumeric, underscore, dot notation)
    FIELD_NAME_PATTERN = re.compile(r'^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*$')
    
    @classmethod
    def validate_id(cls, id_value: Any, field_name: str = "id") -> Union[str, UUID, int]:
        """
        Validate and normalize entity ID with comprehensive type checking.
        
        Args:
            id_value: The ID value to validate
            field_name: Name of the field for error reporting
            
        Returns:
            Validated and normalized ID value
            
        Raises:
            ValidationError: If ID format is invalid
        """
        if id_value is None:
            raise ValidationError(
                f"{field_name} cannot be None",
                field_errors={field_name: ["ID is required"]}
            )
        
        # Handle UUID objects and strings
        if isinstance(id_value, UUID):
            return id_value
        
        if isinstance(id_value, str):
            # Try to parse as UUID first
            if cls.UUID_PATTERN.match(id_value):
                try:
                    return UUID(id_value)
                except ValueError:
                    pass
            
            # Check if it's a valid string ID (non-empty, reasonable length)
            if len(id_value.strip()) == 0:
                raise ValidationError(
                    f"{field_name} cannot be empty string",
                    field_errors={field_name: ["Empty string IDs are not allowed"]}
                )
            
            if len(id_value) > 255:
                raise ValidationError(
                    f"{field_name} too long (max 255 characters)",
                    field_errors={field_name: [f"String ID length {len(id_value)} exceeds maximum of 255"]}
                )
            
            return id_value.strip()
        
        # Handle integer IDs
        if isinstance(id_value, int):
            if id_value <= 0:
                raise ValidationError(
                    f"{field_name} must be positive integer",
                    field_errors={field_name: [f"Integer ID {id_value} must be positive"]}
                )
            
            if id_value > 9223372036854775807:  # Max signed 64-bit int
                raise ValidationError(
                    f"{field_name} exceeds maximum integer value",
                    field_errors={field_name: [f"Integer ID {id_value} exceeds maximum value"]}
                )
            
            return id_value
        
        # Invalid type
        raise ValidationError(
            f"{field_name} must be UUID, string, or integer",
            field_errors={field_name: [f"Invalid ID type {type(id_value).__name__}, expected UUID, str, or int"]}
        )
    
    @classmethod
    def validate_pagination(cls, pagination: Optional[PaginationParams]) -> Optional[PaginationParams]:
        """
        Validate pagination parameters with safety limits.
        
        Args:
            pagination: Pagination parameters to validate
            
        Returns:
            Validated pagination parameters
            
        Raises:
            ValidationError: If pagination parameters are invalid
        """
        if pagination is None:
            return None
        
        field_errors = {}
        
        # Validate limit
        if 'limit' in pagination:
            limit = pagination['limit']
            if not isinstance(limit, int):
                field_errors['limit'] = [f"Limit must be integer, got {type(limit).__name__}"]
            elif limit <= 0:
                field_errors['limit'] = ["Limit must be positive"]
            elif limit > cls.MAX_LIMIT:
                field_errors['limit'] = [f"Limit {limit} exceeds maximum of {cls.MAX_LIMIT}"]
        
        # Validate offset
        if 'offset' in pagination:
            offset = pagination['offset']
            if not isinstance(offset, int):
                field_errors['offset'] = [f"Offset must be integer, got {type(offset).__name__}"]
            elif offset < 0:
                field_errors['offset'] = ["Offset cannot be negative"]
            elif offset > cls.MAX_OFFSET:
                field_errors['offset'] = [f"Offset {offset} exceeds maximum of {cls.MAX_OFFSET}"]
        
        if field_errors:
            raise ValidationError(
                "Invalid pagination parameters",
                field_errors=field_errors
            )
        
        return pagination
    
    @classmethod
    def validate_ordering(
        cls, 
        ordering: Optional[List[OrderingField]], 
        valid_fields: Optional[List[str]] = None
    ) -> Optional[List[OrderingField]]:
        """
        Validate ordering parameters with field existence checking.
        
        Args:
            ordering: List of ordering field specifications
            valid_fields: List of valid field names (if None, field name format is checked)
            
        Returns:
            Validated ordering parameters
            
        Raises:
            ValidationError: If ordering parameters are invalid
        """
        if not ordering:
            return ordering
        
        if not isinstance(ordering, list):
            raise ValidationError(
                "Ordering must be a list",
                field_errors={'ordering': ["Expected list of OrderingField objects"]}
            )
        
        field_errors = {}
        
        for i, order_field in enumerate(ordering):
            field_key = f"ordering[{i}]"
            
            if not isinstance(order_field, dict):
                field_errors[field_key] = ["Each ordering entry must be an OrderingField dictionary"]
                continue
            
            # Validate required field name
            if 'field' not in order_field:
                field_errors[f"{field_key}.field"] = ["Field name is required"]
                continue
            
            field_name = order_field['field']
            
            # Validate field name format
            if not isinstance(field_name, str) or not cls.FIELD_NAME_PATTERN.match(field_name):
                field_errors[f"{field_key}.field"] = [
                    f"Invalid field name '{field_name}'. Must be alphanumeric with underscores and dots."
                ]
            
            # Check against valid fields list if provided
            if valid_fields is not None and field_name not in valid_fields:
                field_errors[f"{field_key}.field"] = [
                    f"Field '{field_name}' is not valid. Valid fields: {', '.join(valid_fields)}"
                ]
            
            # Validate direction
            if 'direction' in order_field:
                direction = order_field['direction']
                if isinstance(direction, str):
                    # Try to normalize to SortDirection enum
                    direction_upper = direction.upper()
                    valid_directions = {
                        'ASC': SortDirection.ASC,
                        'DESC': SortDirection.DESC,
                        'ASCENDING': SortDirection.ASCENDING,
                        'DESCENDING': SortDirection.DESCENDING
                    }
                    
                    if direction_upper in valid_directions:
                        order_field['direction'] = valid_directions[direction_upper]
                    else:
                        field_errors[f"{field_key}.direction"] = [
                            f"Invalid sort direction '{direction}'. Valid: asc, desc, ascending, descending"
                        ]
                elif not isinstance(direction, SortDirection):
                    field_errors[f"{field_key}.direction"] = [
                        f"Direction must be string or SortDirection enum, got {type(direction).__name__}"
                    ]
            
            # Validate nulls_first if present
            if 'nulls_first' in order_field:
                nulls_first = order_field['nulls_first']
                if not isinstance(nulls_first, bool):
                    field_errors[f"{field_key}.nulls_first"] = [
                        f"nulls_first must be boolean, got {type(nulls_first).__name__}"
                    ]
        
        if field_errors:
            raise ValidationError(
                "Invalid ordering parameters",
                field_errors=field_errors
            )
        
        return ordering
    
    @classmethod
    def validate_filters(
        cls, 
        filters: Optional[Dict[str, Any]], 
        valid_fields: Optional[List[str]] = None,
        field_types: Optional[Dict[str, Type]] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Validate filter parameters with type checking and field validation.
        
        Args:
            filters: Filter dictionary to validate
            valid_fields: List of valid field names
            field_types: Mapping of field names to expected types
            
        Returns:
            Validated filters
            
        Raises:
            ValidationError: If filters are invalid
        """
        if not filters:
            return filters
        
        if not isinstance(filters, dict):
            raise ValidationError(
                "Filters must be a dictionary",
                field_errors={'filters': ["Expected dictionary of field-value pairs"]}
            )
        
        field_errors = {}
        
        for field_name, filter_value in filters.items():
            # Validate field name format
            if not isinstance(field_name, str) or not cls.FIELD_NAME_PATTERN.match(field_name):
                field_errors[field_name] = [
                    f"Invalid field name '{field_name}'. Must be alphanumeric with underscores and dots."
                ]
                continue
            
            # Check against valid fields if provided
            if valid_fields is not None and field_name not in valid_fields:
                field_errors[field_name] = [
                    f"Field '{field_name}' is not valid for filtering. Valid fields: {', '.join(valid_fields)}"
                ]
                continue
            
            # Validate filter value type if field types are provided
            if field_types and field_name in field_types:
                expected_type = field_types[field_name]
                if not cls._is_type_compatible(filter_value, expected_type):
                    field_errors[field_name] = [
                        f"Invalid type for field '{field_name}'. Expected {expected_type.__name__}, "
                        f"got {type(filter_value).__name__}"
                    ]
            
            # Handle complex filter conditions
            if isinstance(filter_value, dict) and 'operator' in filter_value:
                cls._validate_filter_condition(field_name, filter_value, field_errors)
        
        if field_errors:
            raise ValidationError(
                "Invalid filter parameters",
                field_errors=field_errors
            )
        
        return filters
    
    @classmethod
    def _validate_filter_condition(cls, field_name: str, condition: Dict[str, Any], field_errors: Dict[str, List[str]]):
        """Validate complex filter condition structure."""
        required_keys = ['operator', 'value']
        missing_keys = [key for key in required_keys if key not in condition]
        
        if missing_keys:
            field_errors[field_name] = [f"Filter condition missing required keys: {', '.join(missing_keys)}"]
            return
        
        # Validate operator
        operator = condition['operator']
        if isinstance(operator, str):
            try:
                FilterOperator(operator)
            except ValueError:
                valid_operators = [op.value for op in FilterOperator]
                field_errors[field_name] = [
                    f"Invalid filter operator '{operator}'. Valid operators: {', '.join(valid_operators)}"
                ]
        elif not isinstance(operator, FilterOperator):
            field_errors[field_name] = [
                f"Operator must be string or FilterOperator enum, got {type(operator).__name__}"
            ]
    
    @classmethod
    def _is_type_compatible(cls, value: Any, expected_type: Type) -> bool:
        """Check if a value is compatible with the expected type."""
        if value is None:
            return True  # None is compatible with Optional types
        
        # Handle Union types (like Optional[T])
        origin = get_origin(expected_type)
        if origin is Union:
            type_args = get_args(expected_type)
            return any(isinstance(value, arg) for arg in type_args if arg is not type(None))
        
        # Direct type check
        return isinstance(value, expected_type)
    
    @classmethod
    def validate_entity_data(
        cls, 
        data: Dict[str, Any], 
        entity_type: Optional[Type] = None,
        required_fields: Optional[List[str]] = None,
        operation: str = "create"
    ) -> Dict[str, Any]:
        """
        Validate entity data with comprehensive field and type checking.
        
        Args:
            data: Entity data to validate
            entity_type: Expected entity type for validation
            required_fields: List of required field names
            operation: Operation type (create, update) for context
            
        Returns:
            Validated entity data
            
        Raises:
            ValidationError: If entity data is invalid
        """
        if not isinstance(data, dict):
            raise ValidationError(
                f"Entity data must be dictionary for {operation} operation",
                field_errors={'data': [f"Expected dictionary, got {type(data).__name__}"]},
                operation=operation
            )
        
        field_errors = {}
        
        # Check required fields for create operations
        if operation == "create" and required_fields:
            missing_fields = [field for field in required_fields if field not in data or data[field] is None]
            if missing_fields:
                for field in missing_fields:
                    field_errors[field] = [f"Required field '{field}' is missing or None"]
        
        # Validate individual fields if entity type is provided
        if entity_type:
            try:
                type_hints = get_type_hints(entity_type)
                for field_name, field_value in data.items():
                    if field_name in type_hints and field_value is not None:
                        expected_type = type_hints[field_name]
                        if not cls._is_type_compatible(field_value, expected_type):
                            field_errors[field_name] = [
                                f"Invalid type for field '{field_name}'. Expected {expected_type}, "
                                f"got {type(field_value).__name__}"
                            ]
            except Exception:
                # Type hint validation failed - skip type checking
                pass
        
        # Additional validation for special fields
        cls._validate_special_fields(data, field_errors, operation)
        
        if field_errors:
            raise ValidationError(
                f"Invalid entity data for {operation} operation",
                field_errors=field_errors,
                operation=operation
            )
        
        return data
    
    @classmethod
    def _validate_special_fields(cls, data: Dict[str, Any], field_errors: Dict[str, List[str]], operation: str):
        """Validate special fields like timestamps, IDs, etc."""
        
        # Validate ID fields
        for id_field in ['id', 'entity_id', 'source_id', 'project_id', 'task_id']:
            if id_field in data and data[id_field] is not None:
                try:
                    cls.validate_id(data[id_field], id_field)
                except ValidationError as e:
                    field_errors.update(e.field_errors)
        
        # Validate timestamp fields
        timestamp_fields = ['created_at', 'updated_at', 'deleted_at', 'last_modified']
        for ts_field in timestamp_fields:
            if ts_field in data and data[ts_field] is not None:
                ts_value = data[ts_field]
                if not isinstance(ts_value, (datetime, str)):
                    field_errors[ts_field] = [
                        f"Timestamp field '{ts_field}' must be datetime object or ISO string"
                    ]
                elif isinstance(ts_value, str):
                    # Try to parse ISO format
                    try:
                        datetime.fromisoformat(ts_value.replace('Z', '+00:00'))
                    except ValueError:
                        field_errors[ts_field] = [
                            f"Timestamp field '{ts_field}' must be valid ISO format"
                        ]
        
        # Validate email fields
        email_fields = ['email', 'contact_email', 'notification_email']
        email_pattern = re.compile(r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$')
        for email_field in email_fields:
            if email_field in data and data[email_field] is not None:
                email_value = data[email_field]
                if not isinstance(email_value, str) or not email_pattern.match(email_value):
                    field_errors[email_field] = [
                        f"Field '{email_field}' must be a valid email address"
                    ]
        
        # Validate URL fields
        url_fields = ['url', 'base_url', 'website_url', 'github_repo']
        url_pattern = re.compile(r'^https?://[^\s/$.?#].[^\s]*$', re.IGNORECASE)
        for url_field in url_fields:
            if url_field in data and data[url_field] is not None:
                url_value = data[url_field]
                if not isinstance(url_value, str) or not url_pattern.match(url_value):
                    field_errors[url_field] = [
                        f"Field '{url_field}' must be a valid HTTP/HTTPS URL"
                    ]
    
    @classmethod
    def validate_batch_data(
        cls,
        data_list: List[Dict[str, Any]],
        entity_type: Optional[Type] = None,
        max_batch_size: int = 1000,
        operation: str = "create"
    ) -> List[Dict[str, Any]]:
        """
        Validate batch operation data with size limits and individual validation.
        
        Args:
            data_list: List of entity data dictionaries
            entity_type: Expected entity type
            max_batch_size: Maximum allowed batch size
            operation: Batch operation type
            
        Returns:
            Validated batch data
            
        Raises:
            ValidationError: If batch data is invalid
        """
        if not isinstance(data_list, list):
            raise ValidationError(
                f"Batch data must be list for {operation} operation",
                field_errors={'batch_data': [f"Expected list, got {type(data_list).__name__}"]}
            )
        
        if len(data_list) == 0:
            raise ValidationError(
                f"Batch data cannot be empty for {operation} operation",
                field_errors={'batch_data': ["At least one item required for batch operation"]}
            )
        
        if len(data_list) > max_batch_size:
            raise ValidationError(
                f"Batch size {len(data_list)} exceeds maximum of {max_batch_size}",
                field_errors={'batch_data': [f"Batch size {len(data_list)} > {max_batch_size}"]}
            )
        
        # Validate each item in the batch
        batch_errors = {}
        for i, item_data in enumerate(data_list):
            try:
                cls.validate_entity_data(item_data, entity_type, operation=operation)
            except ValidationError as e:
                batch_errors[f"item[{i}]"] = e.field_errors
        
        if batch_errors:
            raise ValidationError(
                f"Invalid items in {operation} batch",
                field_errors=batch_errors
            )
        
        return data_list
    
    @classmethod
    def ensure_deterministic_ordering(
        cls,
        ordering: Optional[List[OrderingField]],
        default_timestamp_field: str = "created_at",
        default_id_field: str = "id"
    ) -> List[OrderingField]:
        """
        Ensure ordering is deterministic by adding default fields if needed.
        
        Args:
            ordering: Existing ordering specification
            default_timestamp_field: Default timestamp field for secondary ordering
            default_id_field: Default ID field for final ordering
            
        Returns:
            Deterministic ordering with guaranteed uniqueness
        """
        result_ordering = ordering.copy() if ordering else []
        
        # Extract field names already in ordering
        existing_fields = {field.get('field') for field in result_ordering}
        
        # Add default timestamp ordering if not present
        if default_timestamp_field not in existing_fields:
            result_ordering.append({
                'field': default_timestamp_field,
                'direction': SortDirection.DESC,
                'nulls_first': False
            })
        
        # Add ID ordering for final deterministic ordering if not present
        if default_id_field not in existing_fields:
            result_ordering.append({
                'field': default_id_field,
                'direction': SortDirection.ASC,
                'nulls_first': False
            })
        
        return result_ordering


# Convenience functions for common validations
def validate_uuid(value: Any, field_name: str = "id") -> UUID:
    """Validate and convert value to UUID."""
    validated = RepositoryValidator.validate_id(value, field_name)
    if not isinstance(validated, UUID):
        raise ValidationError(f"{field_name} must be a valid UUID")
    return validated


def validate_positive_int(value: Any, field_name: str, max_value: Optional[int] = None) -> int:
    """Validate positive integer with optional maximum."""
    if not isinstance(value, int):
        raise ValidationError(f"{field_name} must be integer")
    
    if value <= 0:
        raise ValidationError(f"{field_name} must be positive")
    
    if max_value and value > max_value:
        raise ValidationError(f"{field_name} cannot exceed {max_value}")
    
    return value


def validate_string_length(value: Any, field_name: str, min_length: int = 1, max_length: int = 255) -> str:
    """Validate string with length constraints."""
    if not isinstance(value, str):
        raise ValidationError(f"{field_name} must be string")
    
    if len(value) < min_length:
        raise ValidationError(f"{field_name} must be at least {min_length} characters")
    
    if len(value) > max_length:
        raise ValidationError(f"{field_name} cannot exceed {max_length} characters")
    
    return value