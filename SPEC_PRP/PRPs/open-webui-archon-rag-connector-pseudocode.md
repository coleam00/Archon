# Open WebUI × Archon RAG Connector — Pseudocode Blueprint

## Purpose

- Provide a minimal, shippable connector that lets Open WebUI call Archon’s RAG endpoints, return results, and render citations.
- Keep the integration HTTP-first; probe streaming only if the Open WebUI connector API supports it.

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

1. Read Open WebUI docs for connectors/tools/webhooks/streaming and confirm supported patterns.
2. Draft connector code + citation rendering approach; validate with local Archon.
3. Write “Integration How‑To” with env, build/run steps, and troubleshooting.

## Configuration

- `ARCHON_BASE_URL` (default: `http://localhost:8181`)
- `ARCHON_TIMEOUT_MS` (default: `15000`)
- `ARCHON_MAX_RESULTS` (default: `5`)
- Optional: `ARCHON_DEFAULT_SOURCE` (scope queries)

## Endpoints to Use

- POST `${ARCHON_BASE_URL}/api/rag/query`
  - Body: `{ query: string, source?: string, match_count?: number }`
  - Resp: `{ success?: boolean, results: Array<{ content: string, metadata?: any, similarity?: number }>, ... }`
- GET `${ARCHON_BASE_URL}/api/rag/sources`
  - Resp: `{ sources: Array<{ source_id: string, title: string }> }`

---

## Pseudocode (Connector/Tool Registration)

```ts
// file: connectors/archonRag.ts
export function registerArchonRagConnector(openwebui: App) {
  const cfg = {
    baseUrl: env.ARCHON_BASE_URL || "http://localhost:8181",
    timeoutMs: Number(env.ARCHON_TIMEOUT_MS || 15000),
    maxResults: Number(env.ARCHON_MAX_RESULTS || 5),
    defaultSource: env.ARCHON_DEFAULT_SOURCE || undefined,
  };

  // Optional: preload available sources for UI dropdown
  async function getSources(): Promise<Array<{ id: string; title: string }>> {
    try {
      const res = await fetch(`${cfg.baseUrl}/api/rag/sources`, {
        method: "GET",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items = (data.sources || []).map((s: any) => ({
        id: s.source_id,
        title: s.title || s.source_id,
      }));
      return items;
    } catch (e) {
      console.warn("[archon] getSources failed", e);
      return [];
    }
  }

  // Core query
  async function ragQuery(
    query: string,
    opts?: { source?: string; matchCount?: number }
  ) {
    const body = JSON.stringify({
      query,
      source: opts?.source ?? cfg.defaultSource ?? undefined,
      match_count: opts?.matchCount ?? cfg.maxResults,
    });

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(`${cfg.baseUrl}/api/rag/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) {
        const err = await safeJson(res);
        throw new Error(err?.error || `HTTP ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      clearTimeout(t);
      throw e;
    }
  }

  function renderCitations(results: any[]): string {
    // Produce Markdown list with URLs/snippets if present
    return results
      .map((r, i) => {
        const url = r.metadata?.url || r.metadata?.source_url || r.url || "";
        const score =
          typeof r.similarity === "number"
            ? ` (score: ${r.similarity.toFixed(3)})`
            : "";
        const snippet = (r.content || "").slice(0, 240).replace(/\s+/g, " ");
        const link = url ? `[${url}](${url})` : "";
        return `- [${i + 1}] ${link}${score}\n  > ${snippet}`;
      })
      .join("\n");
  }

  // Utility safeJson
  async function safeJson(res: Response) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  // Tool/Function Registration (shape depends on Open WebUI’s plugin API)
  openwebui.tools.register({
    name: "archon_rag_query",
    description:
      "Query Archon knowledge base and return top passages with citations.",
    // UI schema for parameters
    params: {
      type: "object",
      properties: {
        query: { type: "string", description: "User question" },
        source: {
          type: "string",
          description: "Optional source_id to scope (from /api/rag/sources)",
        },
        match_count: {
          type: "number",
          description: "Max results",
          default: cfg.maxResults,
        },
      },
      required: ["query"],
    },
    // Invocation
    run: async ({ query, source, match_count }, ctx) => {
      try {
        const data = await ragQuery(String(query), {
          source,
          matchCount: Number(match_count),
        });
        const results = data.results || [];
        const md = renderCitations(results);
        // Return both an assistant message and a metadata block
        return {
          type: "markdown",
          content: `Archon RAG Results:\n\n${md}`,
          metadata: { results },
        };
      } catch (e) {
        return {
          type: "markdown",
          content: `❌ Archon RAG error: ${String(e)}`,
        };
      }
    },
  });

  // Optional: expose a small UI panel for source selection
  openwebui.ui.registerPanel({
    id: "archon_sources",
    title: "Archon Sources",
    render: async () => {
      const items = await getSources();
      return /* html */ `
        <div>
          <label>Default Source</label>
          <select id="archon-default-source">
            <option value="">All</option>
            ${items
              .map((i) => `<option value="${i.id}">${i.title}</option>`)
              .join("")}
          </select>
        </div>`;
    },
    onMount: (root) => {
      const sel = root.querySelector("#archon-default-source");
      sel?.addEventListener("change", () => {
        cfg.defaultSource = sel.value || undefined;
      });
    },
  });
}
```

---

## Optional: Streaming Sketch

If Open WebUI supports custom streaming responses (SSE/WS) for tools, adapt `run()`:

- Start request; if streaming API exists, pipe chunks to `ctx.stream(token)`.
- Otherwise, simulate streaming by sending partial citation lines with small delays, then final metadata.

```ts
// Pseudocode only – depends on Open WebUI streaming API
openwebui.tools.register({
  name: "archon_rag_query_stream",
  run: async ({ query }, ctx) => {
    try {
      const data = await ragQuery(query);
      for (const r of data.results) {
        await ctx.stream(`• ${(r.metadata?.url || "").slice(0, 80)}...\n`);
      }
      return ctx.done();
    } catch (e) {
      return ctx.done(`❌ Archon RAG error: ${String(e)}`);
    }
  },
});
```

---

## Error Mapping & UX

- HTTP error → chat message: `❌ Archon RAG error: <message>`; do not return null silently.
- Timeouts → suggest retry with lower `match_count`.
- Empty results → return “No results found; try different wording or source.”

## Acceptance Criteria

- A user can invoke the tool (button or slash command) with a query and optional source.
- The connector calls `/api/rag/query` and renders citations with links and snippets.
- Errors are visible in-chat; no silent failures.
- (Optional) A small panel allows picking a default source.

## Test Plan

- `curl -X POST $ARCHON_BASE_URL/api/rag/query -H 'Content-Type: application/json' -d '{"query":"test"}'`
- From Open WebUI, run tool with a simple query; verify citations list.
- Set a default source; verify requests include `source` and results scope accordingly.
