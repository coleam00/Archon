/**
 * Telemetry consent: whether capture is allowed, the anonymous install UUID it
 * reports as, and the one-time first-run notice.
 *
 * Any of these disables capture:
 * - ARCHON_TELEMETRY_DISABLED=1
 * - DO_NOT_TRACK=1
 * - CI=true
 * - POSTHOG_API_KEY=off | 0 | false | disabled | '' (or whitespace-only)
 */
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getArchonHome } from './home-paths';
import { createLogger } from './logger';

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
// Bumped to `-v2` when the captured property set expanded (machine context +
// run outcomes), to `-v3` when chat-turn activity, deployment shape, and
// registration counts were added, and to `-v4` when aggregate usage totals
// (tokens/cost/duration/loop iterations) and approval decisions were added, and
// to `-v5` when install channel and build commit were added, and to `-v6` when
// runs gained an anonymous per-run reference and cancellations were reported, and
// to `-v7` when workflow shape (node-type counts, depth, fan-out, command-reference
// count, prompt-size bucket) and bundled-workflow ancestry were added. Bumping re-shows the updated first-run notice once per install so existing
// users re-consent rather than silently getting broader capture.
export const NOTICE_STAMP_FILENAME = 'telemetry-notice-shown-v7';

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
export function getApiKey(): string | null {
  const env = process.env.POSTHOG_API_KEY;
  if (env === undefined) return EMBEDDED_POSTHOG_API_KEY;
  const trimmed = env.trim();
  if (KEY_OFF_VALUES.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

export function getHost(): string {
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
/** The install UUID events report as, resolved once per process. */
export function getTelemetryId(): string {
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
export function maybeShowFirstRunNotice(): void {
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
    'Archon collects anonymous usage telemetry — now also the shape of each\n' +
    'workflow (node-type counts, depth, fan-out, how many commands it uses, a\n' +
    'prompt-size bucket) and, for a copy of a bundled workflow, which bundled one\n' +
    "it came from — never your own workflow's name, description or text. Also\n" +
    'sent: an anonymous per-run reference (a hash, never the run id), cancelled\n' +
    'runs, how Archon was installed (binary, Docker, or source), the build commit,\n' +
    'chat activity (platform/provider/model, never message content), aggregate\n' +
    'usage totals (token counts, cost, durations, loop iterations), approval\n' +
    'decisions (approved/rejected only), deployment shape, a categorical failure\n' +
    'class, workflow name, run outcome, OS/arch, and version.\n' +
    'Still no code, prompts, file paths, IP, or personal data — see README "Telemetry".\n' +
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

/** @internal reset by `resetTelemetryForTests` */
export function resetConsentForTests(): void {
  telemetryIdCache = undefined;
  noticeChecked = false;
}
