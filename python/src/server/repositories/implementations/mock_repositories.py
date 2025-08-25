"""
Mock repository implementations for testing.

This module contains in-memory mock implementations of all repository interfaces
for use in testing and development environments. These implementations provide
realistic behavior without requiring database connections.
"""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional, Union
from uuid import UUID, uuid4

from ..interfaces.knowledge_repository import (
    ICodeExampleRepository,
    IDocumentRepository,
    ISourceRepository
)
from ..interfaces.project_repository import (
    IProjectRepository,
    ITaskRepository,
    IVersionRepository,
    TaskStatus
)
from ..interfaces.settings_repository import (
    ISettingsRepository,
    IPromptRepository
)


class MockSourceRepository(ISourceRepository):
    """In-memory mock implementation of source repository."""
    
    def __init__(self):
        """Initialize with empty in-memory storage."""
        self._storage: Dict[str, Dict[str, Any]] = {}
        self._logger = logging.getLogger(__name__)
    
    async def create(self, entity: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new source record."""
        entity_id = entity.get('id', str(uuid4()))
        entity['id'] = entity_id
        entity['created_at'] = datetime.now().isoformat()
        entity['updated_at'] = datetime.now().isoformat()
        
        self._storage[entity_id] = entity.copy()
        return entity
    
    async def get_by_id(self, id: Union[str, UUID, int]) -> Optional[Dict[str, Any]]:
        """Retrieve source by ID."""
        return self._storage.get(str(id))
    
    async def get_by_source_id(self, source_id: str) -> Optional[Dict[str, Any]]:
        """Retrieve source by source_id."""
        for source in self._storage.values():
            if source.get('source_id') == source_id:
                return source
        return None
    
    async def update(self, id: Union[str, UUID, int], data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update source record."""
        entity_id = str(id)
        if entity_id in self._storage:
            self._storage[entity_id].update(data)
            self._storage[entity_id]['updated_at'] = datetime.now().isoformat()
            return self._storage[entity_id]
        return None
    
    async def delete(self, id: Union[str, UUID, int]) -> bool:
        """Delete source record."""
        entity_id = str(id)
        if entity_id in self._storage:
            del self._storage[entity_id]
            return True
        return False
    
    async def list(
        self,
        filters: Optional[Dict[str, Any]] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        order_by: Optional[str] = None,
        order_direction: Optional[str] = "asc"
    ) -> List[Dict[str, Any]]:
        """List sources with filtering and pagination."""
        results = list(self._storage.values())
        
        # Apply filters
        if filters:
            for key, value in filters.items():
                results = [r for r in results if r.get(key) == value]
        
        # Apply ordering
        if order_by:
            reverse = order_direction.lower() == "desc"
            results.sort(key=lambda x: x.get(order_by, ''), reverse=reverse)
        
        # Apply pagination
        if offset:
            results = results[offset:]
        if limit:
            results = results[:limit]
        
        return results
    
    async def count(self, filters: Optional[Dict[str, Any]] = None) -> int:
        """Count sources."""
        results = await self.list(filters=filters)
        return len(results)
    
    async def exists(self, id: Union[str, UUID, int]) -> bool:
        """Check if source exists."""
        return str(id) in self._storage
    
    async def create_batch(self, entities: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Create multiple sources."""
        results = []
        for entity in entities:
            result = await self.create(entity)
            results.append(result)
        return results
    
    async def update_batch(self, updates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Update multiple sources."""
        results = []
        for update_data in updates:
            if 'id' in update_data:
                entity_id = update_data.pop('id')
                result = await self.update(entity_id, update_data)
                if result:
                    results.append(result)
        return results
    
    async def delete_batch(self, ids: List[Union[str, UUID, int]]) -> int:
        """Delete multiple sources."""
        count = 0
        for entity_id in ids:
            if await self.delete(entity_id):
                count += 1
        return count
    
    # Source-specific methods
    async def update_crawl_status(
        self,
        source_id: str,
        status: str,
        pages_crawled: Optional[int] = None,
        total_pages: Optional[int] = None
    ) -> Optional[Dict[str, Any]]:
        """Update crawling status and progress."""
        source = await self.get_by_source_id(source_id)
        if source:
            update_data = {'crawl_status': status}
            if pages_crawled is not None:
                update_data['pages_crawled'] = pages_crawled
            if total_pages is not None:
                update_data['total_pages'] = total_pages
            
            return await self.update(source['id'], update_data)
        return None
    
    async def update_metadata(self, source_id: str, metadata: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update source metadata."""
        source = await self.get_by_source_id(source_id)
        if source:
            return await self.update(source['id'], {'metadata': metadata})
        return None
    
    async def get_by_status(self, status: str) -> List[Dict[str, Any]]:
        """Get sources by crawling status."""
        return await self.list(filters={'crawl_status': status})
    
    async def get_by_type(self, source_type: str) -> List[Dict[str, Any]]:
        """Get sources by type."""
        return await self.list(filters={'source_type': source_type})
    
    async def get_crawl_statistics(self) -> Dict[str, Any]:
        """Get crawling statistics."""
        all_sources = await self.list()
        
        stats = {
            'total_sources': len(all_sources),
            'by_status': {},
            'by_type': {},
            'total_pages': 0
        }
        
        for source in all_sources:
            # Count by status
            status = source.get('crawl_status', 'unknown')
            stats['by_status'][status] = stats['by_status'].get(status, 0) + 1
            
            # Count by type
            source_type = source.get('source_type', 'unknown')
            stats['by_type'][source_type] = stats['by_type'].get(source_type, 0) + 1
            
            # Sum total pages
            stats['total_pages'] += source.get('pages_crawled', 0)
        
        return stats


class MockDocumentRepository(IDocumentRepository):
    """In-memory mock implementation of document repository."""
    
    def __init__(self):
        """Initialize with empty in-memory storage."""
        self._storage: Dict[str, Dict[str, Any]] = {}
        self._logger = logging.getLogger(__name__)
    
    async def create(self, entity: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new document chunk."""
        entity_id = entity.get('id', str(uuid4()))
        entity['id'] = entity_id
        entity['created_at'] = datetime.now().isoformat()
        
        self._storage[entity_id] = entity.copy()
        return entity
    
    async def get_by_id(self, id: Union[str, UUID, int]) -> Optional[Dict[str, Any]]:
        """Retrieve document by ID."""
        return self._storage.get(str(id))
    
    async def update(self, id: Union[str, UUID, int], data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update document record."""
        entity_id = str(id)
        if entity_id in self._storage:
            self._storage[entity_id].update(data)
            return self._storage[entity_id]
        return None
    
    async def delete(self, id: Union[str, UUID, int]) -> bool:
        """Delete document record."""
        entity_id = str(id)
        if entity_id in self._storage:
            del self._storage[entity_id]
            return True
        return False
    
    async def list(
        self,
        filters: Optional[Dict[str, Any]] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        order_by: Optional[str] = None,
        order_direction: Optional[str] = "asc"
    ) -> List[Dict[str, Any]]:
        """List documents with filtering and pagination."""
        results = list(self._storage.values())
        
        # Apply filters
        if filters:
            for key, value in filters.items():
                results = [r for r in results if r.get(key) == value]
        
        # Apply ordering
        if order_by:
            reverse = order_direction.lower() == "desc"
            results.sort(key=lambda x: x.get(order_by, ''), reverse=reverse)
        
        # Apply pagination
        if offset:
            results = results[offset:]
        if limit:
            results = results[:limit]
        
        return results
    
    async def count(self, filters: Optional[Dict[str, Any]] = None) -> int:
        """Count documents."""
        results = await self.list(filters=filters)
        return len(results)
    
    async def exists(self, id: Union[str, UUID, int]) -> bool:
        """Check if document exists."""
        return str(id) in self._storage
    
    async def create_batch(self, entities: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Create multiple documents in batch."""
        results = []
        for entity in entities:
            result = await self.create(entity)
            results.append(result)
        return results
    
    async def update_batch(self, updates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Update multiple documents."""
        results = []
        for update_data in updates:
            if 'id' in update_data:
                entity_id = update_data.pop('id')
                result = await self.update(entity_id, update_data)
                if result:
                    results.append(result)
        return results
    
    async def delete_batch(self, ids: List[Union[str, UUID, int]]) -> int:
        """Delete multiple documents."""
        count = 0
        for entity_id in ids:
            if await self.delete(entity_id):
                count += 1
        return count
    
    # Document-specific methods
    async def vector_search(
        self,
        embedding: List[float],
        limit: int = 10,
        source_filter: Optional[str] = None,
        metadata_filter: Optional[Dict[str, Any]] = None
    ) -> List[Dict[str, Any]]:
        """Perform mock vector similarity search."""
        results = list(self._storage.values())
        
        # Apply source filter
        if source_filter:
            results = [r for r in results if r.get('source_id') == source_filter]
        
        # Apply metadata filter (simplified)
        if metadata_filter:
            for key, value in metadata_filter.items():
                results = [r for r in results if r.get('metadata', {}).get(key) == value]
        
        # Mock similarity scoring (random for testing)
        import random
        # Create shallow copies to avoid mutating original entities
        results_with_similarity = []
        for result in results:
            result_copy = result.copy()
            result_copy['similarity'] = random.uniform(0.5, 1.0)
            results_with_similarity.append(result_copy)
        
        # Sort by similarity and limit
        results_with_similarity.sort(key=lambda x: x.get('similarity', 0), reverse=True)
        return results_with_similarity[:limit]
    
    async def hybrid_search(
        self,
        query: str,
        embedding: List[float],
        limit: int = 10,
        source_filter: Optional[str] = None,
        keyword_weight: float = 0.5,
        vector_weight: float = 0.5
    ) -> List[Dict[str, Any]]:
        """Perform mock hybrid search."""
        # Simplified implementation - just use vector search for mock
        return await self.vector_search(embedding, limit, source_filter)
    
    async def get_by_source(
        self,
        source_id: str,
        limit: Optional[int] = None,
        offset: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """Get documents by source ID."""
        return await self.list(
            filters={'source_id': source_id},
            limit=limit,
            offset=offset
        )
    
    async def get_by_url(self, url: str) -> List[Dict[str, Any]]:
        """Get documents by URL."""
        return await self.list(
            filters={'url': url},
            order_by='chunk_number'
        )
    
    async def delete_by_source(self, source_id: str) -> int:
        """Delete all documents for a source."""
        docs = await self.get_by_source(source_id)
        count = 0
        for doc in docs:
            if await self.delete(doc['id']):
                count += 1
        return count
    
    async def delete_by_url(self, url: str) -> int:
        """Delete all documents for a URL."""
        docs = await self.get_by_url(url)
        count = 0
        for doc in docs:
            if await self.delete(doc['id']):
                count += 1
        return count
    
    async def get_content_statistics(self) -> Dict[str, Any]:
        """Get content statistics."""
        all_docs = await self.list()
        
        stats = {
            'total_chunks': len(all_docs),
            'total_sources': len(set(doc.get('source_id') for doc in all_docs)),
            'by_source': {},
            'avg_chunk_size': 0
        }
        
        total_chars = 0
        for doc in all_docs:
            source_id = doc.get('source_id', 'unknown')
            stats['by_source'][source_id] = stats['by_source'].get(source_id, 0) + 1
            
            content = doc.get('content', '')
            if content:
                total_chars += len(content)
        
        if all_docs:
            stats['avg_chunk_size'] = total_chars // len(all_docs)
        
        return stats
    
    async def search_content(
        self,
        query: str,
        limit: int = 10,
        source_filter: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Perform mock full-text search on content."""
        results = list(self._storage.values())
        
        # Apply source filter
        if source_filter:
            results = [r for r in results if r.get('source_id') == source_filter]
        
        # Simple text matching
        query_lower = query.lower()
        matching_results = []
        for result in results:
            content = result.get('content', '').lower()
            if query_lower in content:
                matching_results.append(result)
        
        return matching_results[:limit]


class MockProjectRepository(IProjectRepository):
    """In-memory mock implementation of project repository."""
    
    def __init__(self):
        """Initialize with empty in-memory storage."""
        self._storage: Dict[str, Dict[str, Any]] = {}
        self._logger = logging.getLogger(__name__)
    
    async def create(self, entity: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new project."""
        entity_id = entity.get('id', str(uuid4()))
        entity['id'] = entity_id
        entity['created_at'] = datetime.now().isoformat()
        entity['updated_at'] = datetime.now().isoformat()
        
        # Initialize JSONB fields if not present
        if 'docs' not in entity:
            entity['docs'] = []
        if 'features' not in entity:
            entity['features'] = []
        if 'data' not in entity:
            entity['data'] = {}
        if 'prd' not in entity:
            entity['prd'] = {}
        
        self._storage[entity_id] = entity.copy()
        return entity
    
    async def get_by_id(self, id: Union[str, UUID, int]) -> Optional[Dict[str, Any]]:
        """Retrieve project by ID."""
        return self._storage.get(str(id))
    
    async def update(self, id: Union[str, UUID, int], data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update project record."""
        entity_id = str(id)
        if entity_id in self._storage:
            self._storage[entity_id].update(data)
            self._storage[entity_id]['updated_at'] = datetime.now().isoformat()
            return self._storage[entity_id]
        return None
    
    async def delete(self, id: Union[str, UUID, int]) -> bool:
        """Delete project record."""
        entity_id = str(id)
        if entity_id in self._storage:
            del self._storage[entity_id]
            return True
        return False
    
    async def list(
        self,
        filters: Optional[Dict[str, Any]] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        order_by: Optional[str] = None,
        order_direction: Optional[str] = "asc"
    ) -> List[Dict[str, Any]]:
        """List projects with filtering and pagination."""
        results = list(self._storage.values())
        
        # Apply filters
        if filters:
            for key, value in filters.items():
                results = [r for r in results if r.get(key) == value]
        
        # Apply ordering
        if order_by:
            reverse = order_direction.lower() == "desc"
            results.sort(key=lambda x: x.get(order_by, ''), reverse=reverse)
        
        # Apply pagination
        if offset:
            results = results[offset:]
        if limit:
            results = results[:limit]
        
        return results
    
    async def count(self, filters: Optional[Dict[str, Any]] = None) -> int:
        """Count projects."""
        results = await self.list(filters=filters)
        return len(results)
    
    async def exists(self, id: Union[str, UUID, int]) -> bool:
        """Check if project exists."""
        return str(id) in self._storage
    
    async def create_batch(self, entities: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Create multiple projects."""
        results = []
        for entity in entities:
            result = await self.create(entity)
            results.append(result)
        return results
    
    async def update_batch(self, updates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Update multiple projects."""
        results = []
        for update_data in updates:
            if 'id' in update_data:
                entity_id = update_data.pop('id')
                result = await self.update(entity_id, update_data)
                if result:
                    results.append(result)
        return results
    
    async def delete_batch(self, ids: List[Union[str, UUID, int]]) -> int:
        """Delete multiple projects."""
        count = 0
        for entity_id in ids:
            if await self.delete(entity_id):
                count += 1
        return count
    
    # Project-specific methods
    async def get_with_tasks(self, project_id: UUID) -> Optional[Dict[str, Any]]:
        """Get project with associated tasks."""
        # In mock implementation, just return the project
        # Tasks would be managed separately
        return await self.get_by_id(project_id)
    
    async def update_jsonb_field(
        self,
        project_id: UUID,
        field_name: str,
        value: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """Update a JSONB field."""
        return await self.update(project_id, {field_name: value})
    
    async def merge_jsonb_field(
        self,
        project_id: UUID,
        field_name: str,
        value: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """Merge data into JSONB field."""
        project = await self.get_by_id(project_id)
        if project:
            current_value = project.get(field_name, {})
            if isinstance(current_value, dict):
                current_value.update(value)
                return await self.update_jsonb_field(project_id, field_name, current_value)
        return None
    
    async def append_to_jsonb_array(
        self,
        project_id: UUID,
        field_name: str,
        item: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """Append item to JSONB array."""
        project = await self.get_by_id(project_id)
        if project:
            current_array = project.get(field_name, [])
            if isinstance(current_array, list):
                current_array.append(item)
                return await self.update_jsonb_field(project_id, field_name, current_array)
        return None
    
    async def remove_from_jsonb_array(
        self,
        project_id: UUID,
        field_name: str,
        item_id: str
    ) -> Optional[Dict[str, Any]]:
        """Remove item from JSONB array by item ID."""
        project = await self.get_by_id(project_id)
        if project:
            current_array = project.get(field_name, [])
            if isinstance(current_array, list):
                filtered_array = [item for item in current_array if item.get('id') != item_id]
                return await self.update_jsonb_field(project_id, field_name, filtered_array)
        return None
    
    async def get_pinned(self) -> List[Dict[str, Any]]:
        """Get pinned projects."""
        return await self.list(
            filters={'is_pinned': True},
            order_by='updated_at',
            order_direction='desc'
        )
    
    async def set_pinned(self, project_id: UUID, is_pinned: bool) -> Optional[Dict[str, Any]]:
        """Set pinned status."""
        return await self.update(project_id, {'is_pinned': is_pinned})
    
    async def search_by_title(self, query: str, limit: int = 10) -> List[Dict[str, Any]]:
        """Search projects by title."""
        all_projects = await self.list()
        query_lower = query.lower()
        
        matching_projects = []
        for project in all_projects:
            title = project.get('title', '').lower()
            if query_lower in title:
                matching_projects.append(project)
        
        return matching_projects[:limit]
    
    async def get_project_statistics(self) -> Dict[str, Any]:
        """Get project statistics."""
        all_projects = await self.list()
        
        stats = {
            'total_projects': len(all_projects),
            'pinned_projects': len([p for p in all_projects if p.get('is_pinned', False)]),
            'with_github_repo': len([p for p in all_projects if p.get('github_repo')]),
            'avg_docs_per_project': 0
        }
        
        if all_projects:
            total_docs = sum(len(p.get('docs', [])) for p in all_projects)
            stats['avg_docs_per_project'] = total_docs // len(all_projects)
        
        return stats
    
    async def query_jsonb_field(
        self,
        field_name: str,
        query_path: str,
        query_value: Any,
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        """Query JSONB field - simplified mock implementation."""
        # For mock, just return empty list as this is complex functionality
        return []


class MockSettingsRepository(ISettingsRepository):
    """In-memory mock implementation of settings repository."""
    
    def __init__(self):
        """Initialize with empty in-memory storage."""
        self._storage: Dict[str, Dict[str, Any]] = {}
        self._logger = logging.getLogger(__name__)
    
    async def create(self, entity: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new setting."""
        entity_id = entity.get('id', str(uuid4()))
        entity['id'] = entity_id
        entity['created_at'] = datetime.now().isoformat()
        entity['updated_at'] = datetime.now().isoformat()
        
        self._storage[entity_id] = entity.copy()
        return entity
    
    async def get_by_id(self, id: Union[str, UUID, int]) -> Optional[Dict[str, Any]]:
        """Retrieve setting by ID."""
        return self._storage.get(str(id))
    
    async def get_by_key(self, key: str) -> Optional[Dict[str, Any]]:
        """Retrieve setting by key."""
        for setting in self._storage.values():
            if setting.get('key') == key:
                return setting
        return None
    
    async def update(self, id: Union[str, UUID, int], data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update setting record."""
        entity_id = str(id)
        if entity_id in self._storage:
            self._storage[entity_id].update(data)
            self._storage[entity_id]['updated_at'] = datetime.now().isoformat()
            return self._storage[entity_id]
        return None
    
    async def delete(self, id: Union[str, UUID, int]) -> bool:
        """Delete setting record."""
        entity_id = str(id)
        if entity_id in self._storage:
            del self._storage[entity_id]
            return True
        return False
    
    async def list(
        self,
        filters: Optional[Dict[str, Any]] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        order_by: Optional[str] = None,
        order_direction: Optional[str] = "asc"
    ) -> List[Dict[str, Any]]:
        """List settings with filtering and pagination."""
        results = list(self._storage.values())
        
        # Apply filters
        if filters:
            for key, value in filters.items():
                results = [r for r in results if r.get(key) == value]
        
        # Apply ordering
        if order_by:
            reverse = order_direction.lower() == "desc"
            results.sort(key=lambda x: x.get(order_by, ''), reverse=reverse)
        
        # Apply pagination
        if offset:
            results = results[offset:]
        if limit:
            results = results[:limit]
        
        return results
    
    async def count(self, filters: Optional[Dict[str, Any]] = None) -> int:
        """Count settings."""
        results = await self.list(filters=filters)
        return len(results)
    
    async def exists(self, id: Union[str, UUID, int]) -> bool:
        """Check if setting exists."""
        return str(id) in self._storage
    
    async def create_batch(self, entities: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Create multiple settings."""
        results = []
        for entity in entities:
            result = await self.create(entity)
            results.append(result)
        return results
    
    async def update_batch(self, updates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Update multiple settings."""
        results = []
        for update_data in updates:
            if 'id' in update_data:
                entity_id = update_data.pop('id')
                result = await self.update(entity_id, update_data)
                if result:
                    results.append(result)
        return results
    
    async def delete_batch(self, ids: List[Union[str, UUID, int]]) -> int:
        """Delete multiple settings."""
        count = 0
        for entity_id in ids:
            if await self.delete(entity_id):
                count += 1
        return count
    
    # Settings-specific methods
    async def get_by_category(self, category: str) -> List[Dict[str, Any]]:
        """Get settings by category."""
        return await self.list(filters={'category': category}, order_by='key')
    
    async def upsert(
        self,
        key: str,
        value: str,
        category: str = "general",
        description: Optional[str] = None,
        encrypted: bool = False,
        user_configurable: bool = True,
        default_value: Optional[str] = None,
        validation_regex: Optional[str] = None
    ) -> Dict[str, Any]:
        """Insert or update a setting."""
        existing = await self.get_by_key(key)
        
        setting_data = {
            'key': key,
            'value': value,
            'category': category,
            'description': description,
            'is_encrypted': encrypted,
            'is_user_configurable': user_configurable,
            'default_value': default_value,
            'validation_regex': validation_regex
        }
        
        if existing:
            # Update existing
            await self.update(existing['id'], setting_data)
            return await self.get_by_key(key)
        else:
            # Create new
            return await self.create(setting_data)
    
    async def get_decrypted(self, key: str) -> Optional[str]:
        """Get decrypted setting value."""
        setting = await self.get_by_key(key)
        if setting:
            value = setting.get('value')
            # In mock, we don't actually encrypt/decrypt
            return value
        return None
    
    async def set_encrypted(self, key: str, value: str, category: str = "credentials") -> Dict[str, Any]:
        """Store encrypted setting."""
        return await self.upsert(key, value, category, encrypted=True)
    
    async def get_user_configurable(self) -> List[Dict[str, Any]]:
        """Get user-configurable settings."""
        return await self.list(filters={'is_user_configurable': True}, order_by='category')
    
    async def get_defaults(self) -> Dict[str, str]:
        """Get default values."""
        settings = await self.list()
        return {s['key']: s.get('default_value', '') for s in settings if s.get('default_value')}
    
    async def reset_to_default(self, key: str) -> Optional[Dict[str, Any]]:
        """Reset setting to default."""
        setting = await self.get_by_key(key)
        if setting and setting.get('default_value'):
            return await self.update(setting['id'], {'value': setting['default_value']})
        return None
    
    async def validate_setting(self, key: str, value: str) -> bool:
        """Validate setting value."""
        setting = await self.get_by_key(key)
        if setting and setting.get('validation_regex'):
            import re
            pattern = setting['validation_regex']
            return bool(re.fullmatch(pattern, value))
        return True
    
    async def get_categories(self) -> List[str]:
        """Get all categories."""
        settings = await self.list()
        return list(set(s.get('category', 'general') for s in settings))
    
    async def bulk_update_category(self, category: str, updates: Dict[str, str]) -> List[Dict[str, Any]]:
        """Update multiple settings in category."""
        results = []
        for key, value in updates.items():
            result = await self.upsert(key, value, category)
            results.append(result)
        return results
    
    async def export_settings(self, category_filter: Optional[str] = None, include_encrypted: bool = False) -> Dict[str, Any]:
        """Export settings."""
        filters = {}
        if category_filter:
            filters['category'] = category_filter
        
        settings = await self.list(filters=filters)
        
        if not include_encrypted:
            settings = [s for s in settings if not s.get('is_encrypted', False)]
        
        return {
            'settings': settings,
            'exported_at': datetime.now().isoformat(),
            'count': len(settings)
        }
    
    async def import_settings(self, settings_data: Dict[str, Any], overwrite_existing: bool = False) -> Dict[str, Any]:
        """Import settings."""
        imported = 0
        errors = []
        
        for setting in settings_data.get('settings', []):
            try:
                key = setting.get('key')
                if key:
                    existing = await self.get_by_key(key)
                    if not existing or overwrite_existing:
                        await self.upsert(
                            key=key,
                            value=setting.get('value', ''),
                            category=setting.get('category', 'general'),
                            description=setting.get('description'),
                            encrypted=setting.get('is_encrypted', False),
                            user_configurable=setting.get('is_user_configurable', True),
                            default_value=setting.get('default_value'),
                            validation_regex=setting.get('validation_regex')
                        )
                        imported += 1
            except Exception as e:
                errors.append(str(e))
        
        return {
            'imported': imported,
            'errors': errors,
            'success': len(errors) == 0
        }


# Additional mock repositories with minimal implementations
class MockTaskRepository(ITaskRepository):
    """Minimal mock task repository."""
    
    def __init__(self):
        self._storage: Dict[str, Dict[str, Any]] = {}
        self._logger = logging.getLogger(__name__)
    
    # Implement all required abstract methods with basic functionality
    async def create(self, entity: Dict[str, Any]) -> Dict[str, Any]:
        entity_id = entity.get('id', str(uuid4()))
        entity['id'] = entity_id
        entity['created_at'] = datetime.now().isoformat()
        entity['updated_at'] = datetime.now().isoformat()
        self._storage[entity_id] = entity.copy()
        return entity
    
    async def get_by_id(self, id: Union[str, UUID, int]) -> Optional[Dict[str, Any]]:
        return self._storage.get(str(id))
    
    async def update(self, id: Union[str, UUID, int], data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        entity_id = str(id)
        if entity_id in self._storage:
            self._storage[entity_id].update(data)
            self._storage[entity_id]['updated_at'] = datetime.now().isoformat()
            return self._storage[entity_id]
        return None
    
    async def delete(self, id: Union[str, UUID, int]) -> bool:
        entity_id = str(id)
        if entity_id in self._storage:
            del self._storage[entity_id]
            return True
        return False
    
    async def list(self, filters=None, limit=None, offset=None, order_by=None, order_direction="asc") -> List[Dict[str, Any]]:
        results = list(self._storage.values())
        if filters:
            for key, value in filters.items():
                results = [r for r in results if r.get(key) == value]
        return results[:limit] if limit else results
    
    async def count(self, filters=None) -> int:
        return len(await self.list(filters=filters))
    
    async def exists(self, id) -> bool:
        return str(id) in self._storage
    
    async def create_batch(self, entities) -> List[Dict[str, Any]]:
        return [await self.create(entity) for entity in entities]
    
    async def update_batch(self, updates) -> List[Dict[str, Any]]:
        return []
    
    async def delete_batch(self, ids) -> int:
        return sum(1 for entity_id in ids if await self.delete(entity_id))
    
    # Task-specific methods
    async def get_by_project(self, project_id, include_closed=False, limit=None, offset=None) -> List[Dict[str, Any]]:
        return await self.list(filters={'project_id': str(project_id)}, limit=limit, offset=offset)
    
    async def get_by_status(self, project_id, status, limit=None) -> List[Dict[str, Any]]:
        return await self.list(filters={'project_id': str(project_id), 'status': status.value}, limit=limit)
    
    async def update_status(self, task_id, status, assignee=None) -> Optional[Dict[str, Any]]:
        update_data = {'status': status.value}
        if assignee:
            update_data['assignee'] = assignee
        return await self.update(task_id, update_data)
    
    async def archive(self, task_id) -> bool:
        return await self.delete(task_id)
    
    # Other methods with minimal implementations
    async def get_by_assignee(self, assignee, status_filter=None, limit=None) -> List[Dict[str, Any]]:
        return []
    async def get_by_feature(self, project_id, feature, include_closed=False) -> List[Dict[str, Any]]:
        return []
    async def update_task_order(self, task_id, new_order) -> Optional[Dict[str, Any]]:
        return await self.update(task_id, {'task_order': new_order})
    async def add_source_reference(self, task_id, source) -> Optional[Dict[str, Any]]:
        return await self.get_by_id(task_id)
    async def add_code_example(self, task_id, code_example) -> Optional[Dict[str, Any]]:
        return await self.get_by_id(task_id)
    async def get_task_statistics(self, project_id=None) -> Dict[str, Any]:
        return {'total_tasks': 0, 'by_status': {}, 'by_assignee': {}, 'by_feature': {}}
    async def bulk_update_status(self, task_ids, status, assignee=None) -> List[Dict[str, Any]]:
        return []


class MockVersionRepository(IVersionRepository):
    """Minimal mock version repository."""
    
    def __init__(self):
        self._storage: Dict[str, Dict[str, Any]] = {}
        self._logger = logging.getLogger(__name__)
    
    # Implement all required abstract methods with basic functionality
    async def create(self, entity: Dict[str, Any]) -> Dict[str, Any]:
        entity_id = entity.get('id', str(uuid4()))
        entity['id'] = entity_id
        entity['created_at'] = datetime.now().isoformat()
        self._storage[entity_id] = entity.copy()
        return entity
    
    async def get_by_id(self, id: Union[str, UUID, int]) -> Optional[Dict[str, Any]]:
        return self._storage.get(str(id))
    
    async def update(self, id: Union[str, UUID, int], data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        entity_id = str(id)
        if entity_id in self._storage:
            self._storage[entity_id].update(data)
            return self._storage[entity_id]
        return None
    
    async def delete(self, id: Union[str, UUID, int]) -> bool:
        entity_id = str(id)
        if entity_id in self._storage:
            del self._storage[entity_id]
            return True
        return False
    
    async def list(self, filters=None, limit=None, offset=None, order_by=None, order_direction="asc") -> List[Dict[str, Any]]:
        results = list(self._storage.values())
        if filters:
            for key, value in filters.items():
                results = [r for r in results if r.get(key) == value]
        return results[:limit] if limit else results
    
    async def count(self, filters=None) -> int:
        return len(await self.list(filters=filters))
    
    async def exists(self, id) -> bool:
        return str(id) in self._storage
    
    async def create_batch(self, entities) -> List[Dict[str, Any]]:
        return []
    
    async def update_batch(self, updates) -> List[Dict[str, Any]]:
        return []
    
    async def delete_batch(self, ids) -> int:
        return 0
    
    # Version-specific methods
    async def create_snapshot(self, project_id, field_name, content, change_summary, created_by="system", change_type="automatic", document_id=None) -> Dict[str, Any]:
        version_data = {
            'project_id': str(project_id),
            'field_name': field_name,
            'content': content,
            'change_summary': change_summary,
            'created_by': created_by,
            'change_type': change_type,
            'version_number': 1,
        }
        if document_id:
            version_data['document_id'] = str(document_id)
        return await self.create(version_data)
    
    async def get_version_history(self, project_id, field_name, limit=None, document_id=None) -> List[Dict[str, Any]]:
        return []
    async def get_version(self, project_id, field_name, version_number) -> Optional[Dict[str, Any]]:
        return None
    async def restore_version(self, project_id, field_name, version_number, created_by="system") -> Dict[str, Any]:
        return {}
    async def get_latest_version_number(self, project_id, field_name) -> int:
        return 0
    async def delete_old_versions(self, project_id, field_name, keep_latest=10) -> int:
        return 0
    async def compare_versions(self, project_id, field_name, version_a, version_b) -> Dict[str, Any]:
        return {}
    async def get_version_statistics(self, project_id=None) -> Dict[str, Any]:
        return {'total_versions': 0, 'by_field': {}, 'by_project': {}, 'by_change_type': {}}


class MockCodeExampleRepository(ICodeExampleRepository):
    """Minimal mock code example repository."""
    
    def __init__(self):
        self._storage: Dict[str, Dict[str, Any]] = {}
        self._logger = logging.getLogger(__name__)
    
    # Basic CRUD operations
    async def create(self, entity: Dict[str, Any]) -> Dict[str, Any]:
        entity_id = entity.get('id', str(uuid4()))
        entity['id'] = entity_id
        entity['created_at'] = datetime.now().isoformat()
        self._storage[entity_id] = entity.copy()
        return entity
    
    async def get_by_id(self, id: Union[str, UUID, int]) -> Optional[Dict[str, Any]]:
        return self._storage.get(str(id))
    
    async def update(self, id: Union[str, UUID, int], data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        entity_id = str(id)
        if entity_id in self._storage:
            self._storage[entity_id].update(data)
            return self._storage[entity_id]
        return None
    
    async def delete(self, id: Union[str, UUID, int]) -> bool:
        entity_id = str(id)
        if entity_id in self._storage:
            del self._storage[entity_id]
            return True
        return False
    
    async def list(self, filters=None, limit=None, offset=None, order_by=None, order_direction="asc") -> List[Dict[str, Any]]:
        results = list(self._storage.values())
        if filters:
            for key, value in filters.items():
                results = [r for r in results if r.get(key) == value]
        return results[:limit] if limit else results
    
    async def count(self, filters=None) -> int:
        return len(await self.list(filters=filters))
    
    async def exists(self, id) -> bool:
        return str(id) in self._storage
    
    async def create_batch(self, entities) -> List[Dict[str, Any]]:
        return [await self.create(entity) for entity in entities]
    
    async def update_batch(self, updates) -> List[Dict[str, Any]]:
        return []
    
    async def delete_batch(self, ids) -> int:
        return 0
    
    # Code example specific methods
    async def search_by_summary(self, query, limit=5, source_filter=None) -> List[Dict[str, Any]]:
        return []
    async def get_by_language(self, language, limit=None, offset=None) -> List[Dict[str, Any]]:
        return []
    async def get_by_source(self, source_id, limit=None, offset=None) -> List[Dict[str, Any]]:
        return []
    async def search_by_metadata(self, metadata_query, limit=10) -> List[Dict[str, Any]]:
        return []
    async def get_languages(self) -> List[str]:
        return []
    async def delete_by_source(self, source_id) -> int:
        return 0
    async def get_code_statistics(self) -> Dict[str, Any]:
        return {}
    async def search_code_content(self, query, language_filter=None, limit=10) -> List[Dict[str, Any]]:
        return []


class MockPromptRepository(IPromptRepository):
    """Minimal mock prompt repository."""
    
    def __init__(self):
        self._storage: Dict[str, Dict[str, Any]] = {}
        self._logger = logging.getLogger(__name__)
    
    # Basic CRUD operations
    async def create(self, entity: Dict[str, Any]) -> Dict[str, Any]:
        entity_id = entity.get('id', str(uuid4()))
        entity['id'] = entity_id
        entity['created_at'] = datetime.now().isoformat()
        entity['updated_at'] = datetime.now().isoformat()
        self._storage[entity_id] = entity.copy()
        return entity
    
    async def get_by_id(self, id: Union[str, UUID, int]) -> Optional[Dict[str, Any]]:
        return self._storage.get(str(id))
    
    async def update(self, id: Union[str, UUID, int], data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        entity_id = str(id)
        if entity_id in self._storage:
            self._storage[entity_id].update(data)
            self._storage[entity_id]['updated_at'] = datetime.now().isoformat()
            return self._storage[entity_id]
        return None
    
    async def delete(self, id: Union[str, UUID, int]) -> bool:
        entity_id = str(id)
        if entity_id in self._storage:
            del self._storage[entity_id]
            return True
        return False
    
    async def list(self, filters=None, limit=None, offset=None, order_by=None, order_direction="asc") -> List[Dict[str, Any]]:
        results = list(self._storage.values())
        if filters:
            for key, value in filters.items():
                results = [r for r in results if r.get(key) == value]
        return results[:limit] if limit else results
    
    async def count(self, filters=None) -> int:
        return len(await self.list(filters=filters))
    
    async def exists(self, id) -> bool:
        return str(id) in self._storage
    
    async def create_batch(self, entities) -> List[Dict[str, Any]]:
        return []
    
    async def update_batch(self, updates) -> List[Dict[str, Any]]:
        return []
    
    async def delete_batch(self, ids) -> int:
        return 0
    
    # Prompt-specific methods with minimal implementations
    async def get_by_name(self, name, version=None) -> Optional[Dict[str, Any]]:
        return None
    async def get_by_category(self, category) -> List[Dict[str, Any]]:
        return []
    async def create_version(self, name, title, content, category="general", version=None, variables=None, metadata=None, created_by="system", is_active=True) -> Dict[str, Any]:
        return {}
    async def set_active_version(self, name, version) -> Optional[Dict[str, Any]]:
        return None
    async def get_versions(self, name) -> List[Dict[str, Any]]:
        return []
    async def render_prompt(self, name, variables, version=None) -> str:
        return ""
    async def validate_variables(self, name, variables, version=None) -> Dict[str, Any]:
        return {}
    async def get_user_prompts(self) -> List[Dict[str, Any]]:
        return []
    async def clone_prompt(self, source_name, new_name, new_title, created_by="user") -> Dict[str, Any]:
        return {}
    async def update_metadata(self, name, version, metadata_updates) -> Optional[Dict[str, Any]]:
        return None
    async def get_categories(self) -> List[str]:
        return []
    async def search_prompts(self, query, category_filter=None, limit=10) -> List[Dict[str, Any]]:
        return []
    async def get_prompt_usage_stats(self, name) -> Dict[str, Any]:
        return {}
    async def delete_version(self, name, version) -> bool:
        return False