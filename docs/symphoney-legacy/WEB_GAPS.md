# Web UI gap analysis

Punch list for moving the kanban frontend from "ported and working E2E" to "production-feeling product." Compares the current `web/` workspace (forked from `cursor/cookbook/sdk/agent-kanban`) against the upstream cookbook example, the Symphoney daemon's available data, and `ROADMAP.md` waves.

Severity tags:
- `fix-now` — small, ship in the next PR
- `next` — pre-Wave-2 polish
- `wave-N` — gated on a ROADMAP wave landing

Companion docs: `ROADMAP.md` (long-arc plan), `CLAUDE.md` (Web UI section under "Commands"), `SPEC.md` (source of truth for daemon behavior).

---

## 1. Bugs found in E2E

| Severity | Issue | Where |
|---|---|---|
| `fix-now` | First-card layout glitch — top card in a column has negative left offset / truncated branch text. Other cards in the same column render fine. CSS issue in flex column when the first child is wrapped by `Card`. | `web/src/components/symphony-kanban.tsx:174-182` |
| `fix-now` | Dispatch button enabled on terminal-state cards (`Done`/`Cancelled`). Endpoint correctly returns 404, but UX shouldn't invite the click. | `web/src/components/symphony-kanban.tsx:198` — `dispatchDisabled` should also include `lifecycle === "completed"` |
| `fix-now` | `web/.env.local` setup not documented. Without it the kanban hits same-origin Next and gets 404s on every API call. | Add `cp web/.env.local.example web/.env.local` step to CLAUDE.md Web UI section |
| `fix-now` | `next dev` hardcoded to port 3000 in `web/package.json`. Collides if 3000 is busy. | `web/package.json:6` — switch to `--port ${PORT:-3000}` or document |
| `next` | `SYMPHONY_DEV_CORS` is checked at app-init time (`createApp`), so toggling the env var requires daemon restart. Move the check inside the middleware. | `src/server/http.ts:42` |

---

## 2. Features dropped from upstream agent-kanban

The upstream `cursor/cookbook/sdk/agent-kanban` ships several flows we removed during the Symphoney port. Some are worth restoring once the matching feature exists daemon-side.

| Severity | Feature | Why we dropped | When to restore |
|---|---|---|---|
| `next` | Search box in header | v1 simplicity | When backlog grows past ~20 issues. Filter `cards` by `query` against identifier+title. |
| `next` | Sidebar filter pills (`all`, `withArtifacts`, `prAgents`, `recentlyActive`) | Filters didn't map cleanly to Symphoney domain | Re-add as: `all`, `running`, `failed/retrying`, `recently completed` |
| `wave-2` | API-key onboarding flow | Symphoney has no auth | Restore when Wave 2.3 auth lands (Cloudflare Access OR shared-secret) |
| `wave-2` | Create-agent dialog | Out of scope (Linear is source of truth for new issues) | Could become "create Linear issue from board" if we add Linear write scope |
| `wave-2` | Artifact previews (image / video / file) | No Symphoney analog | Add when workspace artifact surfacing exists. Requires `GET /api/v1/<id>/files` |
| `wave-2` | Model picker | Symphoney's backend is per-workflow, not per-issue | Could surface `agent.backend` and `claude.model` from snapshot as a read-only header chip |

---

## 3. Symphoney-specific feature gaps

Data already exists in the orchestrator/snapshot but isn't exposed in the kanban UI.

| Severity | Gap | Source data |
|---|---|---|
| `next` | **Per-card detail view** — clicking a card does nothing. Should slide a panel with `/api/v1/<identifier>` data: turn count, last_event, full token breakdown, retry timeline. | `src/server/http.ts:149` already returns it |
| `next` | **Cancel/abort running issue from UI** — only way to stop a runaway run is killing the daemon. Need `POST /api/v1/<id>/cancel` that calls `RunningEntry.abort.abort()`. | `src/orchestrator/state.ts:RunningEntry.abort` |
| `next` | **Workspace path** — agents run in `~/symphony_workspaces/<id>/` but UI has no link. | `WorkspaceManager.createForIssue` returns it; needs to be added to `RunningRow` |
| `next` | **Card duration** — computed in transform but never rendered. | `web/src/lib/symphony/transform.ts:55` (`durationMs`) |
| `next` | **Token totals on completed/retrying cards** — only rendered for `running` lifecycle. No input/output split anywhere. | `web/src/components/symphony-kanban.tsx:230-238` |
| `next` | **`last_error` on retrying cards** — UI shows `attempt` + `due_at` but not the error itself. | `OrchestratorRetryRow.error` exists; transform.ts drops it |
| `wave-2` | **Cache token accounting** — Claude reports `cache_creation_input_tokens` and `cache_read_input_tokens`. UI ignores both. Worth surfacing for cost awareness. | `OrchestratorSnapshot.codex_totals.{cache_creation_input_tokens, cache_read_input_tokens}` |
| `wave-2` | **PR URL** — always `null` in the card today because `RunningEntry` never receives one. Field hardcoded `null` in transform. | Wave 0.6 — PR publisher needs to populate it |
| `wave-2` | **Rate-limit display** — `rate_limits: unknown` placeholder; UI shows nothing. | `OrchestratorSnapshot.rate_limits` — type firms up in Wave 1.3 |
| `wave-2` | **Per-card agent event log** — `agent_event` pino lines exist but no `GET /api/v1/<id>/events` endpoint and no UI. | New endpoint + SSE or paginated polling |

---

## 4. UI / UX polish

| Severity | Issue |
|---|---|
| `fix-now` | Dark mode hardcoded in `<html className="dark">` — no toggle. |
| `fix-now` | Toast bottom-right, no stack — multiple errors clobber each other. Use a queue or shadcn `sonner`. |
| `fix-now` | No "just dispatched" highlight on the affected card beyond the toast. A 2s ring/pulse closes the loop. |
| `next` | No loading state on individual cards (only initial board skeleton). Feels frozen during a 240ms `/issues` fetch. |
| `next` | Header "0 running · 0 retrying" is plain text — should be a colored badge (green when 0 errors, red when retries are due soon). |
| `next` | "1d ago" formatting is fine but no actual timestamps on hover. Tooltips missing. |
| `next` | No sort control within columns — cards arrive in tracker order, no override. |
| `next` | No card density toggle (compact vs comfortable). |
| `next` | Repository column collapses to one — make it disappear or merge into the header chip when there's only one. |
| `next` | No keyboard shortcuts (`r` refresh, `g` toggle group, `/` search, `j/k` move focus). |
| `next` | No empty state per column (only per board). Done column with 0 cards just disappears. |
| `next` | No accessibility audit: focus order, aria labels, screen-reader column landmarks, focus rings on cards. |
| `next` | Dispatch button label is generic; should say "Dispatch now" to match ROADMAP/Slack language. |
| `wave-2` | **Mobile / responsive layout** — kanban won't work on a phone, and ROADMAP Wave 2.1 explicitly says "usable from a phone in a meeting." Either add a list view at narrow widths or accept the gap and use Slack on mobile. |

---

## 5. Backend / API gaps

| Severity | Gap | Where |
|---|---|---|
| `fix-now` | `/api/v1/issues` has no pagination or `?limit=`. Linear backlogs > 200 will hammer the API at 5s polling. | `src/server/http.ts:48-76` |
| `fix-now` | `/api/v1/issues` has no in-process cache. Trivial 5s LRU keyed by `states.sort().join(",")` would gut Linear cost. | Same |
| `next` | `/api/v1/repositories` is read from `tracker.repository` config — single static value. Should also derive distinct repos from issue URLs / `branch_name` when multi-repo workflows ship. | `src/server/http.ts:78-87` |
| `next` | Static-export mount has no `Cache-Control` headers — wasteful when fronted by Cloudflare Tunnel later. | `src/server/http.ts:55-61` |
| `next` | No `GET /api/v1/version` — UI shows no daemon version, no "out of date" detection across rebuilds. | New trivial route returning `package.json#version` |
| `next` | Dispatch reason mapping uses `startsWith("issue not found")` to pick 404 vs 409 — fragile string match. Should return a structured `{code: "not_found_in_active_states"}` from `requestImmediateDispatch`. | `src/orchestrator/orchestrator.ts:184-220`, `src/server/http.ts:111-130` |
| `wave-2` | No SSE/WebSocket. Polling only. The observer pattern at `orchestrator.ts:176` is the wiring point. | Defer until Wave 2.3 hosting decision |
| `wave-2` | `/api/v1/<id>` only returns running/retrying entries — completed/idle issues 404. UI can't show their detail. | `src/server/http.ts:149-220` |

---

## 6. Security & hosting (Wave 2.3-aligned)

| Severity | Gap |
|---|---|
| `wave-2` | **Dispatch endpoint is unauthenticated.** Documented in CLAUDE.md. Stop-gap before Wave 2.3: gate behind a `SYMPHONY_DISPATCH_TOKEN` shared-secret header. |
| `wave-2` | No CSRF protection on POST endpoints. Same-origin in prod helps but not bulletproof. |
| `wave-2` | CORS allows only `localhost:3000`. Won't work if the web is run on a different port for any reason. |
| `wave-2` | No rate limiting on `/api/v1/dispatch` — could be abused as a Linear-poll amplifier. |
| `wave-2` | The static export from Hono leaks build metadata (`/_next/...` hashes). Acceptable for an internal tool. |
| `wave-2` | Cloudflare Tunnel + Access routing for `/api/v1/dispatch` vs `/api/v1/state` is undefined — dispatch should require Access; state could be public-with-secret. |

---

## 7. Performance & scale

| Severity | Issue |
|---|---|
| `next` | Polling at 5s for both `state` AND `issues`. The orchestrator tick is 30s by default — `issues` could safely be 30s while `state` stays at 5s. |
| `next` | `buildAgentCards` runs on every poll; no memoization. Fine at <100 cards, will jank above. |
| `next` | `Date.now() - Date.parse(running.started_at)` recomputes on every render — durations don't tick (need a 1s timer to update). |
| `wave-2` | Initial bundle is heavy: two Geist font variants, all of Phosphor icons (despite `optimizePackageImports`), full Tailwind 4 prelude. Could trim ~200 KB. |
| `wave-2` | No service worker → no offline UX. Probably not needed for this product. |

---

## 8. ROADMAP wave touchpoints

How the kanban evolves as ROADMAP waves land.

| Wave | Kanban impact |
|---|---|
| **1.1 SQLite persistence** | New `interrupted` lifecycle state. UI needs a column or badge. Restart no longer loses board state. |
| **1.2 Startup recovery** | Show interrupted cards distinctly with a "resume" button → calls `requestImmediateDispatch`. |
| **1.3 Event-shape coverage** | Once `turn_ended_with_error` and `approval_auto_approved` are emitted, the future per-card event log can render them. |
| **2.1 Slack** | Per-card link to the Slack thread for that dispatch (new field on `RunningEntry`: `slack_thread_url`). |
| **2.3 Cloudflare Access** | Auth boundary lands here. Onboarding flow re-enabled. CORS becomes vestigial. |
| **2.4 `/healthz`** | Surface daemon health in header (uptime, last-poll-age, last tracker error). |
| **3.1 Validation gate** | Card needs a "validation pending / passed / failed" state — probably as a pill below the lifecycle badge. |
| **3.2 Plan-then-execute** | Card body should render the markdown checklist on a tap-to-expand interaction. |
| **3.4 Linear UX polish** | PR URL field finally non-null (Wave 0.6 + 3.4 combo). Card grows a "View PR" link. |

---

## 9. Dev / CI

| Severity | Gap |
|---|---|
| `next` | No Playwright E2E tests in CI. Today verified manually via claude-in-chrome. |
| `next` | No `web/CHANGELOG` or version tracking. |
| `next` | `pnpm build:all` doesn't run `pnpm typecheck:all` — easy to ship a typed regression. |
| `next` | Web `lint` task isn't enforced anywhere; no pre-commit hook. |
| `next` | `pnpm test` doesn't cover the static-mount fallback (tested manually with `mv web/out web/out.bak`). |
| `next` | No screenshot test of the kanban — visual regressions land silently. |

---

## 10. Explicit out-of-scope (won't ship)

- **SSH worker** — per `SPEC.md` scope decision.
- **Multi-user auth** — single-user product per ROADMAP "Out of scope".
- **Drag-to-reorder columns or cards** — Linear state machine is authoritative.
- **Editing issues from the kanban** — Linear is source of truth.
- **Generic webhook system** — explicitly excluded.
- **Built-in metrics stack** — explicitly excluded; rely on launchd logs + heartbeat.

---

## Suggested fix-now PR

Bundle the small items into one ~30 min PR:

1. Disable `Dispatch` button when `lifecycle === "completed"`.
2. Fix the first-card CSS glitch.
3. Add `cp web/.env.local.example web/.env.local` to CLAUDE.md.
4. Add `?limit=` and a 5s LRU cache to `/api/v1/issues`.
5. Add `app.get("/api/v1/version", ...)` returning `package.json#version`.
6. Move `SYMPHONY_DEV_CORS` check inside the middleware so it's reload-friendly.
7. Light dark-mode toggle in the header.
