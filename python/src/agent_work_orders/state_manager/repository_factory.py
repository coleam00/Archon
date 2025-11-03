"""Repository Factory

Creates appropriate repository instances based on configuration.
Supports in-memory (dev/testing), file-based (legacy), and Supabase (production) storage.
"""

import os

from ..config import config
from ..utils.structured_logger import get_logger
from .file_state_repository import FileStateRepository
from .supabase_repository import SupabaseWorkOrderRepository
from .work_order_repository import WorkOrderRepository

logger = get_logger(__name__)

# Supported storage types
SUPPORTED_STORAGE_TYPES = ["memory", "file", "supabase"]


def create_repository() -> WorkOrderRepository | FileStateRepository | SupabaseWorkOrderRepository:
    """Create a work order repository based on configuration

    Returns:
        Repository instance (in-memory, file-based, or Supabase)

    Raises:
        ValueError: If Supabase is configured but credentials are missing, or if storage_type is invalid
    """
    storage_type = config.STATE_STORAGE_TYPE.lower()

    if storage_type == "supabase":
        # Validate Supabase credentials before creating repository
        supabase_url = os.getenv("SUPABASE_URL")
        supabase_key = os.getenv("SUPABASE_SERVICE_KEY")

        if not supabase_url or not supabase_key:
            error_msg = (
                "Supabase storage is configured (STATE_STORAGE_TYPE=supabase) but required "
                "credentials are missing. Set SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables."
            )
            logger.error(
                "supabase_credentials_missing",
                storage_type="supabase",
                missing_url=not bool(supabase_url),
                missing_key=not bool(supabase_key),
            )
            raise ValueError(error_msg)

        logger.info("repository_created", storage_type="supabase")
        return SupabaseWorkOrderRepository()
    elif storage_type == "file":
        state_dir = config.FILE_STATE_DIRECTORY
        logger.info(
            "repository_created",
            storage_type="file",
            state_directory=state_dir
        )
        return FileStateRepository(state_dir)
    elif storage_type == "memory":
        logger.info(
            "repository_created",
            storage_type="memory"
        )
        return WorkOrderRepository()
    else:
        error_msg = (
            f"Invalid storage type '{storage_type}'. "
            f"Supported types are: {', '.join(SUPPORTED_STORAGE_TYPES)}"
        )
        logger.error(
            "invalid_storage_type",
            storage_type=storage_type,
            supported_types=SUPPORTED_STORAGE_TYPES,
        )
        raise ValueError(error_msg)
