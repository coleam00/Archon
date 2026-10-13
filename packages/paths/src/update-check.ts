import { join } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { getArchonHome } from './archon-paths';
import { createLogger } from './logger';

const log = createLogger('update-check');

interface UpdateCheckCache {
  latestVersion: string;
  releaseUrl: string;
  checkedAt: number; // Date.now() ms
  lastNoticeShownAt?: number;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
}

const CACHE_FILE = 'update-check.json';
const STALENESS_MS = 60 * 60 * 1000; // 1 hour
const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000; // 3 seconds
const GITHUB_API_URL = 'https://api.github.com/repos/coleam00/Archon/releases/latest';

function getCachePath(): string {
  return join(getArchonHome(), CACHE_FILE);
}

function readCache(): UpdateCheckCache | null {
  const cachePath = getCachePath();
  try {
    const raw = readFileSync(cachePath, 'utf-8');
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return null;
    if (
      !(
        'latestVersion' in data &&
        typeof data.latestVersion === 'string' &&
        'releaseUrl' in data &&
        typeof data.releaseUrl === 'string' &&
        'checkedAt' in data &&
        typeof data.checkedAt === 'number' &&
        Number.isFinite(data.checkedAt)
      )
    ) {
      return null;
    }
    const lastNoticeShownAt =
      'lastNoticeShownAt' in data &&
      typeof data.lastNoticeShownAt === 'number' &&
      Number.isFinite(data.lastNoticeShownAt)
        ? data.lastNoticeShownAt
        : undefined;
    return {
      latestVersion: data.latestVersion,
      releaseUrl: data.releaseUrl,
      checkedAt: data.checkedAt,
      lastNoticeShownAt,
    };
  } catch (err) {
    log.debug({ err, cachePath }, 'update_check.cache_read_failed');
    return null;
  }
}

function writeCache(cache: UpdateCheckCache): void {
  try {
    mkdirSync(getArchonHome(), { recursive: true });
    writeFileSync(getCachePath(), JSON.stringify(cache), 'utf-8');
  } catch (err) {
    log.debug({ err }, 'update_check.cache_write_failed');
  }
}

/**
 * Compare semver strings: returns true if latest > current.
 * Expects plain MAJOR.MINOR.PATCH (no `v` prefix).
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const c = current.split('.').map(Number);
  const l = latest.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const cv = c[i] ?? 0;
    const lv = l[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

/**
 * Parse tag_name and html_url from GitHub API /releases/latest response.
 * Strips `v` prefix from tag_name.
 */
export function parseLatestRelease(json: unknown): { version: string; url: string } {
  const obj = json as Record<string, unknown>;
  const tagName = obj.tag_name;
  if (typeof tagName !== 'string' || !tagName) {
    throw new Error('Missing tag_name in GitHub release response');
  }
  const version = tagName.startsWith('v') ? tagName.slice(1) : tagName;
  const url = typeof obj.html_url === 'string' ? obj.html_url : '';
  return { version, url };
}

/**
 * Full update check: read cache → fetch if stale → write cache → return result.
 * Network errors are swallowed (returns null).
 * Callers decide whether their install supports release checks.
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult | null> {
  try {
    const cached = readCache();
    if (cached && Date.now() - cached.checkedAt <= STALENESS_MS) {
      return {
        updateAvailable: isNewerVersion(currentVersion, cached.latestVersion),
        currentVersion,
        latestVersion: cached.latestVersion,
        releaseUrl: cached.releaseUrl,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(GITHUB_API_URL, {
        signal: controller.signal,
        headers: { 'User-Agent': 'archon-update-check' },
      });
      if (!res.ok) {
        log.debug({ status: res.status }, 'update_check.fetch_failed');
        return null;
      }
      const json: unknown = await res.json();
      const { version, url } = parseLatestRelease(json);

      writeCache({
        latestVersion: version,
        releaseUrl: url,
        checkedAt: Date.now(),
        // Re-read: a notice may have been shown while this fetch was in flight.
        lastNoticeShownAt: readCache()?.lastNoticeShownAt,
      });

      return {
        updateAvailable: isNewerVersion(currentVersion, version),
        currentVersion,
        latestVersion: version,
        releaseUrl: url,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    log.debug({ err }, 'update_check.fetch_failed');
    return null;
  }
}

/**
 * Sync-only: read cache, compare, return result. No fetch.
 * Returns null for stale or corrupt cache entries.
 */
export function getCachedUpdateCheck(currentVersion: string): UpdateCheckResult | null {
  const cached = readCache();
  if (!cached || Date.now() - cached.checkedAt > STALENESS_MS) return null;
  return {
    updateAvailable: isNewerVersion(currentVersion, cached.latestVersion),
    currentVersion,
    latestVersion: cached.latestVersion,
    releaseUrl: cached.releaseUrl,
  };
}

/**
 * Return a fresh cached notice at most once per 24 hours, without waiting for the network.
 * Read-then-write is not atomic: concurrent processes may rarely both print the notice.
 */
export function takeCachedUpdateNotice(currentVersion: string): UpdateCheckResult | null {
  const cached = readCache();
  if (!cached || Date.now() - cached.checkedAt > STALENESS_MS) return null;
  if (!isNewerVersion(currentVersion, cached.latestVersion)) return null;
  if (
    cached.lastNoticeShownAt !== undefined &&
    Date.now() - cached.lastNoticeShownAt < NOTICE_INTERVAL_MS
  )
    return null;
  writeCache({ ...cached, lastNoticeShownAt: Date.now() });
  return {
    updateAvailable: true,
    currentVersion,
    latestVersion: cached.latestVersion,
    releaseUrl: cached.releaseUrl,
  };
}
