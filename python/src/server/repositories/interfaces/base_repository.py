"""
Base repository interface defining common database operations.

This module provides the foundational IBaseRepository interface that all
domain-specific repositories should inherit from. It uses Python generics
to provide type safety while maintaining flexibility for different entity types.
"""

from abc import ABC, abstractmethod
from typing import Generic, TypeVar, Optional, List, Dict, Any, Union
from uuid import UUID


# Generic type variable for entity types
T = TypeVar('T')


class IBaseRepository(ABC, Generic[T]):
    """
    Abstract base repository interface defining common database operations.
    
    This interface provides a standardized contract for all repository implementations,
    ensuring consistent behavior across different domain entities while maintaining
    type safety through Python generics.
    
    Type Parameters:
        T: The entity type that this repository manages
    
    Example:
        ```python
        class UserRepository(IBaseRepository[User]):
            async def create(self, entity: User) -> User:
                # Implementation specific to User entities
                pass
        ```
    """
    
    @abstractmethod
    async def create(self, entity: T) -> T:
        """
        Create a new entity in the database.
        
        Args:
            entity: The entity instance to create
            
        Returns:
            The created entity with any database-generated fields populated
            
        Raises:
            RepositoryError: If creation fails due to validation or database errors
            DuplicateEntityError: If an entity with the same identifier already exists
        """
        pass
    
    @abstractmethod
    async def get_by_id(self, id: Union[str, UUID, int]) -> Optional[T]:
        """
        Retrieve an entity by its unique identifier.
        
        Args:
            id: The unique identifier of the entity (UUID, string, or integer)
            
        Returns:
            The entity if found, None otherwise
            
        Raises:
            RepositoryError: If retrieval fails due to database errors
        """
        pass
    
    @abstractmethod
    async def update(self, id: Union[str, UUID, int], data: Dict[str, Any]) -> Optional[T]:
        """
        Update an existing entity with new data.
        
        Args:
            id: The unique identifier of the entity to update
            data: Dictionary containing the fields to update and their new values
            
        Returns:
            The updated entity if found and updated successfully, None if not found
            
        Raises:
            RepositoryError: If update fails due to validation or database errors
            EntityNotFoundError: If no entity exists with the given identifier
        """
        pass
    
    @abstractmethod
    async def delete(self, id: Union[str, UUID, int]) -> bool:
        """
        Delete an entity by its unique identifier.
        
        Args:
            id: The unique identifier of the entity to delete
            
        Returns:
            True if the entity was deleted successfully, False if not found
            
        Raises:
            RepositoryError: If deletion fails due to database errors
        """
        pass
    
    @abstractmethod
    async def list(
        self, 
        filters: Optional[Dict[str, Any]] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        order_by: Optional[str] = None,
        order_direction: Optional[str] = "asc"
    ) -> List[T]:
        """
        List entities with optional filtering, pagination, and ordering.
        
        Args:
            filters: Dictionary of field-value pairs to filter by
            limit: Maximum number of entities to return
            offset: Number of entities to skip (for pagination)
            order_by: Field name to order results by
            order_direction: Sort direction - "asc" or "desc"
            
        Returns:
            List of entities matching the criteria
            
        Raises:
            RepositoryError: If query fails due to database errors
            ValidationError: If filter parameters are invalid
        """
        pass
    
    @abstractmethod
    async def count(self, filters: Optional[Dict[str, Any]] = None) -> int:
        """
        Count entities matching the given filters.
        
        Args:
            filters: Dictionary of field-value pairs to filter by
            
        Returns:
            Number of entities matching the criteria
            
        Raises:
            RepositoryError: If count query fails due to database errors
        """
        pass
    
    @abstractmethod
    async def exists(self, id: Union[str, UUID, int]) -> bool:
        """
        Check if an entity exists by its unique identifier.
        
        Args:
            id: The unique identifier to check
            
        Returns:
            True if an entity with the given ID exists, False otherwise
            
        Raises:
            RepositoryError: If existence check fails due to database errors
        """
        pass
    
    @abstractmethod
    async def create_batch(self, entities: List[T]) -> List[T]:
        """
        Create multiple entities in a single batch operation.
        
        Args:
            entities: List of entity instances to create
            
        Returns:
            List of created entities with database-generated fields populated
            
        Raises:
            RepositoryError: If batch creation fails
            ValidationError: If any entity in the batch is invalid
        """
        pass
    
    @abstractmethod
    async def update_batch(
        self, 
        updates: List[Dict[str, Any]]
    ) -> List[T]:
        """
        Update multiple entities in a single batch operation.
        
        Args:
            updates: List of dictionaries, each containing 'id' and update data
            
        Returns:
            List of updated entities
            
        Raises:
            RepositoryError: If batch update fails
            ValidationError: If update data is invalid
        """
        pass
    
    @abstractmethod
    async def delete_batch(self, ids: List[Union[str, UUID, int]]) -> int:
        """
        Delete multiple entities by their identifiers.
        
        Args:
            ids: List of unique identifiers of entities to delete
            
        Returns:
            Number of entities successfully deleted
            
        Raises:
            RepositoryError: If batch deletion fails
        """
        pass