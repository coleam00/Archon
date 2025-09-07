# Crawling Services — Changelog

## [Unreleased] - 2025-09-06
- `code_extraction_service.py`:
  - Markdown extraction now uses settings-driven `MIN_CODE_BLOCK_LENGTH`.
  - Relaxed validation for low-complexity snippet languages (bash/yaml/json/toml/ini).
  - Improved diagnostics around extraction counts and quality checks.
- `crawling_service.py`:
  - No functional change; code example extraction already executed during crawl; upload path now invokes the same logic from API routes.

Files: `code_extraction_service.py`, `crawling_service.py`
