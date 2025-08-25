"""
Project management repository interfaces.

This module contains repository interfaces for all project management related entities:
- IProjectRepository: Manages archon_projects table with JSONB operations
- ITaskRepository: Manages archon_tasks table with status tracking
- IVersionRepository: Manages archon_document_versions table for version control

These interfaces extend the base repository with domain-specific operations
for project lifecycle management, task workflows, and document versioning.
"""

from abc import abstractmethod
from typing import List, Optional, Dict, Any, Union
from uuid import UUID
from enum import Enum

from .base_repository import IBaseRepository


class TaskStatus(str, Enum):
    """Enumeration of task status values following PRP methodology."""
    TODO = "todo"
    DOING = "doing"
    REVIEW = "review"
    DONE = "done"


class IProjectRepository(IBaseRepository[Dict[str, Any]]):
    """
    Repository interface for archon_projects table.
    
    Manages projects with JSONB fields for flexible document storage including
    PRDs (Product Requirements Documents), features, and project metadata.
    
    Table Schema (archon_projects):
    - id (UUID): Primary key
    - title (str): Project title
    - github_repo (str): Optional GitHub repository URL
    - prd (JSONB): Product Requirements Document structure
    - docs (JSONB): Array of project documents
    - features (JSONB): Array of project features
    - data (JSONB): Additional project data and configuration
    - is_pinned (bool): Whether project is pinned in UI
    - created_at (timestamp): Creation timestamp
    - updated_at (timestamp): Last update timestamp
    """
    
    @abstractmethod
    async def get_with_tasks(self, project_id: UUID) -> Optional[Dict[str, Any]]:
        """
        Retrieve a project with all associated tasks included.
        
        Args:
            project_id: UUID of the project
            
        Returns:
            Project record with tasks array if found, None otherwise
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass
    
    @abstractmethod
    async def update_jsonb_field(
        self,
        project_id: UUID,
        field_name: str,
        value: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """
        Update a specific JSONB field with new data.
        
        Args:
            project_id: UUID of the project
            field_name: Name of JSONB field to update ('prd', 'docs', 'features', 'data')
            value: New value for the JSONB field
            
        Returns:
            Updated project record if found, None otherwise
            
        Raises:
            RepositoryError: If update fails due to database errors
            ValidationError: If field_name is not a valid JSONB field
        """
        pass
    
    @abstractmethod
    async def merge_jsonb_field(
        self,
        project_id: UUID,
        field_name: str,
        value: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """
        Merge data into a JSONB field preserving existing content.
        
        Args:
            project_id: UUID of the project
            field_name: Name of JSONB field to merge into
            value: Data to merge with existing JSONB content
            
        Returns:
            Updated project record if found, None otherwise
            
        Raises:
            RepositoryError: If merge fails due to database errors
        """
        pass
    
    @abstractmethod
    async def append_to_jsonb_array(
        self,
        project_id: UUID,
        field_name: str,
        item: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """
        Append an item to a JSONB array field.
        
        Args:
            project_id: UUID of the project
            field_name: Name of JSONB array field ('docs', 'features')
            item: Item to append to the array
            
        Returns:
            Updated project record if found, None otherwise
            
        Raises:
            RepositoryError: If append fails due to database errors
        """
        pass
    
    @abstractmethod
    async def remove_from_jsonb_array(
        self,
        project_id: UUID,
        field_name: str,
        item_id: str
    ) -> Optional[Dict[str, Any]]:
        """
        Remove an item from a JSONB array field by item ID.
        
        Args:
            project_id: UUID of the project
            field_name: Name of JSONB array field
            item_id: ID of the item to remove from the array
            
        Returns:
            Updated project record if found, None otherwise
            
        Raises:
            RepositoryError: If removal fails due to database errors
        """
        pass
    
    @abstractmethod
    async def get_pinned(self) -> List[Dict[str, Any]]:
        """
        Retrieve all pinned projects.
        
        Returns:
            List of pinned projects ordered by updated_at descending
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass
    
    @abstractmethod
    async def set_pinned(self, project_id: UUID, is_pinned: bool) -> Optional[Dict[str, Any]]:
        """
        Set the pinned status of a project.
        
        Args:
            project_id: UUID of the project
            is_pinned: Whether to pin or unpin the project
            
        Returns:
            Updated project record if found, None otherwise
            
        Raises:
            RepositoryError: If update fails due to database errors
        """
        pass
    
    @abstractmethod
    async def search_by_title(self, query: str, limit: int = 10) -> List[Dict[str, Any]]:
        """
        Search projects by title using case-insensitive pattern matching.
        
        Args:
            query: Text to search for in project titles
            limit: Maximum number of results to return
            
        Returns:
            List of projects with matching titles
            
        Raises:
            RepositoryError: If search fails due to database errors
        """
        pass
    
    @abstractmethod
    async def get_project_statistics(self) -> Dict[str, Any]:
        """
        Get aggregated project statistics.
        
        Returns:
            Dictionary containing statistics:
            - total_projects: Total number of projects
            - pinned_projects: Number of pinned projects
            - with_github_repo: Number of projects with GitHub repos
            - avg_docs_per_project: Average number of documents per project
            
        Raises:
            RepositoryError: If aggregation fails due to database errors
        """
        pass
    
    @abstractmethod
    async def query_jsonb_field(
        self,
        field_name: str,
        query_path: str,
        query_value: Any,
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        """
        Query projects by JSONB field content using JSON path expressions.
        
        Args:
            field_name: Name of JSONB field to query
            query_path: JSON path expression (e.g., '$.version', '$.docs[*].title')
            query_value: Value to match at the JSON path
            limit: Maximum number of results to return
            
        Returns:
            List of projects matching the JSONB query
            
        Raises:
            RepositoryError: If JSONB query fails due to database errors
        """
        pass


class ITaskRepository(IBaseRepository[Dict[str, Any]]):
    """
    Repository interface for archon_tasks table.
    
    Manages tasks within projects following PRP methodology workflow with
    status transitions and comprehensive metadata tracking.
    
    Table Schema (archon_tasks):
    - id (UUID): Primary key
    - project_id (UUID): Foreign key to projects table
    - title (str): Task title
    - description (text): Detailed task description
    - status (str): Current task status (todo, doing, review, done)
    - assignee (str): Agent or user responsible for task
    - task_order (int): Priority/ordering within status
    - feature (str): Optional feature label for grouping
    - sources (JSONB): Array of source metadata for task context
    - code_examples (JSONB): Array of relevant code examples
    - created_at (timestamp): Creation timestamp
    - updated_at (timestamp): Last update timestamp
    """
    
    @abstractmethod
    async def get_by_project(
        self,
        project_id: UUID,
        include_closed: bool = False,
        limit: Optional[int] = None,
        offset: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        Retrieve all tasks for a specific project.
        
        Args:
            project_id: UUID of the project
            include_closed: Whether to include tasks with status 'done'
            limit: Maximum number of tasks to return
            offset: Number of tasks to skip for pagination
            
        Returns:
            List of tasks for the project, ordered by task_order descending
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass
    
    @abstractmethod
    async def get_by_status(
        self,
        project_id: UUID,
        status: TaskStatus,
        limit: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        Retrieve tasks by status within a project.
        
        Args:
            project_id: UUID of the project
            status: Task status to filter by
            limit: Maximum number of tasks to return
            
        Returns:
            List of tasks with the specified status, ordered by task_order descending
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass
    
    @abstractmethod
    async def update_status(
        self,
        task_id: UUID,
        status: TaskStatus,
        assignee: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Update task status and optionally reassign.
        
        Args:
            task_id: UUID of the task
            status: New task status
            assignee: Optional new assignee
            
        Returns:
            Updated task record if found, None otherwise
            
        Raises:
            RepositoryError: If update fails due to database errors
        """
        pass
    
    @abstractmethod
    async def archive(self, task_id: UUID) -> bool:
        """
        Archive a task (soft delete by moving to archived status).
        
        Args:
            task_id: UUID of the task to archive
            
        Returns:
            True if task was archived successfully, False if not found
            
        Raises:
            RepositoryError: If archive operation fails due to database errors
        """
        pass
    
    @abstractmethod
    async def get_by_assignee(
        self,
        assignee: str,
        status_filter: Optional[TaskStatus] = None,
        limit: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        Retrieve tasks assigned to a specific agent or user.
        
        Args:
            assignee: Agent or user identifier
            status_filter: Optional status to filter by
            limit: Maximum number of tasks to return
            
        Returns:
            List of assigned tasks, ordered by updated_at descending
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass
    
    @abstractmethod
    async def get_by_feature(
        self,
        project_id: UUID,
        feature: str,
        include_closed: bool = False
    ) -> List[Dict[str, Any]]:
        """
        Retrieve tasks grouped by feature within a project.
        
        Args:
            project_id: UUID of the project
            feature: Feature label to filter by
            include_closed: Whether to include tasks with status 'done'
            
        Returns:
            List of tasks for the feature, ordered by task_order descending
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass
    
    @abstractmethod
    async def update_task_order(
        self,
        task_id: UUID,
        new_order: int
    ) -> Optional[Dict[str, Any]]:
        """
        Update the task_order field for priority management.
        
        Args:
            task_id: UUID of the task
            new_order: New task order value (higher = higher priority)
            
        Returns:
            Updated task record if found, None otherwise
            
        Raises:
            RepositoryError: If update fails due to database errors
        """
        pass
    
    @abstractmethod
    async def add_source_reference(
        self,
        task_id: UUID,
        source: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """
        Add a source reference to task's sources JSONB array.
        
        Args:
            task_id: UUID of the task
            source: Source metadata dictionary (url, type, relevance)
            
        Returns:
            Updated task record if found, None otherwise
            
        Raises:
            RepositoryError: If update fails due to database errors
        """
        pass
    
    @abstractmethod
    async def add_code_example(
        self,
        task_id: UUID,
        code_example: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """
        Add a code example to task's code_examples JSONB array.
        
        Args:
            task_id: UUID of the task
            code_example: Code example metadata dictionary
            
        Returns:
            Updated task record if found, None otherwise
            
        Raises:
            RepositoryError: If update fails due to database errors
        """
        pass
    
    @abstractmethod
    async def get_task_statistics(self, project_id: Optional[UUID] = None) -> Dict[str, Any]:
        """
        Get aggregated task statistics.
        
        Args:
            project_id: Optional project to filter statistics by
            
        Returns:
            Dictionary containing statistics:
            - total_tasks: Total number of tasks
            - by_status: Count of tasks by status
            - by_assignee: Count of tasks by assignee
            - by_feature: Count of tasks by feature
            
        Raises:
            RepositoryError: If aggregation fails due to database errors
        """
        pass
    
    @abstractmethod
    async def bulk_update_status(
        self,
        task_ids: List[UUID],
        status: TaskStatus,
        assignee: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Update status for multiple tasks in a single operation.
        
        Args:
            task_ids: List of task UUIDs to update
            status: New status for all tasks
            assignee: Optional new assignee for all tasks
            
        Returns:
            List of updated task records
            
        Raises:
            RepositoryError: If bulk update fails due to database errors
        """
        pass


class IVersionRepository(IBaseRepository[Dict[str, Any]]):
    """
    Repository interface for archon_document_versions table.
    
    Manages document version history with automatic snapshots and rollback capabilities.
    Supports versioning of different project data fields (docs, features, prd, data).
    
    Table Schema (archon_document_versions):
    - id (UUID): Primary key
    - project_id (UUID): Foreign key to projects table
    - version_number (int): Auto-incremented version number
    - field_name (str): JSONB field being versioned ('docs', 'features', 'prd', 'data')
    - content (JSONB): Complete snapshot of the field content
    - change_summary (text): Description of changes made
    - change_type (str): Type of change ('manual', 'automatic', 'rollback')
    - created_by (str): Agent or user who created this version
    - document_id (UUID): Optional specific document ID within docs array
    - created_at (timestamp): Version creation timestamp
    """
    
    @abstractmethod
    async def create_snapshot(
        self,
        project_id: UUID,
        field_name: str,
        content: Dict[str, Any],
        change_summary: str,
        created_by: str = "system",
        change_type: str = "automatic",
        document_id: Optional[UUID] = None
    ) -> Dict[str, Any]:
        """
        Create a version snapshot of project data.
        
        Args:
            project_id: UUID of the project
            field_name: JSONB field name being versioned
            content: Complete content to snapshot
            change_summary: Description of changes made
            created_by: Agent or user creating the version
            change_type: Type of change ('manual', 'automatic', 'rollback')
            document_id: Optional specific document ID for docs field
            
        Returns:
            Created version record with auto-generated version_number
            
        Raises:
            RepositoryError: If snapshot creation fails due to database errors
        """
        pass
    
    @abstractmethod
    async def get_version_history(
        self,
        project_id: UUID,
        field_name: str,
        limit: Optional[int] = None,
        document_id: Optional[UUID] = None
    ) -> List[Dict[str, Any]]:
        """
        Get version history for a specific field.
        
        Args:
            project_id: UUID of the project
            field_name: JSONB field name to get history for
            limit: Maximum number of versions to return
            document_id: Optional specific document ID for docs field
            
        Returns:
            List of versions ordered by version_number descending (newest first)
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass
    
    @abstractmethod
    async def get_version(
        self,
        project_id: UUID,
        field_name: str,
        version_number: int
    ) -> Optional[Dict[str, Any]]:
        """
        Get a specific version by number.
        
        Args:
            project_id: UUID of the project
            field_name: JSONB field name
            version_number: Specific version number to retrieve
            
        Returns:
            Version record if found, None otherwise
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass
    
    @abstractmethod
    async def restore_version(
        self,
        project_id: UUID,
        field_name: str,
        version_number: int,
        created_by: str = "system"
    ) -> Dict[str, Any]:
        """
        Restore a project field to a previous version.
        
        This creates a new version entry and updates the project's current data.
        
        Args:
            project_id: UUID of the project
            field_name: JSONB field name to restore
            version_number: Version number to restore to
            created_by: Agent or user performing the restore
            
        Returns:
            New version record created for the restore operation
            
        Raises:
            RepositoryError: If restore fails due to database errors
            EntityNotFoundError: If specified version doesn't exist
        """
        pass
    
    @abstractmethod
    async def get_latest_version_number(
        self,
        project_id: UUID,
        field_name: str
    ) -> int:
        """
        Get the latest version number for a field.
        
        Args:
            project_id: UUID of the project
            field_name: JSONB field name
            
        Returns:
            Latest version number, or 0 if no versions exist
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass
    
    @abstractmethod
    async def delete_old_versions(
        self,
        project_id: UUID,
        field_name: str,
        keep_latest: int = 10
    ) -> int:
        """
        Delete old versions keeping only the most recent ones.
        
        Args:
            project_id: UUID of the project
            field_name: JSONB field name to clean up
            keep_latest: Number of latest versions to preserve
            
        Returns:
            Number of versions deleted
            
        Raises:
            RepositoryError: If cleanup fails due to database errors
        """
        pass
    
    @abstractmethod
    async def compare_versions(
        self,
        project_id: UUID,
        field_name: str,
        version_a: int,
        version_b: int
    ) -> Dict[str, Any]:
        """
        Compare two versions and return difference summary.
        
        Args:
            project_id: UUID of the project
            field_name: JSONB field name
            version_a: First version number for comparison
            version_b: Second version number for comparison
            
        Returns:
            Dictionary containing comparison metadata and differences
            
        Raises:
            RepositoryError: If comparison fails due to database errors
            EntityNotFoundError: If either version doesn't exist
        """
        pass
    
    @abstractmethod
    async def get_version_statistics(self, project_id: Optional[UUID] = None) -> Dict[str, Any]:
        """
        Get aggregated version statistics.
        
        Args:
            project_id: Optional project to filter statistics by
            
        Returns:
            Dictionary containing statistics:
            - total_versions: Total number of versions
            - by_field: Count of versions by field name
            - by_project: Count of versions by project
            - by_change_type: Count of versions by change type
            
        Raises:
            RepositoryError: If aggregation fails due to database errors
        """
        pass