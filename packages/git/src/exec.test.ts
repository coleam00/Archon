import { afterEach, describe, expect, it } from 'bun:test';
import { execFileAsync, resolveBashPath } from './exec';

describe('resolveBashPath -- platform-aware bash binary resolution (#1326)', () => {
  const originalEnv = process.env.ARCHON_BASH_PATH;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ARCHON_BASH_PATH;
    } else {
      process.env.ARCHON_BASH_PATH = originalEnv;
    }
  });

  it('returns the platform default when ARCHON_BASH_PATH is unset', () => {
    delete process.env.ARCHON_BASH_PATH;
    const result = resolveBashPath();
    if (process.platform === 'win32') {
      // Multi-candidate scan: first existing Git-Bash location, or the
      // canonical Program Files default when none exist.
      expect(result.endsWith('\\bash.exe')).toBe(true);
    } else {
      expect(result).toBe('bash');
    }
  });

  it('returns the ARCHON_BASH_PATH override when the path exists', () => {
    // process.execPath is the test runner binary — always exists, cross-platform.
    process.env.ARCHON_BASH_PATH = process.execPath;
    expect(resolveBashPath()).toBe(process.execPath);
  });

  it('throws with an actionable message when ARCHON_BASH_PATH points to a non-existent path', () => {
    process.env.ARCHON_BASH_PATH = '/definitely/does/not/exist/bash';
    expect(() => resolveBashPath()).toThrow(
      /ARCHON_BASH_PATH points to a path that does not exist/
    );
  });

  it('error message includes both the bad path and the Git Bash hint', () => {
    process.env.ARCHON_BASH_PATH = '/definitely/does/not/exist/bash';
    try {
      resolveBashPath();
      expect.unreachable('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('/definitely/does/not/exist/bash');
      expect(msg).toContain('LOCALAPPDATA');
    }
  });
});

describe('execFileAsync stdin', () => {
  it('delivers input outside argv', async () => {
    const input = 'é'.repeat(100_000);
    const result = await execFileAsync(
      resolveBashPath(),
      ['-c', 'IFS= read -r -d "" value || :; printf "%s" "$value"'],
      { input }
    );
    expect(result.stdout).toBe(input);
  });

  it('rejects an incomplete input write even when the child exits zero', async () => {
    await expect(
      execFileAsync(resolveBashPath(), ['-c', 'exit 0'], { input: 'x'.repeat(4_000_000) })
    ).rejects.toMatchObject({ code: expect.any(String) });
  });

  it('preserves spawn failure evidence when input is supplied', async () => {
    await expect(
      execFileAsync('/definitely-missing-archon-command', [], { input: 'source' })
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
