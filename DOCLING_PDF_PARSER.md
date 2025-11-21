# Docling PDF Parser Integration

## Overview

Archon now uses **Docling** (IBM Research) as the primary PDF parser for superior document extraction quality. Docling provides significantly better layout recognition, table extraction, and formula handling compared to traditional PDF parsers.

## Why Docling?

### Quality Improvements
- **Layout Recognition**: Computer vision models understand document structure
- **Table Extraction**: Accurately extracts complex tables with structure preserved
- **Formula Support**: Handles mathematical formulas and equations
- **Markdown Output**: Structured output format ideal for RAG applications

### Performance
- **M3 Mac**: ~1.27 seconds/page
- **x86 CPU**: ~3.1 seconds/page
- **NVIDIA GPU**: ~0.49 seconds/page (when available)

### Comparison
Docling outperforms traditional parsers like PyPDF2 and pdfplumber for:
- Complex layouts (multi-column documents)
- Tables with merged cells
- Documents with formulas
- Scanned documents (with OCR fallback)

## Implementation

### PDF Parser Priority

Archon tries parsers in this order:

1. **Docling** (primary) - Best quality, layout preservation
2. **pdfplumber** (fallback) - Good for complex layouts
3. **PyPDF2** (last resort) - Simple PDFs

### Code Location

- **Implementation**: `python/src/server/utils/document_processing.py`
- **Dependencies**: `python/pyproject.toml` (docling>=2.0.0, docling-core>=2.0.0)

### How It Works

```python
def extract_text_from_pdf(file_content: bytes) -> str:
    """
    Extract text from PDF using the best available library.

    Priority:
    1. Docling (best quality, layout preservation, table extraction)
    2. pdfplumber (good for complex layouts)
    3. PyPDF2 (fallback for simple PDFs)
    """
    # Try Docling first
    if DOCLING_AVAILABLE:
        try:
            return extract_text_from_pdf_docling(file_content)
        except Exception:
            # Falls back to pdfplumber/PyPDF2
            ...
```

## Installation

Docling is included in the server dependencies:

```bash
# Using uv
cd python
uv sync --group server

# Docling and docling-core will be installed automatically
```

## Testing

### Manual Testing

1. Start Archon backend:
   ```bash
   docker compose up -d
   # OR
   cd python && uv run python -m src.server.main
   ```

2. Upload a PDF via the UI or API:
   ```bash
   curl -X POST http://localhost:8181/api/knowledge/upload \
     -F "file=@your-document.pdf" \
     -F "title=Test Document"
   ```

3. Check logs for Docling extraction:
   ```
   🚀 Docling extracted 83317 characters from PDF
   ```

### Performance Monitoring

Docling logs extraction stats:
- Characters extracted
- Processing time (implicit in logs)
- Fallback messages if Docling fails

## Benchmarks

Based on community benchmarks (OmniDocBench, ReadDoc):

### Speed (without GPU)
| Parser | M3 Mac | x86 CPU |
|--------|--------|---------|
| Docling | 1.27s/page | 3.1s/page |
| MinerU | - | 3.3s/page |
| Marker | 4.2s/page | 16s/page |
| pdfplumber | ~2s/page | ~3s/page |

### Quality
- **Best All-Round**: MinerU (with GPU)
- **Best Without GPU**: Docling
- **Fastest**: Docling (without GPU)

## Troubleshooting

### Docling Not Available

If Docling fails to load:

1. Check dependencies:
   ```bash
   cd python
   uv sync --group server
   ```

2. Verify installation:
   ```bash
   uv run python -c "from docling.document_converter import DocumentConverter; print('OK')"
   ```

3. Check logs for import errors

### Fallback Behavior

If Docling fails, Archon automatically falls back to pdfplumber/PyPDF2:

```
⚠️ Docling extraction failed, trying fallback methods: [error]
```

This ensures PDF processing continues even if Docling has issues.

### Performance Issues

For large PDFs (>100 pages):
- First extraction: ~5-15 minutes (one-time)
- Subsequent access: Instant (data cached in database)
- Consider processing in background for very large documents

## Future Improvements

Potential enhancements:

1. **GPU Support**: Add CUDA acceleration for faster processing
2. **Batch Processing**: Process multiple PDFs in parallel
3. **Progress Tracking**: Real-time progress for large documents
4. **Configuration**: Allow users to select parser preference
5. **MinerU Integration**: Add MinerU as alternative for GPU setups

## References

- [Docling GitHub](https://github.com/docling-project/docling)
- [Docling Documentation](https://docling-project.github.io/docling/)
- [IBM Research Blog](https://research.ibm.com/blog/docling-generative-AI)
- [Technical Report](https://arxiv.org/html/2408.09869v4)

## License

Docling is licensed under Apache 2.0, making it suitable for commercial use in Archon.
