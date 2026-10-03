import { describe, expect, test } from 'bun:test';
import { closeOpenToolCalls } from './tool-calls';
import type { MessageChunk } from '../types';

async function* gen(...chunks: MessageChunk[]): AsyncGenerator<MessageChunk> {
  for (const c of chunks) yield c;
}

async function collect(stream: AsyncIterable<MessageChunk>): Promise<MessageChunk[]> {
  const out: MessageChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

const call = (toolCallId: string): MessageChunk => ({
  type: 'tool_call',
  toolCallId,
  name: 'Bash',
});
const done = (toolCallId: string): MessageChunk => ({
  type: 'tool_call_update',
  toolCallId,
  status: 'completed',
});
const cancelled = (toolCallId: string): MessageChunk => ({
  type: 'tool_call_update',
  toolCallId,
  status: 'cancelled',
});
const success: MessageChunk = { type: 'result', sessionId: 's' };
const failed: MessageChunk = {
  type: 'result',
  isError: true,
  failure: { class: 'transient', evidence: 'HTTP 529' },
};
const settled: MessageChunk = { type: 'settled' };

describe('closeOpenToolCalls', () => {
  test('closes open calls before a result when the result ends the turn', async () => {
    const out = await collect(
      closeOpenToolCalls(gen(call('a'), call('b'), done('a'), success, settled), {
        resultEndsTurn: true,
      })
    );
    expect(out).toEqual([call('a'), call('b'), done('a'), cancelled('b'), success, settled]);
  });

  test('leaves calls open across a success result when the result does not end the turn', async () => {
    const out = await collect(
      closeOpenToolCalls(gen(call('a'), success, done('a'), success, settled), {
        resultEndsTurn: false,
      })
    );
    expect(out).toEqual([call('a'), success, done('a'), success, settled]);
  });

  test.each<[string, MessageChunk[], MessageChunk[]]>([
    [
      'a failure result',
      [call('a'), failed, settled],
      [call('a'), cancelled('a'), failed, settled],
    ],
    ['settled', [call('a'), success, settled], [call('a'), success, cancelled('a'), settled]],
    ['the end of the stream', [call('a'), success], [call('a'), success, cancelled('a')]],
  ])(
    'with resultEndsTurn false, still closes open calls before %s',
    async (_label, input, expected) => {
      expect(await collect(closeOpenToolCalls(gen(...input), { resultEndsTurn: false }))).toEqual(
        expected
      );
    }
  );

  test('closes open calls, then rethrows a thrown error', async () => {
    async function* aborted(): AsyncGenerator<MessageChunk> {
      yield call('a');
      throw new Error('Query aborted');
    }
    const out: MessageChunk[] = [];
    let thrown: unknown;
    try {
      for await (const c of closeOpenToolCalls(aborted(), { resultEndsTurn: true })) out.push(c);
    } catch (error) {
      thrown = error;
    }
    expect(out).toEqual([call('a'), cancelled('a')]);
    expect((thrown as Error).message).toBe('Query aborted');
  });

  test('never closes a call a second time', async () => {
    const out = await collect(
      closeOpenToolCalls(gen(call('a'), done('a'), failed, settled), { resultEndsTurn: true })
    );
    expect(out).toEqual([call('a'), done('a'), failed, settled]);
  });
});
