"""
Tests for LLMs-full.txt Section Parser
"""

import pytest

from src.server.services.crawling.helpers.llms_full_parser import (
    create_section_slug,
    create_section_url,
    parse_llms_full_sections,
)


def test_create_section_slug():
    """Test slug generation from H1 headings"""
    assert create_section_slug("# Core Concepts") == "core-concepts"
    assert create_section_slug("# Getting Started!") == "getting-started"
    assert create_section_slug("# API Reference (v2)") == "api-reference-v2"
    assert create_section_slug("# Hello World") == "hello-world"
    assert create_section_slug("#   Spaces   ") == "spaces"


def test_create_section_url():
    """Test synthetic URL generation with slug anchor"""
    base_url = "https://example.com/llms-full.txt"
    url = create_section_url(base_url, "# Core Concepts", 0)
    assert url == "https://example.com/llms-full.txt#section-0-core-concepts"

    url = create_section_url(base_url, "# Getting Started", 1)
    assert url == "https://example.com/llms-full.txt#section-1-getting-started"


def test_parse_single_section():
    """Test parsing a single H1 section"""
    content = """# Core Concepts
Claude is an AI assistant built by Anthropic.
It can help with various tasks.
"""
    base_url = "https://example.com/llms-full.txt"
    sections = parse_llms_full_sections(content, base_url)

    assert len(sections) == 1
    assert sections[0].section_title == "# Core Concepts"
    assert sections[0].section_order == 0
    assert sections[0].url == "https://example.com/llms-full.txt#section-0-core-concepts"
    assert "Claude is an AI assistant" in sections[0].content
    assert sections[0].word_count > 0


def test_parse_multiple_sections():
    """Test parsing multiple H1 sections"""
    content = """# Core Concepts
Claude is an AI assistant built by Anthropic that can help with various tasks.
It uses advanced language models to understand and respond to queries.
This section provides an overview of the core concepts and capabilities.

# Getting Started
To get started with Claude, you'll need to create an account and obtain API credentials.
Follow the setup instructions and configure your development environment properly.
This will enable you to make your first API calls and start building applications.

# API Reference
The API uses REST principles and supports standard HTTP methods like GET, POST, PUT, and DELETE.
Authentication is handled through API keys that should be kept secure at all times.
Comprehensive documentation is available for all endpoints and response formats.
"""
    base_url = "https://example.com/llms-full.txt"
    sections = parse_llms_full_sections(content, base_url)

    assert len(sections) == 3
    assert sections[0].section_title == "# Core Concepts"
    assert sections[1].section_title == "# Getting Started"
    assert sections[2].section_title == "# API Reference"

    assert sections[0].section_order == 0
    assert sections[1].section_order == 1
    assert sections[2].section_order == 2

    assert sections[0].url == "https://example.com/llms-full.txt#section-0-core-concepts"
    assert sections[1].url == "https://example.com/llms-full.txt#section-1-getting-started"
    assert sections[2].url == "https://example.com/llms-full.txt#section-2-api-reference"


def test_no_h1_headers():
    """Test handling content with no H1 headers"""
    content = """This is some documentation.
It has no H1 headers.
Just regular content.
"""
    base_url = "https://example.com/llms-full.txt"
    sections = parse_llms_full_sections(content, base_url)

    assert len(sections) == 1
    assert sections[0].section_title == "Full Document"
    assert sections[0].url == "https://example.com/llms-full.txt"
    assert "This is some documentation" in sections[0].content


def test_h2_not_treated_as_section():
    """Test that H2 headers (##) are not treated as section boundaries"""
    content = """# Main Section
This is the main section.

## Subsection
This is a subsection.

## Another Subsection
This is another subsection.
"""
    base_url = "https://example.com/llms-full.txt"
    sections = parse_llms_full_sections(content, base_url)

    assert len(sections) == 1
    assert sections[0].section_title == "# Main Section"
    assert "## Subsection" in sections[0].content
    assert "## Another Subsection" in sections[0].content


def test_empty_sections_skipped():
    """Test that empty sections are skipped"""
    content = """# Section 1
This is the first section with enough content to prevent automatic combination.
It contains multiple sentences and provides substantial information for testing purposes.
The section has several lines to ensure it exceeds the minimum character threshold.

#

# Section 2
This is the second section with enough content to prevent automatic combination.
It also contains multiple sentences and provides substantial information for testing.
The section has several lines to ensure it exceeds the minimum character threshold.
"""
    base_url = "https://example.com/llms-full.txt"
    sections = parse_llms_full_sections(content, base_url)

    # Should only have 2 sections (empty one skipped)
    assert len(sections) == 2
    assert sections[0].section_title == "# Section 1"
    assert sections[1].section_title == "# Section 2"


def test_consecutive_h1_headers():
    """Test handling multiple consecutive H1 headers"""
    content = """# Section 1
The first section contains enough content to prevent automatic combination with subsequent sections.
It has multiple sentences and provides substantial information for proper testing functionality.
This ensures that the section exceeds the minimum character threshold requirement.
# Section 2
This section also has enough content to prevent automatic combination with the previous section.
It contains multiple sentences and provides substantial information for proper testing.
The content here ensures that the section exceeds the minimum character threshold.
"""
    base_url = "https://example.com/llms-full.txt"
    sections = parse_llms_full_sections(content, base_url)

    # Both sections should be parsed
    assert len(sections) == 2
    assert sections[0].section_title == "# Section 1"
    assert sections[1].section_title == "# Section 2"
    assert "The first section contains enough content" in sections[0].content
    assert "This section also has enough content" in sections[1].content


def test_word_count_calculation():
    """Test word count calculation for sections"""
    content = """# Test Section
This is a test section with exactly ten words here.
"""
    base_url = "https://example.com/llms-full.txt"
    sections = parse_llms_full_sections(content, base_url)

    assert len(sections) == 1
    # Word count includes the H1 heading
    assert sections[0].word_count > 10


def test_empty_content():
    """Test handling empty content"""
    content = ""
    base_url = "https://example.com/llms-full.txt"
    sections = parse_llms_full_sections(content, base_url)

    assert len(sections) == 0


def test_whitespace_only_content():
    """Test handling whitespace-only content"""
    content = """


"""
    base_url = "https://example.com/llms-full.txt"
    sections = parse_llms_full_sections(content, base_url)

    assert len(sections) == 0
