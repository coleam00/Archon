import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const trackTempRoot = trackTempRoots();

test.each(['user', 'repository'])(
  'standalone server entry preserves its launching CLI command after %s env loading',
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
        const bundledBuild = await import(${JSON.stringify(resolve(import.meta.dir, '../../paths/src/bundled-build.ts'))});
        mock.module(${JSON.stringify(resolve(import.meta.dir, '../../paths/src/bundled-build.ts'))}, () => ({
          ...bundledBuild,
          BUNDLED_IS_BINARY: true,
          BUNDLED_VERSION: '1.2.3',
        }));
        const cliCommand = JSON.stringify(['/installed/archon']);
        const { runServerEntry } = await import(${JSON.stringify(join(import.meta.dir, 'bin.ts'))});
        process.env.ARCHON_CLI_COMMAND = cliCommand;
        await runServerEntry(['--cli-version', '1.2.3'], process.env, async () => {
          await import(${JSON.stringify(join(import.meta.dir, 'index.ts'))});
          return { startServer: async () => {
            if (process.env.ARCHON_CLI_COMMAND !== cliCommand) {
              throw new Error('Server entry lost the binary CLI host command');
            }
          }};
        });
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
    expect(stderr).not.toContain('Server entry lost the binary CLI host command');
    expect(exitCode).toBe(0);
  }
);
