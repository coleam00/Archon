# TASK PRP — RAG Expansion (Multi-file, HTML, Code Blocks)

## context:
  docs:
    - url: SPEC_PRP/PRPs/rag-expansion-spec.md
      focus: Current vs desired ingestion and endpoints
    - url: python/src/server/utils/document_processing.py
      focus: Extractors and supported types
    - url: python/src/server/services/storage/base_storage_service.py
      focus: smart_chunk_text/_async fencing behavior
    - url: archon-ui-main/src/components/knowledge-base/AddKnowledgeModal.tsx
      focus: File accept list and single-file limitation
  patterns:
    - file: python/src/server/services/crawling/document_storage_operations.py
      copy: Chunk→embed→store pipeline and progress callbacks
    - file: python/src/server/services/embeddings/embedding_service.py
      copy: Batch/skip-on-failure behavior
  gotchas:
    - issue: Code fences split at chunk boundaries; only looks back for ``` markers
      fix: Scan forward to closing fence; support ~~~ and <pre><code>
    - issue: UI blocks .html and code files
      fix: Expand accept list and support multiple files

## Task Sequencing
1. Setup: tests + safety
2. Extractors: HTML + code handling
3. Chunker: stronger code-fence preservation
4. Backend: batch upload endpoint
5. Frontend: multi-file upload + types
6. Validation: ingest + search + code examples
7. Cleanup: docs and flags

---

ACTION python/src/server/utils/document_processing.py:
  - OPERATION: Add `extract_text_from_html(bytes)->str` (BeautifulSoup/readability style). Strip scripts/styles/nav; keep <pre><code> as fenced blocks with language hints.
  - VALIDATE: `uv run pytest -k document_processing -v` with sample HTML containing script/style and code blocks.
  - IF_FAIL: Fallback to tag-stripped plain text; log with `exc_info=True`.
  - ROLLBACK: Guard new path behind content-type check; revert to plaintext decode on exception.

ACTION python/src/server/utils/document_processing.py:
  - OPERATION: Detect code files (.py,.js,.ts,.tsx,.java,.go,.rb,.rs,.c,.cpp,.cs). Decode UTF-8 and wrap content in ```<lang> …``` before returning.
  - VALIDATE: Unit test that result starts with fenced block and chunker preserves fences.
  - IF_FAIL: Return raw decoded text and log a warning.
  - ROLLBACK: Behind extension/content-type check; no change to other types.

ACTION python/src/server/services/storage/base_storage_service.py:
  - OPERATION: Enhance `smart_chunk_text` to preserve fenced blocks across boundaries: detect opening fence region and scan forward for matching closing fence before splitting; support ``` and ~~~; treat <pre><code> markers as fences.
  - VALIDATE: Unit test with long fenced block > chunk_size; ensure split occurs after closing fence.
  - IF_FAIL: Reduce chunk_size for test input and verify at least no mid-block split; log fence mismatch.
  - ROLLBACK: Feature-gate via parameter (e.g., preserve_code_fences=True) defaulting to True.

ACTION python/src/server/api_routes/knowledge_api.py:
  - OPERATION: Create `POST /api/documents/upload-batch` accepting multiple `UploadFile`. Iterate files → extract text → call `DocumentStorageService.store_documents` with per-file metadata; use one progressId with sub-progress.
  - VALIDATE: `curl -F "file=@a.md" -F "file=@b.html" http://localhost:8181/api/documents/upload-batch` returns progressId and completes.
  - IF_FAIL: Process sequentially and emit progress per-file; log individual failures and continue (skip don’t corrupt).
  - ROLLBACK: Keep single-file `/documents/upload` unchanged; hide batch endpoint behind feature flag if needed.

ACTION archon-ui-main/src/components/knowledge-base/AddKnowledgeModal.tsx:
  - OPERATION: Add `multiple` to input and expand accept to `.pdf,.md,.doc,.docx,.txt,.html,.py,.js,.ts,.tsx`. Wire to new batch endpoint; show aggregate progress and per-file status.
  - VALIDATE: `npm run dev` and upload 2–3 files; verify backend ingestion and chunk counts.
  - IF_FAIL: Fallback to sequential calls to single-file endpoint and aggregate progress client-side.
  - ROLLBACK: Keep original single-file UI path behind a toggle.

ACTION python/src/server/services/search/rag_service.py:
  - OPERATION: No core change; add optional source filter support doc and ensure results include snippet boundaries for better citation rendering.
  - VALIDATE: POST `/api/rag/query` with and without `source`; verify counts and content truncation.
  - IF_FAIL: Decrease truncation; log formatting errors.
  - ROLLBACK: None required (no functional change).

## Validation Strategy
- Unit: new extractor tests; chunker fence tests.
- Integration: upload-batch flow with mixed types; verify `archon_crawled_pages` rows.
- Functional: `/api/rag/query` returns relevant results for HTML/code docs; code examples endpoint still works.
- Performance: Batch embeds use existing rate-limit/backoff; watch logs for slowdowns.
- Security: Validate mime/extension; size limits; skip binaries.

## Debug Patterns
- Use progress IDs and logs around each step; verify sub-progress per file.
- If fences split, print fence positions and chunk boundaries.
- If embeddings fail, inspect `failed_items` and do not store placeholders.

## Rollback
- Keep single-file upload intact; batch behind a feature flag.
- Guard new extractors with try/except and fallback to plain text.

## Acceptance Criteria
- Multi-file ingestion works; HTML/code fenced blocks preserved; RAG results searchable; errors logged with tracebacks; no corrupt data stored.

