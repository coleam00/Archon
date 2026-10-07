import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

describe('source CLI re-invocation', () => {
  // From source, cliProgramArguments() re-invokes [bun, <path>/cli.ts], and a
  // detached child (`trigger execute`, background runs) is spawned with the
  // launch's own working directory rather than packages/cli. Module resolution
  // must therefore not depend on packages/cli's tsconfig paths.
  test('the CLI entry starts from an unrelated working directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'archon-cli-cwd-'));
    try {
      const entry = resolve(import.meta.dir, '..', 'cli.ts');
      const child = Bun.spawnSync([process.execPath, entry, '--version'], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(child.stderr.toString()).not.toContain('Cannot find module');
      expect(child.exitCode).toBe(0);
    } finally {
      await removeTempTree(cwd);
    }
  }, 60_000);
});
