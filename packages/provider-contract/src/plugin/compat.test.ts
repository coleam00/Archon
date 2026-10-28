import { expect, test } from 'bun:test';
import { z } from 'zod';
import type { ProviderChunk } from '../events';
import { connectProvider } from './connect';
import baseline from './fixtures/protocol-2-baseline.schema.json';
import { descriptor, fixtureProvider } from './fixtures/provider';
import { streamPair } from './fixtures/streams';
import { PluginProtocolMismatchError, PluginRemoteError, PluginRpc } from './rpc';
import { serveProvider } from './serve';
import { PROVIDER_PLUGIN_PROTOCOL, type ProviderSessionRequest } from './wire';

// The published schema at the first protocol-2 release. Every protocol-2 peer must keep
// speaking with the current code; a protocol bump replaces this snapshot.
function baselineDef(name: keyof typeof baseline.$defs): z.ZodType {
  // JSON imports widen literal schema keywords such as type to string.
  return z.fromJSONSchema({
    ...baseline,
    $ref: `#/$defs/${name}`,
  } as unknown as z.core.JSONSchema.BaseSchema);
}

const initializeParams = (protocol: number): unknown => ({
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
    _meta: { archon: { protocol } },
  },
});

const sessionRequest = {
  prompt: 'turn',
  cwd: '/workspace',
  resumeSessionId: 'native-session',
  model: 'test-model',
  systemPrompt: ['system'],
  appendSystemPrompt: 'append',
  outputFormat: { type: 'json_schema', schema: { type: 'object' } },
  protectedEnvKeys: ['SECRET'],
  maxBudgetUsd: 1,
  fallbackModel: 'fallback-model',
  forkSession: true,
  purpose: 'title-generation',
  nodeConfig: { node: true },
  assistantConfig: { model: 'test-model' },
  execContext: { kind: 'container', containerId: 'container', execUser: 'user' },
  nativeTools: [
    {
      name: 'lookup',
      description: 'Look up a value',
      inputSchema: {
        properties: {
          key: { kind: 'string', description: 'Key' },
          mode: { kind: 'enum', values: ['fast', 'slow'] },
          exact: { kind: 'boolean' },
        },
        required: ['key'],
      },
    },
  ],
  env: { KEY: 'value' },
} satisfies ProviderSessionRequest;

test.each(['full', 'minimal'] as const)(
  'a protocol-1 host with a %s envelope gets the current descriptor and cannot start a session',
  async envelope => {
    const pair = streamPair();
    const serving = serveProvider({ descriptor, create: () => fixtureProvider() }, pair.provider);
    const host = new PluginRpc(pair.host);
    try {
      const params =
        envelope === 'full'
          ? initializeParams(1)
          : { clientCapabilities: { _meta: { archon: { protocol: 1 } } } };
      expect(await host.request('initialize', params)).toMatchObject({
        agentCapabilities: { _meta: { archon: { protocol: PROVIDER_PLUGIN_PROTOCOL } } },
      });
      await expect(
        host.request('session/new', {
          cwd: '/',
          mcpServers: [],
          _meta: { archon: { request: { prompt: 'turn', cwd: '/' } } },
        })
      ).rejects.toThrow('initialize must complete');
    } finally {
      await host.close();
      await serving;
    }
  }
);

test.each(['full', 'minimal'] as const)(
  'connect names both versions when the plugin speaks another protocol with a %s envelope',
  async envelope => {
    for (const protocol of [PROVIDER_PLUGIN_PROTOCOL - 1, PROVIDER_PLUGIN_PROTOCOL + 1]) {
      const pair = streamPair();
      const agent = new PluginRpc(pair.provider);
      agent.handle('initialize', () =>
        envelope === 'full'
          ? {
              protocolVersion: 1,
              agentCapabilities: { _meta: { archon: { ...descriptor, protocol } } },
              authMethods: [],
            }
          : { agentCapabilities: { _meta: { archon: { id: descriptor.id, protocol } } } }
      );
      const error: unknown = await connectProvider(pair.host).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(PluginProtocolMismatchError);
      expect(error).toMatchObject({
        plugin: 'test-provider',
        hostProtocol: PROVIDER_PLUGIN_PROTOCOL,
        pluginProtocol: protocol,
        message: expect.stringContaining(
          `plugin speaks protocol ${String(protocol)}; this Archon speaks protocol ${String(PROVIDER_PLUGIN_PROTOCOL)}`
        ),
      });
      await agent.done;
      await agent.close();
    }
  }
);

test('the baseline is the current protocol', () => {
  expect(baseline.$defs.ProviderPluginDescriptor.properties.protocol.const).toBe(
    PROVIDER_PLUGIN_PROTOCOL
  );
});

test('the session request sample covers every baseline field', () => {
  expect(baselineDef('ProviderSessionRequest').parse(sessionRequest)).toEqual(sessionRequest);
  expect(Object.keys(sessionRequest).sort()).toEqual(
    Object.keys(baseline.$defs.ProviderSessionRequest.properties).sort()
  );
});

test('baseline-shaped requests reach the current plugin', async () => {
  const received: unknown[] = [];
  const provider = fixtureProvider({
    async *sendQuery(prompt, cwd, resumeSessionId, options): AsyncGenerator<ProviderChunk> {
      const { abortSignal: _abortSignal, nativeTools, ...rest } = options ?? {};
      received.push({
        prompt,
        cwd,
        resumeSessionId,
        ...rest,
        nativeTools: nativeTools?.map(({ handler: _handler, ...spec }) => spec),
      });
      yield { type: 'settled' };
    },
    diagnose: async () => ({ checks: [] }),
    listModels: async () => ({ models: [] }),
  });
  const pair = streamPair();
  const serving = serveProvider({ descriptor, create: () => provider }, pair.provider);
  const host = new PluginRpc(pair.host);
  const send = async (
    method: string,
    def: keyof typeof baseline.$defs,
    params: unknown
  ): Promise<unknown> => {
    baselineDef(def).parse(params);
    return host.request(method, params);
  };
  try {
    await send(
      'initialize',
      'ProviderInitializeRequest',
      initializeParams(PROVIDER_PLUGIN_PROTOCOL)
    );
    // The minimal request catches a field that became required; the full one, a field that
    // was removed or narrowed.
    for (const request of [{ prompt: 'minimal', cwd: '/workspace' }, sessionRequest]) {
      const { sessionId } = z.object({ sessionId: z.string() }).parse(
        await send('session/new', 'ProviderNewSessionRequest', {
          cwd: request.cwd,
          mcpServers: [],
          _meta: { archon: { request } },
        })
      );
      await send('session/prompt', 'ProviderPromptRequest', {
        sessionId,
        prompt: [{ type: 'text', text: request.prompt }],
      });
    }
    expect(received).toEqual([expect.objectContaining({ prompt: 'minimal' }), sessionRequest]);
    const credential = { model: 'test-model', assistantConfig: { model: 'test-model' } };
    await send('_archon/check_credential', 'ProviderCheckCredentialRequest', credential);
    await send('_archon/resolve_credential_model', 'ProviderResolveCredentialModelRequest', {
      ...credential,
      cwd: '/workspace',
    });
    await send('_archon/diagnose', 'ProviderDiagnoseRequest', {
      assistantConfig: { model: 'test-model' },
    });
    await send('_archon/list_models', 'ProviderListModelsRequest', {});
    const cancelled = z.object({ sessionId: z.string() }).parse(
      await send('session/new', 'ProviderNewSessionRequest', {
        cwd: '/workspace',
        mcpServers: [],
        _meta: { archon: { request: { prompt: 'cancelled', cwd: '/workspace' } } },
      })
    );
    baselineDef('ProviderCancelNotification').parse(cancelled);
    await host.notify('session/cancel', cancelled);
  } finally {
    await host.close();
    await serving;
  }
});

// A plugin built at the baseline: it refuses any request its schema does not accept,
// exactly as an older plugin's strict parse does.
function pinnedPlugin(io: ReturnType<typeof streamPair>['provider']): {
  agent: PluginRpc;
  requests: unknown[];
} {
  const agent = new PluginRpc(io);
  const requests: unknown[] = [];
  const handle = (method: string, def: keyof typeof baseline.$defs, result: unknown): void => {
    agent.handle(method, params => {
      requests.push(baselineDef(def).parse(params));
      return result;
    });
  };
  handle('initialize', 'ProviderInitializeRequest', {
    protocolVersion: 1,
    agentCapabilities: { _meta: { archon: descriptor } },
    authMethods: [],
  });
  handle('session/new', 'ProviderNewSessionRequest', { sessionId: 'session' });
  agent.handle('session/prompt', async params => {
    baselineDef('ProviderPromptRequest').parse(params);
    await agent.notify('_archon/chunk', { sessionId: 'session', chunk: { type: 'settled' } });
    return { stopReason: 'end_turn' };
  });
  handle('_archon/check_credential', 'ProviderCheckCredentialRequest', {
    state: 'usable',
    source: 'native',
  });
  handle('_archon/resolve_credential_model', 'ProviderResolveCredentialModelRequest', {});
  handle('_archon/diagnose', 'ProviderDiagnoseRequest', { checks: [] });
  handle('_archon/list_models', 'ProviderListModelsRequest', { models: [] });
  return { agent, requests };
}

test('current requests reach a plugin pinned to the baseline', async () => {
  const pair = streamPair();
  const { agent, requests } = pinnedPlugin(pair.provider);
  const client = await connectProvider(pair.host);
  try {
    const { prompt, cwd, resumeSessionId, nativeTools, ...options } = sessionRequest;
    const chunks: ProviderChunk[] = [];
    for await (const chunk of client.sendQuery(prompt, cwd, resumeSessionId, {
      ...options,
      nativeTools: nativeTools.map(tool => ({ ...tool, handler: async (): Promise<string> => '' })),
    }))
      chunks.push(chunk);
    expect(chunks).toEqual([{ type: 'settled' }]);
    expect(requests[1]).toMatchObject({ _meta: { archon: { request: sessionRequest } } });
    const signal = new AbortController().signal;
    expect(await client.checkCredential({ model: 'test-model', env: {}, signal })).toEqual({
      state: 'usable',
      source: 'native',
    });
    expect(await client.resolveCredentialModel({ cwd: '/workspace' })).toBeUndefined();
    expect(await client.diagnose({ signal })).toEqual({ checks: [] });
    expect(await client.listModels({ signal })).toEqual({ models: [] });
  } finally {
    await client.close();
    await agent.close();
  }
});

test('a field newer than the pinned plugin fails instead of being dropped', async () => {
  const pair = streamPair();
  const { agent } = pinnedPlugin(pair.provider);
  const client = await connectProvider(pair.host);
  try {
    const error: unknown = await client
      .sendQuery('turn', '/workspace', undefined, { userCredentialEnvKeys: ['KEY'] })
      .next()
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PluginRemoteError);
    expect(error).toMatchObject({ code: -32602 });
  } finally {
    await client.close();
    await agent.close();
  }
});
