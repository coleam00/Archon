import { createSqlWorkflowHost } from '@archon/core/workflows/sql-host';
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type {
  wakeDueWorkflowContinuations,
  resumeWorkflowContinuation,
} from '@archon/core/workflows/continuation-host';
import type { IWorkflowPlatform } from '@archon/workflows/deps';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowResumeCursor } from '@archon/workflows/store';
const scan = mock<typeof wakeDueWorkflowContinuations>(async () => []);
const resume = mock<typeof resumeWorkflowContinuation>(async () => ({ kind: 'not-accepted' }));
mock.module('@archon/core/workflows/continuation-host', () => ({
  wakeDueWorkflowContinuations: scan,
  resumeWorkflowContinuation: resume,
}));
import {
  startWorkflowContinuationScheduler,
  stopWorkflowContinuationScheduler,
} from './workflow-resume-service';
afterEach(() => {
  stopWorkflowContinuationScheduler();
  mock.restore();
  scan.mockReset();
  scan.mockResolvedValue([]);
  resume.mockReset();
  resume.mockResolvedValue({ kind: 'not-accepted' });
});

test('routes a scheduled continuation to its execution destination and delivers the settled result', async () => {
  const due: WorkflowRun = {
    origin: { conversationId: 'worker-conversation', parentConversationId: 'parent-conversation' },
    id: 'scheduled-run',
    workflow_name: 'deliver',
    conversation_id: 'worker-conversation',
    parent_conversation_id: 'parent-conversation',
    codebase_id: null,
    status: 'paused',
    outcome: null,
    user_message: 'deliver',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: '/tmp/worktree',
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
  };
  const freshRun = { ...due, user_message: 'fresh context' };
  const cursor: WorkflowResumeCursor = {
    kind: 'wait',
    nodeId: 'wait',
    resumeAt: '2026-10-04T10:00:00.000Z',
  };
  let delivered!: () => void;
  const delivery = new Promise<void>(resolve => {
    delivered = resolve;
  });
  const sendMessage = mock<IWorkflowPlatform['sendMessage']>(async () => {
    delivered();
  });
  const platform: IWorkflowPlatform = {
    sendMessage,
    getStreamingMode: () => 'batch',
    getPlatformType: () => 'web',
  };
  const resolver = mock(async (_run: WorkflowRun) => ({
    kind: 'platform' as const,
    destination: {
      platform,
      conversationId: 'execution-worker',
      resultConversationId: 'visible-parent',
    },
  }));
  resume.mockImplementationOnce(async (_engine, runId, resolveContext, receivedCursor) => {
    expect(runId).toBe(due.id);
    expect(receivedCursor).toEqual(cursor);
    expect(await resolveContext(freshRun)).toEqual({
      kind: 'ready',
      platform,
      conversationId: 'execution-worker',
    });
    return {
      kind: 'accepted',
      run: freshRun,
      settled: Promise.resolve({
        success: true,
        workflowRunId: due.id,
        summary: 'Scheduled work finished',
      }),
    };
  });
  scan.mockImplementationOnce(async (_store, _now, admit) => [
    { runId: due.id, ...(await admit(due, cursor)) },
  ]);
  spyOn(globalThis, 'setInterval').mockImplementation(
    () => ({ unref: () => undefined }) as unknown as ReturnType<typeof setInterval>
  );
  spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
  startWorkflowContinuationScheduler(createSqlWorkflowHost(), resolver);
  await delivery;
  expect(scan).toHaveBeenCalledTimes(1);
  expect(resume).toHaveBeenCalledTimes(1);
  expect(resolver).toHaveBeenCalledWith(freshRun);
  expect(sendMessage).toHaveBeenCalledWith('visible-parent', 'Scheduled work finished', {
    category: 'workflow_result',
    segment: 'new',
    workflowResult: { workflowName: 'deliver', runId: due.id },
  });
});

test('delegates immediately, guards overlap, ticks other host work and stops the interval', async () => {
  let release!: () => void;
  scan.mockImplementationOnce(async () => {
    await new Promise<void>(resolve => {
      release = resolve;
    });
    return [];
  });
  let tick: (() => void) | undefined;
  const interval = spyOn(globalThis, 'setInterval').mockImplementation((callback: () => void) => {
    tick = callback;
    return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
  });
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
  const otherHostWork = mock(() => undefined);
  startWorkflowContinuationScheduler(createSqlWorkflowHost(), undefined, otherHostWork);
  expect(scan).toHaveBeenCalledTimes(1);
  expect(interval.mock.calls[0]?.[1]).toBe(5000);
  tick?.();
  expect(scan).toHaveBeenCalledTimes(1);
  expect(otherHostWork).toHaveBeenCalledTimes(2);
  release();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  tick?.();
  expect(scan).toHaveBeenCalledTimes(2);
  stopWorkflowContinuationScheduler();
  expect(clear).toHaveBeenCalledTimes(1);
});
