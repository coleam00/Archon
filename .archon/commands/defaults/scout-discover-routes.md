---
description: Query Scout APM for top slow + high-traffic routes and write routes.json
argument-hint: "[optional app name or app id — else first active app]"
---

# Scout route discovery

**User message**: $ARGUMENTS  
**Artifacts**: $ARTIFACTS_DIR

---

## Mission

Use **Scout MCP** tools to identify **up to 10 HTTP routes** to optimize. Combine:

- **Slowest** endpoints (p95 / mean response time), and  
- **Most hit** (throughput / request volume)

Dedupe by route identity (method + path). If you have fewer than 10 distinct hot/slow routes, include the next candidates by severity. If Scout returns fewer than 10, use all available.

---

## Prerequisites

1. **MCP**: Scout tools should be available (`list_apps`, `get_app_endpoints`, `get_endpoint_metrics`, etc.). If MCP is unavailable, ask the user to set `SCOUT_API_KEY`, ensure Docker can run `scoutapp/scout-mcp-local`, or paste a Scout endpoints export into `$ARTIFACTS_DIR/scout-endpoints-export.json` (array of endpoint objects) and continue from that file.

2. **App selection**: If `$ARGUMENTS` names an app or numeric id, use that. Otherwise call `list_apps` and pick the production app that matches this repo (name/hostname) or the most recently active app. State which app you chose.

---

## Steps

1. Call Scout MCP to list endpoints with metrics for the chosen app (`get_app_endpoints` or equivalent).

2. Rank and select up to **10** routes using a clear rule, e.g.:
   - Take top **5** by p95 latency (or worst mean response time if p95 missing).
   - Take top **5** by throughput.
   - Union, dedupe, then fill remaining slots by composite score: `latency × log(throughput)` or similar.

3. Write **`$ARTIFACTS_DIR/routes.json`** — JSON array of exactly the chosen routes, each object including at least:

   - `rank` (1–10)  
   - `method` (e.g. `GET`)  
   - `path` (e.g. `/api/foo`)  
   - `scout_name` or endpoint id if the API exposes one  
   - `p95_ms`, `mean_ms` (numbers or null)  
   - `rpm` or throughput (number or null)  
   - `error_rate` if available  

4. Write **`$ARTIFACTS_DIR/routes-summary.md`** — human-readable table: rank, method, path, p95, throughput, notes.

5. Print a one-line stdout summary: `Discovered N routes for app {name} (id {id}).`

---

## Error handling

- If no endpoints are returned: write `routes.json` as `[]`, explain in summary, and STOP with a clear error in stdout so the workflow can fail visibly.

---

## Success criteria

- `routes.json` exists and is valid JSON.  
- `routes-summary.md` exists.  
- At most 10 routes; each profile step can rely on fixed indices `0..N-1`.
