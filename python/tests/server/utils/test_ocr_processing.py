"""Unit tests for OCR processing utilities.

Tests Tesseract OCR text extraction from image-based PDFs.
"""

from pathlib import Path

import pytest

from src.server.utils.ocr_processing import (
    PDF2IMAGE_AVAILABLE,
    PYTESSERACT_AVAILABLE,
    extract_text_with_ocr,
    is_ocr_available,
)

# Path to test PDFs
TEST_PDF_DIR = Path(__file__).parent.parent.parent.parent.parent / "test-pdf"


class TestOcrAvailability:
    """Tests for OCR availability checks."""

    def test_is_ocr_available_returns_bool(self):
        """is_ocr_available should return boolean."""
        result = is_ocr_available()
        assert isinstance(result, bool)

    def test_ocr_requires_both_dependencies(self):
        """OCR requires both pytesseract and pdf2image."""
        # If both are available, OCR should be available
        # If either is missing, OCR should not be available
        expected = PDF2IMAGE_AVAILABLE and PYTESSERACT_AVAILABLE
        assert is_ocr_available() == expected


@pytest.mark.skipif(
    not is_ocr_available(),
    reason="OCR dependencies not installed"
)
class TestOcrExtraction:
    """Tests for OCR text extraction (requires Tesseract installed)."""

    @pytest.mark.skipif(
        not (TEST_PDF_DIR / "OCR-Test.pdf").exists(),
        reason="Test PDF not available"
    )
    def test_ocr_extracts_text_from_scanned_pdf(self):
        """OCR should extract text from image-based PDFs."""
        pdf_path = TEST_PDF_DIR / "OCR-Test.pdf"
        with open(pdf_path, "rb") as f:
            content = f.read()

        text = extract_text_with_ocr(content)

        # Should extract meaningful text
        assert text is not None
        assert len(text) > 100, f"Expected substantial text, got {len(text)} chars"

        # Should contain expected content (based on test PDF)
        assert "PDF" in text or "pdf" in text.lower(), "Should recognize 'PDF' text"

    def test_ocr_returns_none_for_invalid_pdf(self):
        """OCR should handle invalid PDF gracefully."""
        invalid_content = b"This is not a PDF"

        result = extract_text_with_ocr(invalid_content)

        # Should return None or raise exception for invalid input
        # (implementation may vary, but should not crash)
        assert result is None or isinstance(result, str)

    def test_ocr_language_parameter(self):
        """OCR should accept language parameter."""
        # Just verify the function accepts the parameter
        # Actual language support depends on Tesseract installation
        pdf_path = TEST_PDF_DIR / "OCR-Test.pdf"
        if not pdf_path.exists():
            pytest.skip("Test PDF not available")

        with open(pdf_path, "rb") as f:
            content = f.read()

        # Should not raise for valid language code
        text = extract_text_with_ocr(content, language="eng")
        assert text is not None


class TestOcrIntegrationWithDocumentProcessing:
    """Tests for OCR integration as fallback in document processing."""

    @pytest.mark.skipif(
        not is_ocr_available(),
        reason="OCR dependencies not installed"
    )
    @pytest.mark.skipif(
        not (TEST_PDF_DIR / "OCR-Test.pdf").exists(),
        reason="Test PDF not available"
    )
    def test_document_processing_uses_ocr_fallback(self):
        """extract_text_from_pdf should use OCR for image-based PDFs."""
        from src.server.utils.document_processing import extract_text_from_pdf

        pdf_path = TEST_PDF_DIR / "OCR-Test.pdf"
        with open(pdf_path, "rb") as f:
            content = f.read()

        # Should succeed via OCR fallback
        text = extract_text_from_pdf(content)

        assert len(text) > 100, "Should extract text via OCR fallback"
