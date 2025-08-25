"""
Knowledge base repository interfaces.

This module contains repository interfaces for all knowledge base related entities:
- ISourceRepository: Manages archon_sources table for crawled websites and uploaded documents
- IDocumentRepository: Manages archon_crawled_pages table with vector search capabilities
- ICodeExampleRepository: Manages archon_code_examples table for extracted code snippets

These interfaces extend the base repository with domain-specific operations
for knowledge management, vector similarity search, and batch processing.
"""

from abc import abstractmethod
from typing import List, Optional, Dict, Any, Union
from uuid import UUID

from .base_repository import IBaseRepository


class ISourceRepository(IBaseRepository[Dict[str, Any]]):
    """
    Repository interface for archon_sources table.
    
    Manages crawled websites and uploaded documents metadata including
    source type (website/upload), crawling status, statistics, and configuration.
    
    Table Schema (archon_sources):
    - id (UUID): Primary key
    - source_id (str): Unique identifier (domain for websites, filename for uploads)
    - source_type (str): Type of source ('website' or 'upload')
    - base_url (str): Original URL or upload path
    - crawl_status (str): Current crawling status ('pending', 'in_progress', 'completed', 'failed')
    - total_pages (int): Number of pages/chunks discovered
    - pages_crawled (int): Number of pages/chunks successfully processed
    - metadata (JSONB): Additional source-specific metadata
    - created_at (timestamp): Creation timestamp
    - updated_at (timestamp): Last update timestamp
    """
    
    @abstractmethod
    async def get_by_source_id(self, source_id: str) -> Optional[Dict[str, Any]]:
        """
        Retrieve a source by its unique source_id.
        
        Args:
            source_id: Unique identifier for the source (domain or filename)
            
        Returns:
            Source record if found, None otherwise
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass
    
    @abstractmethod
    async def update_crawl_status(
        self, 
        source_id: str, 
        status: str,
        pages_crawled: Optional[int] = None,
        total_pages: Optional[int] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Update crawling status and progress for a source.
        
        Args:
            source_id: Unique identifier for the source
            status: New crawling status ('pending', 'in_progress', 'completed', 'failed')
            pages_crawled: Number of pages successfully crawled (optional)
            total_pages: Total number of pages discovered (optional)
            
        Returns:
            Updated source record if found, None otherwise
            
        Raises:
            RepositoryError: If update fails due to database errors
        """
        pass
    
    @abstractmethod
    async def update_metadata(
        self, 
        source_id: str, 
        metadata: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """
        Update or merge metadata for a source.
        
        Args:
            source_id: Unique identifier for the source
            metadata: Metadata dictionary to merge with existing metadata
            
        Returns:
            Updated source record if found, None otherwise
            
        Raises:
            RepositoryError: If update fails due to database errors
        """
        pass
    
    @abstractmethod
    async def get_by_status(self, status: str) -> List[Dict[str, Any]]:
        """
        Retrieve all sources with a specific crawling status.
        
        Args:
            status: Crawling status to filter by
            
        Returns:
            List of source records matching the status
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass
    
    @abstractmethod
    async def get_by_type(self, source_type: str) -> List[Dict[str, Any]]:
        """
        Retrieve all sources of a specific type.
        
        Args:
            source_type: Source type to filter by ('website' or 'upload')
            
        Returns:
            List of source records matching the type
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass
    
    @abstractmethod
    async def get_crawl_statistics(self) -> Dict[str, Any]:
        """
        Get aggregated crawling statistics across all sources.
        
        Returns:
            Dictionary containing statistics:
            - total_sources: Total number of sources
            - by_status: Count of sources by status
            - by_type: Count of sources by type
            - total_pages: Sum of all pages crawled
            
        Raises:
            RepositoryError: If aggregation fails due to database errors
        """
        pass


class IDocumentRepository(IBaseRepository[Dict[str, Any]]):
    """
    Repository interface for archon_crawled_pages table.
    
    Manages processed document chunks with vector embeddings for semantic search.
    Supports both vector similarity search and hybrid search combining keywords and vectors.
    
    Table Schema (archon_crawled_pages):
    - id (UUID): Primary key
    - url (str): Source URL or file path
    - chunk_number (int): Chunk index within the document
    - content (text): Processed text content
    - source_id (str): Reference to source identifier
    - metadata (JSONB): Chunk-specific metadata (headers, word count, etc.)
    - embedding (vector): Vector embedding for semantic search
    - created_at (timestamp): Creation timestamp
    """
    
    @abstractmethod
    async def create_batch(self, documents: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Create multiple document chunks in a single batch operation.
        
        Args:
            documents: List of document chunk dictionaries to create
            
        Returns:
            List of created document chunks with generated IDs
            
        Raises:
            RepositoryError: If batch creation fails
            ValidationError: If any document in the batch is invalid
        """
        pass
    
    @abstractmethod
    async def vector_search(
        self,
        embedding: List[float],
        limit: int = 10,
        source_filter: Optional[str] = None,
        metadata_filter: Optional[Dict[str, Any]] = None
    ) -> List[Dict[str, Any]]:
        """
        Perform vector similarity search using cosine similarity.
        
        Args:
            embedding: Query vector embedding for similarity search
            limit: Maximum number of results to return
            source_filter: Optional source_id to filter results by specific source
            metadata_filter: Optional metadata conditions to filter results
            
        Returns:
            List of document chunks ordered by similarity score (highest first)
            Each result includes similarity score in metadata
            
        Raises:
            RepositoryError: If vector search fails due to database errors
        """
        pass
    
    @abstractmethod
    async def hybrid_search(
        self,
        query: str,
        embedding: List[float],
        limit: int = 10,
        source_filter: Optional[str] = None,
        keyword_weight: float = 0.5,
        vector_weight: float = 0.5
    ) -> List[Dict[str, Any]]:
        """
        Perform hybrid search combining keyword and vector similarity.
        
        Args:
            query: Text query for keyword search
            embedding: Query vector embedding for similarity search
            limit: Maximum number of results to return
            source_filter: Optional source_id to filter results
            keyword_weight: Weight for keyword search component (0.0-1.0)
            vector_weight: Weight for vector search component (0.0-1.0)
            
        Returns:
            List of document chunks with combined relevance scores
            
        Raises:
            RepositoryError: If hybrid search fails due to database errors
            ValidationError: If weights don't sum to 1.0
        """
        pass
    
    @abstractmethod
    async def get_by_source(
        self,
        source_id: str,
        limit: Optional[int] = None,
        offset: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        Retrieve all document chunks for a specific source.
        
        Args:
            source_id: Source identifier to filter by
            limit: Maximum number of chunks to return
            offset: Number of chunks to skip for pagination
            
        Returns:
            List of document chunks for the source
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass
    
    @abstractmethod
    async def get_by_url(self, url: str) -> List[Dict[str, Any]]:
        """
        Retrieve all document chunks for a specific URL.
        
        Args:
            url: URL to filter chunks by
            
        Returns:
            List of document chunks for the URL, ordered by chunk_number
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass
    
    @abstractmethod
    async def delete_by_source(self, source_id: str) -> int:
        """
        Delete all document chunks for a specific source.
        
        Args:
            source_id: Source identifier to delete chunks for
            
        Returns:
            Number of chunks deleted
            
        Raises:
            RepositoryError: If deletion fails due to database errors
        """
        pass
    
    @abstractmethod
    async def delete_by_url(self, url: str) -> int:
        """
        Delete all document chunks for a specific URL.
        
        Args:
            url: URL to delete chunks for
            
        Returns:
            Number of chunks deleted
            
        Raises:
            RepositoryError: If deletion fails due to database errors
        """
        pass
    
    @abstractmethod
    async def get_content_statistics(self) -> Dict[str, Any]:
        """
        Get aggregated content statistics.
        
        Returns:
            Dictionary containing statistics:
            - total_chunks: Total number of document chunks
            - total_sources: Number of unique sources
            - by_source: Count of chunks per source
            - avg_chunk_size: Average chunk size in characters
            
        Raises:
            RepositoryError: If aggregation fails due to database errors
        """
        pass
    
    @abstractmethod
    async def search_content(
        self,
        query: str,
        limit: int = 10,
        source_filter: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Perform full-text search on document content.
        
        Args:
            query: Text query for full-text search
            limit: Maximum number of results to return
            source_filter: Optional source_id to filter results
            
        Returns:
            List of document chunks matching the text query
            
        Raises:
            RepositoryError: If text search fails due to database errors
        """
        pass


class ICodeExampleRepository(IBaseRepository[Dict[str, Any]]):
    """
    Repository interface for archon_code_examples table.
    
    Manages extracted code snippets with metadata for code-specific search and analysis.
    Supports searching by programming language, function names, and code summaries.
    
    Table Schema (archon_code_examples):
    - id (UUID): Primary key
    - source_id (str): Reference to source identifier
    - url (str): Source URL where code was found
    - code_block (text): Extracted code snippet
    - language (str): Programming language detected
    - summary (text): AI-generated summary of the code
    - metadata (JSONB): Code-specific metadata (function names, classes, etc.)
    - created_at (timestamp): Creation timestamp
    """
    
    @abstractmethod
    async def create_batch(self, code_examples: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Create multiple code examples in a single batch operation.
        
        Args:
            code_examples: List of code example dictionaries to create
            
        Returns:
            List of created code examples with generated IDs
            
        Raises:
            RepositoryError: If batch creation fails
            ValidationError: If any code example in the batch is invalid
        """
        pass
    
    @abstractmethod
    async def search_by_summary(
        self,
        query: str,
        limit: int = 5,
        source_filter: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Search code examples by summary using full-text search.
        
        Args:
            query: Text query to search in code summaries
            limit: Maximum number of results to return
            source_filter: Optional source_id to filter results
            
        Returns:
            List of code examples with matching summaries
            
        Raises:
            RepositoryError: If search fails due to database errors
        """
        pass
    
    @abstractmethod
    async def get_by_language(
        self,
        language: str,
        limit: Optional[int] = None,
        offset: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        Retrieve code examples by programming language.
        
        Args:
            language: Programming language to filter by
            limit: Maximum number of examples to return
            offset: Number of examples to skip for pagination
            
        Returns:
            List of code examples in the specified language
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass
    
    @abstractmethod
    async def get_by_source(
        self,
        source_id: str,
        limit: Optional[int] = None,
        offset: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        Retrieve all code examples for a specific source.
        
        Args:
            source_id: Source identifier to filter by
            limit: Maximum number of examples to return
            offset: Number of examples to skip for pagination
            
        Returns:
            List of code examples for the source
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass
    
    @abstractmethod
    async def search_by_metadata(
        self,
        metadata_query: Dict[str, Any],
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        """
        Search code examples by metadata criteria.
        
        Args:
            metadata_query: Dictionary of metadata field-value pairs to search
            limit: Maximum number of results to return
            
        Returns:
            List of code examples matching the metadata criteria
            
        Raises:
            RepositoryError: If metadata search fails due to database errors
        """
        pass
    
    @abstractmethod
    async def get_languages(self) -> List[str]:
        """
        Get all distinct programming languages found in code examples.
        
        Returns:
            List of unique programming language identifiers
            
        Raises:
            RepositoryError: If query fails due to database errors
        """
        pass
    
    @abstractmethod
    async def delete_by_source(self, source_id: str) -> int:
        """
        Delete all code examples for a specific source.
        
        Args:
            source_id: Source identifier to delete examples for
            
        Returns:
            Number of code examples deleted
            
        Raises:
            RepositoryError: If deletion fails due to database errors
        """
        pass
    
    @abstractmethod
    async def get_code_statistics(self) -> Dict[str, Any]:
        """
        Get aggregated code example statistics.
        
        Returns:
            Dictionary containing statistics:
            - total_examples: Total number of code examples
            - by_language: Count of examples per programming language
            - by_source: Count of examples per source
            - avg_code_length: Average code block length in characters
            
        Raises:
            RepositoryError: If aggregation fails due to database errors
        """
        pass
    
    @abstractmethod
    async def search_code_content(
        self,
        query: str,
        language_filter: Optional[str] = None,
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        """
        Perform full-text search on code block content.
        
        Args:
            query: Text query for searching code content
            language_filter: Optional programming language to filter by
            limit: Maximum number of results to return
            
        Returns:
            List of code examples with matching code content
            
        Raises:
            RepositoryError: If code search fails due to database errors
        """
        pass