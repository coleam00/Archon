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

  test("refuses a sub-run whose root run's owner answers", async () => {
    const rootRunId = `resume-root-${crypto.randomUUID()}`;
    const rootOwner = await startRunLiveOwner(rootRunId);
    try {
      const run = runningRun({ parent_run_id: rootRunId });
      mockGetRunAncestry.mockResolvedValueOnce([
        makePausedRun({ id: rootRunId, status: 'running' }),
      ]);
      mockGetWorkflowRun.mockResolvedValueOnce(run);
      const error = await refusal(run.id);
      expect(error.reason).toBe('live_owner');
      expect(error.message).toContain(rootRunId);
    } finally {
      await rootOwner.close();
    }
  });

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
