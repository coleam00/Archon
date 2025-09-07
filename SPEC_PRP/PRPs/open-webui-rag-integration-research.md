# Open WebUI RAG Integration — Research Outline

## Objectives
- Integrate Archon’s RAG endpoints into Open WebUI chat so users can query and see citations/sources.
- Support both standard responses and streaming (if available), with clear error mapping.
- Keep the connector minimal and self‑contained; document setup thoroughly.

## Archon Endpoints to Map
- `POST /api/rag/query` → body: `{ query: string, source?: string, match_count?: number }` → list of results with content/metadata.
- `POST /api/rag/code-examples` → body: `{ query: string, source?: string, match_count?: number }` → code snippets.
- `GET /api/rag/sources` → list of available sources for UI scoping.

## Research Questions (Open WebUI)
- Custom connectors/tools: How to register a function/tool that can be invoked from a chat turn? Where do files live? Hot‑reload vs restart?
- Streaming: Is SSE or WS supported for custom connectors? Expected event format? How to progressively append content and citations?
- Webhooks: Are outbound/inbound webhooks available to trigger Archon calls? Retry policy, signing/secrets, error propagation.
- UI hooks: Best place to inject citations (URL + snippet + score)? Markdown extension? Custom renderer?
- State: Per‑conversation memory and caching — can we store last results to enable follow‑ups and pagination?
- Auth/CORS: How to configure base URL, API key, or allowlist? Are proxy settings available?
- Rate limits/timeouts: Defaults and overrides; recommended backoff; where to surface partial results.

## Integration Options to Compare
- HTTP connector (recommended first): Simple POST to `/api/rag/query` and render results.
- Tool/function API: Register “archon_rag_query” tool that takes `{query, source, match_count}` and returns structured results.
- WebSocket streaming: If supported, stream partial chunks and citations; otherwise fall back to non‑streaming HTTP.

## Minimal POC Targets
- Add a connector that:
  - Reads `ARCHON_BASE_URL` (default `http://localhost:8181`).
  - Calls `/api/rag/query` with `{query}` and renders top N results.
  - Optionally calls `/api/rag/sources` for a source selector.
- Error model: Show Archon’s `detail.error` in the chat; no silent failures.
- Optional: Streaming POC if Open WebUI supports SSE for custom connectors.

## Deliverables
- Architecture note (data flow diagram) comparing HTTP vs Webhook vs Tool APIs.
- Connector spec: request/response schema and mapping to chat messages.
- Reference implementation (skeleton code) + config/env checklist.
- Test plan: local curl tests, connector invocation, streaming (if any), and citation rendering.

## Risks & Mitigations
- CORS/CSRF: Use server‑side connector where possible; if browser fetch, enable local CORS on Archon.
- Streaming mismatch: Provide graceful fallback to non‑streaming HTTP.
- Version drift: Pin Open WebUI version in docs and re‑test on upgrades.

## Next Steps
1) Read Open WebUI docs for connectors/tools/webhooks/streaming and confirm supported patterns.
2) Draft connector code + citation rendering approach; validate with local Archon.
3) Write “Integration How‑To” with env, build/run steps, and troubleshooting.

