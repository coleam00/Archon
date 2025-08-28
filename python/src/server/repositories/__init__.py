"""
Repository pattern implementation for Archon Server.

This package implements the Repository Pattern to abstract database operations
and provide a clean separation between business logic and data access layers.
It includes both abstract interfaces and concrete implementations.

Package Structure:
- interfaces/: Abstract repository interfaces and contracts
- implementations/: Concrete database-specific implementations (to be added)

The repository pattern provides:
- Database abstraction and technology independence
- Improved testability through interface-based design
- Centralized data access logic
- Transaction management capabilities
- Type safety through Python generics

Example Usage:
    ```python
    from fastapi import Depends
    from src.server.repositories.interfaces import IUnitOfWork
    from src.server.core.dependencies import get_database

    # Dependency injection in FastAPI route
    async def get_users(db: IUnitOfWork = Depends(get_database)):
        user_repository = db.users
        users = await user_repository.list(filters={"active": True})
        return users
    ```
"""

# Import interfaces for easy access
from .interfaces import (
    IBaseRepository,
    ITransactionContext,
    IUnitOfWork,
    NestedTransactionError,
    SavepointError,
    EntityType,
    TransactionError,
)

__all__ = [
    # Interfaces
    "IBaseRepository",
    "IUnitOfWork",
    "ITransactionContext",

    # Type variables
    "EntityType",

    # Exceptions
    "TransactionError",
    "SavepointError",
    "NestedTransactionError"
]

# Package metadata
__version__ = "1.0.0"
__author__ = "Archon Development Team"
__description__ = "Repository pattern implementation for database abstraction"

