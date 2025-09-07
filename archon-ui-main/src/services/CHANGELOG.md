# Frontend Services — Changelog

## [Unreleased] - 2025-09-06
- knowledgeBaseService:
  - `searchKnowledgeBase` now maps `limit` → `match_count` (backend default 5 no longer surprises).
  - `uploadDocumentsBatch` sends `group_by`, `group_display_name`, and preserves relative paths for folder uploads.
- credentialsService:
  - Added `SIMILARITY_THRESHOLD` to `RagSettings`; parsed and saved as float.
  - Bulk update propagates threshold via `updateRagSettings`.

Files: `knowledgeBaseService.ts`, `credentialsService.ts`
