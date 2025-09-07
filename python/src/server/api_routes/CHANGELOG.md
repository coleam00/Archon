# API Routes — Changelog

## [Unreleased] - 2025-09-06
- Added `POST /api/documents/upload-batch` for multi-file/folder ingestion.
  - Supports `group_by=file|folder|batch` and optional `group_display_name`.
  - Aggregates summaries/word counts per grouped source.
- Upload flows (single + batch): run code example extraction after storing chunks.
- Exposes search alias `/api/knowledge-items/search` to pass through `match_count` to RAG.

Files: `knowledge_api.py`
