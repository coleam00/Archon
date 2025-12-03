# E2E Test Fixtures

Small PDF samples (4 pages each) for fast E2E testing.

## Files

- **book-sample.pdf** (1.4 MB) - Text-heavy content sample from Book.pdf
- **coding-sample.pdf** (1.0 MB) - Programming content with HTML/ERB code examples

## Source

Extracted from full PDFs in `/test-pdf/`:
- Book.pdf (8.4 MB, 150+ pages)
- Coding.pdf (8.8 MB, 439 pages)

## Usage

Tests automatically use these sample files. For comprehensive testing with full PDFs, manually upload Coding.pdf through the UI - the tests will prefer it if available.

## Regenerating Samples

```bash
cd python
uv run python -c "
import pymupdf
import os

fixtures_dir = '../archon-ui-main/tests/e2e/fixtures'

def extract_pages(src, dst, pages):
    doc = pymupdf.open(src)
    new_doc = pymupdf.open()
    for p in pages:
        if p < len(doc):
            new_doc.insert_pdf(doc, from_page=p, to_page=p)
    new_doc.save(dst)
    return os.path.getsize(dst)

# Book sample: first 4 pages
extract_pages('../test-pdf/Book.pdf', f'{fixtures_dir}/book-sample.pdf', [0, 1, 2, 3])

# Coding sample: pages with long code blocks (>250 chars for backend filter)
# Pages 34 (730 chars), 76 (1380 chars), 32 (453 chars), 31 (413 chars)
extract_pages('../test-pdf/Coding.pdf', f'{fixtures_dir}/coding-sample.pdf', [34, 76, 32, 31])
"
```
