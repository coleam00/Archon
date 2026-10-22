import { describe, test, expect, mock } from 'bun:test';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { createMockLogger } from '../test/mocks/logger';

const log = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => log),
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
  test('drains accepted tool calls on closure and accepts no later calls', async () => {
    const fake = rawChild();
    const connection = AppServerConnection.start(BINARY, [], {}, fake.spawner);
    const complete = Promise.withResolvers<void>();
    const handler = mock(async () => {
      await complete.promise;
      return { success: true, contentItems: [] };
    });
    connection.handleToolCalls(handler);
    fake.reply({ id: 'accepted', method: 'item/tool/call', params: {} });
    await tick();
    fake.child.emit('close', 1, null);
    let drained = false;
    const draining = connection.finishToolCalls().then(() => {
      drained = true;
    });
    fake.reply({ id: 'too-late', method: 'item/tool/call', params: {} });
    await tick();
    expect(drained).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
    complete.resolve();
    await draining;
    expect(drained).toBe(true);
    expect(fake.sent()).toEqual([]);
  });

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

    fake.reply({
      id: 2,
      result: { account: null, requiresOpenaiAuth: true, workspaceRouting: null },
    });
    fake.reply({ id: 1, result: 'first' });
    expect(await first).toBe('first');
    expect(await second).toEqual({
      account: null,
      requiresOpenaiAuth: true,
      workspaceRouting: null,
    });
  });

  test('frames split across reads, or sharing one, are each read whole', async () => {
    const fake = rawChild();
    const connection = AppServerConnection.start(BINARY, [], {}, fake.spawner);
    const first = connection.request('thread/start', {});
    const second = connection.request('account/read', {});
    fake.stdout.write('{"id":1,"result":"fi');
    await tick();
    fake.stdout.write(
      'rst"}\n{"id":2,"result":{"account":null,"requiresOpenaiAuth":true,"workspaceRouting":null}}\n'
    );
    expect(await first).toBe('first');
    expect(await second).toEqual({
      account: null,
      requiresOpenaiAuth: true,
      workspaceRouting: null,
    });
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

  test('a ChatGPT token refresh request is declined as a refresh, not as an unknown method', async () => {
    const fake = rawChild();
    AppServerConnection.start(BINARY, [], {}, fake.spawner);
    fake.reply({
      id: 7,
      method: 'account/chatgptAuthTokens/refresh',
      params: { reason: 'unauthorized', previousAccountId: 'acct-1' },
    });
    await tick();
    expect(fake.sent()).toEqual([
      {
        id: 7,
        error: {
          code: -32000,
          message: 'Archon cannot refresh the delivered ChatGPT token during a turn',
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

  test('answers asynchronous host-tool requests on their JSON-RPC id and declines other requests', async () => {
    const fake = rawChild();
    const connection = AppServerConnection.start(BINARY, [], {}, fake.spawner);
    const pending =
      Promise.withResolvers<
        import('./protocol/v2/DynamicToolCallResponse').DynamicToolCallResponse
      >();
    const handler = mock(() => pending.promise);
    connection.handleToolCalls(handler);
    fake.reply({
      id: 'tool-request',
      method: 'item/tool/call',
      params: { tool: 'invoke_workflow' },
    });
    fake.reply({ id: 999, method: 'item/commandExecution/requestApproval', params: {} });
    await tick();
    expect(handler).toHaveBeenCalledWith({ tool: 'invoke_workflow' });
    expect(fake.sent()).toEqual([
      {
        id: 999,
        error: {
          code: -32601,
          message: 'Archon does not handle item/commandExecution/requestApproval',
        },
      },
    ]);
    pending.resolve({ success: true, contentItems: [{ type: 'inputText', text: 'Queued' }] });
    await tick();
    expect(fake.sent().at(-1)).toEqual({
      id: 'tool-request',
      result: { success: true, contentItems: [{ type: 'inputText', text: 'Queued' }] },
    });
  });

  test('malformed host calls fail without invoking a tool handler', async () => {
    const { buildCodexNativeTools } = await import('./native-tools');
    const fake = rawChild();
    const connection = AppServerConnection.start(BINARY, [], {}, fake.spawner);
    const handler = mock(() => Promise.resolve('no'));
    const tools = buildCodexNativeTools([
      { name: 'test', description: '', inputSchema: { properties: {}, required: [] }, handler },
    ]);
    connection.handleToolCalls(params => tools.call(params, 't', 'u'));
    for (const params of [null, {}, { threadId: 't', turnId: 'u', tool: 'test', arguments: {} }]) {
      fake.reply({ id: 'bad', method: 'item/tool/call', params });
    }
    await tick();
    expect(fake.sent()).toHaveLength(3);
    for (const frame of fake.sent())
      expect(frame).toMatchObject({ id: 'bad', result: { success: false } });
    expect(handler).not.toHaveBeenCalled();
  });

  test('shutdown closes stdin and sends SIGTERM only when asked and the process does not exit', async () => {
    const signalsOnExit: string[] = [];
    const exits = rawChild((_child, signal) => signalsOnExit.push(signal));
    exits.child.stdin.on('finish', () => exits.child.emit('close', 0, null));
    await AppServerConnection.start(BINARY, [], {}, exits.spawner).shutdown(50);
    expect(signalsOnExit).toEqual([]);

    // Without a SIGTERM deadline a slow exit is awaited, however long past any grace.
    const slowSignals: string[] = [];
    const slow = rawChild((_child, signal) => slowSignals.push(signal));
    slow.child.stdin.on('finish', () => setTimeout(() => slow.child.emit('close', 0, null), 60));
    const end = await AppServerConnection.start(BINARY, [], {}, slow.spawner).shutdown(
      undefined,
      20
    );
    expect(slowSignals).toEqual([]);
    expect(end).toEqual({ kind: 'exited', code: 0, signal: null });

    const signals: string[] = [];
    const hangs = rawChild((child, signal) => {
      signals.push(signal);
      child.emit('close', null, signal);
    });
    await AppServerConnection.start(BINARY, [], {}, hangs.spawner).shutdown(20);
    expect(signals).toEqual(['SIGTERM']);
  });

  test('shutdown has no deadline after SIGTERM: a Codex still exiting is awaited until it exits', async () => {
    // A Codex on a loaded machine keeps exiting long after SIGTERM, then exits 0. It closes
    // only once the second still-exiting warning is logged, so the wait must outlast
    // several warning intervals and report each one, however slow the event loop is.
    log.warn.mockClear();
    const waits = (): number[] =>
      log.warn.mock.calls
        .filter(([, event]) => event === 'codex.app_server_still_exiting')
        .map(([fields]) => (fields as { waitedMs: number }).waitedMs);
    const slow = rawChild(child => {
      const poll = setInterval(() => {
        if (waits().length < 2) return;
        clearInterval(poll);
        child.emit('close', 0, null);
      }, 5);
    });
    const end = await AppServerConnection.start(BINARY, [], {}, slow.spawner).shutdown(5, 20);
    expect(end).toEqual({ kind: 'exited', code: 0, signal: null });
    expect(waits().slice(0, 2)).toEqual([20, 40]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: 'process_still_exiting', waitedMs: 40 }),
      'codex.app_server_still_exiting'
    );
  }, 5_000);

  test('an unparseable app-server line is logged by length only, never its text', async () => {
    log.warn.mockClear();
    const fake = rawChild();
    AppServerConnection.start(BINARY, [], {}, fake.spawner);
    const sentinel = 'user-text-sentinel-7f3a';
    fake.stdout.write(`not json ${sentinel}\n`);
    await tick();
    const calls = log.warn.mock.calls.filter(
      ([, event]) => event === 'codex.app_server_unparseable_line'
    );
    expect(calls).toEqual([
      [{ bytes: Buffer.byteLength(`not json ${sentinel}`) }, 'codex.app_server_unparseable_line'],
    ]);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(sentinel);
  });

  test.each(['null', '42', '["private-user-text-ø"]', '"private-user-text-ø"', 'true'])(
    'a non-object JSON line %s is logged by length and later frames still work',
    async line => {
      log.warn.mockClear();
      const fake = rawChild();
      const connection = AppServerConnection.start(BINARY, [], {}, fake.spawner);
      const response = connection.request('thread/start', {});
      const notifications = connection.notifications();
      fake.stdout.write(
        `${line}\n{"id":1,"result":"ok"}\n{"method":"thread/archived","params":{"threadId":"t"}}\n`
      );

      expect(await response).toBe('ok');
      expect(await notifications.next()).toEqual({
        done: false,
        value: { method: 'thread/archived', params: { threadId: 't' } },
      });
      expect(log.warn.mock.calls).toEqual([
        [{ bytes: Buffer.byteLength(line) }, 'codex.app_server_unparseable_line'],
      ]);
      await notifications.return(undefined);
    }
  );
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
    expect(server.processes[0]?.requests[1]?.params).toEqual({ refreshToken: true });
    expect(server.processes[0]?.stdinEnded).toBe(true);
    return status;
  };

  for (const account of [
    { type: 'apiKey' },
    { type: 'chatgpt', email: null, planType: 'plus' },
    { type: 'amazonBedrock', usesCodexManagedCredentials: false },
  ] as const) {
    test(`${account.type} account is usable`, async () => {
      expect(await check({ account })).toEqual({ state: 'usable', source: 'native' });
    });
  }
  for (const account of [
    { type: 'chatgpt', planType: 'a-plan-this-codex-does-not-know' },
    { type: 'amazonBedrock' },
    { type: 'apiKey', aFieldThisCodexDoesNotKnow: true },
    { type: 'aKindThisCodexDoesNotKnow' },
  ]) {
    test(`fields the check does not read do not matter: ${JSON.stringify(account)}`, async () => {
      expect(await check({ accountResponse: { account, requiresOpenaiAuth: true } })).toEqual({
        state: 'usable',
        source: 'native',
      });
    });
  }
  for (const accountResponse of [
    {},
    null,
    { account: 'chatgpt', requiresOpenaiAuth: true },
    { account: null },
  ]) {
    test(`malformed account response ${JSON.stringify(accountResponse)} is check_failed`, async () => {
      expect(await check({ accountResponse })).toMatchObject({
        state: 'check_failed',
        evidence: expect.stringContaining('account/read'),
      });
    });
  }
  test('no account is unusable', async () => {
    expect(await check({ account: null })).toMatchObject({
      state: 'unusable',
      evidence: expect.stringContaining('codex login'),
    });
  });
  test('no account is not_checked when Codex needs no OpenAI login', async () => {
    expect(await check({ account: null, requiresOpenaiAuth: false })).toEqual({
      state: 'not_checked',
      source: 'native',
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
  test('starts the binary a turn starts, from assistant config', async () => {
    const { CodexProvider } = await import('./provider');
    const { createFakeAppServer } = await import('../test/codex-app-server-fake');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { removeTempTree } = await import('@archon/paths/test-utils');
    const dir = mkdtempSync(join(tmpdir(), 'codex-check-binary-'));
    const binary = join(dir, 'codex');
    writeFileSync(binary, '');
    const server = createFakeAppServer(() => ({ account: { type: 'apiKey' } }));
    try {
      expect(
        await new CodexProvider(server, 1).checkCredential({
          assistantConfig: { codexBinaryPath: binary },
          env: { CODEX_API_KEY: '' },
          signal: AbortSignal.timeout(1000),
        })
      ).toEqual({ state: 'usable', source: 'native' });
      expect(server.processes[0]?.binary).toBe(binary);
    } finally {
      await removeTempTree(dir);
    }
  });
  describe('a process that fails', () => {
    const run = async (
      spawner: import('./app-server').Spawner,
      signal: AbortSignal = AbortSignal.timeout(1000)
    ) => {
      const { CodexProvider } = await import('./provider');
      return new CodexProvider(spawner, 1).checkCredential({ env, signal });
    };
    const conforms = async (name: string, check: () => Promise<unknown>) => {
      const { checkCredentialStatuses } = await import('@archon/provider-contract/conformance');
      expect(
        await checkCredentialStatuses([
          {
            name,
            expected: 'check_failed',
            secret: env.TEST_SECRET,
            check: check as () => Promise<import('@archon/provider-contract').CredentialStatus>,
          },
        ])
      ).toEqual([]);
    };
    test('to spawn is check_failed', async () => {
      const { createFakeAppServer } = await import('../test/codex-app-server-fake');
      await conforms('spawn error', () =>
        run(createFakeAppServer(() => ({ spawnError: 'ENOENT' })))
      );
    });
    test('to spawn synchronously is check_failed and redacted', async () => {
      await conforms('sync spawn throw', () =>
        run((() => {
          throw new Error(`cannot start with ${env.TEST_SECRET}`);
        }) as import('./app-server').Spawner)
      );
    });
    test('at startup is check_failed with its stderr redacted', async () => {
      const { createFakeAppServer } = await import('../test/codex-app-server-fake');
      const fails = () =>
        run(
          createFakeAppServer(() => ({
            startupFailure: { code: 1, stderr: `bad config near ${env.TEST_SECRET}` },
          }))
        );
      await conforms('startup failure', fails);
      expect(await fails()).toMatchObject({
        evidence: expect.stringContaining('bad config near [REDACTED]'),
      });
    });
    test('to answer initialize is bounded by the signal', async () => {
      const { createFakeAppServer } = await import('../test/codex-app-server-fake');
      const server = createFakeAppServer(() => ({ ignoreInitialize: true }));
      expect(await run(server, AbortSignal.timeout(50))).toMatchObject({ state: 'check_failed' });
      expect(server.processes[0]?.methods).toEqual(['initialize']);
      expect(server.processes[0]?.stdinEnded).toBe(true);
    });
    test('is never started for a caller that already aborted', async () => {
      const spawner = mock(() => {
        throw new Error('must not spawn');
      });
      expect(
        await run(spawner as unknown as import('./app-server').Spawner, AbortSignal.abort())
      ).toMatchObject({ state: 'check_failed' });
      expect(spawner).not.toHaveBeenCalled();
    });
  });
  test('an Archon-supplied login is usable without starting a process; half a token pair is not', async () => {
    const { CodexProvider } = await import('./provider');
    const spawner = mock(() => {
      throw new Error('must not spawn');
    });
    const check = (env: Record<string, string>) => () =>
      new CodexProvider(spawner).checkCredential({ env, signal: new AbortController().signal });
    const { checkCredentialStatuses } = await import('@archon/provider-contract/conformance');
    expect(
      await checkCredentialStatuses([
        {
          name: 'Codex API key',
          expected: 'usable',
          secret: 'planted-key',
          check: check({ CODEX_API_KEY: 'planted-key' }),
        },
        {
          name: 'managed ChatGPT tokens',
          expected: 'usable',
          secret: 'planted-token',
          check: check({
            ARCHON_CODEX_CHATGPT_ACCESS_TOKEN: 'planted-token',
            ARCHON_CODEX_CHATGPT_ACCOUNT_ID: 'acct-1',
          }),
        },
        {
          name: 'half a managed ChatGPT token pair',
          expected: 'check_failed',
          secret: 'planted-token',
          check: check({ ARCHON_CODEX_CHATGPT_ACCESS_TOKEN: 'planted-token' }),
        },
      ])
    ).toEqual([]);
    expect(spawner).not.toHaveBeenCalled();
  });
});
