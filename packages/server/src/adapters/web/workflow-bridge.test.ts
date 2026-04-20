import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { WorkflowEmitterEvent } from '@archon/workflows/event-emitter';

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
  level: 'info',
};

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import { mapWorkflowEvent } from './workflow-bridge';

type ApprovalPendingEvent = Extract<WorkflowEmitterEvent, { type: 'approval_pending' }>;

function createApprovalPendingEvent(
  overrides: Partial<ApprovalPendingEvent> = {}
): ApprovalPendingEvent {
  return {
    type: 'approval_pending',
    runId: 'run-123',
    nodeId: 'approval-node',
    message: 'Need approval',
    ...overrides,
  };
}

describe('mapWorkflowEvent', () => {
  beforeEach(() => {
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();
    mockLogger.debug.mockClear();
  });

  test('serializes additive approval payload with explicit false booleans', () => {
    const serialized = mapWorkflowEvent(
      createApprovalPendingEvent({
        lastOutput: 'Compatibility snapshot',
        lastOutputTruncated: false,
        finalAssistantOutput: 'Semantic summary',
        finalAssistantOutputTruncated: false,
      })
    );

    expect(serialized).not.toBeNull();

    const payload = JSON.parse(serialized ?? '{}') as {
      type: string;
      runId: string;
      workflowName: string;
      status: string;
      timestamp: number;
      approval: Record<string, unknown>;
    };

    expect(payload.type).toBe('workflow_status');
    expect(payload.runId).toBe('run-123');
    expect(payload.workflowName).toBe('');
    expect(payload.status).toBe('paused');
    expect(payload.timestamp).toBeTypeOf('number');
    expect(payload.approval).toEqual({
      nodeId: 'approval-node',
      message: 'Need approval',
      lastOutput: 'Compatibility snapshot',
      lastOutputTruncated: false,
      finalAssistantOutput: 'Semantic summary',
      finalAssistantOutputTruncated: false,
    });
  });

  test('serializes truncated approval payloads with true booleans', () => {
    const serialized = mapWorkflowEvent(
      createApprovalPendingEvent({
        lastOutput: 'Compatibility snapshot\n\n[truncated]',
        lastOutputTruncated: true,
        finalAssistantOutput: 'Semantic summary',
        finalAssistantOutputTruncated: true,
      })
    );

    expect(serialized).not.toBeNull();

    const payload = JSON.parse(serialized ?? '{}') as {
      approval: Record<string, unknown>;
    };

    expect(payload.approval).toEqual({
      nodeId: 'approval-node',
      message: 'Need approval',
      lastOutput: 'Compatibility snapshot\n\n[truncated]',
      lastOutputTruncated: true,
      finalAssistantOutput: 'Semantic summary',
      finalAssistantOutputTruncated: true,
    });
  });

  test('omits optional approval fields when only message metadata is present', () => {
    const serialized = mapWorkflowEvent(createApprovalPendingEvent());

    expect(serialized).not.toBeNull();

    const payload = JSON.parse(serialized ?? '{}') as {
      approval: Record<string, unknown>;
    };

    expect(payload.approval).toEqual({
      nodeId: 'approval-node',
      message: 'Need approval',
    });
    expect(payload.approval).not.toHaveProperty('lastOutput');
    expect(payload.approval).not.toHaveProperty('lastOutputTruncated');
    expect(payload.approval).not.toHaveProperty('finalAssistantOutput');
    expect(payload.approval).not.toHaveProperty('finalAssistantOutputTruncated');
  });
});
