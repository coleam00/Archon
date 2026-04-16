/**
 * Anonymous PostHog telemetry for Archon.
 *
 * Emits one event — `workflow_invoked` — each time a workflow starts. No PII,
 * no user identity. A random UUID is persisted to `${ARCHON_HOME}/telemetry-id`
 * so we can count distinct installs; `$process_person_profile: false` keeps
 * events in PostHog's anonymous tier (no person profile ever created).
 *
 * Opt-out (any one disables telemetry):
 *   - ARCHON_TELEMETRY_DISABLED=1
 *   - DO_NOT_TRACK=1                   (de facto standard)
 *   - POSTHOG_API_KEY unset *and* no embedded default
 *
 * All functions are fire-and-forget: telemetry errors are logged at debug level
 * and swallowed. Capture must never crash Archon.
 */
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { PostHog } from 'posthog-node';
import { getArchonHome } from './archon-paths';
import { createLogger } from './logger';

/**
 * Embedded write-only PostHog project key. Safe to ship in source: `phc_*`
 * keys can only write events, never read data. Override with POSTHOG_API_KEY
 * for self-hosted PostHog or a different project.
 */
const EMBEDDED_POSTHOG_API_KEY = 'phc_rR7oacut9mm4upGRbuoMptnyjRium34TTbbqobiQYS7x';
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/** Max length of workflow description sent to PostHog. Guards against unusually long YAML descriptions. */
const DESCRIPTION_MAX_LENGTH = 500;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('telemetry');
  return cachedLog;
}

function getApiKey(): string {
  return process.env.POSTHOG_API_KEY ?? EMBEDDED_POSTHOG_API_KEY;
}

function getHost(): string {
  return process.env.POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST;
}

/**
 * Check whether telemetry is disabled via env vars or missing key.
 * Exported for tests and callers that want to short-circuit early.
 */
export function isTelemetryDisabled(): boolean {
  if (process.env.ARCHON_TELEMETRY_DISABLED === '1') return true;
  if (process.env.DO_NOT_TRACK === '1') return true;
  if (!getApiKey()) return true;
  return false;
}

/**
 * Load or create a stable anonymous install UUID at `${ARCHON_HOME}/telemetry-id`.
 * If the file can't be read or written (permissions, disk full), a fresh UUID
 * is returned for this session — telemetry still works, just not correlated
 * across runs.
 */
function getOrCreateTelemetryId(): string {
  const idPath = join(getArchonHome(), 'telemetry-id');
  try {
    if (existsSync(idPath)) {
      const existing = readFileSync(idPath, 'utf8').trim();
      if (existing) return existing;
    }
  } catch (error) {
    getLog().debug({ err: error as Error, idPath }, 'telemetry.id_read_failed');
  }

  const id = randomUUID();
  try {
    mkdirSync(getArchonHome(), { recursive: true });
    writeFileSync(idPath, id, 'utf8');
  } catch (error) {
    getLog().debug({ err: error as Error, idPath }, 'telemetry.id_persist_failed');
  }
  return id;
}

let telemetryIdCache: string | undefined;
function getTelemetryId(): string {
  if (!telemetryIdCache) telemetryIdCache = getOrCreateTelemetryId();
  return telemetryIdCache;
}

/**
 * Lazy singleton. `undefined` = not yet initialized; `null` = disabled or
 * init failed; `PostHog` = live client. Init runs once per process.
 */
let clientInit: Promise<PostHog | null> | undefined;

async function getClient(): Promise<PostHog | null> {
  if (clientInit === undefined) {
    clientInit = initClient();
  }
  return clientInit;
}

async function initClient(): Promise<PostHog | null> {
  if (isTelemetryDisabled()) return null;
  try {
    const posthogModule = await import('posthog-node');
    const client = new posthogModule.PostHog(getApiKey(), {
      host: getHost(),
      flushAt: 20,
      flushInterval: 10000,
      disableGeoip: true,
    });
    // Swallow PostHog errors — network issues must never surface to the user.
    client.on('error', (err: Error) => {
      getLog().debug({ err }, 'telemetry.client_error');
    });
    return client;
  } catch (error) {
    getLog().debug({ err: error as Error }, 'telemetry.init_failed');
    return null;
  }
}

export interface WorkflowInvokedProperties {
  workflowName: string;
  workflowDescription?: string;
  platform?: string;
  archonVersion?: string;
}

/**
 * Fire-and-forget capture of a `workflow_invoked` event. Never throws, never
 * awaits — safe to call from hot paths.
 */
export function captureWorkflowInvoked(props: WorkflowInvokedProperties): void {
  if (isTelemetryDisabled()) return;
  void (async (): Promise<void> => {
    try {
      const client = await getClient();
      if (!client) return;
      const description = props.workflowDescription?.slice(0, DESCRIPTION_MAX_LENGTH);
      client.capture({
        distinctId: getTelemetryId(),
        event: 'workflow_invoked',
        properties: {
          $process_person_profile: false,
          workflow_name: props.workflowName,
          ...(description ? { workflow_description: description } : {}),
          ...(props.platform ? { platform: props.platform } : {}),
          ...(props.archonVersion ? { archon_version: props.archonVersion } : {}),
        },
      });
    } catch (error) {
      getLog().debug({ err: error as Error }, 'telemetry.capture_failed');
    }
  })();
}

/**
 * Flush queued events and close the PostHog client. Call on process exit
 * (server SIGTERM, end of CLI command) so buffered events aren't lost.
 * Safe to call when telemetry was never initialized.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (clientInit === undefined) return;
  try {
    const client = await clientInit;
    if (client) {
      await client.shutdown();
    }
  } catch (error) {
    getLog().debug({ err: error as Error }, 'telemetry.shutdown_failed');
  } finally {
    clientInit = undefined;
  }
}

/**
 * Reset internal state for tests. Not part of the public API.
 * @internal
 */
export function resetTelemetryForTests(): void {
  clientInit = undefined;
  telemetryIdCache = undefined;
}
