"""
SearchResult Domain Model.

Represents a search result with similarity score.
"""

from typing import Generic, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class SearchResult(BaseModel, Generic[T]):
    """
    A search result with similarity score.

    Used to wrap items returned from vector similarity searches.

    Attributes:
        item: The matched item (CrawledPage, CodeExample, etc.)
        similarity: Cosine similarity score (0.0 to 1.0)
    """

    item: T = Field(..., description="The matched item")
    similarity: float = Field(..., ge=0.0, le=1.0, description="Similarity score")

    model_config = {"arbitrary_types_allowed": True}
