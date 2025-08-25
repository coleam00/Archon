"""
Repository interfaces package.

This package contains all the abstract interfaces that define the contracts
for repository implementations in the Archon Server. These interfaces follow
the Repository Pattern and provide abstraction over data access operations.

The interfaces are designed to be:
- Technology agnostic (not tied to specific database implementations)
- Type-safe using Python generics
- Async-first for modern Python applications
- Well-documented for clear contracts

Main Components:
- IBaseRepository: Generic base interface for all repositories
- IUnitOfWork: Transaction management interface
- Domain-specific repository interfaces for knowledge, projects, and settings

Usage:
    ```python
    from src.server.repositories.interfaces import IBaseRepository, IUnitOfWork
    from src.server.repositories.interfaces import ISourceRepository, IDocumentRepository
    
    class UserRepository(IBaseRepository[User]):
        # Implementation here
        pass
    ```
"""

from .base_repository import IBaseRepository
from .unit_of_work import (
    IUnitOfWork,
    ITransactionContext,
    TransactionError,
    SavepointError,
    NestedTransactionError
)

# Knowledge base repository interfaces
from .knowledge_repository import (
    ISourceRepository,
    IDocumentRepository,
    ICodeExampleRepository
)

# Project management repository interfaces
from .project_repository import (
    IProjectRepository,
    ITaskRepository,
    IVersionRepository,
    TaskStatus
)

# Settings and configuration repository interfaces
from .settings_repository import (
    ISettingsRepository,
    IPromptRepository
)

# Type variable re-export for convenience
from .base_repository import T

__all__ = [
    # Base interfaces
    "IBaseRepository",
    "IUnitOfWork", 
    "ITransactionContext",
    
    # Knowledge base interfaces
    "ISourceRepository",
    "IDocumentRepository", 
    "ICodeExampleRepository",
    
    # Project management interfaces
    "IProjectRepository",
    "ITaskRepository",
    "IVersionRepository",
    "TaskStatus",
    
    # Settings interfaces
    "ISettingsRepository",
    "IPromptRepository",
    
    # Type variables
    "T",
    
    # Exceptions
    "TransactionError",
    "SavepointError", 
    "NestedTransactionError"
]

# Version information
__version__ = "1.0.0"
__author__ = "Archon Development Team"
__description__ = "Repository pattern interfaces for Archon Server"