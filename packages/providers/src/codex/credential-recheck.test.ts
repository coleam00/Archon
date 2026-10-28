import { describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createMockLogger } from '../test/mocks/logger';

const log = createMockLogger();
mock.module('@archon/paths', () => ({ createLogger: mock(() => log) }));

import { createFakeAppServer } from '../test/codex-app-server-fake';
import { CodexProvider } from './provider';
import type { Spawner } from './app-server';

const trackTempRoot = trackTempRoots();
const account = { type: 'chatgpt', email: 'fixture@example.test', planType: 'pro' } as const;

function loginFixture() {
  const home = trackTempRoot(mkdtempSync(join(tmpdir(), 'codex-recheck-')));
  const path = join(home, 'auth.json');
  const original = JSON.stringify({ refresh_token: 'fixture-old-refresh-token' });
  writeFileSync(path, original);
  return { path, original, env: { CODEX_HOME: home, CODEX_API_KEY: '' } };
}

function expectRefreshes(server: ReturnType<typeof createFakeAppServer>, count: number) {
  expect(server.processes).toHaveLength(count);
  for (const process of server.processes) {
    expect(process.methods).toEqual(['initialize', 'account/read']);
    expect(process.requests[1]?.params).toEqual({ refreshToken: true });
    expect(process.stdinEnded).toBe(true);
    expect(process.env).toEqual(server.processes[0]?.env);
    expect(process.binary).toBe(server.processes[0]?.binary);
  }
}

describe('Codex native login recheck', () => {
  test('two simultaneous refreshes succeed after the loser reloads the saved login', async () => {
    const fixture = loginFixture();
    const refreshed = JSON.stringify({ refresh_token: 'fixture-new-refresh-token' });
    const loaded: string[] = [];
    const waiting: (() => void)[] = [];
    const bothReading = Promise.withResolvers<void>();
    const server = createFakeAppServer(() => {
      const login = readFileSync(fixture.path, 'utf8');
      loaded.push(login);
      // Both first processes load the old token. The winner saves a new one; the
      // loser keeps its now-reused token and reports no account, as Codex does.
      const reused = loaded.length === 2 && login === fixture.original;
      return {
        account: reused ? null : account,
        deferAccountRead: answer => {
          if (login === refreshed) answer();
          else {
            waiting.push(() => {
              if (!reused) writeFileSync(fixture.path, refreshed);
              answer();
            });
            if (waiting.length === 2) bothReading.resolve();
          }
        },
      };
    });
    const provider = new CodexProvider(server, 1);
    const signal = AbortSignal.timeout(1000);
    const winner = provider.checkCredential({ env: fixture.env, signal });
    const loser = provider.checkCredential({ env: fixture.env, signal });
    await bothReading.promise;
    expect(loaded).toEqual([fixture.original, fixture.original]);
    expect(server.processes.every(process => !process.stdinEnded)).toBe(true);
    for (const answer of waiting) answer();

    expect(await Promise.all([winner, loser])).toEqual([
      { state: 'usable', source: 'native' },
      { state: 'usable', source: 'native' },
    ]);
    expect(loaded).toEqual([fixture.original, fixture.original, refreshed]);
    expect(readFileSync(fixture.path, 'utf8')).toBe(refreshed);
    expectRefreshes(server, 3);
  });

  test('persistent refresh rejection is unusable after two reads and leaves the login unchanged', async () => {
    const fixture = loginFixture();
    const loaded: string[] = [];
    const server = createFakeAppServer(() => {
      loaded.push(readFileSync(fixture.path, 'utf8'));
      return { account: null };
    });
    log.info.mockClear();
    expect(
      await new CodexProvider(server, 1).checkCredential({
        env: fixture.env,
        signal: AbortSignal.timeout(1000),
      })
    ).toMatchObject({ state: 'unusable', evidence: expect.stringContaining('codex login') });
    expectRefreshes(server, 2);
    expect(loaded).toEqual([fixture.original, fixture.original]);
    expect(readFileSync(fixture.path, 'utf8')).toBe(fixture.original);
    expect(
      log.info.mock.calls.filter(([, event]) => event === 'codex.native_login_rechecked')
    ).toEqual([[{ state: 'unusable' }, 'codex.native_login_rechecked']]);
  });

  test('cancellation during first-process shutdown prevents a fresh process', async () => {
    const controller = new AbortController();
    const server = createFakeAppServer(() => ({ account: null, ignoreStdinClose: true }));
    const spawner: Spawner = (command, args, options) => {
      const child = server(command, args, options);
      const process = server.processes.at(-1);
      child.stdin.once('finish', () => {
        controller.abort(new Error('cancelled during shutdown'));
        setImmediate(() => process?.exit(0));
      });
      return child;
    };
    expect(
      await new CodexProvider(spawner, 1).checkCredential({
        env: { CODEX_API_KEY: '' },
        signal: controller.signal,
      })
    ).toMatchObject({ state: 'check_failed', evidence: 'cancelled during shutdown' });
    expectRefreshes(server, 1);
  });
});
