# TASK PRP — Open WebUI × Archon RAG Connector

## context:
  docs:
    - url: SPEC_PRP/PRPs/open-webui-connector-technical-guide.md
      focus: Source of truth for connector behavior and config
    - url: SPEC_PRP/PRPs/open-webui-archon-rag-connector-pseudocode.md
      focus: Registration, HTTP call, citation rendering
    - url: SPEC_PRP/PRPs/open-webui-rag-integration-research.md
      focus: Options, risks, deliverables
  patterns:
    - file: python/src/server/api_routes/knowledge_api.py
      copy: Contract for /api/rag/query, /api/rag/sources
  gotchas:
    - issue: Browser‑side CORS can block requests
      fix: Prefer server‑side connector, or enable local CORS on Archon
    - issue: Timeouts or rate limits on large queries
      fix: Expose `match_count`, lower defaults, and show actionable errors

## Task Sequencing
1. Create connector skeleton
2. Implement HTTP query + config
3. Render citations (links/snippets/score)
4. Add optional Sources panel
5. Handle errors/timeouts cleanly
6. (Optional) Add streaming variant
7. Register/enable in Open WebUI
8. Validate end‑to‑end

---

ACTION connectors/archonRag.ts:
  - OPERATION: Create connector file; register tool `archon_rag_query` using env config (`ARCHON_BASE_URL`, `ARCHON_TIMEOUT_MS`, `ARCHON_MAX_RESULTS`, `ARCHON_DEFAULT_SOURCE`).
  - VALIDATE: Build or reload Open WebUI; confirm tool appears in dev console or UI list.
  - IF_FAIL: Check plugin loader path/version; reduce to a no‑op tool to isolate registration.
  - ROLLBACK: Remove the file and registration call.

ACTION connectors/archonRag.ts:
  - OPERATION: Implement POST `${ARCHON_BASE_URL}/api/rag/query` with `{ query, source?, match_count? }`; support AbortController timeout; parse JSON errors.
  - VALIDATE: Invoke tool with `query: "test"`; expect Markdown output with results list.
  - IF_FAIL: Curl endpoint to ensure Archon is reachable; log base URL and response body.
  - ROLLBACK: Fallback to static demo response.

ACTION connectors/archonRag.ts:
  - OPERATION: Render citations as Markdown list: URL (if present), similarity score, and first ~240 chars of content; include full results in a metadata block.
  - VALIDATE: Visual check that links/snippets render; metadata present in debug.
  - IF_FAIL: Escape Markdown; trim long lines; show URL as plain text.
  - ROLLBACK: Show plain bullet list without links.

ACTION connectors/archonRag.ts:
  - OPERATION: Add optional panel (`archon_sources`) pulling `/api/rag/sources` to set default source at runtime.
  - VALIDATE: Change dropdown; verify subsequent calls include `source`.
  - IF_FAIL: Hardcode `ARCHON_DEFAULT_SOURCE` in env and retry.
  - ROLLBACK: Remove panel; keep env‑only config.

ACTION connectors/archonRag.ts (optional):
  - OPERATION: Add streaming variant `archon_rag_query_stream` if Open WebUI supports `ctx.stream()`; otherwise skip.
  - VALIDATE: Observe incremental tokens/lines in chat.
  - IFFAIL: Downgrade to non‑streaming path; note limitation in docs.
  - ROLLBACK: Remove stream tool export.

ACTION docs/connector-readme.md:
  - OPERATION: Document env vars, install path, register instructions, and troubleshooting (CORS, timeouts, HTTP error mapping).
  - VALIDATE: Fresh clone install and enable following steps succeeds.
  - IFFAIL: Add missing step; include version pin of Open WebUI.
  - ROLLBACK: Keep instructions local to repo in SPEC_PRP; remove external doc.

## Validation Strategy
- Archon API: `curl -X POST $ARCHON_BASE_URL/api/rag/query -H 'Content-Type: application/json' -d '{"query":"hello"}'` → 200 with results.
- Open WebUI: invoke `archon_rag_query` with and without `source`; verify Markdown and links.
- Error paths: point to invalid URL or cut network; confirm visible error message.

## Debug Patterns
- Log base URL, payload, and status on request failure.
- Include short error detail in chat; log full stack to console.
- Use timeout guard; surface timeout advice to user.

## Rollback
- Disable registration/export; remove connector file.
- Revert env changes; remove panel.

## Acceptance Criteria
- Tool appears and executes; returns top‑N citations with links/snippets.
- Clear error messages; no silent failures.
- Configurable base URL and timeouts via env; optional default source.
