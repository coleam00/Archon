"""
Domain model for vector search results.

This module defines the result structure returned by similarity searches.
"""

from pydantic import BaseModel, Field
from .site_page import SitePage


class SearchResult(BaseModel):
    """
    Result from a vector similarity search.

    Combines a page with its similarity score to enable ranking and filtering.

    Attributes:
        page: The matching site page
        similarity: Cosine similarity score (0.0 to 1.0, higher is better)
    """

    page: SitePage
    similarity: float = Field(
        ge=0.0,
        le=1.0,
        description="Cosine similarity score between query and page embeddings",
    )

    model_config = {
        "json_schema_extra": {
            "examples": [
                {
                    "page": {
                        "id": 1,
                        "url": "https://ai.pydantic.dev/agents/",
                        "chunk_number": 0,
                        "title": "Agents - Pydantic AI",
                        "summary": "Introduction to building agents",
                        "content": "Pydantic AI is a framework...",
                        "metadata": {
                            "source": "pydantic_ai_docs",
                            "chunk_size": 1500,
                        },
                    },
                    "similarity": 0.87,
                }
            ]
        }
    }
