"""
Concrete Supabase repository implementations.

This module contains all concrete repository implementations using Supabase
for data persistence. Each repository class implements the corresponding
interface and handles Supabase-specific operations.
"""

import asyncio
import logging
import re
import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Union
from uuid import UUID

from supabase import Client

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


class SupabaseSourceRepository(ISourceRepository):
    """Supabase implementation of source repository for archon_sources table."""
    
    def __init__(self, client: Client):
        """Initialize with Supabase client."""
        self._client = client
        self._table = 'archon_sources'
        self._logger = logging.getLogger(__name__)
    
    async def create(self, entity: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new source record."""
        try:
            response = self._client.table(self._table).insert(entity).execute()
            if response.data:
                return response.data[0]
            else:
                raise Exception("No data returned from insert operation")
        except Exception as e:
            self._logger.exception(f"Failed to create source: {e}")
            raise
    
    async def get_by_id(self, id: Union[str, UUID, int]) -> Optional[Dict[str, Any]]:
        """Retrieve source by ID with retry logic and async execution."""
        max_retries = 3
        base_delay = 0.5  # Starting delay in seconds
        
        for attempt in range(max_retries):
            try:
                # Run blocking Supabase call in thread pool
                response = await asyncio.to_thread(
                    lambda: self._client.table(self._table).select('*').eq('id', str(id)).execute()
                )
                return response.data[0] if response.data else None
                
            except Exception as e:
                if attempt == max_retries - 1:
                    # Last attempt failed, log with full stack trace and re-raise
                    self._logger.error(
                        f"Failed to get source by ID {id} after {max_retries} attempts: {e}", 
                        exc_info=True
                    )
                    raise
                else:
                    # Calculate exponential backoff delay
                    delay = base_delay * (2 ** attempt)
                    self._logger.warning(
                        f"Attempt {attempt + 1}/{max_retries} failed for source ID {id}: {e}. "
                        f"Retrying in {delay}s..."
                    )
                    await asyncio.sleep(delay)
        
        return None
    
    async def get_by_source_id(self, source_id: str) -> Optional[Dict[str, Any]]:
        """Retrieve source by source_id."""
        try:
            response = self._client.table(self._table).select('*').eq('source_id', source_id).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            self._logger.error(f"Failed to get source by source_id {source_id}: {e}")
            return None
    
    async def update(self, id: Union[str, UUID, int], data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update source record."""
        try:
            response = self._client.table(self._table).update(data).eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            self._logger.error(f"Failed to update source {id}: {e}")
            return None
    
    async def delete(self, id: Union[str, UUID, int]) -> bool:
        """Delete source record."""
        try:
            response = self._client.table(self._table).delete().eq('id', str(id)).execute()
            return len(response.data) > 0
        except Exception as e:
            self._logger.error(f"Failed to delete source {id}: {e}")
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
        try:
            query = self._client.table(self._table).select('*')
            
            # Apply filters
            if filters:
                for key, value in filters.items():
                    query = query.eq(key, value)
            
            # Apply ordering
            if order_by:
                ascending = order_direction.lower() == "asc"
                query = query.order(order_by, desc=not ascending)
            
            # Apply pagination
            if limit:
                query = query.limit(limit)
            if offset:
                query = query.offset(offset)
            
            response = query.execute()
            return response.data or []
        except Exception as e:
            self._logger.exception(f"Failed to list sources: {e}")
            return []
    
    # Implement remaining base repository methods with minimal functionality
    async def count(self, filters: Optional[Dict[str, Any]] = None) -> int:
        """Count sources."""
        try:
            sources = await self.list(filters=filters)
            return len(sources)
        except Exception:
            return 0
    
    async def exists(self, id: Union[str, UUID, int]) -> bool:
        """Check if source exists."""
        result = await self.get_by_id(id)
        return result is not None
    
    async def create_batch(self, entities: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Create multiple sources."""
        try:
            response = self._client.table(self._table).insert(entities).execute()
            return response.data or []
        except Exception as e:
            self._logger.error(f"Failed to create source batch: {e}")
            return []
    
    async def update_batch(self, updates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Update multiple sources."""
        # Implementation would need individual updates as Supabase doesn't support bulk updates easily
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
        try:
            update_data = {'crawl_status': status}
            if pages_crawled is not None:
                update_data['pages_crawled'] = pages_crawled
            if total_pages is not None:
                update_data['total_pages'] = total_pages
            
            response = self._client.table(self._table).update(update_data).eq('source_id', source_id).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            self._logger.error(f"Failed to update crawl status for {source_id}: {e}")
            return None
    
    async def update_metadata(self, source_id: str, metadata: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update source metadata."""
        try:
            response = self._client.table(self._table).update({'metadata': metadata}).eq('source_id', source_id).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            self._logger.error(f"Failed to update metadata for {source_id}: {e}")
            return None
    
    async def get_by_status(self, status: str) -> List[Dict[str, Any]]:
        """Get sources by crawling status."""
        return await self.list(filters={'crawl_status': status})
    
    async def get_by_type(self, source_type: str) -> List[Dict[str, Any]]:
        """Get sources by type."""
        return await self.list(filters={'source_type': source_type})
    
    async def get_crawl_statistics(self) -> Dict[str, Any]:
        """Get crawling statistics."""
        try:
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
        except Exception as e:
            self._logger.exception(f"Failed to get crawl statistics: {e}")
            return {'total_sources': 0, 'by_status': {}, 'by_type': {}, 'total_pages': 0}


class SupabaseDocumentRepository(IDocumentRepository):
    """Supabase implementation of document repository for archon_crawled_pages table."""
    
    def __init__(self, client: Client):
        """Initialize with Supabase client."""
        self._client = client
        self._table = 'archon_crawled_pages'
        self._logger = logging.getLogger(__name__)
    
    async def create(self, entity: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new document chunk."""
        try:
            response = self._client.table(self._table).insert(entity).execute()
            if response.data:
                return response.data[0]
            else:
                raise Exception("No data returned from insert operation")
        except Exception as e:
            self._logger.error(f"Failed to create document: {e}")
            raise
    
    async def get_by_id(self, id: Union[str, UUID, int]) -> Optional[Dict[str, Any]]:
        """Retrieve document by ID."""
        try:
            response = self._client.table(self._table).select('*').eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            self._logger.error(f"Failed to get document by ID {id}: {e}")
            return None
    
    async def update(self, id: Union[str, UUID, int], data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update document record."""
        try:
            response = self._client.table(self._table).update(data).eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            self._logger.error(f"Failed to update document {id}: {e}")
            return None
    
    async def delete(self, id: Union[str, UUID, int]) -> bool:
        """Delete document record."""
        try:
            response = self._client.table(self._table).delete().eq('id', str(id)).execute()
            return len(response.data) > 0
        except Exception as e:
            self._logger.error(f"Failed to delete document {id}: {e}")
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
        try:
            query = self._client.table(self._table).select('*')
            
            # Apply filters
            if filters:
                for key, value in filters.items():
                    query = query.eq(key, value)
            
            # Apply ordering
            if order_by:
                ascending = order_direction.lower() == "asc"
                query = query.order(order_by, desc=not ascending)
            
            # Apply pagination
            if limit:
                query = query.limit(limit)
            if offset:
                query = query.offset(offset)
            
            response = query.execute()
            return response.data or []
        except Exception as e:
            self._logger.exception(f"Failed to list documents: {e}")
            return []
    
    # Implement remaining base repository methods
    async def count(self, filters: Optional[Dict[str, Any]] = None) -> int:
        """Count documents."""
        try:
            documents = await self.list(filters=filters)
            return len(documents)
        except Exception:
            return 0
    
    async def exists(self, id: Union[str, UUID, int]) -> bool:
        """Check if document exists."""
        result = await self.get_by_id(id)
        return result is not None
    
    async def create_batch(self, entities: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Create multiple documents in batch."""
        try:
            response = self._client.table(self._table).insert(entities).execute()
            return response.data or []
        except Exception as e:
            self._logger.error(f"Failed to create document batch: {e}")
            return []
    
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
        """Perform vector similarity search."""
        try:
            # Call Supabase RPC function for vector search
            params = {
                'query_embedding': embedding,
                'match_count': limit
            }
            if source_filter:
                params['source_filter'] = source_filter
            
            # Add metadata filter if provided
            # Note: The RPC function expects 'filter' parameter for metadata filtering
            if metadata_filter:
                params['filter'] = metadata_filter
                self._logger.debug(f"Vector search with metadata filter: {metadata_filter}")
            
            response = self._client.rpc('match_archon_crawled_pages', params).execute()
            return response.data or []
        except Exception as e:
            self._logger.error(f"Failed to perform vector search: {e}")
            return []
    
    async def hybrid_search(
        self,
        query: str,
        embedding: List[float],
        limit: int = 10,
        source_filter: Optional[str] = None,
        keyword_weight: float = 0.5,
        vector_weight: float = 0.5
    ) -> List[Dict[str, Any]]:
        """Perform hybrid search combining keyword and vector similarity."""
        try:
            # Call Supabase RPC function for hybrid search
            params = {
                'query_text': query,
                'query_embedding': embedding,
                'match_count': limit,
                'keyword_weight': keyword_weight,
                'vector_weight': vector_weight
            }
            if source_filter:
                params['source_filter'] = source_filter
            
            response = self._client.rpc('hybrid_search_archon_crawled_pages', params).execute()
            return response.data or []
        except Exception as e:
            self._logger.error(f"Failed to perform hybrid search: {e}")
            return []
    
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
        try:
            response = self._client.table(self._table).delete().eq('source_id', source_id).execute()
            return len(response.data)
        except Exception as e:
            self._logger.error(f"Failed to delete documents by source {source_id}: {e}")
            return 0
    
    async def delete_by_url(self, url: str) -> int:
        """Delete all documents for a URL."""
        try:
            response = self._client.table(self._table).delete().eq('url', url).execute()
            return len(response.data)
        except Exception as e:
            self._logger.error(f"Failed to delete documents by URL {url}: {e}")
            return 0
    
    async def get_content_statistics(self) -> Dict[str, Any]:
        """Get content statistics."""
        try:
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
        except Exception as e:
            self._logger.error(f"Failed to get content statistics: {e}")
            return {'total_chunks': 0, 'total_sources': 0, 'by_source': {}, 'avg_chunk_size': 0}
    
    async def search_content(
        self,
        query: str,
        limit: int = 10,
        source_filter: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Perform full-text search on content."""
        try:
            # Use Supabase full-text search
            search_query = self._client.table(self._table).select('*')
            search_query = search_query.text_search('content', query)
            
            if source_filter:
                search_query = search_query.eq('source_id', source_filter)
            
            if limit:
                search_query = search_query.limit(limit)
            
            response = search_query.execute()
            return response.data or []
        except Exception as e:
            self._logger.error(f"Failed to search content: {e}")
            return []
    
    def _calculate_text_relevance(self, query: str, content: str) -> float:
        """Calculate simple text relevance score for hybrid search."""
        if not query or not content:
            return 0.0
        
        query_lower = query.lower()
        content_lower = content.lower()
        
        # Simple keyword matching score
        query_words = query_lower.split()
        content_words = content_lower.split()
        
        if not query_words or not content_words:
            return 0.0
        
        # Count exact matches
        matches = sum(1 for word in query_words if word in content_lower)
        
        # Calculate TF-like score
        word_freq_score = matches / len(query_words)
        
        # Bonus for phrase matches
        phrase_bonus = 0.2 if query_lower in content_lower else 0.0
        
        # Final score (0.0 to 1.0)
        return min(1.0, word_freq_score + phrase_bonus)


class SupabaseProjectRepository(IProjectRepository):
    """Supabase implementation of project repository for archon_projects table."""
    
    def __init__(self, client: Client):
        """Initialize with Supabase client."""
        self._client = client
        self._table = 'archon_projects'
        self._logger = logging.getLogger(__name__)
    
    async def create(self, entity: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new project."""
        try:
            response = self._client.table(self._table).insert(entity).execute()
            if response.data:
                return response.data[0]
            else:
                raise Exception("No data returned from insert operation")
        except Exception as e:
            self._logger.exception(f"Failed to create project: {e}")
            raise
    
    async def get_by_id(self, id: Union[str, UUID, int]) -> Optional[Dict[str, Any]]:
        """Retrieve project by ID."""
        try:
            response = self._client.table(self._table).select('*').eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            self._logger.error(f"Failed to get project by ID {id}: {e}")
            return None
    
    async def update(self, id: Union[str, UUID, int], data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update project record."""
        try:
            response = self._client.table(self._table).update(data).eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            self._logger.error(f"Failed to update project {id}: {e}")
            return None
    
    async def delete(self, id: Union[str, UUID, int]) -> bool:
        """Delete project record."""
        try:
            response = self._client.table(self._table).delete().eq('id', str(id)).execute()
            return len(response.data) > 0
        except Exception as e:
            self._logger.error(f"Failed to delete project {id}: {e}")
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
        try:
            query = self._client.table(self._table).select('*')
            
            # Apply filters
            if filters:
                for key, value in filters.items():
                    query = query.eq(key, value)
            
            # Apply ordering
            if order_by:
                ascending = order_direction.lower() == "asc"
                query = query.order(order_by, desc=not ascending)
            
            # Apply pagination
            if limit:
                query = query.limit(limit)
            if offset:
                query = query.offset(offset)
            
            response = query.execute()
            return response.data or []
        except Exception as e:
            self._logger.exception(f"Failed to list projects: {e}")
            return []
    
    # Implement remaining base repository methods
    async def count(self, filters: Optional[Dict[str, Any]] = None) -> int:
        """Count projects."""
        try:
            projects = await self.list(filters=filters)
            return len(projects)
        except Exception:
            return 0
    
    async def exists(self, id: Union[str, UUID, int]) -> bool:
        """Check if project exists."""
        result = await self.get_by_id(id)
        return result is not None
    
    async def create_batch(self, entities: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Create multiple projects."""
        try:
            response = self._client.table(self._table).insert(entities).execute()
            return response.data or []
        except Exception as e:
            self._logger.error(f"Failed to create project batch: {e}")
            return []
    
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
    
    # Project-specific methods (implementing key methods from interface)
    async def get_with_tasks(self, project_id: UUID) -> Optional[Dict[str, Any]]:
        """Get project with associated tasks."""
        # This would require a join or separate query for tasks
        # For now, return the project - tasks would be fetched separately
        return await self.get_by_id(project_id)
    
    async def update_jsonb_field(
        self,
        project_id: UUID,
        field_name: str,
        value: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """Update a JSONB field."""
        return await self.update(project_id, {field_name: value})
    
    async def get_pinned(self) -> List[Dict[str, Any]]:
        """Get pinned projects."""
        return await self.list(
            filters={'is_pinned': True},
            order_by='updated_at',
            order_direction='desc'
        )
    
    # Simplified implementations for remaining interface methods
    async def merge_jsonb_field(self, project_id: UUID, field_name: str, value: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Merge data into JSONB field."""
        try:
            project = await self.get_by_id(project_id)
            if not project:
                return None
            
            current = project.get(field_name, {})
            if isinstance(current, dict) and isinstance(value, dict):
                merged = {**current, **value}
                return await self.update(project_id, {field_name: merged})
            
            # Fallback: for non-dict types, replace
            return await self.update(project_id, {field_name: value})
        except Exception:
            self._logger.exception(f"Failed to merge JSONB field {field_name} for project {project_id}")
            return None
    
    async def append_to_jsonb_array(self, project_id: UUID, field_name: str, item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Append item to JSONB array - simplified implementation."""
        project = await self.get_by_id(project_id)
        if project:
            current_array = project.get(field_name, [])
            if isinstance(current_array, list):
                current_array.append(item)
                return await self.update_jsonb_field(project_id, field_name, current_array)
        return None
    
    async def remove_from_jsonb_array(self, project_id: UUID, field_name: str, item_id: str) -> Optional[Dict[str, Any]]:
        """Remove item from JSONB array - simplified implementation."""
        project = await self.get_by_id(project_id)
        if project:
            current_array = project.get(field_name, [])
            if isinstance(current_array, list):
                filtered_array = [item for item in current_array if item.get('id') != item_id]
                return await self.update_jsonb_field(project_id, field_name, filtered_array)
        return None
    
    async def set_pinned(self, project_id: UUID, is_pinned: bool) -> Optional[Dict[str, Any]]:
        """Set pinned status."""
        return await self.update(project_id, {'is_pinned': is_pinned})
    
    async def search_by_title(self, query: str, limit: int = 10) -> List[Dict[str, Any]]:
        """Search projects by title."""
        try:
            response = self._client.table(self._table).select('*').ilike('title', f'%{query}%').limit(limit).execute()
            return response.data or []
        except Exception as e:
            self._logger.error(f"Failed to search projects by title: {e}")
            return []
    
    async def get_project_statistics(self) -> Dict[str, Any]:
        """Get project statistics - simplified implementation."""
        try:
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
        except Exception as e:
            self._logger.exception(f"Failed to get project statistics: {e}")
            return {'total_projects': 0, 'pinned_projects': 0, 'with_github_repo': 0, 'avg_docs_per_project': 0}
    
    async def query_jsonb_field(self, field_name: str, query_path: str, query_value: Any, limit: int = 10) -> List[Dict[str, Any]]:
        """Query JSONB field - simplified implementation."""
        # This would require more complex JSONB querying in Supabase
        # For now, return empty list as this is an advanced feature
        self._logger.warning(f"JSONB querying not fully implemented for {field_name}")
        return []


class SupabaseSettingsRepository(ISettingsRepository):
    """Supabase implementation of settings repository for archon_settings table."""
    
    def __init__(self, client: Client):
        """Initialize with Supabase client."""
        self._client = client
        self._table = 'archon_settings'
        self._logger = logging.getLogger(__name__)
    
    async def create(self, entity: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new setting."""
        try:
            response = self._client.table(self._table).insert(entity).execute()
            if response.data:
                return response.data[0]
            else:
                raise Exception("No data returned from insert operation")
        except Exception as e:
            self._logger.error(f"Failed to create setting: {e}")
            raise
    
    async def get_by_id(self, id: Union[str, UUID, int]) -> Optional[Dict[str, Any]]:
        """Retrieve setting by ID."""
        try:
            response = self._client.table(self._table).select('*').eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            self._logger.error(f"Failed to get setting by ID {id}: {e}")
            return None
    
    async def get_by_key(self, key: str) -> Optional[Dict[str, Any]]:
        """Retrieve setting by key."""
        try:
            response = self._client.table(self._table).select('*').eq('key', key).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            self._logger.error(f"Failed to get setting by key {key}: {e}")
            return None
    
    async def update(self, id: Union[str, UUID, int], data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update setting record."""
        try:
            response = self._client.table(self._table).update(data).eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            self._logger.error(f"Failed to update setting {id}: {e}")
            return None
    
    async def delete(self, id: Union[str, UUID, int]) -> bool:
        """Delete setting record."""
        try:
            response = self._client.table(self._table).delete().eq('id', str(id)).execute()
            return len(response.data) > 0
        except Exception as e:
            self._logger.error(f"Failed to delete setting {id}: {e}")
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
        try:
            query = self._client.table(self._table).select('*')
            
            # Apply filters
            if filters:
                for key, value in filters.items():
                    query = query.eq(key, value)
            
            # Apply ordering
            if order_by:
                ascending = order_direction.lower() == "asc"
                query = query.order(order_by, desc=not ascending)
            
            # Apply pagination
            if limit:
                query = query.limit(limit)
            if offset:
                query = query.offset(offset)
            
            response = query.execute()
            return response.data or []
        except Exception as e:
            self._logger.exception(f"Failed to list settings: {e}")
            return []
    
    # Implement remaining base repository methods
    async def count(self, filters: Optional[Dict[str, Any]] = None) -> int:
        """Count settings."""
        try:
            settings = await self.list(filters=filters)
            return len(settings)
        except Exception:
            return 0
    
    async def exists(self, id: Union[str, UUID, int]) -> bool:
        """Check if setting exists."""
        result = await self.get_by_id(id)
        return result is not None
    
    async def create_batch(self, entities: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Create multiple settings."""
        try:
            response = self._client.table(self._table).insert(entities).execute()
            return response.data or []
        except Exception as e:
            self._logger.error(f"Failed to create setting batch: {e}")
            return []
    
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
    
    # Settings-specific methods (implementing key methods from interface)
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
        try:
            # Check if setting exists
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
            
            # Validate value against regex if validation_regex is provided
            if validation_regex is not None:
                if not re.fullmatch(validation_regex, value):
                    raise ValueError(f"Value '{value}' does not match validation regex '{validation_regex}' for setting '{key}'")
            
            if existing:
                # Update existing
                response = self._client.table(self._table).update(setting_data).eq('key', key).execute()
            else:
                # Create new
                response = self._client.table(self._table).insert(setting_data).execute()
            
            return response.data[0] if response.data else {}
        except Exception as e:
            self._logger.error(f"Failed to upsert setting {key}: {e}")
            raise
    
    async def get_decrypted(self, key: str) -> Optional[str]:
        """Get decrypted setting value."""
        setting = await self.get_by_key(key)
        if setting:
            if setting.get('is_encrypted', False):
                raise NotImplementedError(
                    f"Encryption/decryption not yet implemented. Cannot retrieve encrypted setting '{key}'. "
                    "Please implement proper encryption service integration before storing encrypted values."
                )
            return setting.get('value')
        return None
    
    async def set_encrypted(self, key: str, value: str, category: str = "credentials") -> Dict[str, Any]:
        """Store encrypted setting."""
        raise NotImplementedError(
            f"Encryption not yet implemented. Cannot store encrypted setting '{key}'. "
            "Please implement proper encryption service integration (e.g., KMS, encryption key from config) "
            "before storing encrypted values. As a temporary measure, consider storing in environment variables."
        )
    
    # Simplified implementations for remaining interface methods
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
            return bool(re.match(pattern, value))
        return True
    
    async def get_categories(self) -> List[str]:
        """Get all categories."""
        settings = await self.list()
        return list(set(s.get('category', 'general') for s in settings))
    
    async def bulk_update_category(self, category: str, updates: Dict[str, str]) -> List[Dict[str, Any]]:
        """Update multiple settings in category."""
        results = []
        for key, value in updates.items():
            try:
                result = await self.upsert(key, value, category)
                results.append(result)
            except Exception as e:
                self._logger.error(f"Failed to update setting {key}: {e}")
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


# Placeholder implementations for remaining repositories
class SupabaseTaskRepository(ITaskRepository):
    """Minimal task repository implementation."""
    
    def __init__(self, client: Client):
        self._client = client
        self._table = 'archon_tasks'
        self._logger = logging.getLogger(__name__)
    
    # Implement minimal required methods
    async def create(self, entity: Dict[str, Any]) -> Dict[str, Any]:
        try:
            response = self._client.table(self._table).insert(entity).execute()
            return response.data[0] if response.data else {}
        except Exception as e:
            self._logger.error(f"Failed to create task: {e}")
            raise
    
    async def get_by_id(self, id: Union[str, UUID, int]) -> Optional[Dict[str, Any]]:
        try:
            response = self._client.table(self._table).select('*').eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            self._logger.error(f"Failed to get task: {e}")
            return None
    
    async def update(self, id: Union[str, UUID, int], data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        try:
            response = self._client.table(self._table).update(data).eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            self._logger.error(f"Failed to update task: {e}")
            return None
    
    async def delete(self, id: Union[str, UUID, int]) -> bool:
        try:
            response = self._client.table(self._table).delete().eq('id', str(id)).execute()
            return len(response.data) > 0
        except Exception as e:
            self._logger.error(f"Failed to delete task: {e}")
            return False
    
    # Minimal implementations for required abstract methods
    async def list(self, filters=None, limit=None, offset=None, order_by=None, order_direction="asc") -> List[Dict[str, Any]]:
        try:
            query = self._client.table(self._table).select('*')
            if filters:
                for key, value in filters.items():
                    query = query.eq(key, value)
            if limit:
                query = query.limit(limit)
            response = query.execute()
            return response.data or []
        except Exception:
            return []
    
    async def count(self, filters=None) -> int:
        tasks = await self.list(filters=filters)
        return len(tasks)
    
    async def exists(self, id) -> bool:
        return await self.get_by_id(id) is not None
    
    async def create_batch(self, entities) -> List[Dict[str, Any]]:
        try:
            response = self._client.table(self._table).insert(entities).execute()
            return response.data or []
        except Exception:
            return []
    
    async def update_batch(self, updates) -> List[Dict[str, Any]]:
        return []  # Simplified implementation
    
    async def delete_batch(self, ids) -> int:
        return 0  # Simplified implementation
    
    # Task-specific methods with minimal implementation
    async def get_by_project(self, project_id, include_closed=False, limit=None, offset=None) -> List[Dict[str, Any]]:
        filters = {'project_id': str(project_id)}
        if not include_closed:
            # Exclude DONE tasks - include TODO, DOING, and REVIEW
            try:
                query = self._client.table(self._table).select('*').eq('project_id', str(project_id))
                query = query.neq('status', TaskStatus.DONE.value)
                if limit:
                    query = query.limit(limit)
                if offset:
                    query = query.offset(offset)
                response = query.execute()
                return response.data or []
            except Exception as e:
                self._logger.error(f"Failed to get tasks by project: {e}")
                return []
        return await self.list(filters=filters, limit=limit, offset=offset)
    
    async def get_by_status(self, project_id, status, limit=None) -> List[Dict[str, Any]]:
        return await self.list(filters={'project_id': str(project_id), 'status': status.value}, limit=limit)
    
    async def update_status(self, task_id, status, assignee=None) -> Optional[Dict[str, Any]]:
        update_data = {'status': status.value}
        if assignee:
            update_data['assignee'] = assignee
        return await self.update(task_id, update_data)
    
    async def archive(self, task_id) -> bool:
        return await self.delete(task_id)  # Simplified: just delete
    
    # Remaining methods with minimal/placeholder implementations
    async def get_by_assignee(self, assignee, status_filter=None, limit=None) -> List[Dict[str, Any]]:
        filters = {'assignee': assignee}
        if status_filter:
            filters['status'] = status_filter.value
        return await self.list(filters=filters, limit=limit)
    
    async def get_by_feature(self, project_id, feature, include_closed=False) -> List[Dict[str, Any]]:
        filters = {'project_id': str(project_id), 'feature': feature}
        return await self.list(filters=filters)
    
    async def update_task_order(self, task_id, new_order) -> Optional[Dict[str, Any]]:
        return await self.update(task_id, {'task_order': new_order})
    
    async def add_source_reference(self, task_id, source) -> Optional[Dict[str, Any]]:
        # Simplified implementation - would need to handle JSONB array operations
        return await self.get_by_id(task_id)
    
    async def add_code_example(self, task_id, code_example) -> Optional[Dict[str, Any]]:
        # Simplified implementation - would need to handle JSONB array operations
        return await self.get_by_id(task_id)
    
    async def get_task_statistics(self, project_id=None) -> Dict[str, Any]:
        filters = {'project_id': str(project_id)} if project_id else None
        tasks = await self.list(filters=filters)
        return {
            'total_tasks': len(tasks),
            'by_status': {},
            'by_assignee': {},
            'by_feature': {}
        }
    
    async def bulk_update_status(self, task_ids, status, assignee=None) -> List[Dict[str, Any]]:
        results = []
        for task_id in task_ids:
            result = await self.update_status(task_id, status, assignee)
            if result:
                results.append(result)
        return results


class SupabaseVersionRepository(IVersionRepository):
    """Minimal version repository implementation."""
    
    def __init__(self, client: Client):
        self._client = client
        self._table = 'archon_document_versions'
        self._logger = logging.getLogger(__name__)
    
    # Minimal implementations for base repository methods
    async def create(self, entity: Dict[str, Any]) -> Dict[str, Any]:
        try:
            response = self._client.table(self._table).insert(entity).execute()
            return response.data[0] if response.data else {}
        except Exception as e:
            self._logger.error(f"Failed to create version: {e}")
            raise
    
    async def get_by_id(self, id: Union[str, UUID, int]) -> Optional[Dict[str, Any]]:
        try:
            response = self._client.table(self._table).select('*').eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            return None
    
    async def update(self, id: Union[str, UUID, int], data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        try:
            response = self._client.table(self._table).update(data).eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            return None
    
    async def delete(self, id: Union[str, UUID, int]) -> bool:
        try:
            response = self._client.table(self._table).delete().eq('id', str(id)).execute()
            return len(response.data) > 0
        except Exception as e:
            return False
    
    async def list(self, filters=None, limit=None, offset=None, order_by=None, order_direction="asc") -> List[Dict[str, Any]]:
        try:
            query = self._client.table(self._table).select('*')
            if filters:
                for key, value in filters.items():
                    query = query.eq(key, value)
            response = query.execute()
            return response.data or []
        except Exception:
            return []
    
    async def count(self, filters=None) -> int:
        versions = await self.list(filters=filters)
        return len(versions)
    
    async def exists(self, id) -> bool:
        return await self.get_by_id(id) is not None
    
    async def create_batch(self, entities) -> List[Dict[str, Any]]:
        return []  # Simplified
    
    async def update_batch(self, updates) -> List[Dict[str, Any]]:
        return []  # Simplified
    
    async def delete_batch(self, ids) -> int:
        return 0  # Simplified
    
    # Version-specific methods with minimal implementation
    async def create_snapshot(self, project_id, field_name, content, change_summary, created_by="system", change_type="automatic", document_id=None) -> Dict[str, Any]:
        version_data = {
            'project_id': str(project_id),
            'field_name': field_name,
            'content': content,
            'change_summary': change_summary,
            'created_by': created_by,
            'change_type': change_type,
            'version_number': 1,  # Simplified - would need to get next version number
        }
        if document_id:
            version_data['document_id'] = str(document_id)
        
        return await self.create(version_data)
    
    async def get_version_history(self, project_id, field_name, limit=None, document_id=None) -> List[Dict[str, Any]]:
        filters = {'project_id': str(project_id), 'field_name': field_name}
        if document_id:
            filters['document_id'] = str(document_id)
        return await self.list(filters=filters, limit=limit, order_by='version_number', order_direction='desc')
    
    async def get_version(self, project_id, field_name, version_number) -> Optional[Dict[str, Any]]:
        versions = await self.list(filters={
            'project_id': str(project_id),
            'field_name': field_name,
            'version_number': version_number
        })
        return versions[0] if versions else None
    
    async def restore_version(self, project_id, field_name, version_number, created_by="system") -> Dict[str, Any]:
        # Simplified implementation - would need to actually restore the data
        return await self.create_snapshot(
            project_id, field_name, {}, f"Restored to version {version_number}", created_by, "rollback"
        )
    
    async def get_latest_version_number(self, project_id, field_name) -> int:
        versions = await self.get_version_history(project_id, field_name, limit=1)
        return versions[0].get('version_number', 0) if versions else 0
    
    async def delete_old_versions(self, project_id, field_name, keep_latest=10) -> int:
        return 0  # Simplified implementation
    
    async def compare_versions(self, project_id, field_name, version_a, version_b) -> Dict[str, Any]:
        return {'differences': []}  # Simplified implementation
    
    async def get_version_statistics(self, project_id=None) -> Dict[str, Any]:
        filters = {'project_id': str(project_id)} if project_id else None
        versions = await self.list(filters=filters)
        return {
            'total_versions': len(versions),
            'by_field': {},
            'by_project': {},
            'by_change_type': {}
        }


class SupabaseCodeExampleRepository(ICodeExampleRepository):
    """Enhanced Supabase implementation of code example repository with vector search capabilities."""
    
    def __init__(self, client: Client):
        self._client = client
        self._table = 'archon_code_examples'
        self._logger = logging.getLogger(__name__)
    
    # Minimal implementations for base repository methods
    async def create(self, entity: Dict[str, Any]) -> Dict[str, Any]:
        try:
            response = self._client.table(self._table).insert(entity).execute()
            return response.data[0] if response.data else {}
        except Exception as e:
            self._logger.error(f"Failed to create code example: {e}")
            raise
    
    async def get_by_id(self, id: Union[str, UUID, int]) -> Optional[Dict[str, Any]]:
        try:
            response = self._client.table(self._table).select('*').eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            return None
    
    async def update(self, id: Union[str, UUID, int], data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        try:
            response = self._client.table(self._table).update(data).eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            return None
    
    async def delete(self, id: Union[str, UUID, int]) -> bool:
        try:
            response = self._client.table(self._table).delete().eq('id', str(id)).execute()
            return len(response.data) > 0
        except Exception as e:
            return False
    
    async def list(self, filters=None, limit=None, offset=None, order_by=None, order_direction="asc") -> List[Dict[str, Any]]:
        try:
            query = self._client.table(self._table).select('*')
            if filters:
                for key, value in filters.items():
                    query = query.eq(key, value)
            response = query.execute()
            return response.data or []
        except Exception:
            return []
    
    async def count(self, filters=None) -> int:
        examples = await self.list(filters=filters)
        return len(examples)
    
    async def exists(self, id) -> bool:
        return await self.get_by_id(id) is not None
    
    async def create_batch(self, entities) -> List[Dict[str, Any]]:
        try:
            response = self._client.table(self._table).insert(entities).execute()
            return response.data or []
        except Exception:
            return []
    
    async def update_batch(self, updates) -> List[Dict[str, Any]]:
        return []  # Simplified
    
    async def delete_batch(self, ids) -> int:
        return 0  # Simplified
    
    # Code example specific methods with minimal implementation
    async def search_by_summary(
        self, 
        query: str, 
        limit: int = 5, 
        source_filter: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        try:
            search_query = self._client.table(self._table).select('*')
            search_query = search_query.text_search('summary', query)
            if source_filter:
                search_query = search_query.eq('source_id', source_filter)
            if limit:
                search_query = search_query.limit(limit)
            response = search_query.execute()
            return response.data or []
        except Exception:
            return []
    
    async def get_by_language(
        self, 
        language: str, 
        limit: Optional[int] = None, 
        offset: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        return await self.list(filters={'language': language}, limit=limit, offset=offset)
    
    async def get_by_source(
        self, 
        source_id: str, 
        limit: Optional[int] = None, 
        offset: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        return await self.list(filters={'source_id': source_id}, limit=limit, offset=offset)
    
    async def search_by_metadata(
        self, 
        metadata_query: Dict[str, Any], 
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        # Simplified implementation - would need complex JSONB querying
        return []
    
    async def get_languages(self) -> List[str]:
        examples = await self.list()
        return list(set(ex.get('language', 'unknown') for ex in examples))
    
    async def delete_by_source(self, source_id) -> int:
        try:
            response = self._client.table(self._table).delete().eq('source_id', source_id).execute()
            return len(response.data)
        except Exception:
            return 0
    
    async def get_code_statistics(self) -> Dict[str, Any]:
        examples = await self.list()
        return {
            'total_examples': len(examples),
            'by_language': {},
            'by_source': {},
            'avg_code_length': 0
        }
    
    async def search_code_content(
        self, 
        query: str, 
        language_filter: Optional[str] = None, 
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        try:
            search_query = self._client.table(self._table).select('*')
            search_query = search_query.text_search('code_block', query)
            if language_filter:
                search_query = search_query.eq('language', language_filter)
            if limit:
                search_query = search_query.limit(limit)
            response = search_query.execute()
            return response.data or []
        except Exception:
            return []
    
    async def vector_search(
        self,
        embedding: List[float],
        limit: int = 10,
        source_filter: Optional[str] = None,
        metadata_filter: Optional[Dict[str, Any]] = None
    ) -> List[Dict[str, Any]]:
        """Perform vector similarity search on code examples using match_archon_code_examples RPC."""
        try:
            # Validate input parameters
            if not embedding:
                raise ValueError("embedding cannot be empty")
            if len(embedding) != 1536:
                raise ValueError("embedding must have 1536 dimensions")
            if limit <= 0 or limit > 1000:
                raise ValueError("limit must be between 1 and 1000")
            
            # Prepare RPC function parameters
            params = {
                'query_embedding': embedding,
                'match_count': limit,
                'filter': metadata_filter or {},
                'source_filter': source_filter
            }
            
            # Call the Supabase RPC function for code examples
            response = self._client.rpc('match_archon_code_examples', params).execute()
            
            if not response.data:
                self._logger.info(f"Vector search returned no code examples for limit={limit}")
                return []
            
            # Process results and add similarity scores
            results = []
            for row in response.data:
                code_example_data = {
                    'id': row['id'],
                    'url': row['url'],
                    'chunk_number': row['chunk_number'],
                    'content': row['content'],  # This is the code block
                    'summary': row.get('summary', ''),
                    'metadata': row.get('metadata', {}),
                    'source_id': row['source_id'],
                    'similarity_score': row.get('similarity', 0.0)
                }
                # Add similarity score to metadata for backward compatibility
                code_example_data['metadata']['similarity_score'] = code_example_data['similarity_score']
                code_example_data['metadata']['search_type'] = 'vector_search'
                results.append(code_example_data)
            
            self._logger.info(f"Vector search returned {len(results)} code examples")
            return results
            
        except Exception as e:
            self._logger.error(f"Code example vector search failed: {e}", exc_info=True)
            return []
    
    def _calculate_text_relevance(self, query: str, text: str) -> float:
        """Calculate text relevance score for code summaries and descriptions."""
        if not query or not text:
            return 0.0
        
        query_lower = query.lower()
        text_lower = text.lower()
        
        # Simple keyword matching
        query_words = query_lower.split()
        if not query_words:
            return 0.0
        
        matches = sum(1 for word in query_words if word in text_lower)
        word_freq_score = matches / len(query_words)
        
        # Bonus for phrase matches
        phrase_bonus = 0.3 if query_lower in text_lower else 0.0
        
        return min(1.0, word_freq_score + phrase_bonus)
    
    def _calculate_code_relevance(self, query: str, code: str) -> float:
        """Calculate relevance score specifically for code content."""
        if not query or not code:
            return 0.0
        
        query_lower = query.lower()
        code_lower = code.lower()
        
        # Check for exact matches (higher weight for code)
        if query_lower in code_lower:
            return 1.0
        
        # Check for word matches
        query_words = query_lower.split()
        if not query_words:
            return 0.0
        
        matches = sum(1 for word in query_words if word in code_lower)
        word_score = matches / len(query_words)
        
        # Bonus for function/class name matches (common code patterns)
        code_patterns = ['def ', 'class ', 'function ', 'const ', 'var ', 'let ']
        pattern_bonus = 0.0
        for word in query_words:
            for pattern in code_patterns:
                if f'{pattern}{word}' in code_lower:
                    pattern_bonus += 0.2
                    break
        
        return min(1.0, word_score + pattern_bonus)


class SupabasePromptRepository(IPromptRepository):
    """Minimal prompt repository implementation."""
    
    def __init__(self, client: Client):
        self._client = client
        self._table = 'archon_prompts'
        self._logger = logging.getLogger(__name__)
    
    # Minimal implementations for base repository methods
    async def create(self, entity: Dict[str, Any]) -> Dict[str, Any]:
        try:
            response = self._client.table(self._table).insert(entity).execute()
            return response.data[0] if response.data else {}
        except Exception as e:
            self._logger.error(f"Failed to create prompt: {e}")
            raise
    
    async def get_by_id(self, id: Union[str, UUID, int]) -> Optional[Dict[str, Any]]:
        try:
            response = self._client.table(self._table).select('*').eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            return None
    
    async def update(self, id: Union[str, UUID, int], data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        try:
            response = self._client.table(self._table).update(data).eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            return None
    
    async def delete(self, id: Union[str, UUID, int]) -> bool:
        try:
            response = self._client.table(self._table).delete().eq('id', str(id)).execute()
            return len(response.data) > 0
        except Exception as e:
            return False
    
    async def list(self, filters=None, limit=None, offset=None, order_by=None, order_direction="asc") -> List[Dict[str, Any]]:
        try:
            query = self._client.table(self._table).select('*')
            if filters:
                for key, value in filters.items():
                    query = query.eq(key, value)
            response = query.execute()
            return response.data or []
        except Exception:
            return []
    
    async def count(self, filters=None) -> int:
        prompts = await self.list(filters=filters)
        return len(prompts)
    
    async def exists(self, id) -> bool:
        return await self.get_by_id(id) is not None
    
    async def create_batch(self, entities) -> List[Dict[str, Any]]:
        return []  # Simplified
    
    async def update_batch(self, updates) -> List[Dict[str, Any]]:
        return []  # Simplified
    
    async def delete_batch(self, ids) -> int:
        return 0  # Simplified
    
    # Prompt-specific methods with minimal implementation
    async def get_by_name(self, name, version=None) -> Optional[Dict[str, Any]]:
        filters = {'name': name}
        if version:
            filters['version'] = version
        else:
            filters['is_active'] = True
        prompts = await self.list(filters=filters)
        return prompts[0] if prompts else None
    
    async def get_by_category(self, category) -> List[Dict[str, Any]]:
        return await self.list(filters={'category': category, 'is_active': True}, order_by='name')
    
    async def create_version(self, name, title, content, category="general", version=None, variables=None, metadata=None, created_by="system", is_active=True) -> Dict[str, Any]:
        prompt_data = {
            'name': name,
            'title': title,
            'content': content,
            'category': category,
            'version': version or '1.0',
            'variables': variables or [],
            'metadata': metadata or {},
            'created_by': created_by,
            'is_active': is_active,
            'is_system': False
        }
        return await self.create(prompt_data)
    
    async def set_active_version(self, name, version) -> Optional[Dict[str, Any]]:
        # Simplified implementation - would need to deactivate other versions first
        prompts = await self.list(filters={'name': name, 'version': version})
        if prompts:
            return await self.update(prompts[0]['id'], {'is_active': True})
        return None
    
    async def get_versions(self, name) -> List[Dict[str, Any]]:
        return await self.list(filters={'name': name}, order_by='created_at', order_direction='desc')
    
    async def render_prompt(self, name, variables, version=None) -> str:
        prompt = await self.get_by_name(name, version)
        if prompt:
            content = prompt.get('content', '')
            # Simple variable substitution - would need proper template engine
            for key, value in variables.items():
                content = content.replace(f'{{{key}}}', str(value))
            return content
        return ''
    
    async def validate_variables(self, name, variables, version=None) -> Dict[str, Any]:
        prompt = await self.get_by_name(name, version)
        if prompt:
            required_vars = prompt.get('variables', [])
            missing = [var for var in required_vars if var not in variables]
            return {'valid': len(missing) == 0, 'missing': missing}
        return {'valid': False, 'missing': []}
    
    async def get_user_prompts(self) -> List[Dict[str, Any]]:
        return await self.list(filters={'is_system': False})
    
    async def clone_prompt(self, source_name, new_name, new_title, created_by="user") -> Dict[str, Any]:
        source = await self.get_by_name(source_name)
        if source:
            clone_data = source.copy()
            clone_data.update({
                'name': new_name,
                'title': new_title,
                'created_by': created_by,
                'is_system': False
            })
            clone_data.pop('id', None)  # Remove ID to create new record
            return await self.create(clone_data)
        return {}
    
    async def update_metadata(self, name, version, metadata_updates) -> Optional[Dict[str, Any]]:
        prompt = await self.get_by_name(name, version)
        if prompt:
            current_metadata = prompt.get('metadata', {})
            current_metadata.update(metadata_updates)
            return await self.update(prompt['id'], {'metadata': current_metadata})
        return None
    
    async def get_categories(self) -> List[str]:
        prompts = await self.list()
        return list(set(p.get('category', 'general') for p in prompts))
    
    async def search_prompts(self, query, category_filter=None, limit=10) -> List[Dict[str, Any]]:
        # Simplified implementation - would need full-text search
        filters = {}
        if category_filter:
            filters['category'] = category_filter
        prompts = await self.list(filters=filters, limit=limit)
        # Simple text matching
        return [p for p in prompts if query.lower() in p.get('title', '').lower() or query.lower() in p.get('content', '').lower()]
    
    async def get_prompt_usage_stats(self, name) -> Dict[str, Any]:
        return {'usage_count': 0, 'last_used': None}  # Simplified
    
    async def delete_version(self, name, version) -> bool:
        prompt = await self.get_by_name(name, version)
        if prompt:
            return await self.delete(prompt['id'])
        return False

