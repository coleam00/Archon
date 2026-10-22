/**
 * Telemetry transport: the lazy PostHog client, its silenced fetch, fire-and-forget
 * sending and the exit flush. Sending must never crash Archon. Errors log at debug,
 * with the first network failure on a custom POSTHOG_HOST also logged at warn.
 */
import type { PostHog } from 'posthog-node';
import { createLogger } from './logger';
import { getApiKey, getHost, getTelemetryId, isTelemetryDisabled } from './telemetry-consent';
import { collectMachineProperties, PRIVACY_INVARIANTS } from './telemetry-events';
import type { EventProperties } from './telemetry-events';

type PostHogFetch = NonNullable<NonNullable<ConstructorParameters<typeof PostHog>[1]>['fetch']>;
type PostHogFetchOptions = Parameters<PostHogFetch>[1];
type PostHogFetchResponse = Awaited<ReturnType<PostHogFetch>>;

// Leave room for warm CLI startup within the 150 ms help budget.
const TELEMETRY_SHUTDOWN_TIMEOUT_MS = 75;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('telemetry');
  return cachedLog;
}

/**
 * Lazy singleton. `undefined` = not yet initialized; `null` = disabled or
 * init failed; otherwise the live client and its transport cancellation owner.
 */
let clientInit: ReturnType<typeof initClient> | undefined;

async function getClient(): Promise<PostHog | null> {
  if (clientInit === undefined) {
    clientInit = initClient();
  }
  return (await clientInit)?.client ?? null;
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
    const res = await fetch(url, options);
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

async function initClient(): Promise<{ client: PostHog; abortController: AbortController } | null> {
  if (isTelemetryDisabled()) return null;
  const apiKey = getApiKey();
  if (apiKey === null) return null;
  try {
    const posthogModule = await import('posthog-node');
    const abortController = new AbortController();
    const client = new posthogModule.PostHog(apiKey, {
      host: getHost(),
      flushAt: 20,
      flushInterval: 10000,
      disableGeoip: true,
      fetch: (url, options): Promise<PostHogFetchResponse> =>
        silentFetch(url, {
          ...options,
          signal: options.signal
            ? AbortSignal.any([options.signal, abortController.signal])
            : abortController.signal,
        }),
    });
    // Defensive: also hook the client-level error channel in case a future
    // posthog-node version routes errors there instead of (or in addition to)
    // the internal console.error path.
    client.on('error', (err: Error) => {
      getLog().debug({ err }, 'telemetry.client_error');
    });
    // Attach machine context to every event as super-properties. The privacy
    // invariants are NOT registered here — `sendEvent` adds them per event so a
    // register() regression can't silently drop them.
    try {
      await client.register(collectMachineProperties());
    } catch (error) {
      getLog().debug({ err: error as Error }, 'telemetry.register_failed');
    }
    return { client, abortController };
  } catch (error) {
    getLog().debug({ err: error as Error }, 'telemetry.init_failed');
    return null;
  }
}

/**
 * Send one event fire-and-forget: never awaited, never throws. Resolves the lazy
 * client, skips when disabled/uninitialized, and swallows every error (network,
 * SDK, malformed props) at `debug` — telemetry must never crash Archon. Properties
 * are built only once a client exists, inside that same error policy.
 */
export function sendEvent(event: string, buildProperties: () => EventProperties): void {
  void (async (): Promise<void> => {
    try {
      const client = await getClient();
      if (!client) return;
      client.capture({
        distinctId: getTelemetryId(),
        event,
        properties: { ...PRIVACY_INVARIANTS, ...buildProperties() },
      });
    } catch (error) {
      getLog().debug({ err: error as Error }, 'telemetry.capture_failed');
    }
  })();
}

/**
 * Best-effort exit flush. Slow ingestion drops pending events after 75 ms;
 * telemetry must not hold up CLI exit or server shutdown. Tests may override the
 * budget to wait for delivery rather than exercise best-effort exit behavior.
 */
export async function shutdownTelemetry(timeoutMs = TELEMETRY_SHUTDOWN_TIMEOUT_MS): Promise<void> {
  if (clientInit === undefined) return;
  try {
    const initialized = await clientInit;
    if (initialized) {
      try {
        await initialized.client.shutdown(timeoutMs);
      } finally {
        // The SDK deadline only races its flush; it leaves fetch running.
        initialized.abortController.abort();
      }
    }
  } catch (error) {
    getLog().debug({ err: error as Error }, 'telemetry.shutdown_failed');
  } finally {
    clientInit = undefined;
  }
}

/** @internal reset by `resetTelemetryForTests` */
export function resetTransportForTests(): void {
  clientInit = undefined;
  firstFailureLogged = false;
}
