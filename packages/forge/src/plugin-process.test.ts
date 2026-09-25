import { describe, expect, test } from 'bun:test';
import { removeTempTree } from '@archon/paths/test-utils';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPluginProcess } from './plugin-process';

const fixture = join(import.meta.dir, 'fixtures', 'test-plugin.ts');
const candidate = (mode: string) => ({
  command: process.execPath,
  args: [fixture, '--mode', mode],
});

describe('forge plugin process', () => {
  test('captures Unicode JSON and exposes only the selected credential', async () => {
    const result = await runPluginProcess(candidate('structured-error'), ['op', 'resolve'], {
      env: { ...process.env, UNRELATED_SECRET: 'never-visible' },
      token: 'sëcret-value',
      stdin: JSON.stringify({
        operationId: 'op-1',
        op: 'resolve',
        remote: 'ssh://forge.example/a/b',
      }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('réfusé');
    const environment = await runPluginProcess(candidate('environment'), [], {
      env: { ...process.env, UNRELATED_SECRET: 'must-not-leak', TEST_FORGE_TOKEN: 'source-token' },
      token: 'selected-token',
    });
    expect(JSON.parse(environment.stdout)).toEqual({
      unrelated: null,
      token: 'present',
      original: null,
    });
  });

  test('redacts a token from failed process diagnostics', async () => {
    const result = await runPluginProcess(candidate('token-error'), ['op', 'resolve'], {
      env: process.env,
      token: 'token-"that-must-not-leak',
      stdin: JSON.stringify({ operationId: 'op-1', op: 'resolve', remote: null }),
    });
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain('[REDACTED]');
    expect(result.stderr).not.toContain('that-must-not-leak');
  });

  test('bounds output and terminates timed out process groups', async () => {
    const large = await runPluginProcess(candidate('large'), ['op', 'resolve'], {
      env: process.env,
      maxOutputBytes: 100,
    });
    expect(large.outputExceeded).toBe(true);

    const hung = await runPluginProcess(candidate('hang'), ['op', 'resolve'], {
      env: process.env,
      timeoutMs: 50,
    });
    expect(hung.timedOut).toBe(true);
  });

  test('terminates descendants on timeout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'archon-forge-process-'));
    const pidFile = join(directory, 'child.pid');
    try {
      const result = await runPluginProcess(
        {
          command: process.execPath,
          args: [fixture, '--mode', 'hang-child', '--pid-file', pidFile],
        },
        ['op', 'resolve'],
        { env: process.env, timeoutMs: process.platform === 'win32' ? 1000 : 300 }
      );
      expect(result.timedOut).toBe(true);
      const pid = Number(await readFile(pidFile, 'utf8'));
      let alive = true;
      for (let attempt = 0; attempt < 20 && alive; attempt++) {
        try {
          process.kill(pid, 0);
          await Bun.sleep(25);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      await removeTempTree(directory);
    }
  });
});

test.each(['plugin.cmd', 'plugin.bat'])('refuses shell shim %s without execution', async name => {
  const result = await runPluginProcess({ command: join(tmpdir(), name), args: [] }, ['metadata'], {
    env: process.env,
  });
  expect(result.spawnError).toContain('.cmd or .bat');
  expect(result.exitCode).toBeNull();
});
