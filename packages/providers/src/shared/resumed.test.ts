import { describe, test, expect } from 'bun:test';
import { withResumedOutcome, resumedOutcome } from './resumed';
import type { MessageChunk } from '../types';

async function* gen(...chunks: MessageChunk[]): AsyncGenerator<MessageChunk> {
  for (const c of chunks) yield c;
}

async function collect(stream: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const out: MessageChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

describe('withResumedOutcome', () => {
  test('passes chunks through unchanged when resumed is undefined (no resume attempted)', async () => {
    const out = await collect(
      withResumedOutcome(
        gen({ type: 'assistant', content: 'hi' }, { type: 'result', sessionId: 's' }),
        undefined
      )
    );
    expect(out).toEqual([
      { type: 'assistant', content: 'hi' },
      { type: 'result', sessionId: 's' },
    ]);
  });

  test('stamps resumed:true on the result chunk', async () => {
    const out = await collect(withResumedOutcome(gen({ type: 'result', sessionId: 's' }), true));
    expect(out).toEqual([{ type: 'result', sessionId: 's', resumed: true }]);
  });

  test('stamps resumed:false on the result chunk, leaving other chunks untouched', async () => {
    const out = await collect(
      withResumedOutcome(
        gen(
          { type: 'assistant', content: 'x' },
          { type: 'result', sessionId: 's', tokens: { input: 1, output: 2 } }
        ),
        false
      )
    );
    expect(out[0]).toEqual({ type: 'assistant', content: 'x' });
    expect(out[1]).toEqual({
      type: 'result',
      sessionId: 's',
      tokens: { input: 1, output: 2 },
      resumed: false,
    });
  });

  test('stamps every result chunk (defensive — providers normally emit one)', async () => {
    const out = await collect(
      withResumedOutcome(gen({ type: 'result' }, { type: 'result' }), true)
    );
    expect(out).toEqual([
      { type: 'result', resumed: true },
      { type: 'result', resumed: true },
    ]);
  });

  test('drops the stamp when the stream emits no result chunk (nothing to stamp)', async () => {
    const out = await collect(
      withResumedOutcome(gen({ type: 'assistant', content: 'partial' }), false)
    );
    expect(out).toEqual([{ type: 'assistant', content: 'partial' }]);
  });
});

describe('resumedOutcome', () => {
  test('returns undefined when no resume was requested, regardless of success', () => {
    expect(resumedOutcome(undefined, true)).toBeUndefined();
    expect(resumedOutcome(undefined, false)).toBeUndefined();
  });

  test('returns the success boolean when a resume was requested', () => {
    expect(resumedOutcome('sess-1', true)).toBe(true);
    expect(resumedOutcome('sess-1', false)).toBe(false);
  });
});
