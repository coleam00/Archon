// @archon-test-isolated
import { describe, expect, mock, test } from 'bun:test';
import type { MessageChunk } from '@archon/provider-contract';

const mockWarn = mock((_data: unknown, _message?: string): void => {});
const realPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...realPaths,
  createLogger: mock(() => ({ warn: mockWarn })),
}));

import { withStaleResumeRetry } from './stale-resume';

const staleId = '30000000-0000-4000-8000-000000000001';
const staleResult: MessageChunk = {
  type: 'result',
  isError: true,
  errorSubtype: 'error_during_execution',
  failure: { class: 'unknown', evidence: 'error_during_execution: evidence' },
  sessionId: staleId,
  resumed: true,
  sessionNotFound: true,
};
const reply: MessageChunk = { type: 'agent_message_chunk', text: 'hello' };
const freshResult: MessageChunk = { type: 'result', sessionId: 'fresh-id' };

/** A `send` whose nth call streams `attempts[n]`, recording each resume argument. */
function sender(...attempts: MessageChunk[][]) {
  const calls: (string | undefined)[] = [];
  const send = async function* (resumeSessionId: string | undefined) {
    const attempt = attempts[calls.length] ?? [];
    calls.push(resumeSessionId);
    yield* attempt;
  };
  return { send, calls };
}

async function collect(stream: AsyncIterable<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('withStaleResumeRetry', () => {
  test('a stale rejection before output retries once on a fresh session', async () => {
    mockWarn.mockClear();
    const { send, calls } = sender([staleResult], [reply, freshResult]);
    const onRetry = mock(async (_id: string) => {});
    const chunks = await collect(
      withStaleResumeRetry(send, staleId, { logContext: { conversationId: 'c1' }, onRetry })
    );
    expect(calls).toEqual([staleId, undefined]);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(staleId);
    expect(chunks).toEqual([reply, { ...freshResult, resumed: false }]);
    expect(mockWarn).toHaveBeenCalledWith(
      { conversationId: 'c1', staleSessionIdPreview: '30000000' },
      'session.stale_resume_retry'
    );
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain(staleId);
  });

  test('pre-turn setup reports do not prevent the retry and are kept', async () => {
    const warning: MessageChunk = { type: 'warning', code: 'setup', message: 'setup note' };
    const { send, calls } = sender([warning, staleResult], [freshResult]);
    const chunks = await collect(withStaleResumeRetry(send, staleId, { logContext: {} }));
    expect(calls).toEqual([staleId, undefined]);
    expect(chunks).toEqual([warning, { ...freshResult, resumed: false }]);
  });

  test.each<[string, MessageChunk]>([
    ['output', reply],
    ['a tool call', { type: 'tool_call', toolCallId: 't1', name: 'Read' }],
  ])('a stale rejection after %s fails as before', async (_name, first) => {
    const { send, calls } = sender([first, staleResult], [freshResult]);
    const chunks = await collect(withStaleResumeRetry(send, staleId, { logContext: {} }));
    expect(calls).toEqual([staleId]);
    expect(chunks).toEqual([first, staleResult]);
  });

  test('a failure the provider did not mark stale does not retry', async () => {
    const { sessionNotFound: _, ...unmarked } = staleResult as Extract<
      MessageChunk,
      { type: 'result' }
    >;
    const { send, calls } = sender([unmarked], [freshResult]);
    expect(await collect(withStaleResumeRetry(send, staleId, { logContext: {} }))).toEqual([
      unmarked,
    ]);
    expect(calls).toEqual([staleId]);
  });

  test('a second stale rejection fails without another retry', async () => {
    const { send, calls } = sender([staleResult], [staleResult], [freshResult]);
    const chunks = await collect(withStaleResumeRetry(send, staleId, { logContext: {} }));
    expect(calls).toEqual([staleId, undefined]);
    expect(chunks).toEqual([{ ...staleResult, resumed: false }]);
  });

  test('a turn without a resume passes through untouched', async () => {
    const { send, calls } = sender([reply, freshResult]);
    expect(await collect(withStaleResumeRetry(send, undefined, { logContext: {} }))).toEqual([
      reply,
      freshResult,
    ]);
    expect(calls).toEqual([undefined]);
  });
});
