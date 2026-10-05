import { expect, test } from 'bun:test';
import type { IAgentProvider, SendQueryOptions } from '../agent-provider';
import { checkCredentialStatuses, runProviderConformance } from '../conformance';
import { providerEventSchema, type ProviderChunk } from '../events';
import { connectProvider, type ConnectedProvider } from './connect';
import { checkAcp } from './fixtures/acp';
import { chunks, credentialStatuses, descriptor, fixtureProvider } from './fixtures/provider';
import { streamPair } from './fixtures/streams';
import { rpcMessageSchema } from './rpc';
import { serveProvider } from './serve';

async function withProvider(
  provider: IAgentProvider,
  run: (client: ConnectedProvider) => Promise<void>,
  observe?: Parameters<typeof streamPair>[0]
): Promise<void> {
  const pair = streamPair(observe);
  const serving = serveProvider({ descriptor, create: () => provider }, pair.provider);
  const client = await connectProvider(pair.host);
  try {
    await run(client);
  } finally {
    await client.close();
    await serving;
  }
}
async function collect(stream: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const output: ProviderChunk[] = [];
  for await (const chunk of stream) output.push(chunk);
  return output;
}

function matchesProcessEnvironment(env: Record<string, string> | undefined): boolean {
  const entries = Object.entries(process.env).filter(([, value]) => value !== undefined);
  return (
    env !== undefined &&
    Object.keys(env).length === entries.length &&
    entries.every(([key, value]) => env[key] === value)
  );
}

test('every event and result crosses the ACP lifecycle unchanged, including post-result background work', async () => {
  let promptId: string | number | undefined;
  let promptResponse = (): void => {};
  const responseWritten = new Promise<void>(resolve => {
    promptResponse = resolve;
  });
  const wire: { side: 'host' | 'provider'; message: ReturnType<typeof rpcMessageSchema.parse> }[] =
    [];
  await withProvider(
    fixtureProvider(),
    async client => {
      expect(client.descriptor).toEqual(descriptor);
      expect(client.getType()).toBe(descriptor.id);
      expect(client.getCapabilities()).toEqual(descriptor.capabilities);
      const direct = await collect(fixtureProvider().sendQuery('turn', '/workspace'));
      expect(await collect(client.sendQuery('turn', '/workspace'))).toEqual(direct);
      expect(direct).toEqual(chunks);
      expect(
        [
          ...new Set(
            chunks
              .filter(chunk => chunk.type !== 'result' && chunk.type !== 'settled')
              .map(chunk => chunk.type)
          ),
        ].sort()
      ).toEqual(providerEventSchema.options.map(schema => schema.shape.type.value).sort());
      await responseWritten;
    },
    (side, value) => {
      const message = rpcMessageSchema.parse(JSON.parse(new TextDecoder().decode(value)));
      wire.push({ side, message });
      if (
        side === 'host' &&
        'method' in message &&
        'id' in message &&
        message.method === 'session/prompt'
      )
        promptId = message.id;
      if (side === 'provider' && 'result' in message && message.id === promptId) promptResponse();
    }
  );
  const names = {
    initialize: ['InitializeRequest', 'InitializeResponse'],
    'session/new': ['NewSessionRequest', 'NewSessionResponse'],
    'session/prompt': ['PromptRequest', 'PromptResponse'],
  } as const;
  const seen = new Set<string>();
  const requests = new Map<string | number, keyof typeof names>();
  for (const { side, message } of wire) {
    if ('method' in message && 'id' in message) {
      expect(side).toBe('host');
      if (!(message.method in names)) throw new Error(`Unexpected request ${message.method}`);
      const method = message.method as keyof typeof names;
      checkAcp(names[method][0], message.params);
      requests.set(message.id, method);
      seen.add(names[method][0]);
    } else if ('result' in message) {
      expect(side).toBe('provider');
      const method = requests.get(message.id);
      if (!method) throw new Error('Unmatched ACP response');
      checkAcp(names[method][1], message.result);
      seen.add(names[method][1]);
    }
  }
  expect([...seen].sort()).toEqual(Object.values(names).flat().sort());
});

test('in-process and stream-pair conformance agree with live background evidence', async () => {
  let status: 'running' | 'completed' = 'running';
  let release = (): void => {};
  const provider = fixtureProvider({
    async *sendQuery(prompt) {
      if (prompt === 'failure') {
        yield* fixtureProvider().sendQuery(prompt, '/');
        return;
      }
      status = 'running';
      const barrier = new Promise<void>(resolve => {
        release = resolve;
      });
      for (const chunk of chunks) {
        if (chunk.type === 'subtask' && chunk.status === 'completed') {
          await barrier;
          status = 'completed';
        }
        yield chunk;
      }
    },
  });
  async function suite(client: IAgentProvider): Promise<string[]> {
    async function* run(): AsyncGenerator<ProviderChunk> {
      for await (const chunk of client.sendQuery('turn', '/')) {
        yield chunk;
        if (chunk.type === 'subtask' && chunk.status === 'running') release();
      }
    }
    return runProviderConformance({
      capabilities: descriptor.capabilities,
      turns: [{ name: 'whole turn', run }],
      toolTurn: { name: 'two tools', run },
      failureCases: [
        {
          name: 'auth failure',
          expected: 'auth',
          evidence: 'HTTP 401',
          run: () => client.sendQuery('failure', '/'),
        },
      ],
      backgroundCases: [{ name: 'background work', run, runtimeStatus: () => status }],
    });
  }
  const direct = await suite(provider);
  expect(direct).toEqual([]);
  await withProvider(provider, async client => {
    expect(await suite(client)).toEqual(direct);
  });
});

test('serializable options survive; the provider receives its process environment', async () => {
  let received:
    | { prompt: string; cwd: string; resume?: string; options?: SendQueryOptions }
    | undefined;
  const options: SendQueryOptions = {
    model: 'test-model',
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: 'Guide',
      excludeDynamicSections: true,
    },
    outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    protectedEnvKeys: ['KEY'],
    maxBudgetUsd: 2,
    fallbackModel: 'fallback',
    forkSession: true,
    purpose: 'title-generation',
    nodeConfig: {
      mcp: 'test',
      skills: ['test'],
      plugins: ['test'],
      agents: { test: { prompt: 'Task', description: 'Task' } },
    },
    assistantConfig: { extensions: false },
    execContext: { kind: 'container', containerId: 'id', execUser: 'user' },
    env: { KEY: 'host-only' },
    onAdmission: () => {},
  };
  await withProvider(
    fixtureProvider({
      async *sendQuery(prompt, cwd, resume, requestOptions) {
        received = { prompt, cwd, resume, options: requestOptions };
        yield* chunks;
      },
    }),
    async client => {
      await collect(client.sendQuery('prompt', '/workspace', 'resume-native', options));
    }
  );
  expect(received?.prompt).toBe('prompt');
  expect(received?.cwd).toBe('/workspace');
  expect(received?.resume).toBe('resume-native');
  const { env: _env, onAdmission: _admission, ...data } = options;
  const { env, abortSignal: _signal, onAdmission: _observer, ...actual } = received?.options ?? {};
  expect(actual).toEqual(data);
  expect(matchesProcessEnvironment(env)).toBe(true);
  expect(received?.options?.abortSignal).toBeInstanceOf(AbortSignal);
  expect(received?.options?.onAdmission).toBeUndefined();
});

test('host abort reaches a suspended provider and ends without synthetic settled', async () => {
  let signal: AbortSignal | undefined;
  let cancelParams: unknown;
  await withProvider(
    fixtureProvider({
      async *sendQuery(_prompt, _cwd, _resume, options) {
        signal = options?.abortSignal;
        if (!signal) throw new Error('Missing signal');
        yield { type: 'state_update', state: 'running' };
        await new Promise<void>(resolve => {
          if (signal?.aborted) resolve();
          else
            signal?.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true }
            );
        });
      },
    }),
    async client => {
      const abort = new AbortController();
      const output: ProviderChunk[] = [];
      for await (const chunk of client.sendQuery('cancel', '/', undefined, {
        abortSignal: abort.signal,
      })) {
        output.push(chunk);
        abort.abort();
      }
      expect(output).toEqual([{ type: 'state_update', state: 'running' }]);
      expect(signal?.aborted).toBe(true);
    },
    (side, value) => {
      const message = rpcMessageSchema.parse(JSON.parse(new TextDecoder().decode(value)));
      if (side === 'host' && 'method' in message && message.method === 'session/cancel')
        cancelParams = message.params;
    }
  );
  checkAcp('CancelNotification', cancelParams);
});

test('credential states and credential model resolution round-trip without env on the wire', async () => {
  const provider = fixtureProvider({
    checkCredential: async request => {
      expect(matchesProcessEnvironment(request.env)).toBe(true);
      const status = credentialStatuses.find(status => status.state === request.model);
      if (!status) throw new Error('Unknown fixture state');
      return status;
    },
  });
  await withProvider(provider, async client => {
    expect(
      await checkCredentialStatuses(
        credentialStatuses.map(status => ({
          name: status.state,
          expected: status.state,
          secret: 'host-secret-value',
          check: () =>
            client.checkCredential({
              model: status.state,
              env: { KEY: 'host-secret-value' },
              signal: new AbortController().signal,
            }),
        }))
      )
    ).toEqual([]);
    expect(await client.resolveCredentialModel({ cwd: '/', assistantConfig: { test: true } })).toBe(
      'credential-model'
    );
  });
  const { resolveCredentialModel: _resolve, ...withoutResolution } = provider;
  await withProvider(withoutResolution, async client => {
    expect(await client.resolveCredentialModel({ cwd: '/' })).toBeUndefined();
  });
});

test('an uncancelled stream ending before settled fails instead of inventing completion', async () => {
  await withProvider(
    fixtureProvider({
      async *sendQuery() {
        yield { type: 'result' };
      },
    }),
    async client => {
      await expect(collect(client.sendQuery('turn', '/'))).rejects.toThrow('ended before settled');
    }
  );
});

test('a provider rejection after settled still fails the remote turn', async () => {
  const provider = fixtureProvider({
    async *sendQuery() {
      yield { type: 'result', text: 'done' };
      yield { type: 'settled' };
      throw new Error('cleanup failed');
    },
  });
  await expect(collect(provider.sendQuery('turn', '/'))).rejects.toThrow('cleanup failed');
  await withProvider(provider, async client => {
    await expect(collect(client.sendQuery('turn', '/'))).rejects.toThrow('cleanup failed');
  });
});

test('closing a connection aborts a suspended provider and resolves serving', async () => {
  let signal: AbortSignal | undefined;
  const pair = streamPair();
  const serving = serveProvider(
    {
      descriptor,
      create: () =>
        fixtureProvider({
          async *sendQuery(_prompt, _cwd, _resume, options) {
            signal = options?.abortSignal;
            if (!signal) throw new Error('Missing abort signal');
            const aborted = new Promise<void>(resolve => {
              signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            yield { type: 'state_update', state: 'running' };
            await aborted;
          },
        }),
    },
    pair.provider
  );
  const client = await connectProvider(pair.host);
  const stream = client.sendQuery('turn', '/');
  try {
    expect((await stream.next()).value).toEqual({ type: 'state_update', state: 'running' });
    expect(signal?.aborted).toBe(false);
    await client.close();
    await serving;
    expect(signal?.aborted).toBe(true);
    await expect(stream.next()).rejects.toThrow('connection closed');
  } finally {
    await client.close();
    await stream.return(undefined);
    await serving;
  }
});

test('returning early cancels the provider, drains in-flight chunks and leaves the connection usable', async () => {
  let cancelled = (): void => {};
  const cancelledAtProvider = new Promise<void>(resolve => {
    cancelled = resolve;
  });
  await withProvider(
    fixtureProvider({
      async *sendQuery(prompt, _cwd, _resume, options) {
        if (prompt !== 'early-return') {
          yield* chunks;
          return;
        }
        const signal = options?.abortSignal;
        if (!signal) throw new Error('Missing abort signal');
        yield { type: 'state_update', state: 'running' };
        await new Promise<void>(resolve => {
          signal.addEventListener(
            'abort',
            () => {
              resolve();
            },
            { once: true }
          );
        });
        cancelled();
        yield { type: 'agent_message_chunk', text: 'Already in flight when cancelled' };
      },
    }),
    async client => {
      const stream = client.sendQuery('early-return', '/');
      expect((await stream.next()).value).toEqual({ type: 'state_update', state: 'running' });
      await stream.return(undefined);
      await cancelledAtProvider;
      expect(await collect(client.sendQuery('next-turn', '/'))).toEqual(chunks);
    }
  );
});

test('concurrent sessions route their chunks and cancellations independently', async () => {
  await withProvider(
    fixtureProvider({
      async *sendQuery(prompt, _cwd, _resume, options) {
        const signal = options?.abortSignal;
        if (!signal) throw new Error('Missing abort signal');
        yield { type: 'agent_message_chunk', text: prompt };
        if (prompt === 'cancel-me') {
          await new Promise<void>(resolve => {
            signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true }
            );
          });
          return;
        }
        yield { type: 'result', text: prompt, sessionId: `native-${prompt}` };
        yield { type: 'settled' };
      },
    }),
    async client => {
      const abort = new AbortController();
      const cancelled = client.sendQuery('cancel-me', '/', undefined, {
        abortSignal: abort.signal,
      });
      expect((await cancelled.next()).value).toEqual({
        type: 'agent_message_chunk',
        text: 'cancel-me',
      });
      const completed = collect(client.sendQuery('complete-me', '/'));
      abort.abort();
      expect(await cancelled.next()).toEqual({ done: true, value: undefined });
      expect(await completed).toEqual([
        { type: 'agent_message_chunk', text: 'complete-me' },
        { type: 'result', text: 'complete-me', sessionId: 'native-complete-me' },
        { type: 'settled' },
      ]);
    }
  );
});
