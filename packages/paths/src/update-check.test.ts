import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { removeTempTree } from './test-utils';
import {
  isNewerVersion,
  parseLatestRelease,
  checkForUpdate,
  getCachedUpdateCheck,
  takeCachedUpdateNotice,
} from './update-check';

// ─── isNewerVersion ──────────────────────────────────────────────────

describe('isNewerVersion', () => {
  test('returns true when latest minor is higher', () => {
    expect(isNewerVersion('0.3.2', '0.4.0')).toBe(true);
  });

  test('returns true when latest patch is higher', () => {
    expect(isNewerVersion('0.3.2', '0.3.3')).toBe(true);
  });

  test('returns false when current is higher', () => {
    expect(isNewerVersion('0.4.0', '0.3.9')).toBe(false);
  });

  test('returns false when versions are equal', () => {
    expect(isNewerVersion('0.3.2', '0.3.2')).toBe(false);
  });

  test('handles major version differences', () => {
    expect(isNewerVersion('0.99.99', '1.0.0')).toBe(true);
  });

  test('handles double-digit segments correctly (not string comparison)', () => {
    expect(isNewerVersion('0.9.0', '0.10.0')).toBe(true);
  });
});

// ─── parseLatestRelease ──────────────────────────────────────────────

describe('parseLatestRelease', () => {
  test('parses valid response with v prefix', () => {
    const result = parseLatestRelease({
      tag_name: 'v0.4.0',
      html_url: 'https://github.com/coleam00/Archon/releases/tag/v0.4.0',
    });
    expect(result).toEqual({
      version: '0.4.0',
      url: 'https://github.com/coleam00/Archon/releases/tag/v0.4.0',
    });
  });

  test('parses tag_name without v prefix', () => {
    const result = parseLatestRelease({
      tag_name: '0.4.0',
      html_url: 'https://example.com',
    });
    expect(result.version).toBe('0.4.0');
  });

  test('throws on missing tag_name', () => {
    expect(() => parseLatestRelease({})).toThrow('Missing tag_name');
  });

  test('returns empty url when html_url is missing', () => {
    const result = parseLatestRelease({ tag_name: 'v1.0.0' });
    expect(result.url).toBe('');
  });
});

// ─── checkForUpdate (with mocked fetch) ──────────────────────────────

describe('checkForUpdate', () => {
  const testDir = join(tmpdir(), `archon-update-check-test-${Date.now()}`);
  let originalArchonHome: string | undefined;

  beforeEach(() => {
    originalArchonHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = testDir;
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(async () => {
    if (originalArchonHome !== undefined) {
      process.env.ARCHON_HOME = originalArchonHome;
    } else {
      delete process.env.ARCHON_HOME;
    }
    await removeTempTree(testDir);
  });

  test('old cache allows a notice, then suppresses it for 24 hours', () => {
    const now = Date.now();
    const clock = spyOn(Date, 'now').mockReturnValue(now);
    const cachePath = join(testDir, 'update-check.json');
    const cache = { latestVersion: '0.5.0', releaseUrl: 'https://example.com', checkedAt: now };
    try {
      writeFileSync(cachePath, JSON.stringify(cache));
      expect(takeCachedUpdateNotice('0.5.0')).toBeNull();
      expect(takeCachedUpdateNotice('0.4.0')?.latestVersion).toBe('0.5.0');
      expect(takeCachedUpdateNotice('0.4.0')).toBeNull();
      clock.mockReturnValue(now + 24 * 60 * 60 * 1000);
      writeFileSync(
        cachePath,
        JSON.stringify({ ...cache, checkedAt: Date.now(), lastNoticeShownAt: now })
      );
      expect(takeCachedUpdateNotice('0.4.0')?.latestVersion).toBe('0.5.0');
    } finally {
      clock.mockRestore();
    }
  });

  test('refreshing stale release data preserves the notice timestamp', async () => {
    const lastNoticeShownAt = Date.now() - 2 * 60 * 60 * 1000;
    writeFileSync(
      join(testDir, 'update-check.json'),
      JSON.stringify({
        latestVersion: '0.5.0',
        releaseUrl: 'https://example.com',
        checkedAt: lastNoticeShownAt,
        lastNoticeShownAt,
      })
    );
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ tag_name: 'v0.6.0', html_url: 'https://example.com' }))
    );
    try {
      expect(takeCachedUpdateNotice('0.4.0')).toBeNull();
      await checkForUpdate('0.4.0');
      expect(
        JSON.parse(readFileSync(join(testDir, 'update-check.json'), 'utf8')).lastNoticeShownAt
      ).toBe(lastNoticeShownAt);
      expect(takeCachedUpdateNotice('0.4.0')).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('returns result from fresh cache without fetching', async () => {
    const cache = {
      latestVersion: '0.5.0',
      releaseUrl: 'https://github.com/coleam00/Archon/releases/tag/v0.5.0',
      checkedAt: Date.now(),
    };
    writeFileSync(join(testDir, 'update-check.json'), JSON.stringify(cache));

    const fetchSpy = spyOn(globalThis, 'fetch');
    const result = await checkForUpdate('0.4.0');

    expect(result).toEqual({
      updateAvailable: true,
      currentVersion: '0.4.0',
      latestVersion: '0.5.0',
      releaseUrl: 'https://github.com/coleam00/Archon/releases/tag/v0.5.0',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('fetches from GitHub when no cache exists', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v0.5.0',
          html_url: 'https://github.com/coleam00/Archon/releases/tag/v0.5.0',
        }),
        { status: 200 }
      )
    );

    const result = await checkForUpdate('0.4.0');

    expect(result).toEqual({
      updateAvailable: true,
      currentVersion: '0.4.0',
      latestVersion: '0.5.0',
      releaseUrl: 'https://github.com/coleam00/Archon/releases/tag/v0.5.0',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Verify cache was written with correct content
    const cacheRaw = JSON.parse(readFileSync(join(testDir, 'update-check.json'), 'utf-8'));
    expect(cacheRaw.latestVersion).toBe('0.5.0');
    expect(cacheRaw.releaseUrl).toBe('https://github.com/coleam00/Archon/releases/tag/v0.5.0');
    expect(typeof cacheRaw.checkedAt).toBe('number');
    fetchSpy.mockRestore();
  });

  test('returns null on network error', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    const result = await checkForUpdate('0.4.0');

    expect(result).toBeNull();
    fetchSpy.mockRestore();
  });

  test('returns null on non-200 HTTP response', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"message":"rate limit exceeded"}', { status: 403 })
    );

    const result = await checkForUpdate('0.4.0');

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  test('returns updateAvailable: false when current matches latest', async () => {
    const cache = {
      latestVersion: '0.4.0',
      releaseUrl: 'https://github.com/coleam00/Archon/releases/tag/v0.4.0',
      checkedAt: Date.now(),
    };
    writeFileSync(join(testDir, 'update-check.json'), JSON.stringify(cache));

    const result = await checkForUpdate('0.4.0');

    expect(result?.updateAvailable).toBe(false);
  });

  test('fetches when cache is stale', async () => {
    const staleCache = {
      latestVersion: '0.4.0',
      releaseUrl: 'https://example.com',
      checkedAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
    };
    writeFileSync(join(testDir, 'update-check.json'), JSON.stringify(staleCache));

    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v0.5.0',
          html_url: 'https://github.com/coleam00/Archon/releases/tag/v0.5.0',
        }),
        { status: 200 }
      )
    );

    const result = await checkForUpdate('0.4.0');

    expect(result?.latestVersion).toBe('0.5.0');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});

// ─── getCachedUpdateCheck ────────────────────────────────────────────

describe('getCachedUpdateCheck', () => {
  const testDir = join(tmpdir(), `archon-cached-check-test-${Date.now()}`);
  let originalArchonHome: string | undefined;

  beforeEach(() => {
    originalArchonHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = testDir;
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(async () => {
    if (originalArchonHome !== undefined) {
      process.env.ARCHON_HOME = originalArchonHome;
    } else {
      delete process.env.ARCHON_HOME;
    }
    await removeTempTree(testDir);
  });

  test('returns null when no cache file', () => {
    expect(getCachedUpdateCheck('0.4.0')).toBeNull();
  });

  test('returns result from cache file', () => {
    const cache = {
      latestVersion: '0.5.0',
      releaseUrl: 'https://example.com',
      checkedAt: Date.now(),
    };
    writeFileSync(join(testDir, 'update-check.json'), JSON.stringify(cache));

    const result = getCachedUpdateCheck('0.4.0');
    expect(result?.updateAvailable).toBe(true);
    expect(result?.latestVersion).toBe('0.5.0');
  });

  test('returns null for corrupt cache file', () => {
    writeFileSync(join(testDir, 'update-check.json'), 'not json');
    expect(getCachedUpdateCheck('0.4.0')).toBeNull();
  });

  test('returns null for stale cache', () => {
    const staleCache = {
      latestVersion: '0.5.0',
      releaseUrl: 'https://example.com',
      checkedAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
    };
    writeFileSync(join(testDir, 'update-check.json'), JSON.stringify(staleCache));
    expect(getCachedUpdateCheck('0.4.0')).toBeNull();
  });

  test('returns null when checkedAt is missing', () => {
    const cache = { latestVersion: '0.5.0', releaseUrl: 'https://example.com' };
    writeFileSync(join(testDir, 'update-check.json'), JSON.stringify(cache));
    expect(getCachedUpdateCheck('0.4.0')).toBeNull();
  });
});
