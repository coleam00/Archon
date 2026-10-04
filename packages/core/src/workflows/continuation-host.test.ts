import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowResumeCursor } from '@archon/workflows/store';
const mockListDueWorkflowContinuations = mock(async () => [] as WorkflowRun[]);
const mockDeferWorkflowContinuation = mock(async () => undefined);
mock.module('@archon/core/db/workflows', () => ({
  listDueWorkflowContinuations: mockListDueWorkflowContinuations,
  deferWorkflowContinuation: mockDeferWorkflowContinuation,
}));
import { wakeDueWorkflowContinuations } from '@archon/core/workflows/continuation-host';

async function scanDueWorkflowContinuations(
  now: Date,
  resume: (run: WorkflowRun, cursor: WorkflowResumeCursor) => Promise<boolean>
): Promise<number> {
  const outcomes = await wakeDueWorkflowContinuations(now, async (run, cursor) =>
    (await resume(run, cursor))
      ? {
          kind: 'accepted',
          run,
          settled: Promise.resolve({ success: true, workflowRunId: run.id }),
        }
      : { kind: 'unavailable', reason: 'test unavailable' }
  );
  return outcomes.filter(outcome => outcome.kind === 'accepted').length;
}

function run(
  id: string,
  status: 'paused' | 'failed',
  metadata: Record<string, unknown>
): WorkflowRun {
  return {
    id,
    workflow_name: 'deliver',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: null,
    status,
    outcome: null,
    user_message: 'deliver',
    metadata,
    started_at: new Date('2026-08-24T10:00:00.000Z'),
    completed_at: status === 'failed' ? new Date('2026-08-24T10:01:00.000Z') : null,
    last_activity_at: null,
    working_path: '/tmp/worktree',
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
  };
}

describe('continuation host scanner', () => {
  beforeEach(() => {
    mockListDueWorkflowContinuations.mockReset();
    mockDeferWorkflowContinuation.mockReset();
    mockDeferWorkflowContinuation.mockResolvedValue(undefined);
  });
  test('resumes due waits and quota continuations through the shared resume CAS', async () => {
    const scheduled = {
      reason: 'quota' as const,
      resumeAt: '2026-08-24T11:00:00.000Z',
      deadlineAt: '2026-08-25T11:00:00.000Z',
      attempt: 1,
      maxAttempts: 2,
      error: 'usage limit reached',
    };
    mockListDueWorkflowContinuations.mockResolvedValue([
      run('wait-1', 'paused', {
        wait: {
          owner: 'node',
          nodeId: 'delay',
          kind: 'time',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-24T11:00:00.000Z',
        },
      }),
      run('quota-1', 'failed', { scheduled_resume: scheduled }),
    ]);
    const resume = mock(async (_run: WorkflowRun, _cursor: WorkflowResumeCursor) => true);

    await expect(
      scanDueWorkflowContinuations(new Date('2026-08-24T11:00:01.000Z'), resume)
    ).resolves.toBe(2);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume.mock.calls[0]).toEqual([
      expect.objectContaining({ id: 'wait-1' }),
      { kind: 'wait', nodeId: 'delay', resumeAt: '2026-08-24T11:00:00.000Z' },
    ]);
    expect(resume.mock.calls[1]).toEqual([
      expect.objectContaining({ id: 'quota-1' }),
      { kind: 'quota', attempt: 1, resumeAt: '2026-08-24T11:00:00.000Z' },
    ]);
  });
  test('resumes due event waits through the shared resume CAS', async () => {
    mockListDueWorkflowContinuations.mockResolvedValue([
      run('event-1', 'paused', {
        wait: {
          owner: 'node',
          nodeId: 'await-review',
          kind: 'event',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-24T11:00:00.000Z',
          event: 'review.completed',
        },
      }),
    ]);
    const resume = mock(async (_run: WorkflowRun, _cursor: WorkflowResumeCursor) => true);

    await expect(
      scanDueWorkflowContinuations(new Date('2026-08-24T11:00:01.000Z'), resume)
    ).resolves.toBe(1);
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ id: 'event-1' }), {
      kind: 'wait',
      nodeId: 'await-review',
      resumeAt: '2026-08-24T11:00:00.000Z',
    });
  });
  test('does not schedule an action-required wait even if a malformed due query returns it', async () => {
    mockListDueWorkflowContinuations.mockResolvedValue([
      run('attention-1', 'paused', {
        wait: {
          owner: 'node',
          nodeId: 'rerun-ci',
          kind: 'attention',
          waitingSince: '2026-08-24T10:00:00.000Z',
          message: 'Re-run CI, then resume.',
        },
      }),
    ]);
    const resume = mock(async () => true);

    await expect(
      scanDueWorkflowContinuations(new Date('2026-08-24T11:00:01.000Z'), resume)
    ).resolves.toBe(0);
    expect(resume).not.toHaveBeenCalled();
    expect(mockDeferWorkflowContinuation).not.toHaveBeenCalled();
  });
  test('resumes a paused wait even when the run retains historical quota metadata', async () => {
    const scheduled = {
      reason: 'quota' as const,
      resumeAt: '2026-08-24T10:30:00.000Z',
      deadlineAt: '2026-08-25T10:30:00.000Z',
      attempt: 1,
      maxAttempts: 2,
      error: 'usage limit reached',
      triggeredAt: '2026-08-24T10:30:01.000Z',
    };
    mockListDueWorkflowContinuations.mockResolvedValue([
      run('wait-after-quota', 'paused', {
        wait: {
          owner: 'node',
          nodeId: 'delay',
          kind: 'time',
          waitingSince: '2026-08-24T10:31:00.000Z',
          resumeAt: '2026-08-24T11:00:00.000Z',
        },
        scheduled_resume: scheduled,
      }),
    ]);
    const resume = mock(async (_run: WorkflowRun, _cursor: WorkflowResumeCursor) => true);

    await expect(
      scanDueWorkflowContinuations(new Date('2026-08-24T11:00:01.000Z'), resume)
    ).resolves.toBe(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });
  test('backs off a due row when execution prerequisites are unavailable', async () => {
    mockListDueWorkflowContinuations.mockResolvedValueOnce([
      run('wait-poison', 'paused', {
        wait: {
          owner: 'node',
          nodeId: 'delay',
          kind: 'time',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-24T11:00:00.000Z',
        },
      }),
    ]);
    const resume = mock(async () => false);

    await expect(
      scanDueWorkflowContinuations(new Date('2026-08-24T11:00:00.000Z'), resume)
    ).resolves.toBe(0);

    expect(mockDeferWorkflowContinuation).toHaveBeenCalledWith(
      'wait-poison',
      '2026-08-24T11:01:00.000Z',
      { kind: 'wait', nodeId: 'delay', resumeAt: '2026-08-24T11:00:00.000Z' }
    );
  });
  test('logs and backs off a row when destination resolution rejects', async () => {
    mockListDueWorkflowContinuations.mockResolvedValueOnce([
      run('wait-reject', 'paused', {
        wait: {
          owner: 'node',
          nodeId: 'delay',
          kind: 'time',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-24T11:00:00.000Z',
        },
      }),
    ]);
    const resume = mock(async () => {
      throw new Error('conversation lookup failed');
    });

    await expect(
      scanDueWorkflowContinuations(new Date('2026-08-24T11:00:00.000Z'), resume)
    ).resolves.toBe(0);

    expect(mockDeferWorkflowContinuation).toHaveBeenCalledWith(
      'wait-reject',
      '2026-08-24T11:01:00.000Z',
      { kind: 'wait', nodeId: 'delay', resumeAt: '2026-08-24T11:00:00.000Z' }
    );
  });
});

test('reports deferral failure while admitting other rows', async () => {
  const wait = {
    owner: 'node',
    kind: 'time',
    nodeId: 'delay',
    waitingSince: '2026-08-24T10:00:00.000Z',
    resumeAt: '2026-08-24T11:00:00.000Z',
  };
  mockListDueWorkflowContinuations.mockResolvedValue([
    run('bad', 'paused', { wait }),
    run('good', 'paused', { wait }),
  ]);
  mockDeferWorkflowContinuation.mockRejectedValueOnce(new Error('defer unavailable'));
  const outcomes = await wakeDueWorkflowContinuations(
    new Date('2026-08-24T11:00:01.000Z'),
    async candidate => {
      if (candidate.id === 'bad') throw new Error('resume unavailable');
      return {
        kind: 'accepted',
        run: candidate,
        settled: Promise.resolve({ success: true, workflowRunId: candidate.id }),
      };
    }
  );
  expect(outcomes[0]).toEqual({
    runId: 'bad',
    kind: 'failed',
    error: expect.any(Error),
    deferError: expect.any(Error),
  });
  expect(outcomes[1]?.kind).toBe('accepted');
});
