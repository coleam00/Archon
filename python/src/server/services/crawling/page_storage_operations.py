"""
Page Storage Operations

Handles the storage of complete documentation pages in the archon_page_metadata table.
Pages are stored BEFORE chunking to maintain full context for agent retrieval.
"""

from typing import Any

from ...config.logfire_config import get_logger, safe_logfire_info
from .helpers.llms_full_parser import parse_llms_full_sections

logger = get_logger(__name__)


class PageStorageOperations:
    """
    Handles page storage operations for crawled content.

    Pages are stored in the archon_page_metadata table with full content and metadata.
    This enables agents to retrieve complete documentation pages instead of just chunks.
    """

    def __init__(self, supabase_client):
        """
        Initialize page storage operations.

        Args:
            supabase_client: The Supabase client for database operations
        """
        self.supabase_client = supabase_client

    async def store_pages(
        self,
        crawl_results: list[dict],
        source_id: str,
        request: dict[str, Any],
        crawl_type: str,
    ) -> dict[str, str]:
        """
        Store pages in archon_page_metadata table from regular crawl results.

        Args:
            crawl_results: List of crawled documents with url, markdown, title, etc.
            source_id: The source ID these pages belong to
            request: The original crawl request with knowledge_type, tags, etc.
            crawl_type: Type of crawl performed (sitemap, url, link_collection, etc.)

        Returns:
            {url: page_id} mapping for FK references in chunks
        """
        safe_logfire_info(
            f"store_pages called | source_id={source_id} | crawl_type={crawl_type} | num_results={len(crawl_results)}"
        )

        url_to_page_id: dict[str, str] = {}
        pages_to_insert: list[dict[str, Any]] = []

        for doc in crawl_results:
            url = doc.get("url", "").strip()
            markdown = doc.get("markdown", "").strip()

            # Skip documents with empty content or missing URLs
            if not url or not markdown:
                continue

            # Prepare page record
            word_count = len(markdown.split())
            char_count = len(markdown)

            page_record = {
                "source_id": source_id,
                "url": url,
                "full_content": markdown,
                "section_title": None,  # Regular page, not a section
                "section_order": 0,
                "word_count": word_count,
                "char_count": char_count,
                "chunk_count": 0,  # Will be updated after chunking
                "metadata": {
                    "knowledge_type": request.get("knowledge_type", "documentation"),
                    "crawl_type": crawl_type,
                    "page_type": "documentation",
                    "tags": request.get("tags", []),
                },
            }
            pages_to_insert.append(page_record)

        # Batch insert pages
        if pages_to_insert:
            try:
                safe_logfire_info(
                    f"Inserting {len(pages_to_insert)} pages into archon_page_metadata table"
                )
                result = (
                    self.supabase_client.table("archon_page_metadata")
                    .insert(pages_to_insert)
                    .execute()
                )

                # Build url → page_id mapping
                for page in result.data:
                    url_to_page_id[page["url"]] = page["id"]

                safe_logfire_info(
                    f"Successfully stored {len(url_to_page_id)} pages in archon_page_metadata"
                )

            except Exception as e:
                logger.error(f"Error inserting pages into archon_page_metadata: {e}", exc_info=True)
                # Don't raise - allow chunking to continue even if page storage fails

        return url_to_page_id

    async def store_llms_full_sections(
        self,
        base_url: str,
        content: str,
        source_id: str,
        request: dict[str, Any],
        crawl_type: str = "llms_full",
    ) -> dict[str, str]:
        """
        Store llms-full.txt sections as separate pages.

        Each H1 section gets its own page record with a synthetic URL.

        Args:
            base_url: Base URL of the llms-full.txt file
            content: Full text content of the file
            source_id: The source ID these sections belong to
            request: The original crawl request
            crawl_type: Type of crawl (defaults to "llms_full")

        Returns:
            {url: page_id} mapping for FK references in chunks
        """
        url_to_page_id: dict[str, str] = {}

        # Parse sections from content
        sections = parse_llms_full_sections(content, base_url)

        if not sections:
            logger.warning(f"No sections found in llms-full.txt file: {base_url}")
            return url_to_page_id

        safe_logfire_info(
            f"Parsed {len(sections)} sections from llms-full.txt file: {base_url}"
        )

        # Prepare page records for each section
        pages_to_insert: list[dict[str, Any]] = []

        for section in sections:
            page_record = {
                "source_id": source_id,
                "url": section.url,
                "full_content": section.content,
                "section_title": section.section_title,
                "section_order": section.section_order,
                "word_count": section.word_count,
                "char_count": len(section.content),
                "chunk_count": 0,  # Will be updated after chunking
                "metadata": {
                    "knowledge_type": request.get("knowledge_type", "documentation"),
                    "crawl_type": crawl_type,
                    "page_type": "llms_full_section",
                    "tags": request.get("tags", []),
                    "section_metadata": {
                        "section_title": section.section_title,
                        "section_order": section.section_order,
                        "base_url": base_url,
                    },
                },
            }
            pages_to_insert.append(page_record)

        # Batch insert pages
        if pages_to_insert:
            try:
                safe_logfire_info(
                    f"Inserting {len(pages_to_insert)} section pages into archon_page_metadata"
                )
                result = (
                    self.supabase_client.table("archon_page_metadata")
                    .insert(pages_to_insert)
                    .execute()
                )

                # Build url → page_id mapping
                for page in result.data:
                    url_to_page_id[page["url"]] = page["id"]

                safe_logfire_info(
                    f"Successfully stored {len(url_to_page_id)} section pages"
                )

            except Exception as e:
                logger.error(
                    f"Error inserting section pages into archon_page_metadata: {e}", exc_info=True
                )
                # Don't raise - allow process to continue

        return url_to_page_id

    async def update_page_chunk_count(self, page_id: str, chunk_count: int) -> None:
        """
        Update the chunk_count field for a page after chunking is complete.

        Args:
            page_id: The UUID of the page to update
            chunk_count: Number of chunks created from this page
        """
        try:
            self.supabase_client.table("archon_page_metadata").update(
                {"chunk_count": chunk_count}
            ).eq("id", page_id).execute()

            safe_logfire_info(f"Updated chunk_count={chunk_count} for page_id={page_id}")

        except Exception as e:
            logger.warning(
                f"Error updating chunk_count for page {page_id}: {e}", exc_info=True
            )
            # Don't raise - this is a non-critical update
