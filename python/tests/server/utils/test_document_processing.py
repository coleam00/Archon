"""Unit tests for document processing utilities.

Tests PDF text extraction with pymupdf4llm and smart chunking.
"""

from pathlib import Path

import pytest

from src.server.services.storage.base_storage_service import BaseStorageService
from src.server.utils.document_processing import extract_text_from_pdf

# Path to test PDFs
TEST_PDF_DIR = Path(__file__).parent.parent.parent.parent.parent / "test-pdf"


class TestPdfTextExtraction:
    """Tests for PDF text extraction with pymupdf4llm."""

    @pytest.mark.skipif(
        not (TEST_PDF_DIR / "Coding.pdf").exists(),
        reason="Test PDF not available"
    )
    def test_coding_pdf_extracts_code_blocks(self):
        """Coding.pdf should have code blocks extracted as ``` markdown."""
        pdf_path = TEST_PDF_DIR / "Coding.pdf"
        with open(pdf_path, "rb") as f:
            content = f.read()

        text = extract_text_from_pdf(content)

        # Should have significant content
        assert len(text) > 100_000, "Coding.pdf should extract substantial text"

        # Should have code blocks (``` markers)
        code_block_count = text.count("```")
        assert code_block_count >= 100, f"Expected many code blocks, got {code_block_count}"

    @pytest.mark.skipif(
        not (TEST_PDF_DIR / "Book.pdf").exists(),
        reason="Test PDF not available"
    )
    def test_book_pdf_no_false_positive_code_blocks(self):
        """Book.pdf (non-technical) should not have false positive code blocks."""
        pdf_path = TEST_PDF_DIR / "Book.pdf"
        with open(pdf_path, "rb") as f:
            content = f.read()

        text = extract_text_from_pdf(content)

        # Should have content
        assert len(text) > 100_000, "Book.pdf should extract substantial text"

        # Should have minimal/no code blocks (false positives)
        code_block_count = text.count("```")
        assert code_block_count < 10, f"Expected few code blocks, got {code_block_count}"


class TestSmartChunking:
    """Tests for smart_chunk_text code block protection."""

    def test_code_block_not_split(self):
        """Code blocks should not be split across chunks."""
        test_text = """# Introduction

This is some text before the code.

```python
def hello():
    print("Hello World")
    return True
```

## Next Section

More text after the code.
"""
        # Use small chunk size to force splitting
        chunks = BaseStorageService.smart_chunk_text(None, test_text, chunk_size=100)

        # Check no chunk has unbalanced code block markers
        for i, chunk in enumerate(chunks):
            open_count = chunk.count("```")
            assert open_count % 2 == 0, f"Chunk {i} has incomplete code block: {chunk[:100]}"

    def test_heading_priority_chunking(self):
        """Chunks should prefer to break at headings when text is large enough."""
        # Need enough content to force multiple chunks
        test_text = """# First Section

Some content in the first section that goes on for a while. This needs to be long enough to actually require chunking. Let's add more text here to make it substantial.

# Second Section

More content in the second section. Again, we need sufficient content to trigger the chunking logic properly. Adding more text to ensure this section is substantial enough.

# Third Section

Even more content here. The chunking algorithm should prefer to break at heading boundaries when possible.
"""
        chunks = BaseStorageService.smart_chunk_text(None, test_text, chunk_size=200)

        # Should create multiple chunks
        assert len(chunks) >= 2, f"Expected multiple chunks, got {len(chunks)}"

        # At least one chunk (besides first) should start with heading
        heading_starts = sum(1 for c in chunks if c.strip().startswith("#"))
        assert heading_starts >= 1, "At least one chunk should start with heading"

    def test_empty_text_returns_empty_list(self):
        """Empty text should return empty list."""
        chunks = BaseStorageService.smart_chunk_text(None, "", chunk_size=100)
        assert chunks == []

    def test_small_text_returns_single_chunk(self):
        """Text smaller than chunk_size should return single chunk."""
        small_text = "This is a small text."
        chunks = BaseStorageService.smart_chunk_text(None, small_text, chunk_size=1000)
        assert len(chunks) == 1
        assert chunks[0] == small_text
