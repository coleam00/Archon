"""
Domain models and entities for the Archon Server repository layer.

This module contains Pydantic models that represent the core business entities
used throughout the repository layer. These models provide type safety,
validation, and serialization support for all database operations.
"""

from datetime import datetime
from typing import Any, Dict, List, Optional, Union
from uuid import UUID

from pydantic import BaseModel, Field


class BaseEntity(BaseModel):
    """Base entity with common fields for all domain models."""
    
    id: Optional[Union[UUID, str, int]] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class Source(BaseEntity):
    """
    Source entity representing crawled websites and uploaded documents.
    
    Maps to archon_sources table and contains metadata about knowledge sources
    including crawling status, statistics, and source-specific information.
    """
    
    source_id: str = Field(..., description="Unique identifier for the source (domain or filename)")
    source_type: Optional[str] = Field(default="website", description="Type: website, upload, or api")
    base_url: Optional[str] = Field(None, description="Original URL or upload path")
    title: Optional[str] = Field(None, description="Descriptive title for the source")
    summary: Optional[str] = Field(None, description="AI-generated summary of source content")
    crawl_status: Optional[str] = Field(default="pending", description="Crawling status")
    total_pages: Optional[int] = Field(default=0, description="Total number of pages discovered")
    pages_crawled: Optional[int] = Field(default=0, description="Pages successfully crawled")
    total_word_count: Optional[int] = Field(default=0, description="Total word count across all documents")
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Source-specific metadata")
    
    def is_completed(self) -> bool:
        """Check if crawling is completed."""
        return self.crawl_status == 'completed'
    
    def get_progress_percentage(self) -> float:
        """Calculate crawling progress percentage."""
        if not self.total_pages or self.total_pages == 0:
            return 0.0
        return min(100.0, (self.pages_crawled or 0) / self.total_pages * 100.0)


class Document(BaseEntity):
    """
    Document entity representing processed document chunks with embeddings.
    
    Maps to archon_crawled_pages table and contains text chunks with vector
    embeddings for semantic search and retrieval operations.
    """
    
    url: str = Field(..., description="Source URL or file path")
    chunk_number: int = Field(..., description="Chunk index within the document")
    content: str = Field(..., description="Processed text content of the chunk")
    source_id: str = Field(..., description="Reference to source identifier")
    embedding: Optional[List[float]] = Field(None, description="Vector embedding for similarity search")
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Chunk-specific metadata")
    similarity_score: Optional[float] = Field(None, description="Similarity score from search results")
    
    def get_char_count(self) -> int:
        """Get character count of content."""
        return len(self.content) if self.content else 0
    
    def get_word_count(self) -> int:
        """Get approximate word count of content."""
        return len(self.content.split()) if self.content else 0


class CodeExample(BaseEntity):
    """
    Code example entity representing extracted code snippets with analysis.
    
    Maps to archon_code_examples table and contains code blocks with metadata
    for code-specific search, language filtering, and technical analysis.
    """
    
    url: str = Field(..., description="Source URL where code was found")
    chunk_number: int = Field(..., description="Chunk index within the document")
    source_id: str = Field(..., description="Reference to source identifier")
    code_block: str = Field(..., description="Extracted code snippet", alias="content")
    language: Optional[str] = Field(None, description="Detected programming language")
    summary: Optional[str] = Field(None, description="AI-generated summary of the code")
    embedding: Optional[List[float]] = Field(None, description="Vector embedding for similarity search")
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Code-specific metadata")
    similarity_score: Optional[float] = Field(None, description="Similarity score from search results")
    
    def get_code_length(self) -> int:
        """Get character count of code block."""
        return len(self.code_block) if self.code_block else 0
    
    def get_estimated_lines(self) -> int:
        """Get estimated number of code lines."""
        return len(self.code_block.split('\n')) if self.code_block else 0
    
    def extract_function_names(self) -> List[str]:
        """Extract function names from metadata if available."""
        if not self.metadata:
            return []
        return self.metadata.get('function_names', [])
    
    def extract_class_names(self) -> List[str]:
        """Extract class names from metadata if available."""
        if not self.metadata:
            return []
        return self.metadata.get('class_names', [])


class SearchResult(BaseModel):
    """
    Search result wrapper for unified search response formatting.
    
    Provides consistent structure for vector search, hybrid search,
    and other search operations across different entity types.
    """
    
    entity: Union[Document, CodeExample] = Field(..., description="The matched entity")
    similarity_score: float = Field(..., description="Relevance score (0.0 to 1.0)")
    search_type: str = Field(..., description="Type of search performed")
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Search-specific metadata")


class BatchOperationResult(BaseModel):
    """
    Result wrapper for batch operations with success/failure tracking.
    
    Provides detailed information about batch operations including
    success counts, failed items, and error details for debugging.
    """
    
    total_items: int = Field(..., description="Total number of items processed")
    successful_items: int = Field(..., description="Number of successfully processed items")
    failed_items: int = Field(default=0, description="Number of failed items")
    success_rate: float = Field(default=0.0, description="Success rate as percentage")
    errors: List[Dict[str, Any]] = Field(default_factory=list, description="List of error details")
    processing_time_seconds: Optional[float] = Field(None, description="Total processing time")
    
    def is_fully_successful(self) -> bool:
        """Check if all items were processed successfully."""
        return self.failed_items == 0 and self.successful_items == self.total_items
    
    def add_error(self, item_id: Optional[str], error_message: str, error_details: Optional[Dict[str, Any]] = None):
        """Add an error to the error list."""
        error_entry = {
            'item_id': item_id,
            'error_message': error_message,
            'timestamp': datetime.utcnow().isoformat()
        }
        if error_details:
            error_entry['details'] = error_details
        self.errors.append(error_entry)
        self.failed_items += 1


class ContentStatistics(BaseModel):
    """
    Content statistics for knowledge base analysis and reporting.
    
    Provides aggregate information about documents, sources, and
    content distribution for dashboard and analytics purposes.
    """
    
    total_documents: int = Field(default=0, description="Total number of document chunks")
    total_sources: int = Field(default=0, description="Total number of unique sources") 
    total_code_examples: int = Field(default=0, description="Total number of code examples")
    by_source: Dict[str, int] = Field(default_factory=dict, description="Document counts by source")
    by_language: Dict[str, int] = Field(default_factory=dict, description="Code example counts by language")
    avg_chunk_size: int = Field(default=0, description="Average document chunk size in characters")
    avg_code_length: int = Field(default=0, description="Average code example length in characters")
    total_word_count: int = Field(default=0, description="Total word count across all documents")
    last_updated: datetime = Field(default_factory=datetime.utcnow, description="When statistics were calculated")
    
    def get_content_distribution(self) -> Dict[str, float]:
        """Calculate percentage distribution of content by source."""
        if not self.by_source or self.total_documents == 0:
            return {}
        
        return {
            source: (count / self.total_documents) * 100.0
            for source, count in self.by_source.items()
        }
    
    def get_language_distribution(self) -> Dict[str, float]:
        """Calculate percentage distribution of code examples by language."""
        if not self.by_language or self.total_code_examples == 0:
            return {}
        
        return {
            language: (count / self.total_code_examples) * 100.0
            for language, count in self.by_language.items()
        }


class VectorSearchParams(BaseModel):
    """
    Parameters for vector similarity search operations.
    
    Encapsulates all parameters needed for vector search including
    embedding, filters, and search configuration options.
    """
    
    embedding: List[float] = Field(..., description="Query vector embedding")
    limit: int = Field(default=10, description="Maximum number of results")
    source_filter: Optional[str] = Field(None, description="Filter by specific source")
    metadata_filter: Optional[Dict[str, Any]] = Field(None, description="Additional metadata filters")
    similarity_threshold: Optional[float] = Field(None, description="Minimum similarity score threshold")


class HybridSearchParams(BaseModel):
    """
    Parameters for hybrid search combining vector and keyword search.
    
    Extends vector search with keyword search capabilities and
    weighting parameters for balanced retrieval results.
    """
    
    query: str = Field(..., description="Text query for keyword search")
    embedding: List[float] = Field(..., description="Query vector embedding")
    limit: int = Field(default=10, description="Maximum number of results")
    source_filter: Optional[str] = Field(None, description="Filter by specific source")
    keyword_weight: float = Field(default=0.5, description="Weight for keyword search component")
    vector_weight: float = Field(default=0.5, description="Weight for vector search component")