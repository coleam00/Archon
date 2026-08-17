/**
 * Boot-time AiderDesk agent-profile catalog helper.
 *
 * Purpose: where the AiderDesk provider is the source of truth for profile
 * EXISTENCE at runtime, this module provides the SOURCE OF TRUTH for profile
 * EXISTENCE at boot time. Workflow YAMLs declaring `provider: aiderdesk,
 * model: <name>` are validated against a one-shot boot fetch of AiderDesk's
 * `/api/agent-profiles` so a workflow pinned to a profile that no longer
 * exists is rejected with a config error at engine start.
 *
 * Distinct from the provider's per-instance cache:
 *   - This module caches the catalog ONCE per process lifetime. The cache is
 *     process-keyed because the engine is single-instance (one boot, N
 *     workflow invocations).
 *   - The AiderDesk provider caches per-instance (one provider object per
 *     agent lookup); that cache is unrelated to this one.
 *
 * The contract:
 *   1. Call `bootstrapAiderDeskAgentCatalog()` ONCE at engine startup.
 *   2. Workflow discovery uses `validateAiderDeskWorkflowModel('Aider')` to
 *      confirm each declared `provider: aiderdesk` workflow's `model` slot
 *      exists in the cached catalog. Misses are surfaced as config errors.
 *   3. If the boot fetch fails (offline, AiderDesk absent), validation is
 *      SKIPPED — a runtime `UnknownAiderDeskAgentProfileError` will fire
 *      later, which is acceptable for "engine boots without AiderDesk"
 *      scenarios. Operators who hard-pin to AiderDesk must verify the
 *      AiderDesk host is reachable at boot.
 */
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('orchestrator.aiderdesk_catalog');
  return cachedLog;
}

/**
 * Fetch function type — matches global `fetch` for DI in tests. Mirrors the
 * shape used elsewhere in the providers package so the same `rec.fetch`
 * fixture works without a re-fitting layer.
 */
export type FetchFn = typeof fetch;

/** A descriptor for the cache entry — frozen so callers cannot mutate. */
export interface AiderDeskBootCatalog {
  /** All profile NAMES known to the catalog at boot time. */
  names: readonly string[];
  /** When the catalog was fetched (epoch ms). */
  fetchedAt: number;
}

let bootCatalog: AiderDeskBootCatalog | null = null;

/** Default AiderDesk API URL — mirrors the providers package's heuristic. */
function resolveBootApiUrl(): string {
  if (typeof process !== 'undefined') {
    const envUrl = process.env.AIDERDESK_API_URL;
    if (envUrl) return envUrl.replace(/\/+$/, '');
    if (process.env.ARCHON_DOCKER === 'true' || process.env.IS_DOCKER === 'true') {
      return 'http://172.18.0.1:24337';
    }
  }
  return 'http://localhost:24337';
}

/**
 * Read the cached boot catalog without performing a network fetch. Returns
 * `null` when `bootstrapAiderDeskAgentCatalog()` has not yet run, OR when the
 * boot fetch failed (offline / 5xx). Callers MUST tolerate `null` and surface
 * a graceful skip rather than treating it as a hard failure.
 */
export function getBootAiderDeskCatalog(): AiderDeskBootCatalog | null {
  return bootCatalog;
}

/**
 * Fetch /api/agent-profiles from the AiderDesk host and cache the resulting
 * NAME list. Idempotent — calling twice returns the second result without
 * taking a second fetch window (the second call still re-fetches because the
 * caller-supplied fetchFn may have changed; treat as "load + cache").
 *
 * Failures (network / non-2xx / invalid JSON) are swallowed and logged; the
 * module-level cache stays `null`. Runtime resolution still works because the
 * AiderDesk provider carries its own per-instance cache and surfaces
 * `UnknownAiderDeskAgentProfileError` on the actual lookup miss.
 */
export async function bootstrapAiderDeskAgentCatalog(
  fetchFn?: FetchFn,
  apiUrl?: string
): Promise<AiderDeskBootCatalog | null> {
  const base = (apiUrl ?? resolveBootApiUrl()).replace(/\/+$/, '');
  const url = `${base}/api/agent-profiles`;
  const f = fetchFn ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  if (!f) {
    getLog().debug({}, 'aiderdesk.boot_catalog_fetch_unavailable');
    return null;
  }
  try {
    const response = await f(url, { method: 'GET', headers: { Accept: 'application/json' } });
    if (!response.ok) {
      getLog().warn(
        { status: response.status, url },
        'aiderdesk.boot_catalog_non_2xx_skipping_cache'
      );
      return null;
    }
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      getLog().warn({ url }, 'aiderdesk.boot_catalog_non_array_shape_skipping');
      return null;
    }
    const names = (payload as Array<unknown>)
      .filter((e): e is { name?: unknown } => !!e && typeof e === 'object')
      .map(e => (typeof e.name === 'string' ? e.name : ''))
      .filter(n => n.length > 0);
    bootCatalog = Object.freeze({
      names: Object.freeze(names),
      fetchedAt: Date.now(),
    });
    getLog().debug({ count: names.length, url }, 'aiderdesk.boot_catalog_loaded');
    return bootCatalog;
  } catch (error) {
    getLog().warn(
      { error: error instanceof Error ? error.message : String(error), url },
      'aiderdesk.boot_catalog_failed_skipping_cache'
    );
    return null;
  }
}

/**
 * Validate a workflow YAML's `model:` slot against the cached boot catalog.
 *
 * Returns `null` when:
 *   - The boot catalog is not set (caller didn't run bootstrap OR fetch
 *     failed non-fatally); fail-open here is correct per the contract.
 *   - The model is not declared.
 *   - The model string matches an entry in `bootCatalog.names` (case-sensitive).
 *
 * Returns an error message when:
 *   - The boot catalog IS set AND the requested name is absent. The message
 *     ends with a Levenshtein-style near-miss suggestion using
 *     `@archon/providers`' `nearestNames` to help operators notice typos.
 */
export function validateAiderDeskWorkflowModel(
  requestedName: string | undefined
): string | null {
  if (bootCatalog === null) return null; // fail-open across a missing cache
  if (!requestedName || typeof requestedName !== 'string' || requestedName.length === 0) {
    return null;
  }
  if (bootCatalog.names.includes(requestedName)) return null;
  // Lazy import to keep the orchestrator package's cold-start light — most
  // boots never hit the catalog miss path.
  let candidates: readonly string[] = [];
  try {
    // Dynamic import is fine here: the @archon/providers barrel is loaded by
    // test infrastructure already; for production the cost is ~negligible.
    const { nearestNames } = require('@archon/providers') as {
      nearestNames: (
        target: string,
        candidates: readonly string[],
        k?: number
      ) => readonly string[];
    };
    candidates = nearestNames(requestedName, bootCatalog.names);
  } catch {
    /* nearest-names is best-effort; not fatal */
  }
  const known = bootCatalog.names.length > 0 ? bootCatalog.names.join(', ') : '(empty)';
  const hint = candidates.length > 0 ? ` Did you mean: ${candidates.join(', ')}?` : '';
  return `AiderDesk agent profile '${requestedName}' not found in boot catalog. Known names: [${known}].${hint}`;
}

/**
 * Test-only: clear the module-level cache between cases. NOT exported through
 * any barrel — only the test file in this directory imports it.
 */
export function _clearBootCatalogForTests(): void {
  bootCatalog = null;
}
