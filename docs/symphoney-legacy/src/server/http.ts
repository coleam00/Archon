import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Logger } from "pino";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { Tracker } from "../tracker/types.js";
import type { ConfigSnapshot } from "../config/snapshot.js";
import { renderDashboard } from "./dashboard.js";
import { serializeIssue } from "./issue-helpers.js";

// Walk up from this file looking for the symphony package.json. Symmetric across
// `src/server/http.ts` (source) and `dist/src/server/http.js` (built).
function readSymphonyVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    try {
      const pkg = JSON.parse(
        readFileSync(resolve(dir, "package.json"), "utf8"),
      ) as { name?: string; version?: string };
      if (pkg.name === "symphony" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // continue walking
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}
const SYMPHONY_VERSION = readSymphonyVersion();
const SYMPHONY_STARTED_AT = new Date().toISOString();

interface IssuesCacheEntry {
  at: number;
  body: string;
}
const ISSUES_CACHE_TTL_MS = 5_000;
const ISSUES_CACHE_MAX_ENTRIES = 32;

export interface HttpServerDeps {
  orchestrator: Orchestrator;
  tracker: Tracker;
  getSnapshot: () => ConfigSnapshot;
  logger: Logger;
  port: number;
  host?: string;
  /** Absolute path to a directory of static files to serve at /. Optional. */
  webRoot?: string | null;
}

export interface CreateAppDeps {
  orchestrator: Orchestrator;
  tracker: Tracker;
  getSnapshot: () => ConfigSnapshot;
  logger: Logger;
  webRoot?: string | null;
}

export interface RunningHttpServer {
  port: number;
  host: string;
  close(): Promise<void>;
}

function errorEnvelope(code: string, message: string) {
  return { error: { code, message } };
}

export function createApp(deps: CreateAppDeps): Hono {
  const app = new Hono();
  // CORS isn't wired here: in dev, web/next.config.ts proxies /api/* to the
  // daemon (same-origin from the browser); in prod, Hono serves both web/out/
  // and /api/* itself. If you ever need cross-origin access (e.g. running
  // the web on a different host), add CORS back behind an explicit env gate.

  // Serve the Next static export at GET / (and any non-/api path it owns) when
  // it's present on disk. Registered BEFORE /api/v1/* so the API still wins on
  // its prefix; serveStatic only matches when the file exists. Falls through
  // to the legacy dashboard string handler below when web/out is missing.
  const webRootEnabled = !!(deps.webRoot && existsSync(deps.webRoot));
  if (webRootEnabled && deps.webRoot) {
    const root = deps.webRoot;
    app.use("/*", async (c, next) => {
      // Don't let serveStatic intercept API calls.
      if (c.req.path.startsWith("/api/")) return next();
      return serveStatic({ root })(c, next);
    });
  }

  app.get("/", (c) => {
    const snap = deps.orchestrator.getSnapshot();
    return c.html(renderDashboard(snap));
  });

  app.get("/api/v1/state", (c) => {
    return c.json(deps.orchestrator.getSnapshot());
  });

  app.get("/api/v1/version", (c) =>
    c.json({ version: SYMPHONY_VERSION, started_at: SYMPHONY_STARTED_AT }),
  );

  const issuesCache = new Map<string, IssuesCacheEntry>();
  app.get("/api/v1/issues", async (c) => {
    const cfg = deps.getSnapshot();
    const allowed = new Set(
      [...cfg.tracker.active_states, ...cfg.tracker.terminal_states].map((s) =>
        s.toLowerCase(),
      ),
    );
    const statesParam = c.req.query("states");
    const requested = statesParam
      ? statesParam.split(",").map((s) => s.trim()).filter(Boolean)
      : [...cfg.tracker.active_states, ...cfg.tracker.terminal_states];
    const states = requested.filter((s) => allowed.has(s.toLowerCase()));

    let limit: number | null = null;
    const limitParam = c.req.query("limit");
    if (limitParam !== undefined) {
      const parsed = Number.parseInt(limitParam, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return c.json(
          errorEnvelope("bad_request", "limit must be a positive integer"),
          400,
        );
      }
      limit = Math.min(parsed, 500);
    }

    if (states.length === 0) {
      return c.json({ generated_at: new Date().toISOString(), issues: [] });
    }

    const cacheKey = `${[...states].sort().join(",")}|${limit ?? ""}`;
    const cached = issuesCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.at < ISSUES_CACHE_TTL_MS) {
      return c.body(cached.body, 200, { "content-type": "application/json" });
    }

    try {
      const issues = await deps.tracker.fetchIssuesByStates(states);
      const sliced = limit !== null ? issues.slice(0, limit) : issues;
      const payload = {
        generated_at: new Date().toISOString(),
        issues: sliced.map(serializeIssue),
      };
      const body = JSON.stringify(payload);
      issuesCache.set(cacheKey, { at: now, body });
      // Evict stale entries lazily; cap entry count.
      if (issuesCache.size > ISSUES_CACHE_MAX_ENTRIES) {
        for (const [key, entry] of issuesCache) {
          if (now - entry.at >= ISSUES_CACHE_TTL_MS) issuesCache.delete(key);
        }
      }
      return c.body(body, 200, { "content-type": "application/json" });
    } catch (e) {
      return c.json(
        errorEnvelope("tracker_fetch_failed", (e as Error).message),
        502,
      );
    }
  });

  app.post("/api/v1/issues", async (c) => {
    if (typeof deps.tracker.createIssue !== "function") {
      return c.json(
        errorEnvelope(
          "not_supported",
          "configured tracker does not support issue creation",
        ),
        501,
      );
    }
    let body: { title?: unknown; description?: unknown; priority?: unknown } = {};
    try {
      const text = await c.req.text();
      body = text.trim() ? JSON.parse(text) : {};
    } catch {
      return c.json(errorEnvelope("bad_request", "invalid JSON body"), 400);
    }
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      return c.json(
        errorEnvelope("bad_request", "title (string) is required"),
        400,
      );
    }
    const description =
      typeof body.description === "string" && body.description.trim()
        ? body.description
        : null;
    let priority: number | null = null;
    if (typeof body.priority === "number" && Number.isInteger(body.priority)) {
      if (body.priority < 0 || body.priority > 4) {
        return c.json(
          errorEnvelope("bad_request", "priority must be 0..4"),
          400,
        );
      }
      priority = body.priority;
    }
    try {
      const issue = await deps.tracker.createIssue({
        title,
        description,
        priority,
      });
      // Issues cache contains state-keyed entries from GET /api/v1/issues; clear
      // it so the next poll picks the new issue up immediately. Cheap — we
      // recompute on next request anyway.
      issuesCache.clear();
      return c.json({ issue: serializeIssue(issue) }, 201);
    } catch (e) {
      return c.json(
        errorEnvelope("tracker_create_failed", (e as Error).message),
        502,
      );
    }
  });

  app.get("/api/v1/repositories", (c) => {
    const cfg = deps.getSnapshot();
    const repo = cfg.tracker.repository;
    if (!repo) return c.json({ repositories: [] });
    return c.json({
      repositories: [
        { name: repo, url: `https://github.com/${repo}`, count: null },
      ],
    });
  });

  app.get("/api/v1/refresh", (c) =>
    c.json(errorEnvelope("method_not_allowed", "GET not supported on /api/v1/refresh"), 405),
  );

  app.post("/api/v1/dispatch", async (c) => {
    let body: { issue_identifier?: unknown } = {};
    try {
      const text = await c.req.text();
      body = text.trim() ? JSON.parse(text) : {};
    } catch {
      return c.json(errorEnvelope("bad_request", "invalid JSON body"), 400);
    }
    const identifier =
      typeof body.issue_identifier === "string" ? body.issue_identifier.trim() : "";
    if (!identifier) {
      return c.json(
        errorEnvelope("bad_request", "issue_identifier (string) is required"),
        400,
      );
    }
    const result = await deps.orchestrator.requestImmediateDispatch(identifier);
    if (!result.ok) {
      const status =
        result.code === "not_found_in_active_states"
          ? 404
          : result.code === "tracker_fetch_failed"
            ? 502
            : result.code === "stopped"
              ? 503
              : 409;
      return c.json(errorEnvelope(result.code, result.reason), status);
    }
    return c.json(
      {
        dispatched: true,
        issue_identifier: identifier,
        issue_id: result.issue_id,
      },
      202,
    );
  });

  app.get("/api/v1/dispatch", (c) =>
    c.json(errorEnvelope("method_not_allowed", "Use POST"), 405),
  );

  app.post("/api/v1/:identifier/cancel", (c) => {
    const identifier = c.req.param("identifier").trim();
    if (!identifier) {
      return c.json(errorEnvelope("bad_request", "identifier required"), 400);
    }
    const result = deps.orchestrator.requestCancel(identifier);
    if (!result.ok) {
      const status = result.code === "not_running" ? 404 : 503;
      return c.json(errorEnvelope(result.code, result.reason), status);
    }
    return c.json(
      { cancelled: true, issue_identifier: identifier, issue_id: result.issue_id },
      202,
    );
  });

  app.post("/api/v1/refresh", async (c) => {
    let body: unknown = null;
    try {
      const text = await c.req.text();
      body = text.trim() ? JSON.parse(text) : null;
    } catch {
      // ignore — body is optional and may be empty
      body = null;
    }
    const r = deps.orchestrator.requestRefresh();
    return c.json(
      {
        queued: true,
        coalesced: r.coalesced,
        requested_at: new Date().toISOString(),
        operations: ["poll", "reconcile"],
        body,
      },
      202,
    );
  });

  app.get("/api/v1/:identifier", (c) => {
    const ident = c.req.param("identifier");
    const internal = deps.orchestrator.internalState;

    let runEntry = null;
    for (const e of internal.running.values()) {
      if (e.identifier === ident) {
        runEntry = e;
        break;
      }
    }
    let retryEntry = null;
    for (const r of internal.retry_attempts.values()) {
      if (r.identifier === ident) {
        retryEntry = r;
        break;
      }
    }

    if (!runEntry && !retryEntry) {
      return c.json(errorEnvelope("not_found", `unknown issue identifier: ${ident}`), 404);
    }

    const status = runEntry ? "running" : "retrying";
    const issue_id =
      runEntry?.issue_id ?? retryEntry?.issue_id ?? null;
    const restartCount = retryEntry?.attempt ?? 0;
    return c.json({
      issue_identifier: ident,
      issue_id,
      status,
      workspace: { path: null },
      attempts: {
        restart_count: restartCount,
        current_retry_attempt: retryEntry?.attempt ?? null,
      },
      running: runEntry
        ? {
            session_id: runEntry.session_id,
            turn_count: runEntry.turn_count,
            state: runEntry.issue.state,
            started_at: new Date(runEntry.started_at).toISOString(),
            last_event: runEntry.last_codex_event,
            last_message: runEntry.last_codex_message,
            last_event_at: runEntry.last_codex_timestamp
              ? new Date(runEntry.last_codex_timestamp).toISOString()
              : null,
            tokens: {
              input_tokens: runEntry.codex_input_tokens,
              output_tokens: runEntry.codex_output_tokens,
              total_tokens: runEntry.codex_total_tokens,
            },
            publish_result: runEntry.publish_result,
          }
        : null,
      retry: retryEntry
        ? {
            attempt: retryEntry.attempt,
            due_at: new Date(retryEntry.due_at_ms).toISOString(),
            error: retryEntry.error,
          }
        : null,
      logs: { codex_session_logs: [] },
      recent_events: [],
      last_error: retryEntry?.error ?? null,
      tracked: {},
    });
  });

  // Method-not-allowed for unsupported methods on known paths.
  app.all("/api/v1/state", (c) =>
    c.json(errorEnvelope("method_not_allowed", "Use GET"), 405),
  );

  return app;
}

export async function startHttpServer(deps: HttpServerDeps): Promise<RunningHttpServer> {
  const app = createApp({
    orchestrator: deps.orchestrator,
    tracker: deps.tracker,
    getSnapshot: deps.getSnapshot,
    logger: deps.logger,
    webRoot: deps.webRoot,
  });
  const host = deps.host ?? "127.0.0.1";

  const server: ServerType = await new Promise((resolve) => {
    const s = serve(
      {
        fetch: app.fetch,
        hostname: host,
        port: deps.port,
      },
      () => {
        resolve(s);
      },
    );
  });

  const address = (server as unknown as { address: () => { port: number } | string | null }).address?.();
  let resolvedPort = deps.port;
  if (address && typeof address === "object" && "port" in address) {
    resolvedPort = address.port;
  }
  deps.logger.info(
    { host, port: resolvedPort },
    "http_server_started",
  );

  return {
    port: resolvedPort,
    host,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
