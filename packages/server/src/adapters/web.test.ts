import { describe, test, expect, mock, beforeEach } from 'bun:test';

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
import { MAX_TOOL_OUTPUT_CHARS } from './web/truncate';
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
} {
  const emitted: string[] = [];
  const appendToolResultCalls: unknown[][] = [];

  const mockTransport = {
    emit: mock(async (_id: string, event: string) => {
      emitted.push(event);
    }),
  } as unknown as SSETransport;

  const mockPersistence = {
    appendToolResult: mock((_id: string, name: string, output: string, duration: number) => {
      appendToolResultCalls.push([_id, name, output, duration]);
    }),
    appendToolCall: mock(() => {}),
    appendText: mock(() => {}),
    flush: mock(async () => {}),
    finalizeRunningTools: mock(() => {}),
  } as unknown as MessagePersistence;

  const mockBridge = {
    emitOutput: mock(() => {}),
    registerOutputCallback: mock(() => {}),
    removeOutputCallback: mock(() => {}),
    setStepTransitionCallback: mock(() => {}),
    start: mock(() => {}),
    stop: mock(() => {}),
    bridgeWorkerEvents: mock(() => () => {}),
  } as unknown as WorkflowEventBridge;

  const adapter = new WebAdapter(mockTransport, mockPersistence, mockBridge);
  return { adapter, emitted, appendToolResultCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();
});

describe('WebAdapter.sendStructuredEvent — tool_result output bounding', () => {
  test('truncates SSE event output when toolOutput exceeds the cap', async () => {
    const { adapter, emitted } = makeAdapter();
    const largeOutput = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 50_000);

    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool_result',
      toolName: 'bash',
      toolOutput: largeOutput,
    });

    expect(emitted.length).toBe(1);
    const parsed = JSON.parse(emitted[0]!) as { output: string };
    expect(parsed.output.length).toBeLessThan(largeOutput.length);
    expect(parsed.output).toContain('[truncated');
    expect(parsed.output).toContain('full output preserved in run history');
  });

  test('passes SSE event output through unchanged when within the cap', async () => {
    const { adapter, emitted } = makeAdapter();
    const smallOutput = 'small tool output';

    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool_result',
      toolName: 'bash',
      toolOutput: smallOutput,
    });

    expect(emitted.length).toBe(1);
    const parsed = JSON.parse(emitted[0]!) as { output: string };
    expect(parsed.output).toBe(smallOutput);
  });

  test('persists full untruncated output to DB regardless of the SSE cap', async () => {
    const { adapter, appendToolResultCalls } = makeAdapter();
    const largeOutput = 'z'.repeat(MAX_TOOL_OUTPUT_CHARS + 50_000);

    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool_result',
      toolName: 'bash',
      toolOutput: largeOutput,
    });

    expect(appendToolResultCalls.length).toBe(1);
    // Third argument to appendToolResult is the output — must be the full string
    expect(appendToolResultCalls[0]![2]).toBe(largeOutput);
  });
});
