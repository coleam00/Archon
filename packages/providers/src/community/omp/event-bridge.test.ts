import { describe, expect, mock, test } from 'bun:test';
import type { AgentSession } from '@oh-my-pi/pi-coding-agent';

import type { MessageChunk } from '../../types';
import { bridgeSession, mapOmpEvent, ThinkingTagStripper } from './event-bridge';

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type FakeEvent =
  | { type: 'message_update'; assistantMessageEvent: { type: 'text_delta'; delta: string } }
  | { type: 'agent_end'; messages: readonly unknown[] };

function textDelta(delta: string): FakeEvent {
  return { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } };
}

function agentEnd(text = 'done'): FakeEvent {
  return {
    type: 'agent_end',
    messages: [
      {
        role: 'assistant',
        stopReason: 'stop',
        usage,
        content: [{ type: 'text', text }],
      },
    ],
  };
}

function makeSession(events: readonly FakeEvent[]): AgentSession {
  let listener: ((event: FakeEvent) => void) | undefined;
  return {
    subscribe: (fn: (event: FakeEvent) => void) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    prompt: mock(async () => {
      for (const event of events) listener?.(event);
    }),
    abort: mock(async () => undefined),
    dispose: mock(async () => undefined),
  } as unknown as AgentSession;
}

async function collect(session: AgentSession): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of bridgeSession(session, 'prompt')) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('mapOmpEvent', () => {
  test('text_delta maps to assistant chunk', () => {
    expect(mapOmpEvent(textDelta('hello'))).toEqual([{ type: 'assistant', content: 'hello' }]);
  });

  test('thinking_delta maps to thinking chunk', () => {
    expect(
      mapOmpEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'hidden' },
      })
    ).toEqual([{ type: 'thinking', content: 'hidden' }]);
  });
});

describe('ThinkingTagStripper', () => {
  test('strips complete think blocks from text', () => {
    const stripper = new ThinkingTagStripper();

    expect(stripper.write('before <think>hidden</think>after')).toBe('before after');
    expect(stripper.flush()).toBe('');
  });

  test('strips split think blocks without leaking partial tags', () => {
    const stripper = new ThinkingTagStripper();

    expect(stripper.write('before <thi')).toBe('before ');
    expect(stripper.write('nk>hidden')).toBe('');
    expect(stripper.write('</think>after')).toBe('after');
  });

  test('strips thinking alias blocks and stray closing tags', () => {
    const stripper = new ThinkingTagStripper();

    expect(stripper.write('<thinking>hidden</think')).toBe('');
    expect(stripper.write('ing>visible</thinking>')).toBe('visible');
  });

  test('flush preserves non-tag partial text', () => {
    const stripper = new ThinkingTagStripper();

    expect(stripper.write('literal <thi')).toBe('literal ');
    expect(stripper.flush()).toBe('<thi');
  });
});

describe('bridgeSession thinking tag filtering', () => {
  test('removes raw think tags from streamed assistant chunks', async () => {
    const chunks = await collect(
      makeSession([textDelta('<thi'), textDelta('nk>hidden</think>visible'), agentEnd()])
    );

    const assistantText = chunks
      .filter(
        (chunk): chunk is Extract<MessageChunk, { type: 'assistant' }> => chunk.type === 'assistant'
      )
      .map(chunk => chunk.content)
      .join('');

    expect(assistantText).toBe('visible');
    expect(assistantText).not.toContain('<think>');
    expect(assistantText).not.toContain('hidden');
    expect(chunks.some(chunk => chunk.type === 'result')).toBe(true);
  });

  test('flushes pending non-tag text before terminal result', async () => {
    const chunks = await collect(makeSession([textDelta('literal <thi'), agentEnd()]));

    expect(chunks.map(chunk => (chunk.type === 'assistant' ? chunk.content : chunk.type))).toEqual([
      'literal ',
      '<thi',
      'result',
    ]);
  });
});

describe('bridgeSession terminal result chunk', () => {
  async function collectWithSchema(
    session: AgentSession,
    schema?: Record<string, unknown>
  ): Promise<MessageChunk[]> {
    const chunks: MessageChunk[] = [];
    for await (const chunk of bridgeSession(session, 'prompt', undefined, schema)) {
      chunks.push(chunk);
    }
    return chunks;
  }

  test('yields exactly one result chunk with tokens AND structuredOutput when schema set', async () => {
    const json = '{"verdict":"pass","score":9}';
    const chunks = await collectWithSchema(makeSession([textDelta(json), agentEnd(json)]), {
      type: 'object',
    });

    const results = chunks.filter(
      (c): c is Extract<MessageChunk, { type: 'result' }> => c.type === 'result'
    );
    expect(results).toHaveLength(1);
    const result = results[0];
    // Tokens from agent_end usage preserved
    expect(result.tokens).toEqual({ input: 1, output: 1, total: 2, cost: 0 });
    // structuredOutput merged into the SAME terminal chunk
    expect(result.structuredOutput).toEqual({ verdict: 'pass', score: 9 });
    // Terminal result is the last chunk in the stream
    expect(chunks[chunks.length - 1]).toBe(result);
  });

  test('non-schema path yields exactly one result chunk without structuredOutput', async () => {
    const chunks = await collectWithSchema(makeSession([textDelta('hello'), agentEnd()]));

    const results = chunks.filter(
      (c): c is Extract<MessageChunk, { type: 'result' }> => c.type === 'result'
    );
    expect(results).toHaveLength(1);
    expect(results[0].tokens).toEqual({ input: 1, output: 1, total: 2, cost: 0 });
    expect('structuredOutput' in results[0]).toBe(false);
  });

  test('unparseable transcript with schema yields the single token result without structuredOutput', async () => {
    const chunks = await collectWithSchema(
      makeSession([textDelta('not json at all'), agentEnd()]),
      { type: 'object' }
    );

    const results = chunks.filter(
      (c): c is Extract<MessageChunk, { type: 'result' }> => c.type === 'result'
    );
    expect(results).toHaveLength(1);
    expect(results[0].tokens).toBeDefined();
    expect('structuredOutput' in results[0]).toBe(false);
  });

  test('preserves missing_assistant_message semantics on the single terminal result', async () => {
    const chunks = await collectWithSchema(makeSession([{ type: 'agent_end', messages: [] }]), {
      type: 'object',
    });

    const results = chunks.filter(
      (c): c is Extract<MessageChunk, { type: 'result' }> => c.type === 'result'
    );
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].errorSubtype).toBe('missing_assistant_message');
  });
});
