"""
Settings and configuration repository interfaces.

This module contains repository interfaces for system configuration:
- ISettingsRepository: Manages archon_settings table with encryption support
- IPromptRepository: Manages archon_prompts table for AI prompt templates

These interfaces extend the base repository with domain-specific operations
for configuration management, encryption/decryption, and prompt versioning.
"""

from abc import abstractmethod
from typing import Any

from .base_repository import IBaseRepository


class ISettingsRepository(IBaseRepository[dict[str, Any]]):
    """
    Repository interface for archon_settings table.
    
    Manages system settings and user preferences with support for encrypted values.
    Provides categorized access and secure credential storage.
    
    Table Schema (archon_settings):
    - id (UUID): Primary key
    - key (str): Unique setting key identifier
    - value (text): Setting value (plain text or encrypted)
    - category (str): Setting category for organization
    - description (text): Human-readable description
    - is_encrypted (bool): Whether the value is encrypted
    - is_user_configurable (bool): Whether users can modify this setting
    - default_value (text): Default value for the setting
    - validation_regex (text): Optional regex for value validation
    - created_at (timestamp): Creation timestamp
    - updated_at (timestamp): Last update timestamp
    """

    @abstractmethod
    async def get_by_key(self, key: str) -> dict[str, Any] | None:
        """
        Retrieve a setting by its unique key.
        
        Args:
            key: Unique setting key identifier
            
        Returns:
            Setting record if found, None otherwise
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass

    @abstractmethod
    async def get_by_category(self, category: str) -> list[dict[str, Any]]:
        """
        Retrieve all settings within a specific category.
        
        Args:
            category: Category name to filter by
            
        Returns:
            List of settings in the category, ordered by key
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass

    @abstractmethod
    async def upsert(
        self,
        key: str,
        value: str,
        category: str = "general",
        description: str | None = None,
        encrypted: bool = False,
        user_configurable: bool = True,
        default_value: str | None = None,
        validation_regex: str | None = None
    ) -> dict[str, Any]:
        """
        Insert or update a setting with the given key.
        
        Args:
            key: Unique setting key identifier
            value: Setting value to store
            category: Setting category for organization
            description: Human-readable description
            encrypted: Whether to encrypt the value before storage
            user_configurable: Whether users can modify this setting
            default_value: Default value for the setting
            validation_regex: Optional regex pattern for value validation
            
        Returns:
            Created or updated setting record
            
        Raises:
            RepositoryError: If upsert fails due to database errors
            ValidationError: If value doesn't match validation_regex
            EncryptionError: If encryption fails for encrypted settings
        """
        pass

    @abstractmethod
    async def get_decrypted(self, key: str) -> str | None:
        """
        Retrieve and decrypt a setting value by key.
        
        Args:
            key: Setting key to retrieve
            
        Returns:
            Decrypted setting value if found, None otherwise
            
        Raises:
            RepositoryError: If query fails due to database errors
            DecryptionError: If decryption fails for encrypted settings
        """
        pass

    @abstractmethod
    async def set_encrypted(
        self,
        key: str,
        value: str,
        category: str = "credentials"
    ) -> dict[str, Any]:
        """
        Store an encrypted setting value.
        
        Args:
            key: Setting key identifier
            value: Plain text value to encrypt and store
            category: Setting category (defaults to 'credentials')
            
        Returns:
            Created or updated setting record
            
        Raises:
            RepositoryError: If storage fails due to database errors
            EncryptionError: If encryption fails
        """
        pass

    @abstractmethod
    async def get_user_configurable(self) -> list[dict[str, Any]]:
        """
        Retrieve all settings that users can configure.
        
        Returns:
            List of user-configurable settings, grouped by category
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass

    @abstractmethod
    async def get_defaults(self) -> dict[str, str]:
        """
        Get default values for all settings.
        
        Returns:
            Dictionary mapping setting keys to their default values
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass

    @abstractmethod
    async def reset_to_default(self, key: str) -> dict[str, Any] | None:
        """
        Reset a setting to its default value.
        
        Args:
            key: Setting key to reset
            
        Returns:
            Updated setting record if found, None otherwise
            
        Raises:
            RepositoryError: If reset fails due to database errors
        """
        pass

    @abstractmethod
    async def validate_setting(self, key: str, value: str) -> bool:
        """
        Validate a setting value against its validation regex.
        
        Args:
            key: Setting key to validate
            value: Value to validate
            
        Returns:
            True if value is valid or no validation regex exists, False otherwise
            
        Raises:
            RepositoryError: If validation check fails due to database errors
        """
        pass

    @abstractmethod
    async def get_categories(self) -> list[str]:
        """
        Get all distinct setting categories.
        
        Returns:
            List of unique category names
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass

    @abstractmethod
    async def bulk_update_category(
        self,
        category: str,
        updates: dict[str, str]
    ) -> list[dict[str, Any]]:
        """
        Update multiple settings within a category.
        
        Args:
            category: Category to update settings for
            updates: Dictionary mapping setting keys to new values
            
        Returns:
            List of updated setting records
            
        Raises:
            RepositoryError: If bulk update fails due to database errors
            ValidationError: If any value fails validation
        """
        pass

    @abstractmethod
    async def export_settings(
        self,
        category_filter: str | None = None,
        include_encrypted: bool = False
    ) -> dict[str, Any]:
        """
        Export settings for backup or transfer.
        
        Args:
            category_filter: Optional category to filter export by
            include_encrypted: Whether to include encrypted settings (still encrypted)
            
        Returns:
            Dictionary containing exported settings with metadata
            
        Raises:
            RepositoryError: If export fails due to database errors
        """
        pass

    @abstractmethod
    async def import_settings(
        self,
        settings_data: dict[str, Any],
        overwrite_existing: bool = False
    ) -> dict[str, Any]:
        """
        Import settings from exported data.
        
        Args:
            settings_data: Settings data to import
            overwrite_existing: Whether to overwrite existing settings
            
        Returns:
            Import result summary with counts and errors
            
        Raises:
            RepositoryError: If import fails due to database errors
            ValidationError: If imported data is invalid
        """
        pass


class IPromptRepository(IBaseRepository[dict[str, Any]]):
    """
    Repository interface for archon_prompts table.
    
    Manages AI prompt templates with versioning and categorization.
    Supports prompt chains, variables, and performance tracking.
    
    Table Schema (archon_prompts):
    - id (UUID): Primary key
    - name (str): Unique prompt name identifier
    - title (str): Human-readable prompt title
    - content (text): Prompt template content with variables
    - category (str): Prompt category for organization
    - version (str): Prompt version identifier
    - variables (JSONB): Array of variable definitions and defaults
    - metadata (JSONB): Prompt metadata (usage stats, performance, etc.)
    - is_active (bool): Whether this prompt version is active
    - is_system (bool): Whether this is a system prompt (not user-editable)
    - created_by (str): Agent or user who created this prompt
    - created_at (timestamp): Creation timestamp
    - updated_at (timestamp): Last update timestamp
    """

    @abstractmethod
    async def get_by_name(self, name: str, version: str | None = None) -> dict[str, Any] | None:
        """
        Retrieve a prompt by name and optional version.
        
        Args:
            name: Unique prompt name identifier
            version: Specific version to retrieve (defaults to active version)
            
        Returns:
            Prompt record if found, None otherwise
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass

    @abstractmethod
    async def get_by_category(self, category: str) -> list[dict[str, Any]]:
        """
        Retrieve all active prompts within a specific category.
        
        Args:
            category: Category name to filter by
            
        Returns:
            List of active prompts in the category, ordered by name
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass

    @abstractmethod
    async def create_version(
        self,
        name: str,
        title: str,
        content: str,
        category: str = "general",
        version: str | None = None,
        variables: list[dict[str, Any]] | None = None,
        metadata: dict[str, Any] | None = None,
        created_by: str = "system",
        is_active: bool = True
    ) -> dict[str, Any]:
        """
        Create a new version of a prompt.
        
        Args:
            name: Unique prompt name identifier
            title: Human-readable prompt title
            content: Prompt template content
            category: Prompt category for organization
            version: Version identifier (auto-generated if None)
            variables: List of variable definitions
            metadata: Additional prompt metadata
            created_by: Agent or user creating the prompt
            is_active: Whether to make this the active version
            
        Returns:
            Created prompt version record
            
        Raises:
            RepositoryError: If creation fails due to database errors
            ValidationError: If prompt content or variables are invalid
        """
        pass

    @abstractmethod
    async def set_active_version(self, name: str, version: str) -> dict[str, Any] | None:
        """
        Set the active version for a prompt name.
        
        Args:
            name: Prompt name identifier
            version: Version to make active
            
        Returns:
            Updated prompt record if found, None otherwise
            
        Raises:
            RepositoryError: If update fails due to database errors
        """
        pass

    @abstractmethod
    async def get_versions(self, name: str) -> list[dict[str, Any]]:
        """
        Get all versions of a prompt ordered by creation date.
        
        Args:
            name: Prompt name identifier
            
        Returns:
            List of prompt versions, newest first
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass

    @abstractmethod
    async def render_prompt(
        self,
        name: str,
        variables: dict[str, Any],
        version: str | None = None
    ) -> str:
        """
        Render a prompt template with provided variables.
        
        Args:
            name: Prompt name identifier
            variables: Dictionary of variable values
            version: Specific version to render (defaults to active version)
            
        Returns:
            Rendered prompt string with variables substituted
            
        Raises:
            RepositoryError: If prompt retrieval fails
            TemplateError: If template rendering fails due to missing variables
        """
        pass

    @abstractmethod
    async def validate_variables(
        self,
        name: str,
        variables: dict[str, Any],
        version: str | None = None
    ) -> dict[str, Any]:
        """
        Validate provided variables against prompt requirements.
        
        Args:
            name: Prompt name identifier
            variables: Dictionary of variable values to validate
            version: Specific version to validate against
            
        Returns:
            Validation result with missing/invalid variables
            
        Raises:
            RepositoryError: If prompt retrieval fails
        """
        pass

    @abstractmethod
    async def get_user_prompts(self) -> list[dict[str, Any]]:
        """
        Retrieve all user-created (non-system) prompts.
        
        Returns:
            List of user prompts, grouped by category
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass

    @abstractmethod
    async def clone_prompt(
        self,
        source_name: str,
        new_name: str,
        new_title: str,
        created_by: str = "user"
    ) -> dict[str, Any]:
        """
        Clone an existing prompt to create a new prompt.
        
        Args:
            source_name: Name of prompt to clone
            new_name: Name for the new prompt
            new_title: Title for the new prompt
            created_by: Agent or user creating the clone
            
        Returns:
            Created prompt record
            
        Raises:
            RepositoryError: If cloning fails due to database errors
            EntityNotFoundError: If source prompt doesn't exist
        """
        pass

    @abstractmethod
    async def update_metadata(
        self,
        name: str,
        version: str,
        metadata_updates: dict[str, Any]
    ) -> dict[str, Any] | None:
        """
        Update metadata for a specific prompt version.
        
        Args:
            name: Prompt name identifier
            version: Prompt version identifier
            metadata_updates: Metadata fields to update
            
        Returns:
            Updated prompt record if found, None otherwise
            
        Raises:
            RepositoryError: If update fails due to database errors
        """
        pass

    @abstractmethod
    async def get_categories(self) -> list[str]:
        """
        Get all distinct prompt categories.
        
        Returns:
            List of unique category names
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass

    @abstractmethod
    async def search_prompts(
        self,
        query: str,
        category_filter: str | None = None,
        limit: int = 10
    ) -> list[dict[str, Any]]:
        """
        Search prompts by title and content.
        
        Args:
            query: Text to search for in prompt titles and content
            category_filter: Optional category to filter results
            limit: Maximum number of results to return
            
        Returns:
            List of matching prompts with relevance scoring
            
        Raises:
            RepositoryError: If search fails due to database errors
        """
        pass

    @abstractmethod
    async def get_prompt_usage_stats(self, name: str) -> dict[str, Any]:
        """
        Get usage statistics for a prompt.
        
        Args:
            name: Prompt name identifier
            
        Returns:
            Dictionary containing usage statistics and performance metrics
            
        Raises:
            RepositoryError: If stats retrieval fails due to database errors
        """
        pass

    @abstractmethod
    async def delete_version(self, name: str, version: str) -> bool:
        """
        Delete a specific version of a prompt.
        
        Args:
            name: Prompt name identifier
            version: Version to delete
            
        Returns:
            True if version was deleted, False if not found
            
        Raises:
            RepositoryError: If deletion fails due to database errors
            ValidationError: If attempting to delete the only version or active version
        """
        pass
