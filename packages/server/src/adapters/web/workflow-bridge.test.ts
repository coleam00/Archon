import { describe, test, expect, mock, beforeEach } from 'bun:test';

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

import { mapWorkflowEvent } from './workflow-bridge';
import type { WorkflowEmitterEvent } from '@archon/workflows/event-emitter';

describe('mapWorkflowEvent — task_activity (Phase 2 of #975)', () => {
  beforeEach(() => {
    mockLogger.warn.mockClear();
  });

  test('task_activity started → workflow_task_activity with description', () => {
    const event: WorkflowEmitterEvent = {
      type: 'task_activity',
      runId: 'run-1',
      nodeId: 'plan',
      taskId: 't-1',
      activity: 'started',
      description: 'Analyzing the bug',
      taskType: 'general-purpose',
    };
    const sse = mapWorkflowEvent(event);
    expect(sse).not.toBeNull();
    const payload = JSON.parse(sse ?? '{}') as Record<string, unknown>;
    expect(payload.type).toBe('workflow_task_activity');
    expect(payload.runId).toBe('run-1');
    expect(payload.nodeId).toBe('plan');
    expect(payload.taskId).toBe('t-1');
    expect(payload.activity).toBe('started');
    expect(payload.description).toBe('Analyzing the bug');
    expect(payload.taskType).toBe('general-purpose');
    expect(payload).toHaveProperty('timestamp');
  });

  test('task_activity progress with summary + usage + lastToolName', () => {
    const event: WorkflowEmitterEvent = {
      type: 'task_activity',
      runId: 'run-1',
      nodeId: 'plan',
      taskId: 't-1',
      activity: 'progress',
      summary: 'Reading auth module',
      usage: { total_tokens: 1234, tool_uses: 3, duration_ms: 28000 },
      lastToolName: 'Read',
    };
    const sse = mapWorkflowEvent(event);
    const payload = JSON.parse(sse ?? '{}') as Record<string, unknown>;
    expect(payload.activity).toBe('progress');
    expect(payload.summary).toBe('Reading auth module');
    expect(payload.usage).toEqual({ total_tokens: 1234, tool_uses: 3, duration_ms: 28000 });
    expect(payload.lastToolName).toBe('Read');
  });

  test('task_activity completed', () => {
    const event: WorkflowEmitterEvent = {
      type: 'task_activity',
      runId: 'run-1',
      nodeId: 'plan',
      taskId: 't-1',
      activity: 'completed',
      summary: 'Done',
    };
    const sse = mapWorkflowEvent(event);
    const payload = JSON.parse(sse ?? '{}') as Record<string, unknown>;
    expect(payload.activity).toBe('completed');
  });
});

describe('mapWorkflowEvent — hook_activity (Phase 2 of #975)', () => {
  beforeEach(() => {
    mockLogger.warn.mockClear();
  });

  test('hook_activity started → workflow_hook_activity', () => {
    const event: WorkflowEmitterEvent = {
      type: 'hook_activity',
      runId: 'run-1',
      nodeId: 'plan',
      hookId: 'h-1',
      hookName: 'Bash',
      hookEvent: 'PreToolUse',
      activity: 'started',
    };
    const sse = mapWorkflowEvent(event);
    expect(sse).not.toBeNull();
    const payload = JSON.parse(sse ?? '{}') as Record<string, unknown>;
    expect(payload.type).toBe('workflow_hook_activity');
    expect(payload.hookId).toBe('h-1');
    expect(payload.hookName).toBe('Bash');
    expect(payload.hookEvent).toBe('PreToolUse');
    expect(payload.activity).toBe('started');
    expect(payload).not.toHaveProperty('outcome');
  });

  test('hook_activity response with outcome success + exit code', () => {
    const event: WorkflowEmitterEvent = {
      type: 'hook_activity',
      runId: 'run-1',
      nodeId: 'plan',
      hookId: 'h-1',
      hookName: 'Bash',
      hookEvent: 'PreToolUse',
      activity: 'response',
      outcome: 'success',
      exitCode: 0,
    };
    const sse = mapWorkflowEvent(event);
    const payload = JSON.parse(sse ?? '{}') as Record<string, unknown>;
    expect(payload.activity).toBe('response');
    expect(payload.outcome).toBe('success');
    expect(payload.exitCode).toBe(0);
  });

  test('hook_activity response with error outcome and no exit code', () => {
    const event: WorkflowEmitterEvent = {
      type: 'hook_activity',
      runId: 'run-1',
      nodeId: 'plan',
      hookId: 'h-2',
      hookName: 'Edit',
      hookEvent: 'PreToolUse',
      activity: 'response',
      outcome: 'error',
    };
    const sse = mapWorkflowEvent(event);
    const payload = JSON.parse(sse ?? '{}') as Record<string, unknown>;
    expect(payload.outcome).toBe('error');
    expect(payload).not.toHaveProperty('exitCode');
  });
});
