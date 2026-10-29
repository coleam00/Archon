import { describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createMockLogger } from '../test/mocks/logger';

const log = createMockLogger();
const paths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...paths,
  createLogger: mock(() => log),
}));

import { createFakeAppServer } from '../test/codex-app-server-fake';
import { CodexProvider } from './provider';
import type { Spawner } from './app-server';
import * as pluginProcess from '@archon/paths/plugin-process';

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
  test.each([
    { attempt: 1, script: { account } },
    { attempt: 1, script: { account: null } },
    { attempt: 1, script: { account: null, requiresOpenaiAuth: false } },
    { attempt: 1, script: { accountResponse: 'invalid' } },
    { attempt: 2, script: { account } },
  ])(
    'cleanup failure in account process $attempt fails the check for $script',
    async ({ attempt, script }) => {
      const originalPlatform = process.platform;
      const stop = spyOn(pluginProcess, 'terminateTree').mockRejectedValue(
        new Error('credential cleanup refused')
      );
      const server = createFakeAppServer(() =>
        server.processes.length + 1 === attempt ? script : { account: null }
      );
      const spawner: Spawner = (command, args, options) => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const child = server(command, args, options);
        if (server.processes.length === attempt) {
          Object.defineProperty(child, 'pid', { value: 2_147_483_647 });
        }
        return child;
      };
      try {
        expect(
          await new CodexProvider(spawner, 1).checkCredential({
            env: loginFixture().env,
            signal: AbortSignal.timeout(1000),
          })
        ).toMatchObject({
          state: 'check_failed',
          source: 'native',
          evidence: expect.stringContaining('credential cleanup refused'),
        });
        expectRefreshes(server, attempt);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
        stop.mockRestore();
      }
    }
  );

  for (const attempt of [1, 2]) {
    test.each([
      { name: 'code 1', script: { stdinCloseExitCode: 1 } },
      { name: 'signal SIGTERM', script: { ignoreStdinClose: true } },
    ])(
      'process exit $name after account response in attempt ' + attempt,
      async ({ name, script }) => {
        const server = createFakeAppServer(() =>
          server.processes.length + 1 === attempt ? { account, ...script } : { account: null }
        );
        expect(
          await new CodexProvider(server, 1).checkCredential({
            env: loginFixture().env,
            signal: AbortSignal.timeout(1000),
          })
        ).toMatchObject({
          state: 'check_failed',
          source: 'native',
          evidence: expect.stringContaining(name),
        });
        expectRefreshes(server, attempt);
      }
    );

    for (const method of ['initialize', 'account/read'] as const) {
      test.each([{ cleanupFails: false }, { cleanupFails: true }])(
        method + ' rejection in attempt ' + attempt + ' with cleanup failure $cleanupFails',
        async ({ cleanupFails }) => {
          const originalPlatform = process.platform;
          const secret = 'fixture-rpc-cleanup-secret';
          const stop = spyOn(pluginProcess, 'terminateTree').mockImplementation(async () => {
            if (cleanupFails) throw new Error(`cleanup refused ${secret}`);
          });
          const server = createFakeAppServer(() =>
            server.processes.length + 1 === attempt
              ? { errors: { [method]: { code: -32603, message: `RPC refused ${secret}` } } }
              : { account: null }
          );
          const spawner: Spawner = (command, args, options) => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            const child = server(command, args, options);
            if (server.processes.length === attempt) {
              Object.defineProperty(child, 'pid', { value: 2_147_483_647 });
            }
            return child;
          };
          try {
            const status = await new CodexProvider(spawner, 1).checkCredential({
              env: { ...loginFixture().env, TEST_SECRET: secret },
              signal: AbortSignal.timeout(1000),
            });
            if (status.state !== 'check_failed') throw new Error('Expected check_failed');
            expect(status.source).toBe('native');
            expect(status.evidence).toContain('RPC refused [REDACTED]');
            expect(status.evidence).not.toContain(secret);
            if (cleanupFails) expect(status.evidence).toContain('cleanup refused [REDACTED]');
            expect(server.processes).toHaveLength(attempt);
            expect(server.processes.at(-1)?.methods).toEqual(
              method === 'initialize' ? ['initialize'] : ['initialize', 'account/read']
            );
            expect(server.processes.every(process => process.stdinEnded)).toBe(true);
            expect(stop).toHaveBeenCalledTimes(1);
          } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
            stop.mockRestore();
          }
        }
      );
    }
  }

  test('two simultaneous refreshes succeed after the loser reloads the saved login', async () => {
    log.info.mockClear();
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
    expect(
      log.info.mock.calls.filter(([, event]) => event === 'codex.native_login_rechecked')
    ).toEqual([[{ state: 'usable' }, 'codex.native_login_rechecked']]);
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

  for (const { attempt, state, script } of [
    { attempt: 1, state: 'unusable', script: { account: null } },
    { attempt: 2, state: 'usable', script: { account } },
  ]) {
    test(`abort during process ${attempt} shutdown overrides ${state} before exit`, async () => {
      log.info.mockClear();
      const controller = new AbortController();
      const shuttingDown = Promise.withResolvers<void>();
      const terminated = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      let spawned = 0;
      const server = createFakeAppServer(() =>
        ++spawned === attempt ? { ...script, ignoreStdinClose: true } : { account: null }
      );
      const spawner: Spawner = (command, args, options) => {
        const child = server(command, args, options);
        if (spawned === attempt) {
          child.stdin.once('finish', () => shuttingDown.resolve());
          child.once('close', () => closed.resolve());
          child.kill = () => {
            terminated.resolve();
            return true;
          };
        }
        return child;
      };
      const check = new CodexProvider(spawner, 1).checkCredential({
        env: { CODEX_API_KEY: '' },
        signal: controller.signal,
      });
      try {
        await shuttingDown.promise;
        controller.abort(new Error('cancelled during shutdown'));
        const result = await Promise.race([
          check,
          new Promise<'still waiting'>(resolve => setImmediate(() => resolve('still waiting'))),
        ]);
        expect(result).toMatchObject({
          state: 'check_failed',
          evidence: 'cancelled during shutdown',
        });
        expectRefreshes(server, attempt);
        expect(
          log.info.mock.calls.filter(([, event]) => event === 'codex.native_login_rechecked')
        ).toEqual([]);
        await terminated.promise;
      } finally {
        server.processes.at(-1)?.exit(0);
        await closed.promise;
        await check;
      }
    });
  }
});
