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
  sent: () => Record<string, unknown>[];
  reply: (frame: object) => void;
  calls: { args: string[]; env: Record<string, string> }[];
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
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

    fake.reply({ id: 2, result: 'second' });
    fake.reply({ id: 1, result: 'first' });
    expect(await first).toBe('first');
    expect(await second).toBe('second');
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
