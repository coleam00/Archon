import { expect, test } from 'bun:test';
import { z } from 'zod';
import { connectProvider } from './connect';
import { descriptor } from './fixtures/provider';
import { streamPair } from './fixtures/streams';
import { PluginProtocolError, PluginRemoteError, PluginRpc, rpcMessageSchema } from './rpc';
import { PROVIDER_PLUGIN_MAX_MESSAGE_BYTES } from './wire';

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(value)}\n`);

async function malformed(parts: Uint8Array[], line: number): Promise<void> {
  const rpc = new PluginRpc({
    readable: new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
    writable: new WritableStream(),
  });
  rpc.plugin = descriptor.id;
  try {
    await expect(rpc.done).rejects.toBeInstanceOf(PluginProtocolError);
    await expect(rpc.done).rejects.toThrow(`Plugin test-provider, line ${String(line)}`);
  } finally {
    await rpc.close();
  }
}

test('framing rejects malformed JSON, UTF-8, envelopes and unterminated final lines', async () => {
  const prefix = encode({ jsonrpc: '2.0', method: '_ignored' });
  await malformed([prefix, new TextEncoder().encode('not-json\n')], 2);
  await malformed([new Uint8Array([0xff, 10])], 1);
  await malformed([encode({ method: 'missing-jsonrpc' })], 1);
  await malformed([new TextEncoder().encode('{}')], 1);
  await malformed([encode({ jsonrpc: '2.0', id: 999, result: {} })], 1);
});

test('line evidence names a method only when the connection handles it', async () => {
  const evidence = async (value: unknown): Promise<unknown> => {
    const rpc = new PluginRpc({
      readable: new ReadableStream({
        start(controller) {
          controller.enqueue(encode(value));
          controller.close();
        },
      }),
      writable: new WritableStream(),
    });
    rpc.on('_test', () => undefined);
    const error: unknown = await rpc.done.catch((e: unknown) => e);
    await rpc.close();
    expect(error).toBeInstanceOf(PluginProtocolError);
    expect(String(error)).not.toContain('private-line-secret');
    return (error as PluginProtocolError).evidence?.message;
  };
  expect(await evidence({ jsonrpc: '1.0', method: '_test' })).toBe('_test');
  expect(await evidence({ jsonrpc: '1.0', method: 'private-line-secret' })).toBe('unknown');
  expect(await evidence({ jsonrpc: '1.0', id: 'private-line-secret' })).toBe('unknown');
});

test('the size cap counts bytes across reads, including multibyte text', async () => {
  const first = new Uint8Array(PROVIDER_PLUGIN_MAX_MESSAGE_BYTES).fill(32);
  await malformed([first, new TextEncoder().encode('🦊\n')], 1);
  await malformed([new Uint8Array(PROVIDER_PLUGIN_MAX_MESSAGE_BYTES + 1).fill(32)], 1);
});

test('framing handles split UTF-8, CRLF and multiple messages per read', async () => {
  const messages: unknown[] = [];
  const raw = new TextEncoder().encode(
    '{"jsonrpc":"2.0","method":"_test","params":"🦊"}\r\n{"jsonrpc":"2.0","method":"_test","params":42}\n'
  );
  const parts = [...raw].map(byte => new Uint8Array([byte]));
  const rpc = new PluginRpc({
    readable: new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
    writable: new WritableStream(),
  });
  rpc.on('_test', params => {
    messages.push(params);
  });
  await rpc.done;
  expect(messages).toEqual(['🦊', 42]);
  await rpc.close();
});

test('unknown notifications are ignored and requests get -32601 in either direction', async () => {
  const pair = streamPair();
  const host = new PluginRpc(pair.host);
  const agent = new PluginRpc(pair.provider);
  await agent.notify('_unknown', { test: true });
  await expect(agent.request('fs/read_text_file', { path: '/tmp/file' })).rejects.toMatchObject({
    code: -32601,
  });
  await expect(host.request('_unknown', {})).rejects.toBeInstanceOf(PluginRemoteError);
  await host.close();
  await agent.done;
  await agent.close();
});

test('pending requests fail when the peer disconnects', async () => {
  const pair = streamPair();
  const host = new PluginRpc(pair.host);
  const agent = new PluginRpc(pair.provider);
  let started = (): void => {};
  const observed = new Promise<void>(resolve => {
    started = resolve;
  });
  agent.handle('_hang', () => {
    started();
    return new Promise(() => {});
  });
  const request = host.request('_hang', {});
  await observed;
  await agent.close();
  await expect(request).rejects.toThrow('connection ended with pending requests');
  await host.close();
});

test('malformed chunks fail with the plugin identity and incoming line number', async () => {
  const pair = streamPair();
  const agent = new PluginRpc(pair.provider);
  agent.handle('initialize', () => ({
    protocolVersion: 1,
    agentCapabilities: { _meta: { archon: descriptor } },
    authMethods: [],
  }));
  agent.handle('session/new', () => ({ sessionId: 'session' }));
  agent.handle('session/prompt', async () => {
    await agent.notify('_archon/chunk', { sessionId: 'session', chunk: { type: 'tool_call' } });
    return { stopReason: 'end_turn' };
  });
  const client = await connectProvider(pair.host);
  try {
    const stream = client.sendQuery('turn', '/');
    const error: unknown = await stream.next().catch(error => error);
    expect(error).toBeInstanceOf(PluginProtocolError);
    expect(error).toMatchObject({ plugin: 'test-provider', line: 3 });
    await expect(client.sendQuery('turn', '/').next()).rejects.toThrow('test-provider');
  } finally {
    await client.close();
    await agent.close();
  }
});

test('initialize rejects unsupported ACP or Archon protocol versions and missing descriptors', async () => {
  for (const response of [
    { protocolVersion: 2, agentCapabilities: { _meta: { archon: descriptor } }, authMethods: [] },
    {
      protocolVersion: 1,
      agentCapabilities: { _meta: { archon: { ...descriptor, protocol: 1 } } },
      authMethods: [],
    },
    { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
  ]) {
    const pair = streamPair();
    const agent = new PluginRpc(pair.provider);
    agent.handle('initialize', () => response);
    await expect(connectProvider(pair.host)).rejects.toBeInstanceOf(PluginProtocolError);
    await agent.done;
    await agent.close();
  }
});

test('host rejects unsupported agent-to-client requests after handshake', async () => {
  const pair = streamPair();
  const agent = new PluginRpc(pair.provider);
  agent.handle('initialize', () => ({
    protocolVersion: 1,
    agentCapabilities: { _meta: { archon: descriptor } },
    authMethods: [],
  }));
  const client = await connectProvider(pair.host);
  try {
    await expect(agent.request('terminal/create', { command: 'sh' })).rejects.toMatchObject({
      code: -32601,
    });
  } finally {
    await client.close();
    await agent.close();
  }
});

test('JSON-RPC errors cannot masquerade as results', () => {
  expect(
    rpcMessageSchema.safeParse({
      jsonrpc: '2.0',
      id: 1,
      result: {},
      error: { code: -32603, message: 'failure' },
    }).success
  ).toBe(false);
});

test('a cancelled turn may end at transport EOF without a synthetic chunk', async () => {
  const pair = streamPair();
  const agent = new PluginRpc(pair.provider);
  const abort = new AbortController();
  agent.handle('initialize', () => ({
    protocolVersion: 1,
    agentCapabilities: { _meta: { archon: descriptor } },
    authMethods: [],
  }));
  agent.handle('session/new', () => ({ sessionId: 'session' }));
  agent.handle('session/prompt', async () => {
    await agent.notify('_archon/chunk', {
      sessionId: 'session',
      chunk: { type: 'state_update', state: 'running' },
    });
    return new Promise(() => {});
  });
  agent.on('session/cancel', () => {
    void agent.close();
  });
  const client = await connectProvider(pair.host);
  try {
    const output = [];
    for await (const chunk of client.sendQuery('cancel', '/', undefined, {
      abortSignal: abort.signal,
    })) {
      output.push(chunk);
      abort.abort();
    }
    expect(output).toEqual([{ type: 'state_update', state: 'running' }]);
  } finally {
    await client.close();
    await agent.close();
  }
});

test('the exact line-byte limit is accepted and oversized outbound messages fail', async () => {
  const overhead = encode({ jsonrpc: '2.0', method: '_ignored', params: '' }).byteLength - 1;
  const line = encode({
    jsonrpc: '2.0',
    method: '_ignored',
    params: 'a'.repeat(PROVIDER_PLUGIN_MAX_MESSAGE_BYTES - overhead),
  });
  const rpc = new PluginRpc({
    readable: new ReadableStream({
      start(controller) {
        controller.enqueue(line);
        controller.close();
      },
    }),
    writable: new WritableStream(),
  });
  rpc.plugin = descriptor.id;
  await rpc.done;
  await expect(
    rpc.notify('_ignored', { text: 'a'.repeat(PROVIDER_PLUGIN_MAX_MESSAGE_BYTES) })
  ).rejects.toBeInstanceOf(PluginProtocolError);
  await rpc.close();
});

test('payload explanations name schema paths and issue codes, never values or plugin keys', () => {
  const rpc = new PluginRpc({ readable: new ReadableStream(), writable: new WritableStream() });
  const failure = (schema: z.ZodType, value: unknown): PluginProtocolError => {
    try {
      rpc.parse(schema, value);
    } catch (error) {
      if (error instanceof PluginProtocolError) return error;
      throw error;
    }
    throw new Error('expected parse to fail');
  };
  const record = failure(z.object({ env: z.record(z.string(), z.string()) }), {
    env: { 'secret key': 5 },
  });
  expect(record.detail).toBe('invalid payload (env.*: invalid_type, expected string)');
  const strict = failure(z.strictObject({ a: z.string() }), { a: 'x', 'secret key': 1 });
  expect(strict.detail).toBe('invalid payload (<root>: unrecognized_keys)');
  expect(`${record.message}${strict.message}`).not.toContain('secret');
  void rpc.close();
});

test('a response that fails its schema carries its line evidence and rejects only its request', async () => {
  const pair = streamPair();
  const host = new PluginRpc(pair.host);
  const agent = new PluginRpc(pair.provider);
  agent.handle('x', () => ({ n: 'secret' }));
  agent.handle('y', () => 'ok');
  const line = JSON.stringify({ jsonrpc: '2.0', id: 0, result: { n: 'secret' } });
  const error = await host.request('x', {}, z.object({ n: z.number() })).catch(e => e);
  expect(error).toBeInstanceOf(PluginProtocolError);
  expect(error).toMatchObject({
    detail: 'invalid payload (n: invalid_type, expected number)',
    evidence: { bytes: new TextEncoder().encode(line).byteLength, message: 'x response' },
  });
  expect(await host.request('y', {})).toBe('ok');
  await host.close();
  await agent.done;
  await agent.close();
});
