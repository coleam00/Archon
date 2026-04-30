import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getArchonHome } from '@archon/paths';
import { createLogger } from '@archon/paths';
import { getDatabase } from '@archon/core/db';
import { parseSymphonyConfig } from './config/parse';
import { buildSnapshot, type ConfigSnapshot, type TrackerConfig } from './config/snapshot';
import { LinearTracker } from './tracker/linear';
import { GitHubTracker } from './tracker/github';
import type { Tracker } from './tracker/types';
import { Orchestrator, type TrackerMap } from './orchestrator/orchestrator';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('symphony.service');
  return cachedLog;
}

export interface StartSymphonyServiceOptions {
  /**
   * Absolute path to a symphony YAML config. If omitted, defaults to
   * `${ARCHON_HOME}/symphony.yaml`.
   */
  configPath?: string;
  /** Override env (used by tests). */
  env?: NodeJS.ProcessEnv;
}

export interface SymphonyServiceHandle {
  orchestrator: Orchestrator;
  snapshot: ConfigSnapshot;
  configPath: string;
  stop: () => Promise<void>;
}

function defaultConfigPath(): string {
  return join(getArchonHome(), 'symphony.yaml');
}

function buildTrackers(snapshot: ConfigSnapshot): TrackerMap {
  const out: TrackerMap = {};
  for (const cfg of snapshot.trackers) {
    out[cfg.kind] = buildTracker(cfg);
  }
  return out;
}

function buildTracker(cfg: TrackerConfig): Tracker {
  if (cfg.kind === 'linear') {
    return new LinearTracker({
      apiKey: cfg.apiKey,
      endpoint: cfg.endpoint,
      projectSlug: cfg.projectSlug,
      activeStates: cfg.activeStates,
      terminalStates: cfg.terminalStates,
    });
  }
  return new GitHubTracker({
    owner: cfg.owner,
    repo: cfg.repo,
    token: cfg.token,
    activeStates: cfg.activeStates,
    terminalStates: cfg.terminalStates,
  });
}

/**
 * Boot the Symphony orchestrator: load config, build trackers, instantiate
 * the orchestrator, start the polling loop. Returns a handle exposing the
 * orchestrator and a stop() that aborts in-flight work and clears timers.
 *
 * Phase 2 caveat: this does not start an HTTP server. Phase 3 wires the
 * service into Archon's existing server process.
 */
export async function startSymphonyService(
  opts: StartSymphonyServiceOptions = {}
): Promise<SymphonyServiceHandle> {
  const env = opts.env ?? process.env;
  const configPath = opts.configPath ?? defaultConfigPath();
  const log = getLog();

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === 'ENOENT') {
      throw new Error(
        `symphony config not found at ${configPath}. Copy packages/symphony/symphony.yaml.example to ~/.archon/symphony.yaml and edit.`
      );
    }
    throw err;
  }
  const parsed = parseSymphonyConfig(raw);
  const snapshot = buildSnapshot(parsed, env);

  const trackers = buildTrackers(snapshot);
  const orchestrator = new Orchestrator({
    getSnapshot: (): ConfigSnapshot => snapshot,
    trackers,
    getDb: (): ReturnType<typeof getDatabase> => getDatabase(),
  });

  log.info(
    {
      config_path: configPath,
      trackers: snapshot.trackers.map(t =>
        t.kind === 'linear'
          ? { kind: t.kind, projectSlug: t.projectSlug }
          : { kind: t.kind, owner: t.owner, repo: t.repo }
      ),
      polling_ms: snapshot.polling.intervalMs,
      max_concurrent: snapshot.dispatch.maxConcurrent,
      workflows: Object.keys(snapshot.stateWorkflowMap).length,
    },
    'symphony.service_started'
  );

  orchestrator.start();

  return {
    orchestrator,
    snapshot,
    configPath,
    stop: async (): Promise<void> => {
      await orchestrator.stop();
      log.info({ config_path: configPath }, 'symphony.service_stopped');
    },
  };
}
