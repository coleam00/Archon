# Open WebUI × Archon RAG Connector — Python Blueprint

## Purpose
- Server-side connector in Python (not TypeScript) that calls Archon’s RAG HTTP endpoints and returns chat-ready citations.
- Keeps CORS simple (server → server). Maps timeouts/errors to visible chat messages.

## Configuration
- `ARCHON_BASE_URL` default `http://localhost:8181`
- `ARCHON_TIMEOUT_MS` default `15000`
- `ARCHON_MAX_RESULTS` default `5`
- Optional `ARCHON_DEFAULT_SOURCE`

## Endpoints
- POST `{BASE}/api/rag/query` with body `{ query, source?, match_count? }`
- GET `{BASE}/api/rag/sources` for optional source selector

## Connector Skeleton (pseudocode, Python)
```python
import os
import json
import asyncio
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import aiohttp

@dataclass
class ArchonConfig:
    base_url: str = os.getenv("ARCHON_BASE_URL", "http://localhost:8181")
    timeout_ms: int = int(os.getenv("ARCHON_TIMEOUT_MS", "15000"))
    max_results: int = int(os.getenv("ARCHON_MAX_RESULTS", "5"))
    default_source: Optional[str] = os.getenv("ARCHON_DEFAULT_SOURCE")

class ArchonRAGConnector:
    def __init__(self, cfg: ArchonConfig | None = None):
        self.cfg = cfg or ArchonConfig()

    async def _post_json(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        url = f"{self.cfg.base_url}{path}"
        timeout = aiohttp.ClientTimeout(total=self.cfg.timeout_ms / 1000)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, json=payload) as resp:
                text = await resp.text()
                if resp.status // 100 != 2:
                    try:
                        body = json.loads(text)
                        msg = body.get("error") or body.get("detail") or text
                    except Exception:
                        msg = text
                    raise RuntimeError(f"HTTP {resp.status}: {msg}")
                try:
                    return json.loads(text)
                except Exception:
                    return {"results": []}

    async def _get_json(self, path: str) -> Dict[str, Any]:
        url = f"{self.cfg.base_url}{path}"
        timeout = aiohttp.ClientTimeout(total=self.cfg.timeout_ms / 1000)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as resp:
                text = await resp.text()
                if resp.status // 100 != 2:
                    raise RuntimeError(f"HTTP {resp.status}: {text}")
                try:
                    return json.loads(text)
                except Exception:
                    return {}

    async def rag_query(self, query: str, *, source: Optional[str] = None, match_count: Optional[int] = None) -> Dict[str, Any]:
        payload = {
            "query": query,
            "source": source or self.cfg.default_source,
            "match_count": match_count or self.cfg.max_results,
        }
        return await self._post_json("/api/rag/query", payload)

    async def get_sources(self) -> List[Dict[str, Any]]:
        data = await self._get_json("/api/rag/sources")
        return data.get("sources", [])

    @staticmethod
    def render_citations(results: List[Dict[str, Any]]) -> str:
        lines = []
        for i, r in enumerate(results, start=1):
            meta = r.get("metadata", {})
            url = meta.get("url") or meta.get("source_url") or r.get("url") or ""
            score = r.get("similarity")
            score_str = f" (score: {score:.3f})" if isinstance(score, (int, float)) else ""
            snippet = (r.get("content") or "")[:240].replace("\n", " ").strip()
            link = f"[{url}]({url})" if url else ""
            lines.append(f"- [{i}] {link}{score_str}\n  > {snippet}")
        return "\n".join(lines)

    # Registration hook: adapt to Open WebUI's plugin API
    def register(self, tools_registry):
        """
        tools_registry.register(
            name="archon_rag_query",
            description="Query Archon knowledge base and return passages with citations.",
            params={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "source": {"type": "string"},
                    "match_count": {"type": "number", "default": self.cfg.max_results},
                },
                "required": ["query"],
            },
            handler=self._run_tool,
        )

    async def _run_tool(self, args: Dict[str, Any], ctx: Any) -> Dict[str, Any]:
        try:
            data = await self.rag_query(
                query=str(args.get("query", "")),
                source=args.get("source"),
                match_count=int(args.get("match_count") or self.cfg.max_results),
            )
            results = data.get("results", [])
            md = self.render_citations(results)
            return {"type": "markdown", "content": f"Archon RAG Results:\n\n{md}", "metadata": {"results": results}}
        except asyncio.TimeoutError:
            return {"type": "markdown", "content": "❌ Archon RAG timeout. Try fewer results or retry."}
        except Exception as e:
            return {"type": "markdown", "content": f"❌ Archon RAG error: {e}"}
```

## Optional Streaming (only if API supports it)
```python
    async def _run_tool_stream(self, args: Dict[str, Any], ctx: Any):
        try:
            data = await self.rag_query(query=str(args.get("query", "")))
            for r in data.get("results", []):
                url = (r.get("metadata") or {}).get("url") or ""
                await ctx.stream(f"• {url[:80]}...\n")
            return await ctx.done()
        except Exception as e:
            return await ctx.done(f"❌ Archon RAG error: {e}")
```

## Integration Notes
- Registration entry point differs by Open WebUI version. Provide a thin `setup(app)` that instantiates `ArchonRAGConnector(cfg)` and calls `connector.register(app.tools)`.
- Prefer server-side execution (Python) to avoid browser CORS.

## Test Plan
- `curl -X POST $ARCHON_BASE_URL/api/rag/query -H 'Content-Type: application/json' -d '{"query":"hello"}'` ⇒ 200
- Invoke the tool from Open WebUI: expect Markdown list with links/snippets.
- Toggle default source via env or optional UI panel (if implemented).

## Error Handling
- Non-2xx → raise `RuntimeError`, render as `❌ Archon RAG error: ...`
- Timeout → `❌ timeout` guidance
- Empty results → return empty list gracefully
