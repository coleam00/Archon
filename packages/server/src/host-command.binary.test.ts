import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const trackTempRoot = trackTempRoots();

// Each case cold-imports the whole server graph in a fresh Bun process. Under the parallel CI
// suite that alone measured 5 s on ubuntu and 10.8 s on Windows, so the default budget is too
// small for the work, not a sign of a hang (the child exits as soon as the import finishes).
const SERVER_IMPORT_BUDGET_MS = 30_000;

test.each(['user', 'repository'])(
  'in-process binary CLI server import republishes its host command after %s env loading',
  async scope => {
    const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-server-binary-host-')));
    const home = join(root, 'home');
    const repo = join(root, 'repo');
    mkdirSync(home);
    mkdirSync(join(repo, '.archon'), { recursive: true });
    const envPath = scope === 'user' ? join(home, '.env') : join(repo, '.archon', '.env');
    writeFileSync(envPath, 'ARCHON_CLI_COMMAND=malformed-command\n');
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        '-e',
        `
        import { mock } from 'bun:test';
        mock.module(${JSON.stringify(resolve(import.meta.dir, '../../paths/src/bundled-build.ts'))}, () => ({
          BUNDLED_IS_BINARY: true,
          BUNDLED_VERSION: '1.2.3',
          BUNDLED_GIT_COMMIT: 'test',
          BUNDLED_WEB_DIST_SHA256: '',
        }));
        const { publishArchonCliCommand } = await import(${JSON.stringify(resolve(import.meta.dir, '../../paths/src/cli-command.ts'))});
        publishArchonCliCommand();
        await import(${JSON.stringify(join(import.meta.dir, 'index.ts'))});
        if (process.env.ARCHON_CLI_COMMAND !== JSON.stringify([process.execPath])) {
          throw new Error('Server import lost the binary CLI host command');
        }
        `,
      ],
      {
        cwd: repo,
        env: { ...process.env, ARCHON_HOME: home },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(stderr).not.toContain('Server import lost the binary CLI host command');
    expect(exitCode).toBe(0);
  },
  SERVER_IMPORT_BUDGET_MS
);
