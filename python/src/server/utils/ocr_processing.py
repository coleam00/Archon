"""
OCR Processing Utilities

This module provides OCR (Optical Character Recognition) capabilities
for extracting text from image-based PDFs and scanned documents.

Primary engine: Tesseract OCR
- Fast (~0.5s per page)
- Cross-platform (macOS, Linux, Windows)
- Good accuracy for clean documents
"""

import io
import tempfile
import os
from typing import Optional

from ..config.logfire_config import get_logger, logfire

logger = get_logger(__name__)

# Check for OCR dependencies
try:
    from pdf2image import convert_from_bytes
    PDF2IMAGE_AVAILABLE = True
except ImportError:
    PDF2IMAGE_AVAILABLE = False

try:
    import pytesseract
    PYTESSERACT_AVAILABLE = True
except ImportError:
    PYTESSERACT_AVAILABLE = False


def is_ocr_available() -> bool:
    """Check if OCR processing is available."""
    return PDF2IMAGE_AVAILABLE and PYTESSERACT_AVAILABLE


def extract_text_with_ocr(
    file_content: bytes,
    language: str = "eng",
    dpi: int = 300,
) -> Optional[str]:
    """
    Extract text from a PDF using OCR (Tesseract).

    This function converts each PDF page to an image and runs OCR on it.
    Use this for scanned documents or image-based PDFs that don't contain
    extractable text layers.

    Args:
        file_content: Raw PDF bytes
        language: Tesseract language code (default: "eng")
                  Common codes: eng, deu, fra, spa, ita, por, nld
                  Multiple: "eng+deu" for English and German
        dpi: Resolution for PDF to image conversion (default: 300)
             Higher = better quality but slower

    Returns:
        Extracted text content, or None if OCR fails

    Raises:
        RuntimeError: If OCR dependencies are not installed
    """
    if not PDF2IMAGE_AVAILABLE:
        raise RuntimeError(
            "pdf2image not installed. Install with: pip install pdf2image\n"
            "Also requires poppler: brew install poppler (macOS) or apt install poppler-utils (Linux)"
        )

    if not PYTESSERACT_AVAILABLE:
        raise RuntimeError(
            "pytesseract not installed. Install with: pip install pytesseract\n"
            "Also requires tesseract: brew install tesseract (macOS) or apt install tesseract-ocr (Linux)"
        )

    try:
        logger.info(f"Starting OCR extraction (language={language}, dpi={dpi})")

        # Convert PDF pages to images
        images = convert_from_bytes(file_content, dpi=dpi)

        if not images:
            logger.warning("No pages found in PDF for OCR")
            return None

        logger.info(f"Converting {len(images)} pages with OCR...")

        # Extract text from each page
        text_content = []
        for page_num, image in enumerate(images, start=1):
            try:
                # Run Tesseract OCR on the image
                page_text = pytesseract.image_to_string(image, lang=language)

                if page_text and page_text.strip():
                    # Add page marker for multi-page documents
                    if len(images) > 1:
                        text_content.append(f"--- Page {page_num} ---\n{page_text.strip()}")
                    else:
                        text_content.append(page_text.strip())

                    logger.debug(f"OCR extracted {len(page_text)} chars from page {page_num}")
                else:
                    logger.debug(f"No text found on page {page_num}")

            except Exception as e:
                logger.warning(f"OCR failed on page {page_num}: {e}")
                continue

        if not text_content:
            logger.warning("OCR extracted no text from any page")
            return None

        combined_text = "\n\n".join(text_content)
        logger.info(f"OCR completed: {len(combined_text)} chars from {len(images)} pages")

        return combined_text

    except Exception as e:
        logfire.error(f"OCR extraction failed: {e}")
        return None


def get_supported_languages() -> list[str]:
    """
    Get list of installed Tesseract languages.

    Returns:
        List of language codes available for OCR
    """
    if not PYTESSERACT_AVAILABLE:
        return []

    try:
        languages = pytesseract.get_languages()
        # Filter out 'osd' (orientation and script detection) as it's not a real language
        return [lang for lang in languages if lang != 'osd']
    except Exception as e:
        logger.warning(f"Could not get Tesseract languages: {e}")
        return ["eng"]  # Default fallback
