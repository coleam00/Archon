"""
Document Processing Utilities

This module provides utilities for extracting text from various document formats
including PDF, Word documents, and plain text files.
"""

import io

# Removed direct logging import - using unified config

# Import document processing libraries with availability checks
try:
    import PyPDF2

    PYPDF2_AVAILABLE = True
except ImportError:
    PYPDF2_AVAILABLE = False

try:
    import pdfplumber

    PDFPLUMBER_AVAILABLE = True
except ImportError:
    PDFPLUMBER_AVAILABLE = False

try:
    from docx import Document as DocxDocument

    DOCX_AVAILABLE = True
except ImportError:
    DOCX_AVAILABLE = False

from ..config.logfire_config import get_logger, logfire

# Optional HTML parsing support
try:
    from bs4 import BeautifulSoup  # type: ignore

    BS4_AVAILABLE = True
except Exception:
    BS4_AVAILABLE = False

logger = get_logger(__name__)


def extract_text_from_document(file_content: bytes, filename: str, content_type: str) -> str:
    """
    Extract text from various document formats.

    Args:
        file_content: Raw file bytes
        filename: Name of the file
        content_type: MIME type of the file

    Returns:
        Extracted text content

    Raises:
        ValueError: If the file format is not supported
        Exception: If extraction fails
    """
    try:
        # PDF files
        if content_type == "application/pdf" or filename.lower().endswith(".pdf"):
            return extract_text_from_pdf(file_content)

        # Word documents
        elif content_type in [
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/msword",
        ] or filename.lower().endswith((".docx", ".doc")):
            return extract_text_from_docx(file_content)

        # HTML files
        elif content_type == "text/html" or filename.lower().endswith(".html"):
            return extract_text_from_html(file_content, filename)

        # Code files (treat entire file as fenced block to preserve formatting)
        elif filename.lower().endswith(
            (
                ".py",
                ".js",
                ".ts",
                ".tsx",
                ".java",
                ".go",
                ".rb",
                ".rs",
                ".c",
                ".cpp",
                ".cs",
                ".json",
                ".css",
                ".html",
            )
        ) or content_type in (
            "text/x-python",
            "application/javascript",
            "text/javascript",
            "text/typescript",
            "text/x-c++src",
            "text/x-csrc",
            "text/x-java-source",
        ):
            try:
                text = file_content.decode("utf-8", errors="ignore")
            except Exception:
                text = file_content.decode(errors="ignore")
            language = _infer_language_from_filename(filename)
            return f"```{language}\n{text}\n```\n"

        # Text files (markdown, txt, etc.)
        elif content_type.startswith("text/") or filename.lower().endswith((
            ".txt",
            ".md",
            ".markdown",
            ".rst",
        )):
            return file_content.decode("utf-8", errors="ignore")

        else:
            raise ValueError(f"Unsupported file format: {content_type} ({filename})")

    except Exception as e:
        logfire.error(
            "Document text extraction failed",
            filename=filename,
            content_type=content_type,
            error=str(e),
        )
        raise Exception(f"Failed to extract text from {filename}: {str(e)}")


def _infer_language_from_filename(filename: str) -> str:
    lower = filename.lower()
    mapping = {
        ".py": "python",
        ".js": "javascript",
        ".ts": "typescript",
        ".tsx": "tsx",
        ".java": "java",
        ".go": "go",
        ".rb": "ruby",
        ".rs": "rust",
        ".c": "c",
        ".cpp": "cpp",
        ".cc": "cpp",
        ".cs": "csharp",
        ".json": "json",
        ".css": "css",
        ".html": "html",
        ".md": "markdown",
    }
    for ext, lang in mapping.items():
        if lower.endswith(ext):
            return lang
    return ""


def extract_text_from_html(file_content: bytes, filename: str | None = None) -> str:
    """Extract readable text from HTML, preserving code blocks as fenced sections.

    Attempts to use BeautifulSoup if available. Falls back to regex-based stripping.
    """
    html = None
    try:
        html = file_content.decode("utf-8", errors="ignore")
    except Exception:
        html = str(file_content)

    # If BeautifulSoup is available, use it for better parsing
    if BS4_AVAILABLE:
        try:
            soup = BeautifulSoup(html, "html.parser")
            # Remove script and style
            for tag in soup(["script", "style", "noscript"]):
                tag.decompose()

            # Convert <pre><code> blocks to fenced code
            for pre in soup.find_all("pre"):
                code = pre.find("code") if pre else None
                code_text = code.get_text("\n") if code else pre.get_text("\n")
                language = ""
                # Language from class like language-python
                classes = []
                if code and code.has_attr("class"):
                    classes = code.get("class", [])
                elif pre and pre.has_attr("class"):
                    classes = pre.get("class", [])
                for cls in classes:
                    if cls.startswith("language-"):
                        language = cls.split("-", 1)[1]
                        break
                fenced = soup.new_string(f"```{language}\n{code_text}\n```\n")
                pre.replace_with(fenced)

            # Get text
            text = soup.get_text("\n")
            return text
        except Exception as e:
            logger.warning(f"BeautifulSoup HTML parsing failed: {e}")

    # Fallback: regex-based removal, but preserve <pre> blocks
    try:
        import re

        # Remove scripts/styles
        cleaned = re.sub(r"<script[\s\S]*?</script>", "", html, flags=re.IGNORECASE)
        cleaned = re.sub(r"<style[\s\S]*?</style>", "", cleaned, flags=re.IGNORECASE)

        # Convert <pre> blocks to fenced
        def pre_to_fence(m: "re.Match[str]") -> str:
            inner = m.group(1)
            # Remove inner tags like <code>
            inner_text = re.sub(r"<[^>]+>", "", inner)
            return f"```\n{inner_text}\n```\n"

        cleaned = re.sub(r"<pre[^>]*>([\s\S]*?)</pre>", pre_to_fence, cleaned, flags=re.IGNORECASE)

        # Strip remaining tags
        cleaned = re.sub(r"<[^>]+>", "\n", cleaned)
        # Unescape HTML entities
        import html as _html

        text = _html.unescape(cleaned)
        return text
    except Exception as e:
        raise Exception(f"Failed to extract text from HTML: {str(e)}")


def extract_text_from_pdf(file_content: bytes) -> str:
    """
    Extract text from PDF using both PyPDF2 and pdfplumber for best results.

    Args:
        file_content: Raw PDF bytes

    Returns:
        Extracted text content
    """
    if not PDFPLUMBER_AVAILABLE and not PYPDF2_AVAILABLE:
        raise Exception(
            "No PDF processing libraries available. Please install pdfplumber and PyPDF2."
        )

    text_content = []

    # First try with pdfplumber (better for complex layouts)
    if PDFPLUMBER_AVAILABLE:
        try:
            with pdfplumber.open(io.BytesIO(file_content)) as pdf:
                for page_num, page in enumerate(pdf.pages):
                    try:
                        page_text = page.extract_text()
                        if page_text:
                            text_content.append(f"--- Page {page_num + 1} ---\n{page_text}")
                    except Exception as e:
                        logfire.warning(f"pdfplumber failed on page {page_num + 1}: {e}")
                        continue

            # If pdfplumber got good results, use them
            if text_content and len("\n".join(text_content).strip()) > 100:
                return "\n\n".join(text_content)

        except Exception as e:
            logfire.warning(f"pdfplumber extraction failed: {e}, trying PyPDF2")

    # Fallback to PyPDF2
    if PYPDF2_AVAILABLE:
        try:
            text_content = []
            pdf_reader = PyPDF2.PdfReader(io.BytesIO(file_content))

            for page_num, page in enumerate(pdf_reader.pages):
                try:
                    page_text = page.extract_text()
                    if page_text:
                        text_content.append(f"--- Page {page_num + 1} ---\n{page_text}")
                except Exception as e:
                    logfire.warning(f"PyPDF2 failed on page {page_num + 1}: {e}")
                    continue

            if text_content:
                return "\n\n".join(text_content)
            else:
                raise Exception("No text could be extracted from PDF")

        except Exception as e:
            raise Exception(f"PyPDF2 failed to extract text: {str(e)}")

    # If we get here, no libraries worked
    raise Exception("Failed to extract text from PDF - no working PDF libraries available")


def extract_text_from_docx(file_content: bytes) -> str:
    """
    Extract text from Word documents (.docx).

    Args:
        file_content: Raw DOCX bytes

    Returns:
        Extracted text content
    """
    if not DOCX_AVAILABLE:
        raise Exception("python-docx library not available. Please install python-docx.")

    try:
        doc = DocxDocument(io.BytesIO(file_content))
        text_content = []

        for paragraph in doc.paragraphs:
            if paragraph.text.strip():
                text_content.append(paragraph.text)

        # Also extract text from tables
        for table in doc.tables:
            for row in table.rows:
                row_text = []
                for cell in row.cells:
                    if cell.text.strip():
                        row_text.append(cell.text.strip())
                if row_text:
                    text_content.append(" | ".join(row_text))

        if not text_content:
            raise Exception("No text content found in document")

        return "\n\n".join(text_content)

    except Exception as e:
        raise Exception(f"Failed to extract text from Word document: {str(e)}")
