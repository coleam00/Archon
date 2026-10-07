import { expect, mock, test } from 'bun:test';
import { runServerEntry } from './bin';
import { BUNDLED_VERSION } from '@archon/paths/bundled-build';
import { serverLaunchArgv } from '@archon/paths/server-launch';

const env = { ARCHON_CLI_COMMAND: '["archon"]' };

test('matching launcher starts the server with parsed overrides', async () => {
  const startServer = mock(async () => {});
  const loadServer = mock(async () => ({ startServer }));
  await runServerEntry(
    serverLaunchArgv({ cliVersion: BUNDLED_VERSION, port: 8080, webDistPath: '/web dist' }),
    env,
    loadServer
  );
  expect(loadServer).toHaveBeenCalledTimes(1);
  expect(startServer).toHaveBeenCalledWith({ port: 8080, webDistPath: '/web dist' });
});

test('application env loading cannot replace the validated launcher command', async () => {
  const launchEnv = { ARCHON_CLI_COMMAND: '["/installed/archon"]' };
  const command = launchEnv.ARCHON_CLI_COMMAND;
  const startServer = mock(async () => {
    expect(launchEnv.ARCHON_CLI_COMMAND).toBe(command);
  });
  await runServerEntry(['--cli-version', BUNDLED_VERSION], launchEnv, async () => {
    launchEnv.ARCHON_CLI_COMMAND = '["/wrong/archon-server"]';
    return { startServer };
  });
  expect(startServer).toHaveBeenCalledTimes(1);
});

test('mismatch refuses before importing application code and names both versions', async () => {
  const loadServer = mock(async () => ({ startServer: async () => {} }));
  await expect(runServerEntry(['--cli-version', '0.0.0'], env, loadServer)).rejects.toThrow(
    `archon-server version ${BUNDLED_VERSION} does not match CLI version 0.0.0`
  );
  expect(loadServer).not.toHaveBeenCalled();
});

test.each([
  { argv: [], env },
  { argv: ['--cli-version', BUNDLED_VERSION], env: {} },
  { argv: ['--cli-version', BUNDLED_VERSION], env: { ARCHON_CLI_COMMAND: '' } },
])('missing launch contract refuses without importing application code: %j', async input => {
  const loadServer = mock(async () => ({ startServer: async () => {} }));
  await expect(runServerEntry(input.argv, input.env, loadServer)).rejects.toThrow(
    'archon-server is started by `archon serve`'
  );
  expect(loadServer).not.toHaveBeenCalled();
});

test.each([
  {
    argv: ['--cli-version', '0.0.0'],
    command: '["archon"]',
    message: `server version ${BUNDLED_VERSION} does not match CLI version 0.0.0`,
  },
  { argv: [], command: '', message: 'archon-server is started by `archon serve`' },
])('source executable exits non-zero on refusal: %j', async input => {
  const child = Bun.spawn(
    [process.execPath, '--no-env-file', `${import.meta.dir}/bin.ts`, ...input.argv],
    {
      env: { ...process.env, ARCHON_CLI_COMMAND: input.command },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain(input.message);
  expect(stdout).toBe('');
});

test.each([
  { option: 'cli-version', argv: ['--cli-version', '0.0.0', '--cli-version=dev'] },
  { option: 'port', argv: ['--cli-version', 'dev', '--port', '8080', '--port=8081'] },
  {
    option: 'web-dist',
    argv: ['--cli-version', 'dev', '--web-dist', '/first', '--web-dist=/second'],
  },
])('repeated --$option refuses before importing application code', async ({ option, argv }) => {
  const loadServer = mock(async () => ({ startServer: async () => {} }));
  await expect(runServerEntry(argv, env, loadServer)).rejects.toThrow(
    `--${option} may only be supplied once`
  );
  expect(loadServer).not.toHaveBeenCalled();
});
