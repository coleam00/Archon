"""
Crawling Models Module

This module contains Pydantic models for crawling configuration,
specifically for domain filtering and URL pattern matching.
"""


from pydantic import BaseModel, Field, validator


class CrawlConfig(BaseModel):
    """Configuration for domain filtering during crawl."""

    allowed_domains: list[str] | None = Field(None, description="Whitelist of domains to crawl")
    excluded_domains: list[str] | None = Field(None, description="Blacklist of domains to exclude")
    include_patterns: list[str] | None = Field(None, description="URL patterns to include (glob-style)")
    exclude_patterns: list[str] | None = Field(None, description="URL patterns to exclude (glob-style)")

    @validator("allowed_domains", "excluded_domains", pre=True)
    def normalize_domains(cls, v):
        """Normalize domain formats for consistent matching."""
        if v is None:
            return v
        return [d.lower().strip().replace("http://", "").replace("https://", "").rstrip("/") for d in v]

    @validator("include_patterns", "exclude_patterns", pre=True)
    def validate_patterns(cls, v):
        """Validate URL patterns are valid glob patterns."""
        if v is None:
            return v
        # Ensure patterns are strings and not empty
        return [p.strip() for p in v if p and isinstance(p, str) and p.strip()]


class CrawlRequestV2(BaseModel):
    """Extended crawl request with domain filtering."""

    url: str = Field(..., description="URL to start crawling from")
    knowledge_type: str | None = Field("technical", description="Type of knowledge (technical/business)")
    tags: list[str] | None = Field(default_factory=list, description="Tags to apply to crawled content")
    update_frequency: int | None = Field(None, description="Update frequency in days")
    max_depth: int | None = Field(3, description="Maximum crawl depth")
    crawl_config: CrawlConfig | None = Field(None, description="Domain filtering configuration")
    crawl_options: dict | None = Field(None, description="Additional crawl options")
    extract_code_examples: bool | None = Field(True, description="Whether to extract code examples")

    @validator("url")
    def validate_url(cls, v):
        """Ensure URL is properly formatted."""
        if not v or not v.strip():
            raise ValueError("URL cannot be empty")
        # Add http:// if no protocol specified
        if not v.startswith(("http://", "https://")):
            v = f"https://{v}"
        return v.strip()

    @validator("knowledge_type")
    def validate_knowledge_type(cls, v):
        """Ensure knowledge type is valid."""
        if v and v not in ["technical", "business"]:
            return "technical"  # Default to technical if invalid
        return v or "technical"
