# Search Services — Changelog

## [Unreleased] - 2025-09-06
- `base_search_strategy.py`:
  - Similarity threshold now configurable via Settings (category `rag_strategy`, key `SIMILARITY_THRESHOLD`) or env fallback.
  - Threshold value recorded in spans for traceability.

Files: `base_search_strategy.py`
