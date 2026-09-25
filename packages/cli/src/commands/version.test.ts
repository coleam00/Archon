/**
 * Tests for version command
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as git from '@archon/git';
import { removeTempTree } from '@archon/paths/test-utils';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { versionCommand } from './version';

describe('versionCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let execSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    execSpy = spyOn(git, 'execFileAsync').mockResolvedValue({ stdout: 'abc1234\n', stderr: '' });
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((...args: unknown[]) => {
      const callback = args.find(arg => typeof arg === 'function');
      if (typeof callback === 'function') (callback as () => void)();
      return true;
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    execSpy.mockRestore();
    stdoutSpy.mockRestore();
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

    // Fifth call should contain git commit with the mocked SHA
    const fifthCall = consoleSpy.mock.calls[4][0] as string;
    expect(fifthCall).toMatch(/Git commit: ([0-9a-f]{7,}|unknown)/);
    expect(fifthCall).toBe('  Git commit: abc1234');
  });

  it('should return unknown git commit when git is unavailable', async () => {
    execSpy.mockRejectedValueOnce(new Error('not a git repository'));

    await versionCommand();

    const fifthCall = consoleSpy.mock.calls[4][0] as string;
    expect(fifthCall).toBe('  Git commit: unknown');
  });

  it('should output correct format for version line', async () => {
    await versionCommand();

    const firstCall = consoleSpy.mock.calls[0][0] as string;
    // Format: "Archon CLI v0.2.0"
    expect(firstCall).toMatch(/^Archon CLI v\d+\.\d+\.\d+$/);
  });

  it('should show source (bun) build type in development', async () => {
    await versionCommand();

    const buildCall = consoleSpy.mock.calls[2][0] as string;
    expect(buildCall).toContain('source (bun)');
  });

  it('emits the exact engine revision and declared contracts as JSON', async () => {
    const revision = '8618b5c2cd7d35bb3ad4d4e87e4f445d035043d5';
    execSpy.mockResolvedValueOnce({ stdout: `${revision}\n`, stderr: '' });

    await versionCommand({ json: true });

    expect(consoleSpy).not.toHaveBeenCalled();
    const payload = JSON.parse((stdoutSpy.mock.calls[0]?.[0] as string) ?? '') as {
      revision: string;
      contracts: Record<string, { version: number; values: string[] }>;
    };
    expect(payload.revision).toBe(revision);
    expect(payload.contracts['node_failed.data.error_class']).toEqual({
      version: 1,
      values: ['fatal', 'transient', 'unknown'],
    });
    expect(execSpy).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], {
      timeout: 5000,
      cwd: join(import.meta.dir, '../../../..'),
    });
  });

  it('resolves the text-mode commit from the engine source, not the caller cwd', async () => {
    await versionCommand();

    expect(execSpy).toHaveBeenCalledWith('git', ['rev-parse', '--short', 'HEAD'], {
      timeout: 5000,
      cwd: join(import.meta.dir, '../../../..'),
    });
  });

  it('supports archon version --json outside a git project', async () => {
    const callerCwd = mkdtempSync(join(tmpdir(), 'archon-version-json-'));
    const sourceRoot = join(import.meta.dir, '../../../..');
    try {
      const expectedRevision = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: sourceRoot,
        encoding: 'utf8',
      }).stdout.trim();
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dir, '../cli.ts'), 'version', '--json'],
        {
          cwd: callerCwd,
          encoding: 'utf8',
          env: {
            ...process.env,
            ARCHON_HOME: join(callerCwd, 'archon-home'),
            ARCHON_TELEMETRY_DISABLED: '1',
          },
        }
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const payload = JSON.parse(result.stdout) as { revision: string };
      expect(payload.revision).toBe(expectedRevision);
    } finally {
      await removeTempTree(callerCwd);
    }
  });
});
