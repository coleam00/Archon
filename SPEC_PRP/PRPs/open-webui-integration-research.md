# Open WebUI Integration — Research Brief

## Objectives
- Integrate Archon RAG endpoints into Open WebUI for querying and citation display.
- Support streaming responses where possible; handle errors clearly.
- Explore both HTTP endpoints and Webhooks; note feasibility of WebSocket/function plugins.

## Key Questions to Answer
- HTTP: How to add a connector that POSTs to `http://localhost:8181/api/rag/query` and `/api/rag/code-examples`? Auth, headers, CORS?
- Streaming: Does Open WebUI support SSE/streaming for custom connectors? Expected stream format and backpressure handling.
- Webhooks: Inbound vs outbound webhooks—how to trigger RAG calls from chat turns? Retry policy, signatures, security.
- Functions/Tools: Can we register a custom “tool” that calls Archon RAG? Request/response schema, error propagation, tool result rendering.
- WebSocket: API for custom WS clients? Message framing, reconnects, and how to stream partial tokens.
- UI Extensions: How to render citations/sources (URL + snippet) in the chat? Hook points for post-processing.
- Config/Deployment: Where to register connectors/plugins (file locations, env vars)? Hot reload vs restart required.
- Rate limiting & timeouts: Defaults, overrides, and how to surface partial results.

## Required Deliverables
- Architecture notes: Data flow diagrams for HTTP and Webhook approaches.
- Connector spec: Request/response shapes mapping to Archon (`query`, `source`, `match_count`).
- Error model: How errors map from Archon (HTTP 4xx/5xx bodies) to Open WebUI user-visible messages.
- Streaming plan: Proof that streaming is supported or fallback plan if not.
- Minimal POC: Code snippet registering a custom connector/tool; curl examples.
- Ops notes: Configuration steps (env, keys), CORS checklist, and local test plan.

## Success Criteria
- From Open WebUI, a prompt triggers POST to `/api/rag/query` and renders top results.
- Optional: toggle to scope by `source` and show citation list with URLs.
- Clear handling of timeouts, retries, and failures (no silent nulls).

## Risks & Mitigations
- CORS/CSRF: Enable CORS only for local hosts; document exact headers.
- Streaming mismatch: If SSE unsupported, use chunked polling fallback.
- Version drift: Capture Open WebUI version/API assumptions in the report.

## Research Plan
1) Read Open WebUI docs for: HTTP connectors, Webhooks, function/tool APIs, streaming support, and plugin packaging.
2) Draft connector spec and error/stream mapping; confirm with a minimal local POC.
3) Validate with two flows: (A) standard RAG; (B) code examples endpoint.
4) Produce a short “Integration How-To” with config and testing steps.

## References Needed
- Open WebUI docs (connectors/plugins/tools/webhooks/streaming).
- Archon endpoints: `/api/rag/query`, `/api/rag/code-examples`, and `/api/rag/sources`.

