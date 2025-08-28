"""
Core module for dependency injection and system configuration.

This module provides the fundamental infrastructure for dependency injection,
database management, and system configuration used throughout the application.
"""

from .dependencies import (
    DatabaseConfig,
    DatabaseProvider,
    get_database,
    get_database_config,
    set_database_config,
    setup_database,
    teardown_database,
    create_database_instance,
)

__all__ = [
    "DatabaseConfig",
    "DatabaseProvider", 
    "get_database",
    "get_database_config",
    "set_database_config",
    "setup_database",
    "teardown_database",
    "create_database_instance",
]