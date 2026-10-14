// @archon-test-isolated
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowResumeCursor } from '@archon/workflows/store';
const mockWarn = mock((_fields: unknown, _message: string) => undefined);
const paths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...paths,
  createLogger: () => ({ warn: mockWarn, error: mock(() => undefined) }),
}));
const { WorkflowSourceUnavailableError } = await import('../../../workflows/src/workflow-source');
const mockListDueWorkflowContinuations = mock(
  async (_now: Date, _limit: number) => [] as WorkflowRun[]
);
const mockDeferWorkflowContinuation = mock(async () => undefined);
const store = {
  listDueWorkflowContinuations: mockListDueWorkflowContinuations,
  deferWorkflowContinuation: mockDeferWorkflowContinuation,
};
const { wakeDueWorkflowContinuations } = await import('@archon/core/workflows/continuation-host');

async function scanDueWorkflowContinuations(
  now: Date,
  resume: (run: WorkflowRun, cursor: WorkflowResumeCursor) => Promise<boolean>
): Promise<number> {
  const outcomes = await wakeDueWorkflowContinuations(store, now, async (run, cursor) =>
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
    origin: { conversationId: 'conv-1' },
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
  test('does not schedule an attention wait even if a malformed due query returns it', async () => {
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
    store,
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

test('bounds structural source failures locally and warns once', async () => {
  const candidate = run('structural-source', 'paused', {
    wait: {
      owner: 'node',
      kind: 'time',
      nodeId: 'delay',
      waitingSince: '2026-08-24T10:00:00.000Z',
      resumeAt: '2026-08-24T11:00:00.000Z',
    },
  });
  mockListDueWorkflowContinuations.mockResolvedValue([candidate]);
  mockDeferWorkflowContinuation.mockClear();
  mockWarn.mockClear();
  const resume = mock(async () => {
    throw new WorkflowSourceUnavailableError(
      '/owning-host/source/manifest.json',
      new Error('ENOENT')
    );
  });
  for (let attempt = 0; attempt < 8; attempt++) {
    await wakeDueWorkflowContinuations(
      store,
      new Date(Date.parse('2026-08-24T11:00:00Z') + attempt * 60_000),
      resume
    );
  }
  expect(resume).toHaveBeenCalledTimes(3);
  expect(mockDeferWorkflowContinuation).toHaveBeenCalledTimes(2);
  expect(mockWarn).toHaveBeenCalledTimes(1);
  expect(mockWarn).toHaveBeenCalledWith(
    { runId: candidate.id, path: '/owning-host/source/manifest.json', attempts: 3 },
    expect.stringContaining(`archon workflow resume ${candidate.id}`)
  );
  expect(mockWarn.mock.calls[0]).toEqual([
    expect.any(Object),
    expect.stringContaining(`archon workflow abandon ${candidate.id}`),
  ]);
  expect(candidate.status).toBe('paused');
  const child = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `
    import { wakeDueWorkflowContinuations } from ${JSON.stringify(new URL('./continuation-host.ts', import.meta.url).pathname)};
    const run = ${JSON.stringify(candidate)};
    let resumed = false;
    const outcomes = await wakeDueWorkflowContinuations({
      listDueWorkflowContinuations: async () => [run],
      deferWorkflowContinuation: async () => { throw new Error('healthy host deferred'); },
    }, new Date('2026-08-24T12:00:00Z'), async () => {
      resumed = true;
      return { kind: 'accepted', run, settled: Promise.resolve({ success: true, workflowRunId: run.id }) };
    });
    if (!resumed || outcomes[0]?.kind !== 'accepted') process.exit(1);
  `,
    ],
    { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, DATABASE_URL: '' } }
  );
  expect(await new Response(child.stderr).text()).toBe('');
  expect(await child.exited).toBe(0);
});

test('transient failures keep the 60 second retry beyond the structural bound', async () => {
  const candidate = run('transient-source', 'paused', {
    wait: {
      owner: 'node',
      kind: 'time',
      nodeId: 'delay',
      waitingSince: '2026-08-24T10:00:00Z',
      resumeAt: '2026-08-24T11:00:00Z',
    },
  });
  mockListDueWorkflowContinuations.mockResolvedValue([candidate]);
  mockDeferWorkflowContinuation.mockClear();
  const resume = mock(async () => {
    throw new Error('Workflow source ENOENT');
  });
  for (let attempt = 0; attempt < 8; attempt++) {
    const now = new Date(Date.parse('2026-08-24T11:00:00Z') + attempt * 60_000);
    await wakeDueWorkflowContinuations(store, now, resume);
    expect(mockDeferWorkflowContinuation).toHaveBeenLastCalledWith(
      candidate.id,
      new Date(now.getTime() + 60_000).toISOString(),
      { kind: 'wait', nodeId: 'delay', resumeAt: '2026-08-24T11:00:00Z' }
    );
  }
  expect(resume).toHaveBeenCalledTimes(8);
});

test('blocked rows do not starve later continuations in the same database', async () => {
  const candidates = Array.from({ length: 26 }, (_, i) =>
    run(`queue-${i}`, 'paused', {
      wait: {
        owner: 'node',
        kind: 'time',
        nodeId: 'delay',
        waitingSince: '2026-08-24T10:00:00Z',
        resumeAt: '2026-08-24T11:00:00Z',
      },
    })
  );
  mockListDueWorkflowContinuations.mockImplementation(async (_now: Date, limit: number) =>
    candidates.slice(0, limit)
  );
  const resume = mock(async (candidate: WorkflowRun) =>
    candidate.id === 'queue-25'
      ? {
          kind: 'accepted' as const,
          run: candidate,
          settled: Promise.resolve({ success: true as const, workflowRunId: candidate.id }),
        }
      : {
          kind: 'unavailable' as const,
          reason: 'source unreadable',
          sourceError: new WorkflowSourceUnavailableError('/foreign/source', new Error('ENOENT')),
        }
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    await wakeDueWorkflowContinuations(store, new Date('2026-08-24T11:00:00Z'), resume);
  }
  resume.mockClear();
  const outcomes = await wakeDueWorkflowContinuations(
    store,
    new Date('2026-08-24T12:00:00Z'),
    resume
  );
  expect(resume).toHaveBeenCalledTimes(1);
  expect(outcomes).toEqual([expect.objectContaining({ runId: 'queue-25', kind: 'accepted' })]);
});
