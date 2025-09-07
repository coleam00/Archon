# Utils — Changelog

## [Unreleased] - 2025-09-06
- `document_processing.py`:
  - HTML extraction added (BeautifulSoup if available; regex fallback) with `<pre><code>` → fenced blocks.
  - Code-file handling: wraps entire file content in fenced block with inferred language.

Files: `document_processing.py`
