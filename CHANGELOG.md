# Changelog

## [Unreleased] - 2025-09-06 (not yet committed)

- Base commit before this working session: d0b9608

Added
- Batch upload API with grouping (file/folder/batch) and display name option.
- HTML + code-file extraction (fenced blocks) and fence-preserving chunker.
- Code example extraction for uploads and batch uploads.
- Similarity Threshold control in Settings (UI + backend live read).
- Research/spec docs for Open WebUI integration (HTTP + Python blueprint).

Changed
- Knowledge search UI now sends `match_count` (was `limit`).
- Uploader UX: dedicated buttons for Single File, Multiple Files, Folder.
- Markdown code extraction uses settings-driven min length; relaxed rules for bash/yaml/json/toml/ini.

This record summarizes the code changes made during the ADK integration and RAG pipeline tuning. It focuses on what changed, where, and why, with pointers for verification.

## Summary
- Added multi-file and folder ingestion (with grouping) and a new batch upload API.
- Improved HTML and code-file extraction; preserved code fences across chunks.
- Enabled code example extraction for uploads (previously only on crawl).
- Exposed Similarity Threshold to Settings UI; backend reads it live from credentials/env.
- Fixed search request to honor `match_count`; improved uploader UX (single/multiple/folder).
- Added Open WebUI research/spec docs (HTTP connector, Python blueprint).

## Backend
- `python/src/server/api_routes/knowledge_api.py`
  - New: `POST /api/documents/upload-batch` (group_by: `file|folder|batch`, optional `group_display_name`).
  - Upload (single + batch): Run code example extraction after storing chunks; map progress; skip on failure.
  - Aggregated source update after batch (per source_id) with combined summary/word counts.

- `python/src/server/utils/document_processing.py`
  - HTML extraction (BeautifulSoup if available; regex fallback) preserving `<pre><code>` to fenced blocks.
  - Code-file support (.py/.js/.ts/.tsx/.java/.go/.rb/.rs/.c/.cpp/.cs/.json/.css/.html): wrap in fenced block with inferred language.

- `python/src/server/services/storage/base_storage_service.py`
  - Chunker: preserve fences across chunk boundaries (```, ~~~, <pre>); updated `has_code` metadata.

- `python/src/server/services/search/base_search_strategy.py`
  - Similarity threshold made configurable: reads `SIMILARITY_THRESHOLD` from credentials (category `rag_strategy`) or `env`; traces used value.

- `python/src/server/services/crawling/code_extraction_service.py`
  - Markdown extraction now uses settings-driven `MIN_CODE_BLOCK_LENGTH` (not hardcoded 250).
  - Soft acceptance path for low-complexity snippet languages (bash/yaml/json/toml/ini) to capture short, config-like examples.

## Frontend
- `archon-ui-main/src/components/knowledge-base/AddKnowledgeModal.tsx`
  - Expanded accept list; added explicit Single File / Multiple Files / Folder buttons.
  - Folder selection auto-enables “Group as single source” and suggests folder name.
  - Separate hidden inputs for single-file, multi-file, and folder pickers; stable user intent.

- `archon-ui-main/src/services/knowledgeBaseService.ts`
  - `searchKnowledgeBase`: map `limit` → `match_count` so backend returns requested number (not default 5).
  - `uploadDocumentsBatch`: send relative paths and `group_by` / `group_display_name`.

- `archon-ui-main/src/components/settings/RAGSettings.tsx`
  - Added Similarity Threshold control (slider + percent input). Saves as decimal (e.g., 0.30) under key `SIMILARITY_THRESHOLD`.

- `archon-ui-main/src/services/credentialsService.ts`
  - Added `SIMILARITY_THRESHOLD` to RAG settings; parses as float; removed accidental int-cast.

## New/Updated Docs (specs & tasks)
- `SPEC_PRP/PRPs/open-webui-integration-research.md` – Integration research brief.
- `SPEC_PRP/PRPs/open-webui-rag-integration-research.md` – RAG-focused research outline.
- `SPEC_PRP/PRPs/open-webui-archon-rag-connector-pseudocode.md` – JS/TS pseudocode connector blueprint.
- `SPEC_PRP/PRPs/open-webui-archon-rag-connector-python.md` – Python server-side connector blueprint.
- `TASK_PRP/PRPs/open-webui-connector-tasks.md` – Task PRP for connector build.

## Settings to tune (UI → Settings → RAG / Code Extraction)
- RAG
  - `SIMILARITY_THRESHOLD`: 0.10–0.12 (recall) / 0.15 (balanced) / 0.20 (precision)
  - `USE_HYBRID_SEARCH`, `USE_RERANKING`
- Code Extraction
  - `MIN_CODE_BLOCK_LENGTH` (e.g., 80–120 for ADK snippets)
  - `MIN_CODE_INDICATORS` (1–2 for small examples)
  - `MAX_PROSE_RATIO` (0.35–0.45)

## Endpoints
- `POST /api/documents/upload-batch` – Multi-file/folder ingestion; returns `progressId`.
- `POST /api/rag/query` – Accepts `match_count`; uses live `SIMILARITY_THRESHOLD`.
- `POST /api/rag/code-examples` – Code examples search (depends on extraction results).
- `GET /api/knowledge-items/{source_id}/code-examples` – Inspect stored examples.

## Verification
- Ingest
  - Single file: verify progress → code extraction → completion.
  - Folder: verify grouping creates one source_id and code examples populate.
- Search
  - `curl -X POST /api/rag/query -d '{"query":"...","match_count":20}'`
  - `curl -X POST /api/rag/code-examples -d '{"query":"install","source":"<source_id>","match_count":10}'`
- Settings
  - Adjust threshold to 0.30; ensure it persists in UI and reflected in logs (`similarity_threshold`).

## Notes
- Code extraction for uploads was added; previously only executed during crawls.
- Folder grouping modes: `file` (default), `folder` (per top-level folder), `batch` (single source for entire upload) with optional `group_display_name`.
- HTML parsing uses BeautifulSoup when present; otherwise falls back to safe regex.
