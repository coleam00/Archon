import { describe, expect, test } from 'bun:test';

import { augmentPromptForJsonSchema, bridgeOpencodeEvents } from './event-bridge';

const SESSION = 'ses_abc123';

async function collect(events: unknown[], sessionId = SESSION, schema?: Record<string, unknown>) {
  const chunks = [];
  async function* gen() {
    for (const e of events) yield e;
  }
  for await (const c of bridgeOpencodeEvents(gen(), sessionId, schema)) {
    chunks.push(c);
  }
  return chunks;
}

describe('bridgeOpencodeEvents', () => {
  test('maps message.part.delta text to assistant chunks', async () => {
    const chunks = await collect([
      {
        type: 'message.part.delta',
        properties: { sessionID: SESSION, field: 'text', delta: 'Hi' },
      },
      { type: 'message.part.delta', properties: { sessionID: SESSION, field: 'text', delta: '!' } },
      { type: 'session.idle', properties: { sessionID: SESSION } },
    ]);

    expect(chunks.filter(c => c.type === 'assistant')).toEqual([
      { type: 'assistant', content: 'Hi' },
      { type: 'assistant', content: '!' },
    ]);
  });

  test('skips empty deltas', async () => {
    const chunks = await collect([
      { type: 'message.part.delta', properties: { sessionID: SESSION, field: 'text', delta: '' } },
      { type: 'session.idle', properties: { sessionID: SESSION } },
    ]);
    expect(chunks.filter(c => c.type === 'assistant')).toHaveLength(0);
  });

  test('filters events from other sessions', async () => {
    const chunks = await collect([
      {
        type: 'message.part.delta',
        properties: { sessionID: 'ses_OTHER', field: 'text', delta: 'noise' },
      },
      {
        type: 'message.part.delta',
        properties: { sessionID: SESSION, field: 'text', delta: 'signal' },
      },
      { type: 'session.idle', properties: { sessionID: SESSION } },
    ]);
    const text = chunks.filter(c => c.type === 'assistant').map(c => c.content);
    expect(text).toEqual(['signal']);
  });

  test('emits thinking chunks from reasoning part snapshots', async () => {
    const chunks = await collect([
      {
        type: 'message.part.updated',
        properties: {
          sessionID: SESSION,
          part: {
            id: 'prt1',
            type: 'reasoning',
            sessionID: SESSION,
            messageID: 'msg1',
            text: 'Think',
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: SESSION,
          part: {
            id: 'prt1',
            type: 'reasoning',
            sessionID: SESSION,
            messageID: 'msg1',
            text: 'Think more',
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: SESSION } },
    ]);

    const thinking = chunks.filter(c => c.type === 'thinking');
    expect(thinking).toEqual([
      { type: 'thinking', content: 'Think' },
      { type: 'thinking', content: ' more' },
    ]);
  });

  test('emits tool + tool_result chunks for tool calls', async () => {
    const chunks = await collect([
      {
        type: 'message.part.updated',
        properties: {
          sessionID: SESSION,
          part: {
            id: 'prt-tool',
            type: 'tool',
            sessionID: SESSION,
            messageID: 'msg1',
            callID: 'call_xyz',
            tool: 'bash',
            state: { status: 'running', input: { command: 'ls' } },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: SESSION,
          part: {
            id: 'prt-tool',
            type: 'tool',
            sessionID: SESSION,
            messageID: 'msg1',
            callID: 'call_xyz',
            tool: 'bash',
            state: { status: 'completed', input: { command: 'ls' }, output: 'file.txt' },
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: SESSION } },
    ]);

    expect(chunks.filter(c => c.type === 'tool')).toEqual([
      { type: 'tool', toolName: 'bash', toolInput: { command: 'ls' }, toolCallId: 'call_xyz' },
    ]);
    expect(chunks.filter(c => c.type === 'tool_result')).toEqual([
      { type: 'tool_result', toolName: 'bash', toolOutput: 'file.txt', toolCallId: 'call_xyz' },
    ]);
  });

  test('does not duplicate tool chunks on repeated state updates', async () => {
    const chunks = await collect([
      {
        type: 'message.part.updated',
        properties: {
          sessionID: SESSION,
          part: {
            id: 'prt-tool',
            type: 'tool',
            sessionID: SESSION,
            messageID: 'msg1',
            callID: 'call_1',
            tool: 'read',
            state: { status: 'running', input: { path: '/x' } },
          },
        },
      },
      // Second running update — should not produce another 'tool' chunk
      {
        type: 'message.part.updated',
        properties: {
          sessionID: SESSION,
          part: {
            id: 'prt-tool',
            type: 'tool',
            sessionID: SESSION,
            messageID: 'msg1',
            callID: 'call_1',
            tool: 'read',
            state: { status: 'running', input: { path: '/x' } },
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: SESSION } },
    ]);
    expect(chunks.filter(c => c.type === 'tool')).toHaveLength(1);
  });

  test('tool error maps to tool_result with Error: prefix', async () => {
    const chunks = await collect([
      {
        type: 'message.part.updated',
        properties: {
          sessionID: SESSION,
          part: {
            id: 'prt-t',
            type: 'tool',
            sessionID: SESSION,
            messageID: 'msg1',
            callID: 'c1',
            tool: 'write',
            state: { status: 'running', input: {} },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: SESSION,
          part: {
            id: 'prt-t',
            type: 'tool',
            sessionID: SESSION,
            messageID: 'msg1',
            callID: 'c1',
            tool: 'write',
            state: { status: 'error', input: {}, error: 'permission denied' },
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: SESSION } },
    ]);
    const r = chunks.find(c => c.type === 'tool_result');
    expect(r?.toolOutput).toBe('Error: permission denied');
  });

  test('accumulates tokens and cost from step-finish parts', async () => {
    const chunks = await collect([
      {
        type: 'message.part.updated',
        properties: {
          sessionID: SESSION,
          part: {
            id: 'sf1',
            type: 'step-finish',
            sessionID: SESSION,
            messageID: 'msg1',
            cost: 0.01,
            tokens: { input: 100, output: 50 },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: SESSION,
          part: {
            id: 'sf2',
            type: 'step-finish',
            sessionID: SESSION,
            messageID: 'msg1',
            cost: 0.02,
            tokens: { input: 200, output: 80 },
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: SESSION } },
    ]);

    const result = chunks.find(c => c.type === 'result');
    expect(result?.tokens).toEqual({ input: 300, output: 130, total: 430 });
    expect(result?.cost).toBeCloseTo(0.03);
  });

  test('terminates on session.error with isError result', async () => {
    const chunks = await collect([
      {
        type: 'session.error',
        properties: { sessionID: SESSION, error: { message: 'auth failed' } },
      },
    ]);
    const result = chunks.find(c => c.type === 'result');
    expect(result?.isError).toBe(true);
    expect(result?.errors).toContain('auth failed');
    expect(chunks.length).toBe(1);
  });

  test('emits result even when stream ends without session.idle', async () => {
    const chunks = await collect([
      { type: 'message.part.delta', properties: { sessionID: SESSION, field: 'text', delta: 'x' } },
    ]);
    const result = chunks.find(c => c.type === 'result');
    expect(result).toBeDefined();
    expect(result?.isError).toBeUndefined();
  });

  test('parses structured output from accumulated text when schema provided', async () => {
    const chunks = await collect(
      [
        {
          type: 'message.part.delta',
          properties: { sessionID: SESSION, field: 'text', delta: '{"answer":42}' },
        },
        { type: 'session.idle', properties: { sessionID: SESSION } },
      ],
      SESSION,
      { type: 'object', properties: { answer: { type: 'number' } } }
    );
    const result = chunks.find(c => c.type === 'result');
    expect(result?.structuredOutput).toEqual({ answer: 42 });
  });

  test('strips code fences before JSON parse', async () => {
    const chunks = await collect(
      [
        {
          type: 'message.part.delta',
          properties: { sessionID: SESSION, field: 'text', delta: '```json\n{"x":1}\n```' },
        },
        { type: 'session.idle', properties: { sessionID: SESSION } },
      ],
      SESSION,
      { type: 'object' }
    );
    const result = chunks.find(c => c.type === 'result');
    expect(result?.structuredOutput).toEqual({ x: 1 });
  });

  test('leaves structuredOutput undefined on parse failure', async () => {
    const chunks = await collect(
      [
        {
          type: 'message.part.delta',
          properties: { sessionID: SESSION, field: 'text', delta: 'not json' },
        },
        { type: 'session.idle', properties: { sessionID: SESSION } },
      ],
      SESSION,
      { type: 'object' }
    );
    const result = chunks.find(c => c.type === 'result');
    expect(result?.structuredOutput).toBeUndefined();
  });

  test('ignores server.connected heartbeat events', async () => {
    const chunks = await collect([
      { type: 'server.connected', properties: {} },
      { type: 'server.heartbeat', properties: {} },
      {
        type: 'message.part.delta',
        properties: { sessionID: SESSION, field: 'text', delta: 'ok' },
      },
      { type: 'session.idle', properties: { sessionID: SESSION } },
    ]);
    expect(chunks.filter(c => c.type === 'assistant')).toHaveLength(1);
  });
});

describe('augmentPromptForJsonSchema', () => {
  test('appends schema instruction to prompt', () => {
    const result = augmentPromptForJsonSchema('Hello', { type: 'object' });
    expect(result).toContain('Hello');
    expect(result).toContain('CRITICAL');
    expect(result).toContain('"type": "object"');
  });
});
