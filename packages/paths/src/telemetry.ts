/**
 * Anonymous PostHog telemetry for Archon.
 *
 * Emits a small set of anonymous events — `archon_started` (once per process),
 * `workflow_invoked` (each workflow start), and `workflow_completed` /
 * `workflow_failed` (each terminal run) — so maintainers can see active
 * installs, which workflows run, and run outcomes. No PII, no user identity.
 * A random UUID is persisted to `${ARCHON_HOME}/telemetry-id` so we can count
 * distinct installs.
 *
 * Every event carries the privacy invariants `$process_person_profile: false`
 * (anonymous tier — no person profile ever created) and `$ip: ''` (PostHog
 * drops the source IP at ingest). Machine context (os, arch, version,
 * is_binary, runtime, is_ci, is_tty) rides along on every event via PostHog
 * super-properties. What is collected is categorical only: workflow name (real
 * for bundled workflows, `"custom"` for user-authored), platform, provider,
 * model, node shape, and run outcome/duration. Never sent: code, prompts, file
 * paths, IP, geo, error text, or custom workflow names/descriptions.
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
import { BUNDLED_IS_BINARY, BUNDLED_VERSION } from './bundled-build';
import { createLogger } from './logger';

/** Bumped when the captured property set changes (documented in README). */
export const TELEMETRY_SCHEMA_VERSION = 2;

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
// Bumped to `-v2` when the captured property set expanded (machine context +
// run outcomes). Bumping re-shows the updated first-run notice once per install
// so existing users re-consent rather than silently getting broader capture.
const NOTICE_STAMP_FILENAME = 'telemetry-notice-shown-v2';

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

/**
 * Privacy invariants attached to EVERY telemetry event. Kept per-event (not
 * relying solely on super-properties) so each capture site is visibly correct
 * and a super-property regression can never silently leak the source IP or
 * create a person profile.
 */
const PRIVACY_INVARIANTS = {
  $process_person_profile: false,
  // Strip source IP at ingest. `disableGeoip: true` only prevents geo
  // enrichment; `$ip: ''` drops the IP from the event entirely.
  $ip: '',
} as const;

/**
 * Stable machine/runtime context registered once as PostHog super-properties
 * (attached to every event from this client). Categorical only — no
 * identifiers, no paths. `install_method` is intentionally omitted until a
 * build-time channel constant exists (never derive it from a filesystem path).
 */
function collectMachineProperties(): Record<string, string | boolean> {
  const bunVersion = typeof Bun !== 'undefined' ? Bun.version : undefined;
  return {
    os: process.platform,
    arch: process.arch,
    archon_version: BUNDLED_VERSION,
    is_binary: BUNDLED_IS_BINARY,
    runtime_version: bunVersion ? `bun-${bunVersion}` : process.version,
    // Mirrors the CI auto-disable check; when telemetry is enabled this is
    // effectively always false, but it's cheap and future-proof.
    is_ci: process.env.CI?.toLowerCase() === 'true',
    // `process.stderr.isTTY` is `undefined` at runtime when stderr is not a TTY
    // (servers, pipes, CI), so without coercion the field is silently omitted on
    // the primary server path. bun-types incorrectly narrows it to `boolean`,
    // which makes the lint rule think the coercion is redundant — it is not.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- bun-types mis-types process.stderr.isTTY as always-boolean; runtime value is boolean|undefined and the coercion guarantees a present `false`.
    is_tty: Boolean(process.stderr.isTTY),
  };
}

/** Discovery source of a workflow, mirrored from `@archon/workflows` as a
 * plain string union so `@archon/paths` keeps zero `@archon/*` dependencies. */
export type WorkflowTelemetrySource = 'bundled' | 'global' | 'project';

/**
 * Apply the workflow-name privacy rule: bundled (Archon-authored) workflows
 * report their real name so maintainers can see which defaults are popular;
 * user-authored (global/project) workflows report `"custom"` so private names
 * (e.g. "deploy-acme-prod") never leave the machine. `workflow_source` is
 * always reported for the custom-vs-default split.
 */
export function classifyWorkflowForTelemetry(
  name: string,
  source: WorkflowTelemetrySource | undefined
): { workflow_name: string; is_builtin: boolean; workflow_source: WorkflowTelemetrySource } {
  const isBuiltin = source === 'bundled';
  return {
    is_builtin: isBuiltin,
    workflow_name: isBuiltin ? name : 'custom',
    workflow_source: source ?? 'project',
  };
}

/**
 * Model ids are user-supplied (forwarded verbatim from workflow/`config.yaml`
 * YAML), so unlike `provider` they're not structurally categorical. Forward a
 * value only when it looks like a real model ref (alphanumerics plus `/._:-`,
 * bounded length — covers `sonnet`, `gpt-5.3-codex`, `anthropic/claude-haiku-4-5`,
 * `openrouter/qwen/qwen3-coder`). Anything else is dropped so a stray free-text
 * value can't slip through the "categorical only" telemetry contract.
 *
 * Exported for direct testing of the privacy guard. @internal
 */
export function sanitizeModelForTelemetry(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  return /^[a-zA-Z0-9/._:-]{1,64}$/.test(model) ? model : undefined;
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
    'Archon collects anonymous usage telemetry — now also OS/arch and run\n' +
    'outcome (success/failure), alongside workflow name, platform, and version.\n' +
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
    // Attach machine context to every event as super-properties. The privacy
    // invariants are NOT registered here — they stay per-event (see
    // PRIVACY_INVARIANTS) so a register() regression can't silently drop them.
    try {
      await client.register(collectMachineProperties());
    } catch (error) {
      getLog().debug({ err: error as Error }, 'telemetry.register_failed');
    }
    return client;
  } catch (error) {
    getLog().debug({ err: error as Error }, 'telemetry.init_failed');
    return null;
  }
}

export interface WorkflowInvokedProperties {
  workflowName: string;
  /** Discovery source — drives the custom-vs-default split and name redaction. */
  workflowSource?: WorkflowTelemetrySource;
  platform?: string;
  provider?: string;
  model?: string;
  nodeCount?: number;
  usesLoop?: boolean;
  usesApproval?: boolean;
  usesScript?: boolean;
  usesBash?: boolean;
  interactive?: boolean;
  usedIsolation?: boolean;
  isResume?: boolean;
}

/** Once-per-process startup event — the basis for active-install counting. */
export interface ArchonStartedProperties {
  surface: 'cli' | 'server';
}

/** Categorical terminal exit reason — a fixed enum, never raw error text. */
export type WorkflowExitReason = 'no_nodes_completed' | 'node_error' | 'unhandled_error';

/**
 * Terminal workflow-run event (`workflow_completed` / `workflow_failed`).
 * Cancellation is intentionally not tracked: external `/workflow cancel` exits
 * via the `skipIfStatusChanged` paths in the DAG executor, which emit no
 * telemetry by design (see "No Autonomous Lifecycle Mutation" in CLAUDE.md).
 */
export interface WorkflowCompletedProperties {
  outcome: 'completed' | 'failed';
  workflowName: string;
  workflowSource?: WorkflowTelemetrySource;
  provider?: string;
  durationMs?: number;
  nodesCompleted?: number;
  nodesFailed?: number;
  nodesSkipped?: number;
  nodesTotal?: number;
  exitReason?: WorkflowExitReason;
}

/**
 * Run a telemetry capture fire-and-forget: never awaited, never throws. Resolves
 * the lazy client, skips when disabled/uninitialized, and swallows every error
 * (network, SDK, malformed props) at `debug` — telemetry must never crash Archon.
 * The per-event error policy lives here, in exactly one place.
 */
function fireAndForget(capture: (client: PostHog) => void): void {
  void (async (): Promise<void> => {
    try {
      const client = await getClient();
      if (!client) return;
      capture(client);
    } catch (error) {
      getLog().debug({ err: error as Error }, 'telemetry.capture_failed');
    }
  })();
}

/**
 * Fire-and-forget capture of a `workflow_invoked` event. Never throws, never
 * awaits — safe to call from hot paths. Shows the first-run notice on first
 * invocation when telemetry is enabled and stderr is interactive.
 */
export function captureWorkflowInvoked(props: WorkflowInvokedProperties): void {
  if (isTelemetryDisabled()) return;
  maybeShowFirstRunNotice();
  const model = sanitizeModelForTelemetry(props.model);
  fireAndForget(client => {
    client.capture({
      distinctId: getTelemetryId(),
      event: 'workflow_invoked',
      properties: {
        ...PRIVACY_INVARIANTS,
        ...classifyWorkflowForTelemetry(props.workflowName, props.workflowSource),
        schema_version: TELEMETRY_SCHEMA_VERSION,
        ...(props.platform ? { platform: props.platform } : {}),
        ...(props.provider ? { provider: props.provider } : {}),
        ...(model ? { model } : {}),
        ...(props.nodeCount !== undefined ? { node_count: props.nodeCount } : {}),
        uses_loop: Boolean(props.usesLoop),
        uses_approval: Boolean(props.usesApproval),
        uses_script: Boolean(props.usesScript),
        uses_bash: Boolean(props.usesBash),
        interactive: Boolean(props.interactive),
        used_isolation: Boolean(props.usedIsolation),
        is_resume: Boolean(props.isResume),
      },
    });
  });
}

/**
 * Fire-and-forget capture of an `archon_started` event. Call once per CLI
 * invocation and per server boot (the single call sites in `cli.ts` / the
 * server entrypoint enforce the "once per process" contract — there is no
 * in-function dedup guard). This (not just `workflow_invoked`) is what makes
 * active-install / DAU metrics honest, since users who only run
 * `doctor`/`serve`/chat would otherwise be invisible. Machine context rides
 * along via the registered super-properties. Also shows the first-run notice.
 */
export function captureArchonStarted(props: ArchonStartedProperties): void {
  if (isTelemetryDisabled()) return;
  maybeShowFirstRunNotice();
  fireAndForget(client => {
    client.capture({
      distinctId: getTelemetryId(),
      event: 'archon_started',
      properties: {
        ...PRIVACY_INVARIANTS,
        surface: props.surface,
        schema_version: TELEMETRY_SCHEMA_VERSION,
      },
    });
  });
}

/**
 * Fire-and-forget capture of a terminal workflow run. Emits `workflow_completed`
 * when `outcome === 'completed'`, otherwise `workflow_failed`. Carries run
 * outcome, duration, node counts, and a categorical exit reason so maintainers
 * can measure success rates and funnels — not just intent. Intentionally does
 * not show the first-run notice (that fires on start events, not completion).
 */
export function captureWorkflowCompleted(props: WorkflowCompletedProperties): void {
  if (isTelemetryDisabled()) return;
  fireAndForget(client => {
    client.capture({
      distinctId: getTelemetryId(),
      event: props.outcome === 'completed' ? 'workflow_completed' : 'workflow_failed',
      properties: {
        ...PRIVACY_INVARIANTS,
        ...classifyWorkflowForTelemetry(props.workflowName, props.workflowSource),
        outcome: props.outcome,
        schema_version: TELEMETRY_SCHEMA_VERSION,
        ...(props.provider ? { provider: props.provider } : {}),
        ...(props.durationMs !== undefined ? { duration_ms: props.durationMs } : {}),
        ...(props.nodesCompleted !== undefined ? { nodes_completed: props.nodesCompleted } : {}),
        ...(props.nodesFailed !== undefined ? { nodes_failed: props.nodesFailed } : {}),
        ...(props.nodesSkipped !== undefined ? { nodes_skipped: props.nodesSkipped } : {}),
        ...(props.nodesTotal !== undefined ? { nodes_total: props.nodesTotal } : {}),
        ...(props.exitReason ? { exit_reason: props.exitReason } : {}),
      },
    });
  });
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
