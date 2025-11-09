"""State Manager Module

Manages agent work order state with pluggable storage backends.
Supports both in-memory (development) and file-based (production) storage.
"""

from .file_state_repository import FileStateRepository
from .repository_factory import create_repository
from .work_order_repository import WorkOrderRepository

__all__ = [
    "WorkOrderRepository",
    "FileStateRepository",
    "create_repository",
]
