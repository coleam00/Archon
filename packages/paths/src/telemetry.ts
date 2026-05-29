/**
 * Anonymous PostHog telemetry for Archon.
 *
 * Emits one event — `workflow_invoked` — each time a workflow starts. No PII,
 * no user identity. A random UUID is persisted to `${ARCHON_HOME}/telemetry-id`
 * so we can count distinct installs; `$process_person_profile: false` keeps
 * events in PostHog's anonymous tier (no person profile ever created); `$ip: ''`
 * prevents PostHog from retaining the source IP at ingest.
 *
 * Opt-out (any one disables telemetry):
 *   - ARCHON_TELEMETRY_DISABLED=1
 *   - DO_NOT_TRACK=1                          (de facto standard)
 *   - CI=true                                 (auto-disabled in CI environments)
 *   - POSTHOG_API_KEY=off | 0 | false | disabled | '' (or whitespace-only)
 *
 * All capture functions are fire-and-forget: telemetry errors are swallowed
 * (logged at `debug`, with the first network failure on a custom POSTHOG_HOST
 * also logged at `warn` so self-hosters notice typo'd hosts). Capture must
 * never crash Archon.
 */
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { PostHog } from 'posthog-node';
import { getArchonHome } from './archon-paths';
import { createLogger } from './logger';

// Minimal shape of posthog-node's `fetch` option — copied from @posthog/core
// (a transitive dep) to avoid pulling it in as a direct dependency.
interface PostHogFetchOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  mode?: 'no-cors';
  credentials?: 'omit';
  headers: Record<string, string>;
  body?: string | Blob;
  signal?: AbortSignal;
}
interface PostHogFetchResponse {
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
  headers?: { get(name: string): string | null };
}

/**
 * Embedded write-only PostHog project key. Safe to ship in source: `phc_*`
 * keys can only write events, never read data. Override with POSTHOG_API_KEY
 * for self-hosted PostHog or a different project, or set it to `off` / `0` /
 * `false` / `disabled` / empty string to opt out entirely.
 */
const EMBEDDED_POSTHOG_API_KEY = 'phc_rR7oacut9mm4upGRbuoMptnyjRium34TTbbqobiQYS7x';
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/**
 * Filename for the one-time notice stamp written to ARCHON_HOME. Presence
 * means the first-run notice has been shown; absence means it hasn't.
 */
const NOTICE_STAMP_FILENAME = 'telemetry-notice-shown';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('telemetry');
  return cachedLog;
}

/** Values of POSTHOG_API_KEY that are interpreted as "explicitly disabled". */
const KEY_OFF_VALUES = new Set(['', 'off', '0', 'false', 'disabled']);

/**
 * Resolve the effective PostHog API key.
 *
 * - Unset env var → embedded default
 * - Env var set to a recognized "off" sentinel → `null` (caller treats as opt-out)
 * - Env var set to anything else → that value (self-hosted / alternate project)
 */
function getApiKey(): string | null {
  const env = process.env.POSTHOG_API_KEY;
  if (env === undefined) return EMBEDDED_POSTHOG_API_KEY;
  const trimmed = env.trim();
  if (KEY_OFF_VALUES.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

function getHost(): string {
  return process.env.POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST;
}

/** Why telemetry is currently disabled. `null` means it's enabled. */
export type TelemetryDisabledReason =
  | 'ARCHON_TELEMETRY_DISABLED'
  | 'DO_NOT_TRACK'
  | 'CI'
  | 'POSTHOG_API_KEY';

interface TelemetryStatusBase {
  /** Stable anonymous install UUID (always populated, even when disabled). */
  distinctId: string;
  /** PostHog ingest host. */
  host: string;
}

/**
 * Full current telemetry state. Discriminated on `enabled` so an enabled status
 * can never carry a `disabledReason` (and vice versa), and so `keySource: 'none'`
 * is only representable in the disabled arm.
 */
export type TelemetryStatus =
  | (TelemetryStatusBase & {
      enabled: true;
      disabledReason: null;
      /** Whether the active API key is the embedded default or a user override. */
      keySource: 'embedded' | 'env';
    })
  | (TelemetryStatusBase & {
      enabled: false;
      disabledReason: TelemetryDisabledReason;
      /** `'none'` means POSTHOG_API_KEY was set to an opt-out value. */
      keySource: 'embedded' | 'env' | 'none';
    });

/**
 * Decide whether telemetry is disabled, and if so, why. The order here is
 * also the precedence order: the first matching reason wins.
 */
function resolveDisabledReason(): TelemetryDisabledReason | null {
  if (process.env.ARCHON_TELEMETRY_DISABLED === '1') return 'ARCHON_TELEMETRY_DISABLED';
  if (process.env.DO_NOT_TRACK === '1') return 'DO_NOT_TRACK';
  // Standard CI env var set by GitHub Actions, CircleCI, GitLab CI, Travis,
  // Buildkite, etc. Forks running fixtures in CI shouldn't pollute telemetry.
  // Matched case-insensitively because AppVeyor sets `CI=True`; `CI=1` is left
  // alone (rare, and we keep the match narrow to "true").
  if (process.env.CI?.toLowerCase() === 'true') return 'CI';
  if (getApiKey() === null) return 'POSTHOG_API_KEY';
  return null;
}

/**
 * Check whether telemetry is disabled via env vars or missing/disabled key.
 * Kept for backwards compatibility; new callers should prefer
 * {@link getTelemetryStatus} for richer information.
 */
export function isTelemetryDisabled(): boolean {
  return resolveDisabledReason() !== null;
}

/**
 * Return the full current telemetry state — enabled/disabled, reason,
 * distinct ID, host, and key source. Used by `archon telemetry status` and
 * `archon doctor` to surface what's happening without duplicating logic.
 */
export function getTelemetryStatus(): TelemetryStatus {
  const reason = resolveDisabledReason();
  const host = getHost();
  const envKeySet = process.env.POSTHOG_API_KEY !== undefined;
  if (reason === null) {
    // Enabled: a usable key exists, so keySource is embedded or env (never none).
    return {
      enabled: true,
      disabledReason: null,
      distinctId: getTelemetryId(),
      host,
      keySource: envKeySet ? 'env' : 'embedded',
    };
  }
  // Disabled: read the install UUID without creating it, so inspecting status
  // while opted out never materializes a telemetry-id file the user didn't ask for.
  const keySource: 'embedded' | 'env' | 'none' =
    getApiKey() === null ? 'none' : envKeySet ? 'env' : 'embedded';
  return {
    enabled: false,
    disabledReason: reason,
    distinctId: peekTelemetryId(),
    host,
    keySource,
  };
}

/**
 * Load or create a stable anonymous install UUID at `${ARCHON_HOME}/telemetry-id`.
 * If the file can't be read or written (permissions, disk full), a fresh UUID
 * is returned for this session — telemetry still works, just not correlated
 * across runs.
 *
 * Exported so tests can exercise the id-resolution invariants directly
 * without spinning up the PostHog client.
 * @internal
 */
export function getOrCreateTelemetryId(): string {
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
 * Read the persisted install UUID without creating it. Returns a fresh,
 * unpersisted UUID when none exists yet. Used for status display while
 * telemetry is disabled, so inspecting state (`telemetry status` / `doctor`)
 * never writes a `telemetry-id` file for an opted-out user.
 */
function peekTelemetryId(): string {
  const idPath = join(getArchonHome(), 'telemetry-id');
  try {
    if (existsSync(idPath)) {
      const existing = readFileSync(idPath, 'utf8').trim();
      if (existing) return existing;
    }
  } catch (error) {
    getLog().debug({ err: error as Error, idPath }, 'telemetry.id_read_failed');
  }
  return randomUUID();
}

/**
 * Force-rotate the persisted install UUID. Returns the new ID. Used by
 * `archon telemetry reset`. Caller is responsible for any UX around it.
 *
 * Unlike the other functions here, this is NOT fire-and-forget: it is a
 * deliberate, user-initiated write, so filesystem errors propagate.
 * @throws {NodeJS.ErrnoException} if ARCHON_HOME can't be created or the id
 *   file can't be written (e.g. EACCES, ENOSPC). The CLI caller
 *   (`telemetryResetCommand`) catches this and exits non-zero.
 */
export function resetTelemetryId(): string {
  const idPath = join(getArchonHome(), 'telemetry-id');
  const newId = randomUUID();
  mkdirSync(getArchonHome(), { recursive: true });
  writeFileSync(idPath, newId, 'utf8');
  telemetryIdCache = newId;
  return newId;
}

/**
 * Show a one-time stderr notice that telemetry is collected, then stamp the
 * notice file so we don't show it again. Skipped when:
 *   - telemetry is disabled (no point notifying about a no-op)
 *   - the stamp file already exists
 *   - stderr is not a TTY (avoid polluting scripted / piped output)
 *
 * Idempotent in-process via `noticeChecked` so the worst case is one stat()
 * per process, not one per workflow.
 */
let noticeChecked = false;
function maybeShowFirstRunNotice(): void {
  if (noticeChecked) return;
  noticeChecked = true;

  // Self-contained guards so the function is safe for any caller, not just
  // captureWorkflowInvoked: never notify about telemetry that won't be sent,
  // and never pollute scripted / piped output.
  if (isTelemetryDisabled()) return;
  if (!process.stderr.isTTY) return;

  const stampPath = join(getArchonHome(), NOTICE_STAMP_FILENAME);
  try {
    if (existsSync(stampPath)) return;
  } catch (error) {
    getLog().debug({ err: error as Error, stampPath }, 'telemetry.notice_stat_failed');
    return;
  }

  const message =
    'Archon collects anonymous usage telemetry (workflow name, platform, version).\n' +
    'No code, prompts, file paths, or personal data — see README "Telemetry" for details.\n' +
    'Opt out anytime: DO_NOT_TRACK=1 or ARCHON_TELEMETRY_DISABLED=1\n';
  try {
    process.stderr.write(`\n${message}\n`);
  } catch (error) {
    getLog().debug({ err: error as Error }, 'telemetry.notice_write_failed');
  }

  try {
    mkdirSync(getArchonHome(), { recursive: true });
    writeFileSync(stampPath, new Date().toISOString(), 'utf8');
  } catch (error) {
    // Failure here means we'll re-show the notice on the next process run (the
    // in-process `noticeChecked` guard still prevents a repeat this run);
    // annoying but not broken. Log so repeat failures leave a diagnostic trace.
    getLog().debug({ err: error as Error, stampPath }, 'telemetry.notice_stamp_failed');
  }
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

/**
 * Fetch wrapper that masks all failures as 200 responses. The PostHog SDK's
 * internal `logFlushError` writes to stderr via `console.error` on any network
 * or HTTP error, bypassing logger configuration (see `@posthog/core`
 * `posthog-core-stateless.mjs` `logFlushError`). For a fire-and-forget
 * telemetry path we want no user-visible noise on the default host when
 * PostHog is unreachable (offline, firewalled, DNS broken, rate-limited), so
 * we intercept failures before the SDK sees them.
 *
 * Self-hosters who override POSTHOG_HOST need *some* feedback when they typo a
 * URL, so on a custom host the first failure in a process is logged at `warn`
 * (visible at default log levels) and subsequent failures drop to `debug`.
 * On the default host every failure stays at `debug`.
 */
const FAKE_OK_RESPONSE: PostHogFetchResponse = {
  status: 200,
  text: () => Promise.resolve('{"status":"ok"}'),
  json: () => Promise.resolve({ status: 'ok' }),
  headers: { get: () => null },
};

let firstFailureLogged = false;
function logFetchFailure(ctx: { status?: number; err?: Error }, event: string): void {
  // Only self-hosters (POSTHOG_HOST overridden) get a visible warning about a
  // typo'd host. Default-host users who are simply offline/firewalled stay at
  // `debug`, per the "no user-visible noise on the default host" goal above.
  if (process.env.POSTHOG_HOST !== undefined && !firstFailureLogged) {
    firstFailureLogged = true;
    getLog().warn(
      { ...ctx, host: getHost() },
      `${event} (first failure shown; subsequent suppressed to debug)`
    );
    return;
  }
  getLog().debug(ctx, event);
}

async function silentFetch(
  url: string,
  options: PostHogFetchOptions
): Promise<PostHogFetchResponse> {
  try {
    const res = await fetch(url, options as RequestInit);
    if (res.status < 200 || res.status >= 400) {
      logFetchFailure({ status: res.status }, 'telemetry.http_non_2xx_suppressed');
      return FAKE_OK_RESPONSE;
    }
    return res;
  } catch (error) {
    logFetchFailure({ err: error as Error }, 'telemetry.fetch_failed_suppressed');
    return FAKE_OK_RESPONSE;
  }
}

async function initClient(): Promise<PostHog | null> {
  if (isTelemetryDisabled()) return null;
  const apiKey = getApiKey();
  if (apiKey === null) return null;
  try {
    const posthogModule = await import('posthog-node');
    const client = new posthogModule.PostHog(apiKey, {
      host: getHost(),
      flushAt: 20,
      flushInterval: 10000,
      disableGeoip: true,
      fetch: silentFetch,
    });
    // Defensive: also hook the client-level error channel in case a future
    // posthog-node version routes errors there instead of (or in addition to)
    // the internal console.error path.
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
  platform?: string;
  archonVersion?: string;
}

/**
 * Fire-and-forget capture of a `workflow_invoked` event. Never throws, never
 * awaits — safe to call from hot paths. Shows the first-run notice on first
 * invocation when telemetry is enabled and stderr is interactive.
 */
export function captureWorkflowInvoked(props: WorkflowInvokedProperties): void {
  if (isTelemetryDisabled()) return;
  maybeShowFirstRunNotice();
  void (async (): Promise<void> => {
    try {
      const client = await getClient();
      if (!client) return;
      client.capture({
        distinctId: getTelemetryId(),
        event: 'workflow_invoked',
        properties: {
          $process_person_profile: false,
          // Strip source IP at ingest. `disableGeoip: true` only prevents geo
          // enrichment; `$ip: ''` drops the IP from the event entirely.
          $ip: '',
          workflow_name: props.workflowName,
          ...(props.platform ? { platform: props.platform } : {}),
          ...(props.archonVersion ? { archon_version: props.archonVersion } : {}),
        },
      });
    } catch (error) {
      // Fire-and-forget: telemetry must never crash Archon, so swallow every
      // error here (network, SDK, malformed props) and record it at debug.
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
  noticeChecked = false;
  firstFailureLogged = false;
}
