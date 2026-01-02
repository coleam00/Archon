"""
Source Domain Model.

Represents a documentation source (e.g., a website, documentation site).
Maps to the archon_sources table.
"""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class Source(BaseModel):
    """
    A documentation source.

    Represents a crawled documentation source with metadata about
    the crawl status, page count, and configuration.

    Attributes:
        source_id: Unique identifier (typically domain-based)
        url: Base URL of the source
        title: Human-readable title
        description: Description of the source content
        metadata: Additional metadata (crawl config, etc.)
        pages_count: Number of pages crawled
        chunks_count: Number of chunks stored
        status: Crawl status (pending, crawling, completed, failed)
        created_at: When the source was added
        updated_at: Last update timestamp
    """

    source_id: str = Field(..., description="Unique source identifier")
    url: str = Field(..., description="Base URL of the source")
    title: str | None = Field(default=None, description="Human-readable title")
    description: str | None = Field(default=None, description="Description of the source")
    metadata: dict[str, Any] = Field(default_factory=dict, description="Additional metadata")
    pages_count: int = Field(default=0, description="Number of pages crawled")
    chunks_count: int = Field(default=0, description="Number of chunks stored")
    status: str = Field(default="pending", description="Crawl status")
    created_at: datetime | None = Field(default=None, description="Creation timestamp")
    updated_at: datetime | None = Field(default=None, description="Last update timestamp")


class SourceCreate(BaseModel):
    """
    DTO for creating a new Source.

    Used when adding a new documentation source to crawl.
    """

    source_id: str = Field(..., description="Unique source identifier")
    url: str = Field(..., description="Base URL of the source")
    title: str | None = Field(default=None, description="Human-readable title")
    description: str | None = Field(default=None, description="Description of the source")
    metadata: dict[str, Any] = Field(default_factory=dict, description="Additional metadata")
