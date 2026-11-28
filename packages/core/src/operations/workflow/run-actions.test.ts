// @archon-test-isolated
import { describe, test, expect, beforeEach } from 'bun:test';
import { hostname } from 'node:os';
import { startRunLiveOwner } from '../../services/run-live-owner';
import {
  operator,
  mockGetWorkflowRun,
  EMPTY_COUNTS,
  mockListWorkflowRuns,
  mockDeleteWorkflowNodeSessions,
  makePausedRun,
  makeDashboardRun,
  mockGetRunAncestry,
  ResumeRefusedError,
  getWorkflowStatus,
  resumeWorkflow,
  resetWorkflowNodeSessions,
} from './test-harness';

describe('getWorkflowStatus', () => {
  beforeEach(() => {
    mockListWorkflowRuns.mockClear();
  });

  test('returns running and paused runs', async () => {
    const runs = [
      makeDashboardRun({ status: 'running', active_nodes: ['plan', 'implement'] }),
      makeDashboardRun({ id: 'run-2', status: 'paused' }),
    ];
    mockListWorkflowRuns.mockResolvedValueOnce({
      runs,
      total: 2,
      counts: { ...EMPTY_COUNTS, all: 2, running: 1, paused: 1 },
    });

    const result = await getWorkflowStatus();

    expect(result.runs).toHaveLength(2);
    expect(result.runs[0]?.active_nodes).toEqual(['plan', 'implement']);
    expect(mockListWorkflowRuns).toHaveBeenCalledWith({
      status: ['running', 'paused'],
      limit: 50,
    });
  });

  test('walks every page when asked for every active run, and stops at a short page', async () => {
    mockListWorkflowRuns
      .mockResolvedValueOnce({
        runs: Array.from({ length: 50 }, (_, index) =>
          makeDashboardRun({ id: `run-${String(index)}`, status: 'running' })
        ),
        total: 51,
        counts: EMPTY_COUNTS,
      })
      .mockResolvedValueOnce({
        runs: [makeDashboardRun({ id: 'run-50', status: 'paused' })],
        total: 51,
        counts: EMPTY_COUNTS,
      });

    const result = await getWorkflowStatus({ every: true, codebaseId: 'cb-project-a' });

    expect(result.runs.map(run => run.id)).toHaveLength(51);
    expect(result.runs[50]?.id).toBe('run-50');
    expect(mockListWorkflowRuns).toHaveBeenCalledTimes(2);
    expect(mockListWorkflowRuns).toHaveBeenNthCalledWith(1, {
      status: ['running', 'paused'],
      limit: 50,
      offset: 0,
      codebaseId: 'cb-project-a',
    });
    expect(mockListWorkflowRuns).toHaveBeenNthCalledWith(2, {
      status: ['running', 'paused'],
      limit: 50,
      offset: 50,
      codebaseId: 'cb-project-a',
    });
  });

  test('stops after one page when asked for every active run and the page is short', async () => {
    mockListWorkflowRuns.mockResolvedValueOnce({
      runs: [],
      total: 0,
      counts: EMPTY_COUNTS,
    });

    await getWorkflowStatus({ every: true });

    expect(mockListWorkflowRuns).toHaveBeenCalledTimes(1);
    expect(mockListWorkflowRuns).toHaveBeenCalledWith({
      status: ['running', 'paused'],
      limit: 50,
      offset: 0,
    });
  });

  test('passes an explicit codebase scope to the active-run query', async () => {
    mockListWorkflowRuns.mockResolvedValueOnce({
      runs: [],
      total: 0,
      counts: EMPTY_COUNTS,
    });

    await getWorkflowStatus({ codebaseId: 'cb-project-a' });

    expect(mockListWorkflowRuns).toHaveBeenCalledWith({
      status: ['running', 'paused'],
      limit: 50,
      codebaseId: 'cb-project-a',
    });
  });
});

describe('resumeWorkflow', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockClear();
  });

  test('returns run when status is resumable', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'failed' }));

    const run = await resumeWorkflow('run-1', operator);
    expect(run.id).toBe('run-1');
  });

  test('throws on non-resumable status', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'completed' }));

    await expect(resumeWorkflow('run-1', operator)).rejects.toThrow(
      "Cannot resume run with status 'completed'"
    );
  });

  test('a run that failed before its checkout was prepared is refused with the line that restarts it', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        status: 'failed',
        working_path: null,
        workflow_name: "@it's $pack",
        metadata: { inputs: { item: 'secret-value' } },
      })
    );

    const error = await resumeWorkflow('run-1', operator).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResumeRefusedError);
    const refusal = error as InstanceType<typeof ResumeRefusedError>;
    expect(refusal.reason).toBe('not_resumable');
    // Only the run id: nothing in the line needs quoting in any shell.
    expect(refusal.message).toEndWith(
      'Start it again with: archon workflow run --supersedes run-1'
    );
    expect(refusal.message).not.toContain('secret-value');
  });

  test('a cancelled run is refused with the line that restarts it, but a child whose parent was deleted gets none', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'cancelled' }));
    const top = (await resumeWorkflow('run-1', operator).catch((e: unknown) => e)) as InstanceType<
      typeof ResumeRefusedError
    >;
    expect(top.restartCommand).toBe('archon workflow run --supersedes run-1');
    expect(top.message).toEndWith('with: archon workflow run --supersedes run-1');

    // Deleting the parent clears parent_run_id; the spawning node's id stays.
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        status: 'cancelled',
        parent_run_id: null,
        metadata: { parent_node_id: 'child-node' },
      })
    );
    const orphan = (await resumeWorkflow('run-1', operator).catch(
      (e: unknown) => e
    )) as InstanceType<typeof ResumeRefusedError>;
    expect(orphan).toBeInstanceOf(ResumeRefusedError);
    expect(orphan.restartCommand).toBeUndefined();
    expect(orphan.message).not.toContain('--supersedes');
  });

  test('throws wrapped message when DB throws', async () => {
    mockGetWorkflowRun.mockRejectedValueOnce(new Error('connection reset'));

    await expect(resumeWorkflow('run-1', operator)).rejects.toThrow(
      'Failed to look up workflow run run-1: connection reset'
    );
  });
});

describe('resumeWorkflow on a running run', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockClear();
    mockGetRunAncestry.mockReset();
    mockGetRunAncestry.mockImplementation(() => Promise.resolve([]));
  });

  const thisOwner = { host: hostname(), pid: 4242, uid: process.getuid?.() };
  const runningRun = (overrides: Parameters<typeof makePausedRun>[0] = {}) =>
    makePausedRun({
      id: `resume-running-${crypto.randomUUID()}`,
      status: 'running',
      metadata: { execution_owner: thisOwner },
      ...overrides,
    });

  async function refusal(id: string): Promise<InstanceType<typeof ResumeRefusedError>> {
    const error = await resumeWorkflow(id, operator).then(
      () => undefined,
      (rejection: unknown) => rejection
    );
    expect(error).toBeInstanceOf(ResumeRefusedError);
    return error as InstanceType<typeof ResumeRefusedError>;
  }

  test('returns a running run when no owner answers for it', async () => {
    const run = runningRun();
    mockGetWorkflowRun.mockResolvedValueOnce(run);
    expect(await resumeWorkflow(run.id, operator)).toBe(run);
  });

  test('refuses a running run whose owner answers, naming that owner', async () => {
    const run = runningRun();
    const owner = await startRunLiveOwner(run.id);
    try {
      mockGetWorkflowRun.mockResolvedValueOnce(run);
      const error = await refusal(run.id);
      expect(error.reason).toBe('live_owner');
      expect(error.message).toContain(`host ${thisOwner.host}, pid 4242`);
    } finally {
      await owner.close();
    }
  });

  // A sub-run runs in the process driving any of its ancestors: the root, or an
  // intermediate sub-run resumed on its own after the root's process died.
  for (const live of ['parent', 'root'] as const) {
    test(`refuses a sub-run whose ${live} run's owner answers`, async () => {
      const parentRunId = `resume-parent-${crypto.randomUUID()}`;
      const rootRunId = `resume-root-${crypto.randomUUID()}`;
      const liveRunId = live === 'parent' ? parentRunId : rootRunId;
      const liveOwner = await startRunLiveOwner(liveRunId);
      try {
        const run = runningRun({ parent_run_id: parentRunId });
        mockGetRunAncestry.mockResolvedValueOnce([
          makePausedRun({ id: parentRunId, status: 'running', parent_run_id: rootRunId }),
          makePausedRun({ id: rootRunId, status: 'running' }),
        ]);
        mockGetWorkflowRun.mockResolvedValueOnce(run);
        const error = await refusal(run.id);
        expect(error.reason).toBe('live_owner');
        expect(error.message).toContain(liveRunId);
      } finally {
        await liveOwner.close();
      }
    });
  }

  test('refuses a running run whose recorded owner is on another host', async () => {
    const run = runningRun({ metadata: { execution_owner: { host: 'build-box', pid: 7 } } });
    mockGetWorkflowRun.mockResolvedValueOnce(run);
    const error = await refusal(run.id);
    expect(error.reason).toBe('owner_unreachable');
    expect(error.message).toContain('build-box');
  });

  test.skipIf(process.getuid === undefined)(
    'refuses a running run whose recorded owner ran as another user',
    async () => {
      const uid = (process.getuid?.() ?? 0) + 1;
      const run = runningRun({ metadata: { execution_owner: { ...thisOwner, uid } } });
      mockGetWorkflowRun.mockResolvedValueOnce(run);
      expect((await refusal(run.id)).reason).toBe('owner_unreachable');
    }
  );
});

describe('resetWorkflowNodeSessions', () => {
  beforeEach(() => {
    mockDeleteWorkflowNodeSessions.mockClear();
    mockDeleteWorkflowNodeSessions.mockImplementation(() => Promise.resolve({ deleted: 0 }));
  });

  test('passes workflow_name only when scope and node are absent', async () => {
    mockDeleteWorkflowNodeSessions.mockResolvedValueOnce({ deleted: 3 });
    const result = await resetWorkflowNodeSessions({ workflow_name: 'feature-dev' });
    expect(result).toEqual({ deleted: 3 });
    expect(mockDeleteWorkflowNodeSessions).toHaveBeenCalledWith({ workflow_name: 'feature-dev' });
  });

  test('forwards scope and node filters', async () => {
    mockDeleteWorkflowNodeSessions.mockResolvedValueOnce({ deleted: 1 });
    const result = await resetWorkflowNodeSessions({
      workflow_name: 'feature-dev',
      scope_key: 'conv-1',
      node_id: 'planner',
    });
    expect(result).toEqual({ deleted: 1 });
    expect(mockDeleteWorkflowNodeSessions).toHaveBeenCalledWith({
      workflow_name: 'feature-dev',
      scope_key: 'conv-1',
      node_id: 'planner',
    });
  });

  test('wraps DB errors with a descriptive message', async () => {
    mockDeleteWorkflowNodeSessions.mockRejectedValueOnce(new Error('connection refused'));
    await expect(resetWorkflowNodeSessions({ workflow_name: 'feature-dev' })).rejects.toThrow(
      'Failed to reset workflow node sessions: connection refused'
    );
  });
});
