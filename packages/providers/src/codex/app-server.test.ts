import { describe, test, expect, mock } from 'bun:test';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { createMockLogger } from '../test/mocks/logger';

mock.module('@archon/paths', () => ({
  createLogger: mock(() => createMockLogger()),
}));

import {
  AppServerConnection,
  ConnectionClosedError,
  JsonRpcError,
  type Spawner,
} from './app-server';

/** A child whose stdout the test writes and whose stdin the test reads. */
function rawChild(onKill: (child: EventEmitter, signal: string) => void = () => undefined): {
  spawner: Spawner;
  child: ChildProcessWithoutNullStreams;
  stdout: PassThrough;
  stderr: PassThrough;
  sent: () => Record<string, unknown>[];
  reply: (frame: object) => void;
  calls: { args: string[]; env: Record<string, string> }[];
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 7,
    kill: (signal: string) => {
      onKill(child, signal);
      return true;
    },
  }) as unknown as ChildProcessWithoutNullStreams;
  let written = '';
  stdin.on('data', (chunk: Buffer) => {
    written += chunk.toString();
  });
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  return {
    spawner: ((_command, args, options) => {
      calls.push({ args, env: options.env });
      return child;
    }) as Spawner,
    child,
    stdout,
    stderr,
    sent: () =>
      written
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>),
    reply: frame => stdout.write(`${JSON.stringify(frame)}\n`),
    calls,
  };
}

const BINARY = { path: '/bin/codex', pathDirs: ['/vendor/codex-path'] };
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('AppServerConnection', () => {
  test('starts app-server with the extra args and the helper dirs first on PATH', () => {
    const fake = rawChild();
    AppServerConnection.start(BINARY, ['-c', 'x=1'], { PATH: '/usr/bin' }, fake.spawner);
    expect(fake.calls[0]).toEqual({
      args: ['app-server', '-c', 'x=1'],
      env: { PATH: `/vendor/codex-path${process.platform === 'win32' ? ';' : ':'}/usr/bin` },
    });
  });

  test('resolves responses by id, in whatever order they arrive', async () => {
    const fake = rawChild();
    const connection = AppServerConnection.start(BINARY, [], {}, fake.spawner);
    const first = connection.request('thread/start', {});
    const second = connection.request('account/read', {});
    await tick();
    const [a, b] = fake.sent();
    expect(a).toMatchObject({ id: 1, method: 'thread/start' });
    expect(b).toMatchObject({ id: 2, method: 'account/read' });

    fake.reply({ id: 2, result: { account: null, requiresOpenaiAuth: true } });
    fake.reply({ id: 1, result: 'first' });
    expect(await first).toBe('first');
    expect(await second).toEqual({ account: null, requiresOpenaiAuth: true });
  });

  test('frames split across reads, or sharing one, are each read whole', async () => {
    const fake = rawChild();
    const connection = AppServerConnection.start(BINARY, [], {}, fake.spawner);
    const first = connection.request('thread/start', {});
    const second = connection.request('account/read', {});
    fake.stdout.write('{"id":1,"result":"fi');
    await tick();
    fake.stdout.write('rst"}\n{"id":2,"result":{"account":null,"requiresOpenaiAuth":true}}\n');
    expect(await first).toBe('first');
    expect(await second).toEqual({ account: null, requiresOpenaiAuth: true });
  });

  test('a JSON-RPC error rejects with its code and the method', async () => {
    const fake = rawChild();
    const connection = AppServerConnection.start(BINARY, [], {}, fake.spawner);
    const pending = connection.request('thread/resume', { threadId: 'gone' });
    fake.reply({ id: 1, error: { code: -32600, message: 'no rollout found' } });

    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcError);
    expect(error).toMatchObject({ code: -32600, method: 'thread/resume' });
    expect((error as Error).message).toContain('no rollout found');
  });

  test('a request from Codex gets an error reply with its id, so the turn never stalls', async () => {
    const fake = rawChild();
    AppServerConnection.start(BINARY, [], {}, fake.spawner);
    fake.reply({ id: 'srv-9', method: 'item/commandExecution/requestApproval', params: {} });
    await tick();
    expect(fake.sent()).toEqual([
      {
        id: 'srv-9',
        error: {
          code: -32601,
          message: 'Archon does not handle item/commandExecution/requestApproval',
        },
      },
    ]);
  });

  test('the process ending fails pending requests and ends notifications after the last frame', async () => {
    const fake = rawChild();
    const connection = AppServerConnection.start(BINARY, [], {}, fake.spawner);
    const pending = connection.request('turn/start', { threadId: 't', input: [] });
    fake.reply({ method: 'turn/started', params: {} });
    await tick();
    fake.child.emit('close', 1, null);

    const methods: string[] = [];
    for await (const notification of connection.notifications()) methods.push(notification.method);
    expect(methods).toEqual(['turn/started']);
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionClosedError);
    expect((error as Error).message).toContain('exited (code 1)');
  });

  test('a process ending keeps the tail of its stderr as evidence, off the error message', async () => {
    const fake = rawChild();
    const connection = AppServerConnection.start(BINARY, [], {}, fake.spawner);
    const pending = connection.request('initialize', {
      clientInfo: { name: 'archon', title: null, version: '0' },
      capabilities: null,
    });
    fake.stderr.write('x'.repeat(10_000));
    for (let line = 1; line <= 20; line++) fake.stderr.write(`log line ${String(line)}\n`);
    fake.stderr.write('Error: stdin is not a terminal\n');
    await tick();
    fake.child.emit('close', 1, null);

    const error = (await pending.catch((e: unknown) => e)) as ConnectionClosedError;
    expect(error.beforeFirstResponse).toBe(true);
    expect(error.message).not.toContain('stdin is not a terminal');
    expect(error.evidence).toContain('exited (code 1)');
    expect(error.evidence).toContain('Error: stdin is not a terminal');
    // The last ten lines only.
    expect(error.evidence).toContain('log line 20');
    expect(error.evidence).not.toContain('log line 10\n');
    expect(error.evidence).not.toContain('xxx');
  });

  test('a credential is redacted before the evidence is cut, so the cut cannot leave its tail', async () => {
    const key = 'sk-straddle-0123456789';
    const fake = rawChild();
    const connection = AppServerConnection.start(BINARY, [], { CODEX_API_KEY: key }, fake.spawner);
    const pending = connection.request('initialize', {
      clientInfo: { name: 'archon', title: null, version: '0' },
      capabilities: null,
    });
    // One 1017-char line whose last 1000 chars begin seven chars into the key: cutting
    // first would leave `ddle-0123456789`, which no later redaction recognises.
    fake.stderr.write(`${'a'.repeat(10)}${key}${'b'.repeat(985)}\n`);
    await tick();
    fake.child.emit('close', 1, null);

    const error = (await pending.catch((e: unknown) => e)) as ConnectionClosedError;
    const stderr = error.evidence.slice(error.evidence.indexOf('stderr:\n') + 'stderr:\n'.length);
    expect(stderr).toContain('[REDACTED]');
    expect(stderr).not.toContain('0123456789');
    expect(stderr.length).toBeLessThanOrEqual(1000);
  });

  test('shutdown closes stdin and sends SIGTERM only when the process does not exit', async () => {
    const signalsOnExit: string[] = [];
    const exits = rawChild((_child, signal) => signalsOnExit.push(signal));
    exits.child.stdin.on('finish', () => exits.child.emit('close', 0, null));
    await AppServerConnection.start(BINARY, [], {}, exits.spawner).shutdown(50);
    expect(signalsOnExit).toEqual([]);

    const signals: string[] = [];
    const hangs = rawChild((child, signal) => {
      signals.push(signal);
      child.emit('close', null, signal);
    });
    await AppServerConnection.start(BINARY, [], {}, hangs.spawner).shutdown(20);
    expect(signals).toEqual(['SIGTERM']);
  });
});

describe('Codex native credential check', () => {
  const env = { CODEX_API_KEY: '', TEST_SECRET: 'planted-codex-secret' };
  const check = async (script: import('../test/codex-app-server-fake').FakeTurnScript) => {
    const { CodexProvider } = await import('./provider');
    const { createFakeAppServer } = await import('../test/codex-app-server-fake');
    const server = createFakeAppServer(() => script);
    const status = await new CodexProvider(server, 1).checkCredential({
      env,
      signal: AbortSignal.timeout(1000),
    });
    expect(server.processes[0]?.methods).toEqual(['initialize', 'account/read']);
    expect(server.processes[0]?.requests[1]?.params).toEqual({ refreshToken: false });
    expect(server.processes[0]?.stdinEnded).toBe(true);
    return status;
  };

  test('an account is usable', async () => {
    expect(await check({ account: { type: 'chatgpt', email: null, planType: 'plus' } })).toEqual({
      state: 'usable',
      source: 'native',
    });
  });
  test('no account is unusable', async () => {
    expect(await check({ account: null })).toMatchObject({
      state: 'unusable',
      evidence: expect.stringContaining('codex login'),
    });
  });
  test('JSON-RPC errors are check_failed and redact secrets', async () => {
    const { checkCredentialStatuses } = await import('@archon/provider-contract/conformance');
    expect(
      await checkCredentialStatuses([
        {
          name: 'Codex error',
          expected: 'check_failed',
          secret: env.TEST_SECRET,
          check: () =>
            check({
              errors: {
                'account/read': { code: -32600, message: `cannot verify ${env.TEST_SECRET}` },
              },
            }),
        },
      ])
    ).toEqual([]);
  });
  test('an abort stops an unanswered account read', async () => {
    expect(await check({ ignoreAccountRead: true })).toMatchObject({ state: 'check_failed' });
  });
  test('CODEX_API_KEY is usable without starting a process', async () => {
    const { CodexProvider } = await import('./provider');
    const spawner = mock(() => {
      throw new Error('must not spawn');
    });
    const { checkCredentialStatuses } = await import('@archon/provider-contract/conformance');
    expect(
      await checkCredentialStatuses([
        {
          name: 'Codex API key',
          expected: 'usable',
          secret: 'planted-key',
          check: () =>
            new CodexProvider(spawner).checkCredential({
              env: { CODEX_API_KEY: 'planted-key' },
              signal: new AbortController().signal,
            }),
        },
      ])
    ).toEqual([]);
    expect(spawner).not.toHaveBeenCalled();
  });
});
