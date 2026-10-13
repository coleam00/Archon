import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots, testTimeout } from '@archon/paths/test-utils';

const track = trackTempRoots();
const cliDir = join(import.meta.dir, '..', 'packages', 'cli');

async function runCliTests(home: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  const child = Bun.spawn([process.execPath, 'run', 'test', ...args], {
    cwd: cliDir,
    env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1', ARCHON_HOME: home, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ status, output: status === 0 ? '' : stdout + stderr }).toEqual({
    status: 0,
    output: '',
  });
  expect(readdirSync(home)).toEqual([]);
}

test(
  'the CLI package test command leaves its inherited Archon home empty',
  async () => {
    const home = track(mkdtempSync(join(tmpdir(), 'archon-cli-package-sentinel-')));
    await runCliTests(home, { ARCHON_DOCKER: '', WORKSPACE_PATH: '' });
  },
  testTimeout(300_000)
);

for (const [name, env] of [
  ['explicit Docker flag', { ARCHON_DOCKER: 'true', WORKSPACE_PATH: '' }],
  ['Docker workspace', { ARCHON_DOCKER: '', WORKSPACE_PATH: '/workspace' }],
  [
    'root with a workspace',
    { ARCHON_DOCKER: '', WORKSPACE_PATH: '/test/workspace', HOME: '/root' },
  ],
] as const) {
  test(
    `CLI fixtures own their homes with an inherited ${name}`,
    async () => {
      const home = track(mkdtempSync(join(tmpdir(), 'archon-cli-docker-sentinel-')));
      await runCliTests(home, env, [
        'src/commands/workflow.test.ts',
        '-t',
        'spawns a detached child with its pending run and branch',
      ]);
      await runCliTests(home, env, [
        'src/cli.test.ts',
        '-t',
        'still accepts a valid workflow dry-run invocation',
      ]);
    },
    testTimeout(20_000)
  );
}
