"""
Domain models for site pages and their metadata.

These models represent the core business entities for storing and managing
crawled documentation pages with their embeddings.
"""

from pydantic import BaseModel, Field
from datetime import datetime
from typing import Optional, List


class SitePageMetadata(BaseModel):
    """
    Metadata for a crawled documentation page.

    Attributes:
        source: Source identifier (e.g., "pydantic_ai_docs", "supabase_docs")
        chunk_size: Size of the content chunk in characters
        crawled_at: Timestamp when the page was crawled
        url_path: Relative path of the URL for easier filtering
    """

    source: str
    chunk_size: Optional[int] = None
    crawled_at: Optional[datetime] = None
    url_path: Optional[str] = None

    model_config = {"extra": "allow"}  # Allows additional fields for extensibility


class SitePage(BaseModel):
    """
    Represents a documentation page or chunk stored in the database.

    A single URL can have multiple chunks (identified by chunk_number).
    Each chunk can have its own embedding for vector similarity search.

    Attributes:
        id: Database identifier (None for new pages)
        url: Full URL of the page
        chunk_number: Chunk index for pages split into multiple parts (0-based)
        title: Page title
        summary: Brief summary of the content
        content: Full text content of the chunk
        metadata: Additional metadata about the page
        embedding: Vector embedding for similarity search (1536 dimensions for OpenAI)
        created_at: Timestamp when the record was created
    """

    id: Optional[int] = None
    url: str
    chunk_number: int = 0
    title: Optional[str] = None
    summary: Optional[str] = None
    content: Optional[str] = None
    metadata: SitePageMetadata
    embedding: Optional[List[float]] = None
    created_at: Optional[datetime] = None

    model_config = {
        "from_attributes": True,  # Enables conversion from ORM models and dicts
        "json_schema_extra": {
            "examples": [
                {
                    "id": 1,
                    "url": "https://ai.pydantic.dev/agents/",
                    "chunk_number": 0,
                    "title": "Agents - Pydantic AI",
                    "summary": "Introduction to building agents with Pydantic AI",
                    "content": "Pydantic AI is a framework for building...",
                    "metadata": {
                        "source": "pydantic_ai_docs",
                        "chunk_size": 1500,
                        "crawled_at": "2025-11-29T12:00:00Z",
                        "url_path": "/agents/",
                    },
                    "embedding": [0.1, 0.2, 0.3],  # Truncated for example
                    "created_at": "2025-11-29T12:05:00Z",
                }
            ]
        },
    }
