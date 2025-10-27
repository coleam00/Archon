"""
LLMs-full.txt Section Parser

Parses llms-full.txt files by splitting on H1 headers (# ) to create separate
"pages" for each section. Each section gets a synthetic URL with a slug anchor.
"""

import re

from pydantic import BaseModel


class LLMsFullSection(BaseModel):
    """Parsed section from llms-full.txt file"""

    section_title: str  # Raw H1 text: "# Core Concepts"
    section_order: int  # Position in document: 0, 1, 2, ...
    content: str  # Section content (including H1 header)
    url: str  # Synthetic URL: base.txt#core-concepts
    word_count: int


def create_section_slug(h1_heading: str) -> str:
    """
    Generate URL slug from H1 heading.

    Args:
        h1_heading: H1 text like "# Core Concepts" or "# Getting Started"

    Returns:
        Slug like "core-concepts" or "getting-started"

    Examples:
        "# Core Concepts" -> "core-concepts"
        "# API Reference" -> "api-reference"
        "# Getting Started!" -> "getting-started"
    """
    # Remove "# " prefix if present
    slug_text = h1_heading.replace("# ", "").strip()

    # Convert to lowercase
    slug = slug_text.lower()

    # Replace spaces with hyphens
    slug = slug.replace(" ", "-")

    # Remove special characters (keep only alphanumeric and hyphens)
    slug = re.sub(r"[^a-z0-9-]", "", slug)

    # Remove consecutive hyphens
    slug = re.sub(r"-+", "-", slug)

    # Remove leading/trailing hyphens
    slug = slug.strip("-")

    return slug


def create_section_url(base_url: str, h1_heading: str, section_order: int) -> str:
    """
    Generate synthetic URL with slug anchor for a section.

    Args:
        base_url: Base URL like "https://example.com/llms-full.txt"
        h1_heading: H1 text like "# Core Concepts"
        section_order: Section position (0-based)

    Returns:
        Synthetic URL like "https://example.com/llms-full.txt#section-0-core-concepts"
    """
    slug = create_section_slug(h1_heading)
    return f"{base_url}#section-{section_order}-{slug}"


def parse_llms_full_sections(content: str, base_url: str) -> list[LLMsFullSection]:
    """
    Split llms-full.txt content by H1 headers to create separate sections.

    Each H1 (lines starting with "# " but not "##") marks a new section.
    Sections are given synthetic URLs with slug anchors.

    Args:
        content: Full text content of llms-full.txt file
        base_url: Base URL of the file (e.g., "https://example.com/llms-full.txt")

    Returns:
        List of LLMsFullSection objects, one per H1 section

    Edge cases:
        - No H1 headers: Returns single section with entire content
        - Multiple consecutive H1s: Creates separate sections correctly
        - Empty sections: Skipped (not included in results)

    Example:
        Input content:
        '''
        # Core Concepts
        Claude is an AI assistant...

        # Getting Started
        To get started...
        '''

        Returns:
        [
            LLMsFullSection(
                section_title="# Core Concepts",
                section_order=0,
                content="# Core Concepts\\nClaude is...",
                url="https://example.com/llms-full.txt#core-concepts",
                word_count=5
            ),
            LLMsFullSection(
                section_title="# Getting Started",
                section_order=1,
                content="# Getting Started\\nTo get started...",
                url="https://example.com/llms-full.txt#getting-started",
                word_count=4
            )
        ]
    """
    lines = content.split("\n")

    # Pre-scan: mark which lines are inside code blocks
    inside_code_block = set()
    in_block = False
    for i, line in enumerate(lines):
        if line.strip().startswith("```"):
            in_block = not in_block
        if in_block:
            inside_code_block.add(i)

    # Parse sections, ignoring H1 headers inside code blocks
    sections: list[LLMsFullSection] = []
    current_h1: str | None = None
    current_content: list[str] = []
    section_order = 0

    for i, line in enumerate(lines):
        # Detect H1 (starts with "# " but not "##") - but ONLY if not in code block
        is_h1 = line.startswith("# ") and not line.startswith("## ")
        if is_h1 and i not in inside_code_block:
            # Save previous section if it exists
            if current_h1 is not None:
                section_text = "\n".join(current_content)
                # Skip empty sections (only whitespace)
                if section_text.strip():
                    section_url = create_section_url(base_url, current_h1, section_order)
                    word_count = len(section_text.split())

                    sections.append(
                        LLMsFullSection(
                            section_title=current_h1,
                            section_order=section_order,
                            content=section_text,
                            url=section_url,
                            word_count=word_count,
                        )
                    )
                    section_order += 1

            # Start new section
            current_h1 = line
            current_content = [line]
        else:
            # Only accumulate if we've seen an H1
            if current_h1 is not None:
                current_content.append(line)

    # Save last section
    if current_h1 is not None:
        section_text = "\n".join(current_content)
        if section_text.strip():
            section_url = create_section_url(base_url, current_h1, section_order)
            word_count = len(section_text.split())
            sections.append(
                LLMsFullSection(
                    section_title=current_h1,
                    section_order=section_order,
                    content=section_text,
                    url=section_url,
                    word_count=word_count,
                )
            )

    # Edge case: No H1 headers found, treat entire file as single page
    if not sections and content.strip():
        sections.append(
            LLMsFullSection(
                section_title="Full Document",
                section_order=0,
                content=content,
                url=base_url,  # No anchor for single-page
                word_count=len(content.split()),
            )
        )

    # Fix sections that were split inside code blocks - merge them with next section
    if sections:
        fixed_sections: list[LLMsFullSection] = []
        i = 0
        while i < len(sections):
            current = sections[i]

            # Count ``` at start of lines only (proper code fences)
            code_fence_count = sum(
                1 for line in current.content.split('\n')
                if line.strip().startswith('```')
            )

            # If odd number, we're inside an unclosed code block - merge with next
            while code_fence_count % 2 == 1 and i + 1 < len(sections):
                next_section = sections[i + 1]
                # Combine content
                combined_content = current.content + "\n\n" + next_section.content
                # Update current with combined content
                current = LLMsFullSection(
                    section_title=current.section_title,
                    section_order=current.section_order,
                    content=combined_content,
                    url=current.url,
                    word_count=len(combined_content.split()),
                )
                # Move to next section and recount ``` at start of lines
                i += 1
                code_fence_count = sum(
                    1 for line in current.content.split('\n')
                    if line.strip().startswith('```')
                )

            fixed_sections.append(current)
            i += 1

        sections = fixed_sections

    # Combine consecutive small sections (<200 chars) together
    if sections:
        combined_sections: list[LLMsFullSection] = []
        i = 0
        while i < len(sections):
            current = sections[i]
            combined_content = current.content

            # Keep combining while current is small and there are more sections
            while len(combined_content) < 200 and i + 1 < len(sections):
                i += 1
                combined_content = combined_content + "\n\n" + sections[i].content

            # Create combined section with first section's metadata
            combined = LLMsFullSection(
                section_title=current.section_title,
                section_order=current.section_order,
                content=combined_content,
                url=current.url,
                word_count=len(combined_content.split()),
            )
            combined_sections.append(combined)
            i += 1

        sections = combined_sections

    return sections
