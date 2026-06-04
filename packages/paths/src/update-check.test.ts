import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import {
  isNewerVersion,
  isForkBuildVersion,
  parseLatestRelease,
  checkForUpdate,
  getCachedUpdateCheck,
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

// ─── isForkBuildVersion ──────────────────────────────────────────────

describe('isForkBuildVersion', () => {
  test('detects AISRV fork build versions', () => {
    expect(isForkBuildVersion('0.3.12-aisrv.6130ddb')).toBe(true);
    expect(isForkBuildVersion('0.3.12-aisrv')).toBe(true);
    expect(isForkBuildVersion('0.3.12+aisrv.6130ddb')).toBe(true);
  });

  test('does not classify upstream versions as fork builds', () => {
    expect(isForkBuildVersion('0.3.12')).toBe(false);
    expect(isForkBuildVersion('0.4.1')).toBe(false);
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

  afterEach(() => {
    if (originalArchonHome !== undefined) {
      process.env.ARCHON_HOME = originalArchonHome;
    } else {
      delete process.env.ARCHON_HOME;
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test('skips upstream update checks for AISRV fork builds', async () => {
    const cache = {
      latestVersion: '0.5.0',
      releaseUrl: 'https://github.com/coleam00/Archon/releases/tag/v0.5.0',
      checkedAt: Date.now(),
    };
    writeFileSync(join(testDir, 'update-check.json'), JSON.stringify(cache));

    const fetchSpy = spyOn(globalThis, 'fetch');
    const result = await checkForUpdate('0.3.12-aisrv.6130ddb');

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
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

  afterEach(() => {
    if (originalArchonHome !== undefined) {
      process.env.ARCHON_HOME = originalArchonHome;
    } else {
      delete process.env.ARCHON_HOME;
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test('returns null for AISRV fork builds even when cache exists', () => {
    const cache = {
      latestVersion: '0.5.0',
      releaseUrl: 'https://example.com',
      checkedAt: Date.now(),
    };
    writeFileSync(join(testDir, 'update-check.json'), JSON.stringify(cache));
    expect(getCachedUpdateCheck('0.3.12-aisrv.6130ddb')).toBeNull();
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
