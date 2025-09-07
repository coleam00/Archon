# RAG Ingestion & Integration Expansion

## High-Level Objective

- Expand Archon’s RAG to support multi-file uploads and additional file types (HTML, code files), and provide a simple integration path for Open WebUI to query the existing RAG endpoints.

## Mid-Level Objectives

- Multi-file: Add a batch upload API and UI support; reuse existing `DocumentStorageService.store_documents`.
- File types: Add robust HTML extraction and improve code file handling (.py, .js, .ts, etc.).
- Consumption: Expose/confirm a minimal REST contract for Open WebUI using `/api/rag/query` and `/api/rag/code-examples`.

## Implementation Notes

- Current ingestion flows: upload one file via `POST /api/documents/upload` → `DocumentStorageService.upload_document` → `smart_chunk_text_async` → batch embeddings → insert into `archon_crawled_pages`.
- Current extractors support: PDF (pdfplumber/PyPDF2), DOC/DOCX (python-docx), plaintext/markdown/rst. No HTML-specific parsing; code files treated as text if allowed through UI.
- Frontend file input restricts to `.pdf,.md,.doc,.docx,.txt` (blocks HTML and code).
- RAG consumption: `POST /api/rag/query` delegates to `RAGService` (vector, optional hybrid + rerank); UI also uses `/knowledge-items/search` (alias).

## Context

current_state:
  files:
    - `python/src/server/api_routes/knowledge_api.py` (upload, rag endpoints)
    - `python/src/server/utils/document_processing.py` (text extraction)
    - `python/src/server/services/storage/{base_storage_service.py,storage_services.py,document_storage_service.py}` (chunk/store)
    - `python/src/server/services/embeddings/embedding_service.py` (batch embeddings)
    - `python/src/server/services/search/rag_service.py` (RAG pipeline)
    - `archon-ui-main/src/components/knowledge-base/AddKnowledgeModal.tsx` (file accept types)
  behavior:
    - Single-file upload; chunk-size ~5000 chars; batch embeddings; store in `archon_crawled_pages`.
    - RAG query over stored chunks with optional hybrid/rerank.
  issues:
    - No HTML parsing; code uploads blocked by UI; no multi-file endpoint.

desired_state:
  files:
    - New: `POST /api/documents/upload-batch` accepting multiple `UploadFile`.
    - Enhance HTML/text extractor; add code-file handling utility.
    - UI: widen file accept list; optional drag-drop multi-select.
  behavior:
    - Upload multiple files in one request; each file becomes a `source_id` or a grouped `source_id` by user option.
    - Correctly extract readable text from HTML; preserve code as fenced blocks to aid chunking.
  benefits:
    - Faster ingestion; broader corpus coverage; improved search quality.

## Low-Level Tasks

1. Backend: Add batch upload endpoint

```
Update file: python/src/server/api_routes/knowledge_api.py
Create endpoint: POST /api/documents/upload-batch (files: list[UploadFile], tags, knowledge_type)
Implementation: Loop files → extract text → call DocumentStorageService.store_documents with per-file metadata; track a single progressId.
Validation: uv run pytest -k upload and exercise /api/documents/upload-batch with 2 small files.
```

2. Backend: HTML extraction

```
Update file: python/src/server/utils/document_processing.py
Add: extract_text_from_html(bytes) using BeautifulSoup/readability fallback; strip scripts/styles; convert to readable text/markdown-like.
Route: Detect content_type text/html or .html; prefer html extractor over generic text decode.
Validation: Unit test with a small HTML sample containing <script>, <style>, and body text.
```

3. Backend: Code file handling

```
Update file: python/src/server/utils/document_processing.py
Add detection for code extensions (.py, .js, .ts, .tsx, .java, .go, .rb, .rs, .c, .cpp, .cs) and content types (text/x-python, etc.).
Strategy: Decode as UTF‑8 and wrap entire content in ```<lang> ... ``` before chunking.
Validation: Unit test that resulting text begins with fenced block and chunker preserves it as one or few chunks.
```

4. Frontend: Enable multi-file + types

```
Update file: archon-ui-main/src/components/knowledge-base/AddKnowledgeModal.tsx
Change: input[type=file] accept to include .html,.py,.js,.ts,.tsx and add multiple attribute.
Add: iterate selected files and call new /documents/upload-batch; show aggregated progress.
Validation: Manual dev test (npm run dev) selecting multiple files and watching progress.
```

5. Open WebUI integration (consumption)

```
Contract: Use POST /api/rag/query { query, source?, match_count } and /api/rag/code-examples.
Option A: Minimal proxy route in Open WebUI that forwards chat prompts to /api/rag/query and formats results.
Option B: Simple Python/Node client snippet for direct REST calls.
Validation: cURL examples succeed locally; document usage in README/Open WebUI notes.
```

## Risks & Mitigations

- Large batches overload: throttle by batch size and reuse existing rate-limit/backoff; surface progress via tracker.
- HTML noise: use readability heuristic; fallback to plain text with tags stripped.
- Code size: very large files—enforce max size (e.g., 10MB) and advise repo-to-markdown pipeline for monorepos.

## Rollback Strategy

- Feature flag new endpoint path; keep original single-file endpoint untouched.
- Guard HTML/code extraction with try/except; fall back to existing text decode.

## Quick Validation Commands

- Backend tests: `uv run pytest -k rag -v` and targeted tests for document processing.
- API smoke: `curl -F "file=@sample1.md" -F "file=@sample2.html" http://localhost:8181/api/documents/upload-batch`.
- RAG query: `curl -X POST localhost:8181/api/rag/query -H 'Content-Type: application/json' -d '{"query":"test"}'`.

