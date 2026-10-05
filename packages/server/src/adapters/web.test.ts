import { describe, test, expect, mock, beforeEach, spyOn } from 'bun:test';

// Mock logger before importing any module that transitively imports @archon/paths
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info' as const,
};

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import { WebAdapter } from './web';
import type { SSETransport } from './web/transport';
import type { MessagePersistence } from './web/persistence';
import type { WorkflowEventBridge } from './web/workflow-bridge';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(): {
  adapter: WebAdapter;
  emitted: string[];
  appendToolResultCalls: unknown[][];
  bridge: WorkflowEventBridge;
} {
  const emitted: string[] = [];
  const appendToolResultCalls: unknown[][] = [];

  const mockTransport = {
    emit: mock(async (_id: string, event: string) => {
      emitted.push(event);
    }),
  } as unknown as SSETransport;

  const mockPersistence = {
    appendToolResult: mock((_id: string, toolCallId: string, output: string, duration: number) => {
      appendToolResultCalls.push([_id, toolCallId, output, duration]);
    }),
    appendToolCall: mock(() => {}),
    appendText: mock(() => {}),
    flush: mock(async () => {}),
    finalizeRunningTools: mock(() => {}),
  } as unknown as MessagePersistence;

  const mockBridge = {
    setStepTransitionCallback: mock(() => {}),
    start: mock(() => {}),
    stop: mock(() => {}),
    bridgeWorkerEvents: mock(() => () => {}),
  } as unknown as WorkflowEventBridge;

  const adapter = new WebAdapter(mockTransport, mockPersistence, mockBridge);
  return { adapter, emitted, appendToolResultCalls, bridge: mockBridge };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();
});

test('WebAdapter supports durable conversation project detachment', () => {
  expect(makeAdapter().adapter.capabilities.canDetachProject).toBe(true);
});

describe('WebAdapter.sendStructuredEvent — provider results', () => {
  test('does not emit a provider session id on SSE', async () => {
    const { adapter, emitted } = makeAdapter();
    const sessionId = 'provider-session-3597-resumable-conversation';

    await adapter.sendStructuredEvent('conv-1', { type: 'result', sessionId });

    expect(emitted.join('\n')).not.toContain(sessionId);
    expect(emitted).toEqual([]);
  });
});

describe('WebAdapter.sendStructuredEvent — tool results', () => {
  test.each(['patch text', 0, false, null, ['a', 1]].map(input => [input] as const))(
    'streams non-object tool input %j unchanged',
    async input => {
      const { adapter, emitted } = makeAdapter();
      await adapter.sendStructuredEvent('conv-1', {
        type: 'tool_call',
        toolCallId: 'patch',
        name: 'apply_patch',
        rawInput: input,
      });
      expect(JSON.parse(emitted[0]!)).toMatchObject({ type: 'tool_call', input });
    }
  );

  test('pairs results by id when two tools with the same name run concurrently', async () => {
    const { adapter, emitted, appendToolResultCalls } = makeAdapter();

    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool_call',
      toolCallId: 'a',
      name: 'Bash',
      rawInput: { command: 'sleep 2' },
    });
    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool_call',
      toolCallId: 'b',
      name: 'Bash',
      rawInput: { command: 'echo b' },
    });
    // The later call finishes first.
    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool_call_update',
      toolCallId: 'b',
      status: 'failed',
      exitCode: 1,
      output: 'out-b',
    });
    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool_call_update',
      toolCallId: 'a',
      status: 'completed',
      output: 'out-a',
    });

    const results = emitted
      .map(
        e => JSON.parse(e) as { type: string; toolCallId?: string; name?: string; output?: string }
      )
      .filter(e => e.type === 'tool_result');
    expect(results).toEqual([
      expect.objectContaining({
        toolCallId: 'b',
        name: 'Bash',
        output: 'out-b',
        status: 'failed',
        exitCode: 1,
      }),
      expect.objectContaining({ toolCallId: 'a', name: 'Bash', output: 'out-a' }),
    ]);
    expect(appendToolResultCalls.map(c => [c[1], c[2]])).toEqual([
      ['b', 'out-b'],
      ['a', 'out-a'],
    ]);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

describe('WebAdapter.sendMessage — text event category', () => {
  test('carries the metadata category on the text event', async () => {
    const { adapter, emitted } = makeAdapter();

    await adapter.sendMessage('conv-1', '🚀 Dispatching workflow: **plan**', {
      category: 'workflow_dispatch_status',
      segment: 'new',
    });

    expect(emitted.length).toBe(1);
    const parsed = JSON.parse(emitted[0]!) as { type: string; category?: string };
    expect(parsed.type).toBe('text');
    expect(parsed.category).toBe('workflow_dispatch_status');
  });

  test('omits the category key entirely for agent prose', async () => {
    const { adapter, emitted } = makeAdapter();

    await adapter.sendMessage('conv-1', 'ordinary assistant text');

    expect(emitted.length).toBe(1);
    const parsed = JSON.parse(emitted[0]!) as Record<string, unknown>;
    expect('category' in parsed).toBe(false);
  });

  test('still suppresses structurally-handled categories rather than emitting them', async () => {
    const { adapter, emitted } = makeAdapter();

    await adapter.sendMessage('conv-1', 'formatted tool call', {
      category: 'tool_call_formatted',
    });
    await adapter.sendMessage('conv-1', '📍 repo @ `branch`', {
      category: 'isolation_context',
    });

    expect(emitted.length).toBe(0);
  });
});

test('background preparation maps persistence and releases the bridge before awaited lock flush', async () => {
  const { adapter, bridge: workflowBridge } = makeAdapter();
  const calls: string[] = [];
  const mapping = spyOn(adapter, 'setConversationDbId').mockImplementation(() => {
    calls.push('mapping');
  });
  const bridge = spyOn(workflowBridge, 'bridgeWorkerEvents').mockImplementation(() => () => {
    calls.push('unsubscribe');
  });
  let release: () => void = () => {};
  const lock = spyOn(adapter, 'emitLockEvent').mockImplementation(async () => {
    await new Promise<void>(resolve => {
      release = resolve;
    });
    calls.push('lock');
  });
  const finish = await adapter.prepareBackgroundConversation({
    workerConversationId: 'worker',
    parentConversationId: 'parent',
    conversationDbId: 'db',
  });
  expect(mapping).toHaveBeenCalledWith('worker', 'db');
  expect(bridge).toHaveBeenCalledWith('worker', 'parent');
  const finished = finish();
  expect(calls).toEqual(['mapping', 'unsubscribe']);
  expect(lock).toHaveBeenCalledWith('worker', false);
  release();
  await finished;
  expect(calls).toEqual(['mapping', 'unsubscribe', 'lock']);
});
