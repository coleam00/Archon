/**
 * Tests for version command
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as archonCommit from '@archon/git/archon-commit';
import { trackTempRoots } from '@archon/paths/test-utils';
import { versionCommand } from './version';

const trackTempRoot = trackTempRoots();

describe('versionCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let commitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    commitSpy = spyOn(archonCommit, 'readArchonCommit').mockResolvedValue({
      sha: 'abc1234',
      committedAt: '2026-11-12T14:03:21+01:00',
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    commitSpy.mockRestore();
  });

  it('should output version and system info', async () => {
    await versionCommand();

    // Should have called console.log 5 times (version, platform, build, database, git commit)
    expect(consoleSpy).toHaveBeenCalledTimes(5);

    // First call should contain "Archon CLI" and version
    const firstCall = consoleSpy.mock.calls[0][0] as string;
    expect(firstCall).toContain('Archon CLI');
    expect(firstCall).toMatch(/v\d+\.\d+\.\d+/);

    // Second call should contain platform info
    const secondCall = consoleSpy.mock.calls[1][0] as string;
    expect(secondCall).toContain('Platform:');

    // Third call should contain build type
    const thirdCall = consoleSpy.mock.calls[2][0] as string;
    expect(thirdCall).toContain('Build:');

    // Fourth call should contain database type
    const fourthCall = consoleSpy.mock.calls[3][0] as string;
    expect(fourthCall).toContain('Database:');

    // Fifth call names Archon's commit
    const fifthCall = consoleSpy.mock.calls[4][0] as string;
    expect(fifthCall).toBe('  Git commit: abc1234');
  });

  it("omits the git commit line when Archon's commit is unknown", async () => {
    commitSpy.mockResolvedValueOnce(undefined);

    await versionCommand();

    const lines = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(lines).toHaveLength(4);
    expect(lines.some((line: string) => line.includes('Git commit'))).toBe(false);
  });

  it('should show source (bun) build type in development', async () => {
    await versionCommand();

    const buildCall = consoleSpy.mock.calls[2][0] as string;
    expect(buildCall).toContain('source (bun)');
  });

  it("names Archon's commit when run from another repository", async () => {
    commitSpy.mockRestore();
    const spawn = (cwd: string, ...args: string[]): string => {
      const result = Bun.spawnSync(
        ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
        { cwd, env: archonCommit.withoutRepositorySelectors(process.env) }
      );
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    const elsewhere = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-version-')));
    spawn(elsewhere, 'init', '-q');
    spawn(elsewhere, 'commit', '-q', '--allow-empty', '--no-gpg-sign', '-m', 'elsewhere');
    const archonHead = spawn(import.meta.dir, 'rev-parse', '--short', 'HEAD');
    const before = process.cwd();
    process.chdir(elsewhere);
    try {
      await versionCommand();
    } finally {
      process.chdir(before);
    }

    const lines = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(lines).toContain(`  Git commit: ${archonHead}`);
  });
});
