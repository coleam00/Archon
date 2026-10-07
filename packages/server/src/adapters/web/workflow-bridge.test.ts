import { describe, test, expect, mock } from 'bun:test';

// Mock logger before importing bridge
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

import {
  DASHBOARD_SOURCE_EVENT_TYPES,
  mapWorkflowEvent,
  mapWorkflowEventRow,
  WorkflowEventBridge,
} from './workflow-bridge';
import type { SSETransport } from './transport';
import {
  getWorkflowEventEmitter,
  type WorkflowEmitterEvent,
} from '@archon/workflows/event-emitter';
import type { NodeExecutionMetadata } from '@archon/workflows/schemas/node-execution';

const suspendedExecution: NodeExecutionMetadata = {
  runId: 'run-1',
  path: 'review',
  node: { id: 'review', kind: 'workflow' },
  invocation: { id: 'inv-1', startedAt: '2026-09-22T10:00:00Z', loopPath: [] },
  attempt: { id: 'attempt-1', startedAt: '2026-09-22T10:00:00Z' },
  binding: { sessionPreview: '12345678', sessionOrigin: 'resumed' },
  timing: { startedAt: '2026-09-22T10:00:00Z', durationMs: 25 },
  spend: {
    tokens: { source: 'unavailable', reason: 'not_applicable' },
    costUsd: { source: 'unavailable', reason: 'not_applicable' },
    stopReason: { source: 'unavailable', reason: 'not_applicable' },
    numTurns: { source: 'unavailable', reason: 'not_applicable' },
  },
  accounting: 'node',
  lifecycle: { status: 'suspended', point: 'child_workflow' },
};

test('suspended node stays running and carries only public execution metadata', () => {
  const event: WorkflowEmitterEvent = {
    type: 'node_suspended',
    runId: 'run-1',
    nodeId: 'review',
    nodeName: 'Review',
    execution: suspendedExecution,
  };
  const payload = JSON.parse(mapWorkflowEvent(event) ?? '{}') as Record<string, unknown>;
  expect(payload).toMatchObject({
    type: 'dag_node',
    status: 'running',
    execution: suspendedExecution,
  });
  expect(JSON.stringify(payload)).not.toContain('sessionId');
});

test('persisted typed node rows retain public execution metadata through dashboard replay', () => {
  const { runId: _runId, path: _path, lifecycle: _lifecycle, ...data } = suspendedExecution;
  const payload = JSON.parse(
    mapWorkflowEventRow({
      id: 'event-1',
      workflow_run_id: 'run-1',
      event_type: 'node_suspended',
      step_index: null,
      step_name: 'review',
      created_at: '2026-09-22T10:00:25Z',
      data: { ...data, suspend_point: 'child_workflow' },
    }) ?? '{}'
  ) as Record<string, unknown>;
  expect(payload).toMatchObject({ status: 'running', execution: suspendedExecution });
  expect(JSON.stringify(payload)).not.toContain('sessionId');
});

test.each(['conv-1', null])(
  'workflow start projection accepts optional provenance and hides the host transcript path',
  conversationId => {
    const event: WorkflowEmitterEvent = {
      type: 'workflow_started',
      runId: 'run-1',
      workflowName: 'implement',
      conversationId,
      transcriptPath: '/host/.archon/workspaces/acme/widget/logs/run-1.jsonl',
    };

    const payload = JSON.parse(mapWorkflowEvent(event) ?? '{}') as Record<string, unknown>;
    expect(payload).toMatchObject({ type: 'workflow_status', runId: 'run-1', status: 'running' });
    expect(payload).not.toHaveProperty('transcriptPath');
  }
);

test('node skip projection preserves the live skip cause', () => {
  const event: WorkflowEmitterEvent = {
    type: 'node_skipped',
    runId: 'run-1',
    nodeId: 'publish',
    nodeName: 'Publish',
    reason: 'trigger_rule',
    cause: { kind: 'upstream_failed', origin: 'validate' },
  };

  expect(JSON.parse(mapWorkflowEvent(event) ?? '{}')).toMatchObject({
    type: 'dag_node',
    runId: 'run-1',
    nodeId: 'publish',
    status: 'skipped',
    reason: 'trigger_rule',
    cause: { kind: 'upstream_failed', origin: 'validate' },
  });
});

test('prior-success replay projects as a completed dag_node', () => {
  const event: WorkflowEmitterEvent = {
    type: 'node_skipped_prior_success',
    runId: 'run-1',
    nodeId: 'publish',
    nodeName: 'Publish',
  };

  const payload = JSON.parse(mapWorkflowEvent(event) ?? '{}') as Record<string, unknown>;
  expect(payload).toMatchObject({
    type: 'dag_node',
    runId: 'run-1',
    nodeId: 'publish',
    status: 'completed',
  });
  expect(payload).not.toHaveProperty('reason');
  expect(payload).not.toHaveProperty('cause');
});

test('timeout skip projection preserves the live timeout cause', () => {
  const event: WorkflowEmitterEvent = {
    type: 'node_skipped',
    runId: 'run-1',
    nodeId: 'ci-note',
    nodeName: 'CI note',
    reason: 'timeout',
    cause: { kind: 'timeout' },
  };

  expect(JSON.parse(mapWorkflowEvent(event) ?? '{}')).toMatchObject({
    type: 'dag_node',
    runId: 'run-1',
    nodeId: 'ci-note',
    status: 'skipped',
    reason: 'timeout',
    cause: { kind: 'timeout' },
  });
});

describe('provider events on the live stream', () => {
  const providerEvent: WorkflowEmitterEvent = {
    type: 'provider_event',
    runId: 'run-1',
    stepName: 'loop.implement',
    attemptId: 'attempt-1',
    seq: 4,
    observedAt: '2026-10-02T10:00:00.123Z',
    event: {
      type: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'failed',
      output: 'boom',
      exitCode: 1,
    },
  };

  test('carries the recorded envelope and event unchanged', () => {
    expect(JSON.parse(mapWorkflowEvent(providerEvent) ?? '{}')).toEqual({
      type: 'workflow_provider_event',
      runId: 'run-1',
      stepName: 'loop.implement',
      attemptId: 'attempt-1',
      seq: 4,
      observedAt: '2026-10-02T10:00:00.123Z',
      event: {
        type: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'failed',
        output: 'boom',
        exitCode: 1,
      },
    });
  });

  test("reach only the run's own stream, never the dashboard or a parent conversation", () => {
    const emitted: Array<[string, string]> = [];
    const transport = {
      emitWorkflowEvent: (conversationId: string, event: string) => {
        emitted.push([conversationId, JSON.parse(event).type as string]);
      },
    } as unknown as SSETransport;
    const bridge = new WorkflowEventBridge(transport);
    const emitter = getWorkflowEventEmitter();
    emitter.registerRun('run-1', 'worker-conv');
    bridge.start();
    const unbridge = bridge.bridgeWorkerEvents('worker-conv', 'parent-conv');
    try {
      emitter.emit(providerEvent);
      emitter.emit({ type: 'workflow_cancelled', runId: 'run-1', nodeId: 'n', reason: 'x' });
    } finally {
      unbridge();
      bridge.stop();
      emitter.unregisterRun('run-1');
    }

    expect(emitted.filter(([, type]) => type === 'workflow_provider_event')).toEqual([
      ['worker-conv', 'workflow_provider_event'],
    ]);
    // Lifecycle frames still fan out everywhere.
    expect(
      emitted
        .filter(([, type]) => type === 'workflow_status')
        .map(([c]) => c)
        .sort()
    ).toEqual(['__dashboard__', 'parent-conv', 'worker-conv']);
  });
});

describe('mapWorkflowEvent — container_lifecycle (Phase B)', () => {
  test('container_lifecycle created → workflow_container_lifecycle SSE', () => {
    const event: WorkflowEmitterEvent = {
      type: 'container_lifecycle',
      runId: 'run-1',
      phase: 'created',
      containerId: 'abc123def456',
    };
    const sse = mapWorkflowEvent(event);
    const payload = JSON.parse(sse ?? '{}') as Record<string, unknown>;
    expect(payload.type).toBe('workflow_container_lifecycle');
    expect(payload.runId).toBe('run-1');
    expect(payload.phase).toBe('created');
    expect(payload.containerId).toBe('abc123def456');
  });

  test('container_lifecycle destroyed → SSE without a containerId', () => {
    const event: WorkflowEmitterEvent = {
      type: 'container_lifecycle',
      runId: 'run-1',
      phase: 'destroyed',
    };
    const payload = JSON.parse(mapWorkflowEvent(event) ?? '{}') as Record<string, unknown>;
    expect(payload.type).toBe('workflow_container_lifecycle');
    expect(payload.phase).toBe('destroyed');
    expect(payload).not.toHaveProperty('containerId');
  });
});

test('live approval frames retain the exact declared vocabulary', () => {
  const decisions = [
    { id: 'approve', label: 'Ship it' },
    { id: 'revise', label: 'Try again' },
    { id: 'cancel' },
  ];
  const payload: unknown = JSON.parse(
    mapWorkflowEvent({
      type: 'approval_pending',
      runId: 'r1',
      nodeId: 'review',
      message: 'Choose',
      decisions,
      pauseId: 'pause-one',
    }) ?? '{}'
  );
  expect(payload).toMatchObject({
    type: 'workflow_status',
    status: 'paused',
    approval: { nodeId: 'review', message: 'Choose', decisions, pauseId: 'pause-one' },
  });
});

test('attention publication and clearing invalidate existing dashboard readers without command contents', () => {
  expect(DASHBOARD_SOURCE_EVENT_TYPES).toContain('run_attention_changed');
  for (const hasAttention of [true, false]) {
    const local = JSON.parse(
      mapWorkflowEvent({
        type: 'run_attention_changed',
        runId: 'run',
        streamId: 'stream',
        hasAttention,
      })!
    );
    const durable = JSON.parse(
      mapWorkflowEventRow({
        id: 'event',
        workflow_run_id: 'run',
        event_type: 'run_attention_changed',
        step_index: null,
        step_name: null,
        created_at: new Date().toISOString(),
        data: { streamId: 'stream', hasAttention },
      })!
    );
    for (const payload of [local, durable])
      expect(payload).toEqual({
        type: 'workflow_status',
        runId: 'run',
        workflowName: '',
        status: 'running',
        timestamp: expect.any(Number),
      });
  }
});
