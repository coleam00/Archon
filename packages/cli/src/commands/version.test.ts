/**
 * Tests for version command
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as git from '@archon/git';
import { versionCommand } from './version';

describe('versionCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let execSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    execSpy = spyOn(git, 'execFileAsync').mockResolvedValue({ stdout: 'abc1234\n', stderr: '' });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    execSpy.mockRestore();
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
});
