import { dirname, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getLogger, setLogLevel } from "./logging/logger.js";
import { startWorkflowWatcher } from "./workflow/watch.js";
import { validateDispatchConfig } from "./config/validate.js";
import { createLinearTrackerFromConfig } from "./tracker/linear.js";
import { createWorkspaceManager } from "./workspace/manager.js";
import { createAgentClient } from "./agent/factory.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { startHttpServer, type RunningHttpServer } from "./server/http.js";
import { publishPullRequest } from "./publisher/pr.js";
import type { ConfigSnapshot } from "./config/snapshot.js";

export interface ServiceOptions {
  workflowPath: string;
  port?: number | null;
  logLevel?: string;
}

export interface RunningService {
  stop(): Promise<void>;
}

/**
 * Locate the Next static export directory. Tries the dev path first
 * (src/service.ts → ../web/out), then the built path (dist/src/service.js
 * → ../../web/out), then cwd/web/out. Returns null when none exist —
 * the HTTP server then falls back to the legacy dashboard string.
 */
function resolveWebRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "web", "out"),
    resolve(here, "..", "..", "web", "out"),
    resolve(process.cwd(), "web", "out"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export async function startService(opts: ServiceOptions): Promise<RunningService> {
  if (opts.logLevel) setLogLevel(opts.logLevel);
  const logger = getLogger();

  const workflowAbs = resolve(opts.workflowPath);
  try {
    await stat(workflowAbs);
  } catch {
    throw new Error(`workflow file not found: ${workflowAbs}`);
  }

  const watcher = await startWorkflowWatcher(workflowAbs, {
    onReload: (snap) => {
      logger.info({ workflow: snap.workflow_path }, "workflow_reloaded");
    },
    onError: (err) => {
      logger.error({ err: err.message }, "workflow_reload_error");
    },
  });

  const initialSnapshot = watcher.current();
  const validation = validateDispatchConfig(initialSnapshot);
  if (!validation.ok) {
    await watcher.close();
    throw new Error(`workflow validation failed: ${validation.code}: ${validation.message}`);
  }

  // Tracker is rebuilt from current snapshot on each access via a thin wrapper
  // so reload-applied tracker config (api_key, slug) is honored.
  let trackerCache: { snap: ConfigSnapshot; tracker: ReturnType<typeof createLinearTrackerFromConfig> } | null =
    null;
  const getTracker = () => {
    const snap = watcher.current();
    if (!trackerCache || trackerCache.snap !== snap) {
      trackerCache = { snap, tracker: createLinearTrackerFromConfig(snap) };
    }
    return trackerCache.tracker;
  };

  const workspaces = createWorkspaceManager({
    getSnapshot: () => watcher.current(),
    logHookResult: (name, identifier, res) => {
      const log = logger.child({ issue_identifier: identifier });
      if (res.ok) {
        log.debug({ hook: name, ms: res.durationMs }, "hook_completed");
      } else {
        log.warn(
          {
            hook: name,
            ms: res.durationMs,
            timed_out: res.timedOut,
            exit: res.exitCode,
            err: res.error,
            stderr: res.stderr.slice(0, 400),
          },
          "hook_failed",
        );
      }
    },
  });

  const agent = await createAgentClient(initialSnapshot, logger);

  // Tracker proxy that re-resolves per call so the orchestrator always uses fresh config.
  const trackerProxy = {
    fetchCandidateIssues: () => getTracker().fetchCandidateIssues(),
    fetchIssueStatesByIds: (ids: string[]) => getTracker().fetchIssueStatesByIds(ids),
    fetchIssuesByStates: (states: string[]) => getTracker().fetchIssuesByStates(states),
    createIssue: (input: Parameters<NonNullable<ReturnType<typeof getTracker>["createIssue"]>>[0]) => {
      const t = getTracker();
      if (typeof t.createIssue !== "function") {
        throw new Error("tracker does not support createIssue");
      }
      return t.createIssue(input);
    },
    commentOnIssue: (input: Parameters<NonNullable<ReturnType<typeof getTracker>["commentOnIssue"]>>[0]) => {
      const t = getTracker();
      if (typeof t.commentOnIssue !== "function") {
        throw new Error("tracker does not support commentOnIssue");
      }
      return t.commentOnIssue(input);
    },
  };

  const orchestrator = new Orchestrator({
    getSnapshot: () => watcher.current(),
    tracker: trackerProxy,
    agent,
    workspaces,
    logger,
    publishPullRequest,
  });

  await orchestrator.startupCleanup();
  orchestrator.start();

  let httpServer: RunningHttpServer | null = null;
  const httpPort = opts.port ?? initialSnapshot.server.port;
  if (typeof httpPort === "number") {
    httpServer = await startHttpServer({
      orchestrator,
      tracker: trackerProxy,
      getSnapshot: () => watcher.current(),
      logger,
      port: httpPort,
      host: initialSnapshot.server.bind_host,
      webRoot: resolveWebRoot(),
    });
  }

  logger.info({ workflow: initialSnapshot.workflow_path }, "service_started");

  return {
    async stop() {
      logger.info({}, "service_stopping");
      try {
        await orchestrator.stop();
      } catch (e) {
        logger.warn({ err: (e as Error).message }, "orchestrator_stop_failed");
      }
      try {
        await watcher.close();
      } catch (e) {
        logger.warn({ err: (e as Error).message }, "watcher_close_failed");
      }
      if (httpServer) {
        try {
          await httpServer.close();
        } catch (e) {
          logger.warn({ err: (e as Error).message }, "http_server_close_failed");
        }
      }
      logger.info({}, "service_stopped");
    },
  };
}
