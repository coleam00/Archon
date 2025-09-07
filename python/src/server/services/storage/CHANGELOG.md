# Storage Services — Changelog

## [Unreleased] - 2025-09-06
- `base_storage_service.py`:
  - Fence-preserving chunker: respects ``` / ~~~ / <pre> across chunk boundaries.
  - `has_code` metadata updated to detect tildes and <pre>.

Files: `base_storage_service.py`
