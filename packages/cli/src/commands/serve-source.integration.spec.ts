import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const repoRoot = resolve(import.meta.dir, '../../../..');
const cliEntry = join(repoRoot, 'packages/cli/src/cli.ts');

test('source archon serve starts the server on the requested port and serves the built console', async () => {
  const build = Bun.spawn([process.execPath, 'run', 'build:web'], {
    cwd: repoRoot,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  expect(await build.exited).toBe(0);

  const root = mkdtempSync(join(tmpdir(), 'archon-source-serve-'));
  const stdout = join(root, 'stdout.log');
  const stderr = join(root, 'stderr.log');
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const envReservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = reservation.port;
  const envPort = envReservation.port;
  await reservation.stop(true);
  await envReservation.stop(true);
  let serverPid: number | undefined;
  const child = Bun.spawn(
    [process.execPath, '--no-env-file', cliEntry, 'serve', '--port', String(port)],
    {
      cwd: root,
      env: {
        ...process.env,
        ARCHON_HOME: join(root, 'home'),
        DATABASE_URL: '',
        WEB_AUTH_ENABLED: 'false',
        PORT: String(envPort),
        TELEGRAM_BOT_TOKEN: '',
        DISCORD_BOT_TOKEN: '',
        SLACK_BOT_TOKEN: '',
        GITEA_TOKEN: '',
        GITLAB_TOKEN: '',
        WEBHOOK_SECRET: '',
        GITHUB_APP_ID: '',
        LOG_LEVEL: 'info',
        CLAUDE_USE_GLOBAL_AUTH: 'true',
        ARCHON_TELEMETRY_DISABLED: '1',
      },
      stdin: 'ignore',
      stdout: Bun.file(stdout),
      stderr: Bun.file(stderr),
    }
  );
  try {
    let ready = false;
    let serverReady = false;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const output = readFileSync(stdout, 'utf8');
      for (const line of output.split('\n')) {
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          typeof event === 'object' &&
          event !== null &&
          'msg' in event &&
          event.msg === 'server_ready'
        )
          serverReady = true;
        if (
          typeof event === 'object' &&
          event !== null &&
          'msg' in event &&
          event.msg === 'server.spawned' &&
          'serverPid' in event &&
          typeof event.serverPid === 'number'
        )
          serverPid = event.serverPid;
      }
      if (child.exitCode !== null)
        throw new Error(
          `serve exited ${child.exitCode}:\n${output}\n${readFileSync(stderr, 'utf8')}`
        );
      try {
        const health = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(1000),
        });
        ready = health.ok && serverReady && serverPid !== undefined;
      } catch {
        // The child has not bound its listening socket yet.
      }
      if (ready) break;
      await Bun.sleep(100);
    }
    expect(ready, `${readFileSync(stdout, 'utf8')}\n${readFileSync(stderr, 'utf8')}`).toBe(true);
    const consoleResponse = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1000),
    });
    expect(consoleResponse.ok).toBe(true);
    expect(await consoleResponse.text()).toContain('<!doctype html>');
  } finally {
    // Windows does not deliver SIGTERM to the launcher handler.
    if (process.platform === 'win32' && serverPid !== undefined) process.kill(serverPid);
    child.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Not `child.exitCode === null`: a launcher killed by a signal (always the
      // case on Windows) exits with a null exitCode and a signalCode instead.
      const exitedInTime = await Promise.race([
        child.exited.then(() => true),
        new Promise<false>(resolve => {
          timer = setTimeout(() => resolve(false), 10_000);
        }),
      ]);
      if (!exitedInTime) {
        if (serverPid !== undefined) process.kill(serverPid, 'SIGKILL');
        child.kill('SIGKILL');
      }
      const code = await child.exited;
      if (process.platform !== 'win32') expect(code).toBe(0);
    } finally {
      clearTimeout(timer);
      await removeTempTree(root);
    }
  }
}, 120_000);
