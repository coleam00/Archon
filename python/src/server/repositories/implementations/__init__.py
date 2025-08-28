"""
Repository implementations package.

This package contains all concrete implementations of repository interfaces,
including Supabase implementations for production use and mock implementations
for testing and development.
"""

# Main database class
from .supabase_database import SupabaseDatabase

# Supabase repository implementations
from .supabase_repositories import (
    SupabaseCodeExampleRepository,
    SupabaseDocumentRepository,
    SupabaseProjectRepository,
    SupabasePromptRepository,
    SupabaseSettingsRepository,
    SupabaseSourceRepository,
    SupabaseTaskRepository,
    SupabaseVersionRepository,
)

# Mock repository implementations for testing
from .mock_repositories import (
    MockCodeExampleRepository,
    MockDocumentRepository,
    MockProjectRepository,
    MockPromptRepository,
    MockSettingsRepository,
    MockSourceRepository,
    MockTaskRepository,
    MockVersionRepository,
)

__all__ = [
    # Main database class
    "SupabaseDatabase",
    
    # Supabase implementations
    "SupabaseCodeExampleRepository",
    "SupabaseDocumentRepository",
    "SupabaseProjectRepository",
    "SupabasePromptRepository",
    "SupabaseSettingsRepository",
    "SupabaseSourceRepository",
    "SupabaseTaskRepository",
    "SupabaseVersionRepository",
    
    # Mock implementations
    "MockCodeExampleRepository",
    "MockDocumentRepository",
    "MockProjectRepository",
    "MockPromptRepository",
    "MockSettingsRepository",
    "MockSourceRepository",
    "MockTaskRepository",
    "MockVersionRepository",
]