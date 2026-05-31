import { describe, expect, test } from 'bun:test';
import type { Run, SDKMessage } from '@cursor/sdk';

import { bridgeRun, mapCursorMessage } from './event-bridge';

describe('mapCursorMessage', () => {
  test('maps assistant text blocks', () => {
    const chunks = mapCursorMessage({
      type: 'assistant',
      agent_id: 'agent-1',
      run_id: 'run-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
      },
    });
    expect(chunks).toEqual([{ type: 'assistant', content: 'Hello' }]);
  });

  test('maps assistant tool_use blocks', () => {
    expect(
      mapCursorMessage({
        type: 'assistant',
        agent_id: 'agent-1',
        run_id: 'run-1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'read',
              input: { path: 'foo.ts' },
            },
          ],
        },
      })
    ).toEqual([
      {
        type: 'tool',
        toolName: 'read',
        toolInput: { path: 'foo.ts' },
        toolCallId: 'tu-1',
      },
    ]);
  });

  test('maps thinking messages', () => {
    expect(
      mapCursorMessage({
        type: 'thinking',
        agent_id: 'agent-1',
        run_id: 'run-1',
        text: 'hmm',
      })
    ).toEqual([{ type: 'thinking', content: 'hmm' }]);
  });

  test('maps running and completed tool_call events', () => {
    const running = mapCursorMessage({
      type: 'tool_call',
      agent_id: 'agent-1',
      run_id: 'run-1',
      call_id: 'call-1',
      name: 'shell',
      status: 'running',
      args: { command: 'ls' },
    });
    expect(running).toEqual([
      {
        type: 'tool',
        toolName: 'shell',
        toolInput: { command: 'ls' },
        toolCallId: 'call-1',
      },
    ]);

    const completed = mapCursorMessage({
      type: 'tool_call',
      agent_id: 'agent-1',
      run_id: 'run-1',
      call_id: 'call-1',
      name: 'shell',
      status: 'completed',
      result: 'ok',
    });
    expect(completed).toEqual([
      {
        type: 'tool_result',
        toolName: 'shell',
        toolOutput: 'ok',
        toolCallId: 'call-1',
      },
    ]);
  });

  test('maps tool_call error status', () => {
    expect(
      mapCursorMessage({
        type: 'tool_call',
        agent_id: 'agent-1',
        run_id: 'run-1',
        call_id: 'call-1',
        name: 'shell',
        status: 'error',
        result: 'boom',
      })
    ).toEqual([
      {
        type: 'tool_result',
        toolName: 'shell',
        toolOutput: '❌ boom',
        toolCallId: 'call-1',
      },
    ]);
  });

  test('maps system status and task events', () => {
    expect(
      mapCursorMessage({
        type: 'system',
        agent_id: 'agent-1',
        run_id: 'run-1',
      })
    ).toEqual([{ type: 'system', content: 'Cursor agent session initialized' }]);

    expect(
      mapCursorMessage({
        type: 'status',
        agent_id: 'agent-1',
        run_id: 'run-1',
        status: 'running',
        message: 'working',
      })
    ).toEqual([{ type: 'system', content: 'Cursor status running: working' }]);

    expect(
      mapCursorMessage({
        type: 'task',
        agent_id: 'agent-1',
        run_id: 'run-1',
        text: 'subtask',
      })
    ).toEqual([{ type: 'system', content: 'subtask' }]);
  });

  test('unknown event types yield no chunks', () => {
    expect(
      mapCursorMessage({
        type: 'unknown_event' as SDKMessage['type'],
        agent_id: 'agent-1',
        run_id: 'run-1',
      } as SDKMessage)
    ).toEqual([]);
  });
});

type FakeRun = {
  id: string;
  streamEvents: SDKMessage[];
  waitResult: { status: 'finished' | 'error' | 'cancelled'; result?: string };
  cancelled: boolean;
  stream(): AsyncGenerator<SDKMessage>;
  wait(): Promise<FakeRun['waitResult']>;
  supports(op: string): boolean;
  cancel(): Promise<void>;
};

function makeFakeRun(
  events: SDKMessage[],
  waitResult: FakeRun['waitResult'] = { status: 'finished', result: 'done' }
): FakeRun {
  const run: FakeRun = {
    id: 'run-bridge-1',
    streamEvents: events,
    waitResult,
    cancelled: false,
    async *stream() {
      for (const event of run.streamEvents) {
        yield event;
      }
    },
    wait: async () => run.waitResult,
    supports: op => op === 'cancel',
    cancel: async () => {
      run.cancelled = true;
    },
  };
  return run;
}

async function collectChunks(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

describe('bridgeRun', () => {
  test('yields mapped stream chunks and terminal result', async () => {
    const run = makeFakeRun([
      {
        type: 'assistant',
        agent_id: 'agent-1',
        run_id: 'run-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi' }],
        },
      },
    ]);

    const chunks = await collectChunks(bridgeRun(run as unknown as Run, 'agent-1'));

    expect(chunks.some(c => (c as { type: string }).type === 'assistant')).toBe(true);
    const result = chunks.find(c => (c as { type: string }).type === 'result');
    expect(result).toEqual({ type: 'result', sessionId: 'agent-1' });
  });

  test('marks result as error when wait returns error status', async () => {
    const run = makeFakeRun([], { status: 'error', result: 'failed hard' });

    const chunks = await collectChunks(bridgeRun(run as unknown as Run, 'agent-1'));
    const result = chunks.find(c => (c as { type: string }).type === 'result') as {
      isError?: boolean;
      errorSubtype?: string;
      errors?: string[];
    };

    expect(result?.isError).toBe(true);
    expect(result?.errorSubtype).toBe('error');
    expect(result?.errors).toEqual(['failed hard']);
  });

  test('marks result as error when wait returns cancelled status', async () => {
    const run = makeFakeRun([], { status: 'cancelled' });

    const chunks = await collectChunks(bridgeRun(run as unknown as Run, 'agent-1'));
    const result = chunks.find(c => (c as { type: string }).type === 'result') as {
      isError?: boolean;
      errorSubtype?: string;
    };

    expect(result?.isError).toBe(true);
    expect(result?.errorSubtype).toBe('cancelled');
  });

  test('parses structured output from assistant buffer', async () => {
    const run = makeFakeRun([
      {
        type: 'assistant',
        agent_id: 'agent-1',
        run_id: 'run-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '{"ok":true}' }],
        },
      },
    ]);

    const chunks = await collectChunks(
      bridgeRun(run as unknown as Run, 'agent-1', undefined, { type: 'object' })
    );
    const result = chunks.find(c => (c as { type: string }).type === 'result') as {
      structuredOutput?: unknown;
    };

    expect(result?.structuredOutput).toEqual({ ok: true });
  });

  test('throws AbortError when signal already aborted', async () => {
    const run = makeFakeRun([]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      collectChunks(bridgeRun(run as unknown as Run, 'agent-1', controller.signal))
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('recovers from stream error when wait returns finished with output', async () => {
    const events: SDKMessage[] = [
      {
        type: 'assistant',
        agent_id: 'agent-1',
        run_id: 'run-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '4' }],
        },
      },
    ];
    const run = makeFakeRun(events);
    const originalStream = run.stream.bind(run);
    run.stream = async function* brokenStream() {
      for await (const event of originalStream()) {
        yield event;
      }
      throw new Error('NGHTTP2_FRAME_SIZE_ERROR');
    };

    const chunks = await collectChunks(bridgeRun(run as unknown as Run, 'agent-1'));
    expect(chunks.some(c => (c as { content?: string }).content === '4')).toBe(true);
    expect(chunks.some(c => (c as { type: string }).type === 'result')).toBe(true);
  });

  test('calls cancel when aborted mid-stream', async () => {
    const run = makeFakeRun([
      {
        type: 'assistant',
        agent_id: 'agent-1',
        run_id: 'run-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'partial' }],
        },
      },
    ]);

    const controller = new AbortController();
    const gen = bridgeRun(run as unknown as Run, 'agent-1', controller.signal);
    await gen.next();
    controller.abort();
    await collectChunks(gen);
    expect(run.cancelled).toBe(true);
  });
});
