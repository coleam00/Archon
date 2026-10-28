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

describe('execFileAsync stdin delivery', () => {
  const read = 'const b = require("node:fs").readFileSync(0); process.stdout.write(b)';

  it('delivers exact UTF-8 and closes even empty input', async () => {
    for (const input of ["€\nquote' \\ $()`\n\n", '']) {
      expect(await execFileAsync(process.execPath, ['-e', read], { input })).toEqual({
        stdout: input,
        stderr: '',
      });
    }
  });

  it('leaves stdin open when input is absent', async () => {
    await expect(
      execFileAsync(process.execPath, ['-e', read], { timeout: 200 })
    ).rejects.toMatchObject({ killed: true, code: null });
  });

  it('preserves process errors when the child exits before consuming input', async () => {
    const input = '€'.repeat(1_000_000);
    await expect(
      execFileAsync(process.execPath, ['-e', 'process.stderr.write("failed"); process.exit(7)'], {
        input,
      })
    ).rejects.toMatchObject({ code: 7, stderr: 'failed' });
    await expect(execFileAsync('/nonexistent/archon-command', [], { input })).rejects.toMatchObject(
      { code: 'ENOENT' }
    );
    await expect(
      execFileAsync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        input,
        timeout: 200,
      })
    ).rejects.toMatchObject({ killed: true, code: null });
  });
});
