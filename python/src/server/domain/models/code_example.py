"""
CodeExample Domain Model.

Represents an extracted code example from documentation.
Maps to the archon_code_examples table.
"""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class CodeExample(BaseModel):
    """
    An extracted code example.

    Represents a code snippet extracted from documentation with
    its context, language, and vector embedding for semantic search.

    Attributes:
        id: Unique identifier (UUID)
        source_id: Foreign key to archon_sources
        page_url: URL of the page containing this code
        code: The actual code content
        language: Programming language (python, javascript, etc.)
        summary: AI-generated summary of what the code does
        context: Surrounding text/documentation context
        metadata: Additional metadata
        embedding_*: Vector embeddings for different dimensions
        created_at: When the example was extracted
    """

    id: str | None = Field(default=None, description="UUID primary key")
    source_id: str = Field(..., description="Foreign key to archon_sources")
    page_url: str = Field(..., description="URL of the page containing this code")
    code: str = Field(..., description="The code content")
    language: str | None = Field(default=None, description="Programming language")
    summary: str | None = Field(default=None, description="Summary of what the code does")
    context: str | None = Field(default=None, description="Surrounding documentation context")
    metadata: dict[str, Any] = Field(default_factory=dict, description="Additional metadata")

    # Embedding columns - support multiple dimensions
    embedding_768: list[float] | None = Field(default=None, description="768-dim embedding")
    embedding_1024: list[float] | None = Field(default=None, description="1024-dim embedding")
    embedding_1536: list[float] | None = Field(default=None, description="1536-dim embedding")
    embedding_3072: list[float] | None = Field(default=None, description="3072-dim embedding")

    embedding_model: str | None = Field(default=None, description="Embedding model used")
    embedding_dimension: int | None = Field(default=None, description="Dimension of the embedding")

    created_at: datetime | None = Field(default=None, description="Creation timestamp")

    def get_embedding(self) -> list[float] | None:
        """Get the active embedding based on embedding_dimension."""
        if self.embedding_dimension == 768:
            return self.embedding_768
        elif self.embedding_dimension == 1024:
            return self.embedding_1024
        elif self.embedding_dimension == 1536:
            return self.embedding_1536
        elif self.embedding_dimension == 3072:
            return self.embedding_3072
        return self.embedding_1536 or self.embedding_768 or self.embedding_1024 or self.embedding_3072


class CodeExampleCreate(BaseModel):
    """
    DTO for creating a new CodeExample.

    Used when extracting and storing code examples from documentation.
    """

    source_id: str = Field(..., description="Foreign key to archon_sources")
    page_url: str = Field(..., description="URL of the page containing this code")
    code: str = Field(..., description="The code content")
    language: str | None = Field(default=None, description="Programming language")
    summary: str | None = Field(default=None, description="Summary of what the code does")
    context: str | None = Field(default=None, description="Surrounding documentation context")
    metadata: dict[str, Any] = Field(default_factory=dict, description="Additional metadata")
    embedding: list[float] | None = Field(default=None, description="Vector embedding")
    embedding_dimension: int | None = Field(default=None, description="Embedding dimension")
    embedding_model: str | None = Field(default=None, description="Embedding model used")
