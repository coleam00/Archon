import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';

// ---------------------------------------------------------------------------
// Mock DB + operations before importing the module under test. This file runs
// in its own `bun test` invocation (see package.json) because it mock.module's
// ../db/workflows with a different shape than operations/workflow-operations.test.ts.
// ---------------------------------------------------------------------------

const mockFindByPrefix = mock(
  (_idPrefix: string, _codebaseId: string): Promise<WorkflowRun[]> => Promise.resolve([])
);
const mockListDashboardRuns = mock(() => Promise.resolve({ runs: [] as unknown[] }));

mock.module('../db/workflows', () => ({
  findWorkflowRunsByIdPrefix: mockFindByPrefix,
  listDashboardRuns: mockListDashboardRuns,
}));

const mockAbandon = mock((_id: string) =>
  Promise.resolve({
    run: { id: 'r1abcdef', workflow_name: 'wf' },
    cascadeFailures: 0,
    blockedParentRunId: null,
  })
);
const mockApprove = mock((_id: string, _c?: string) =>
  Promise.resolve({ workflowName: 'wf', type: 'approval_gate' as const })
);
const mockReject = mock((_id: string, _r?: string) =>
  Promise.resolve({ workflowName: 'wf', cancelled: true, maxAttemptsReached: false })
);
const mockResume = mock((_id: string) => Promise.resolve({ id: 'r1abcdef', workflow_name: 'wf' }));

mock.module('../operations/workflow-operations', () => ({
  abandonWorkflow: mockAbandon,
  approveWorkflow: mockApprove,
  rejectWorkflow: mockReject,
  resumeWorkflow: mockResume,
}));

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
};
mock.module('@archon/paths', () => ({
  captureApprovalResolved: () => undefined,
  createLogger: mock(() => mockLogger),
}));

const { buildManageRunTool } = await import('./manage-run-tool');

const CODEBASE_ID = 'proj-1';

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'r1abcdef-1234',
    workflow_name: 'archon-assist',
    status: 'running',
    started_at: new Date('2026-06-01T00:00:00.000Z'),
    completed_at: null,
    metadata: {},
    codebase_id: CODEBASE_ID,
    ...overrides,
  } as WorkflowRun;
}

beforeEach(() => {
  for (const m of [
    mockFindByPrefix,
    mockListDashboardRuns,
    mockAbandon,
    mockApprove,
    mockReject,
    mockResume,
  ]) {
    m.mockReset();
  }
});

describe('manage_run — progressive disclosure', () => {
  test('help overview lists every action', async () => {
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'help' });
    expect(out).toContain('manage_run');
    for (const a of ['list', 'get', 'start', 'resume', 'cancel', 'abandon', 'approve', 'reject']) {
      expect(out).toContain(a);
    }
  });

  test('help with subtool returns that action’s detail', async () => {
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'help', subtool: 'approve' });
    expect(out).toContain('approve');
    expect(out).toContain('confirm=true');
  });

  test('help with unknown subtool is explicit', async () => {
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'help', subtool: 'nope' });
    expect(out).toContain("no help for 'nope'");
  });

  test('unknown action points to help', async () => {
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'frobnicate' });
    expect(out).toContain('unknown action');
  });
});

describe('manage_run — reads', () => {
  test('list renders runs scoped to the project', async () => {
    mockListDashboardRuns.mockResolvedValue({
      runs: [
        {
          id: 'abcdef1234',
          workflow_name: 'wf',
          status: 'running',
          current_step_name: 'plan',
          total_steps: 3,
        },
      ],
    });
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'list' });
    expect(out).toContain('abcdef12');
    expect(out).toContain('plan/3');
    expect(mockListDashboardRuns).toHaveBeenCalledWith({ codebaseId: CODEBASE_ID, limit: 20 });
  });

  test('list with no runs is friendly', async () => {
    mockListDashboardRuns.mockResolvedValue({ runs: [] });
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    expect(await tool.handler({ action: 'list' })).toContain('No workflow runs');
  });

  test('get requires a runId', async () => {
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    expect(await tool.handler({ action: 'get' })).toContain('requires a runId');
  });

  test('get is project-scoped — the lookup is constrained to this codebase', async () => {
    // The query is scoped to the codebase, so a foreign run never comes back.
    mockFindByPrefix.mockResolvedValue([]);
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'get', runId: 'r1abcdef' });
    expect(out).toContain('no run found');
    expect(mockFindByPrefix).toHaveBeenCalledWith('r1abcdef', CODEBASE_ID);
  });

  test('get with an ambiguous prefix asks for more characters', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ id: 'r1ab1111' }), makeRun({ id: 'r1ab2222' })]);
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'get', runId: 'r1ab' });
    expect(out).toContain('matches more than one run');
  });

  test('get returns detail for an in-project run resolved by short prefix', async () => {
    mockFindByPrefix.mockResolvedValue([
      makeRun({ status: 'completed', completed_at: new Date('2026-06-01T01:00:00.000Z') }),
    ]);
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'get', runId: 'r1abcdef' });
    expect(out).toContain('status: completed');
    expect(out).toContain('finished:');
  });

  test('get does not crash on SQLite rows where timestamps are strings (#2078)', async () => {
    // SQLite hydrates started_at/completed_at as 'YYYY-MM-DD HH:MM:SS' TEXT
    // even though the schema type says Date. formatRunDetail must not call
    // Date methods unguarded — this used to throw and fail interactive resume.
    mockFindByPrefix.mockResolvedValue([
      makeRun({
        status: 'completed',
        started_at: '2026-07-10 18:26:36' as unknown as Date,
        completed_at: '2026-07-10 18:30:00' as unknown as Date,
      }),
    ]);
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'get', runId: 'r1abcdef' });
    expect(out).not.toContain('manage_run error');
    expect(out).toContain('started: 2026-07-10 18:26:36');
    expect(out).toContain('finished: 2026-07-10 18:30:00');
  });

  test('get surfaces the structured gate state on a paused interactive_loop run (#2074 E)', async () => {
    mockFindByPrefix.mockResolvedValue([
      makeRun({
        status: 'paused',
        metadata: {
          approval: {
            nodeId: 'refine',
            message: 'gate',
            type: 'interactive_loop',
            iteration: 3,
            completionSignaled: true,
            signaledOutput: 'validation PASS — all 42 checks green',
          },
        },
      }),
    ]);
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'get', runId: 'r1abcdef' });
    expect(out).toContain('gate: awaiting approval (node refine, iteration 3)');
    expect(out).toContain('completionSignaled: true');
    // The finalize hint tells an AI approver how to accept without re-running.
    expect(out).toContain('FINALIZE');
    expect(out).toContain('output: validation PASS');
  });

  test('get shows completionSignaled: false with no finalize hint on a non-signaled gate (#2074 E)', async () => {
    mockFindByPrefix.mockResolvedValue([
      makeRun({
        status: 'paused',
        metadata: {
          approval: {
            nodeId: 'refine',
            message: 'gate',
            type: 'interactive_loop',
            iteration: 1,
            completionSignaled: false,
            signaledOutput: null,
          },
        },
      }),
    ]);
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'get', runId: 'r1abcdef' });
    expect(out).toContain('completionSignaled: false');
    expect(out).not.toContain('FINALIZE');
  });
});

describe('manage_run — start', () => {
  test('start delegates to the injected closure with workflow + message', async () => {
    const startWorkflow = mock((_w: string, _m: string) => Promise.resolve('dispatched'));
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID, startWorkflow });
    const out = await tool.handler({ action: 'start', workflow: 'plan', message: 'add dark mode' });
    expect(out).toBe('dispatched');
    expect(startWorkflow).toHaveBeenCalledWith('plan', 'add dark mode');
  });

  test('start without a dispatch context is rejected', async () => {
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    expect(await tool.handler({ action: 'start', workflow: 'plan' })).toContain('not available');
  });

  test('start requires a workflow name', async () => {
    const startWorkflow = mock((_w: string, _m: string) => Promise.resolve('x'));
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID, startWorkflow });
    expect(await tool.handler({ action: 'start' })).toContain('requires a workflow');
    expect(startWorkflow).not.toHaveBeenCalled();
  });
});

describe('manage_run — destructive confirmation gate', () => {
  // Every destructive action must preview (and NOT mutate) without confirm.
  // This covers the whole DESTRUCTIVE_ACTIONS set so dropping a member is caught.
  test('cancel without confirm previews and does NOT mutate', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun()]);
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'cancel', runId: 'r1abcdef' });
    expect(out).toContain('confirm: true');
    expect(out).toContain('irreversible');
    expect(mockAbandon).not.toHaveBeenCalled();
  });

  test('abandon without confirm previews and does NOT mutate', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'failed' })]);
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'abandon', runId: 'r1abcdef' });
    expect(out).toContain('confirm: true');
    expect(mockAbandon).not.toHaveBeenCalled();
  });

  test('approve without confirm previews the human gate and does NOT mutate', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'paused' })]);
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'approve', runId: 'r1abcdef' });
    expect(out).toContain('confirm: true');
    expect(out).toContain('human gate');
    expect(mockApprove).not.toHaveBeenCalled();
  });

  test('reject without confirm previews the human gate and does NOT mutate', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'paused' })]);
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'reject', runId: 'r1abcdef' });
    expect(out).toContain('confirm: true');
    expect(out).toContain('human gate');
    expect(mockReject).not.toHaveBeenCalled();
  });

  test('cancel with confirm cancels the run using the verified full id', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun()]);
    mockAbandon.mockResolvedValue({
      run: { id: 'r1abcdef-1234', workflow_name: 'archon-assist' },
      cascadeFailures: 0,
      blockedParentRunId: null,
    });
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'cancel', runId: 'r1abcdef', confirm: true });
    expect(out).toContain('Cancelled');
    // Operations are called with the resolved full id, not the short prefix.
    expect(mockAbandon).toHaveBeenCalledWith('r1abcdef-1234');
  });

  test('approve with confirm passes the comment through (approval gate)', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'paused' })]);
    mockApprove.mockResolvedValue({ workflowName: 'wf', type: 'approval_gate' });
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({
      action: 'approve',
      runId: 'r1abcdef',
      confirm: true,
      message: 'lgtm',
    });
    expect(out).toContain('Approved');
    expect(mockApprove).toHaveBeenCalledWith('r1abcdef-1234', 'lgtm');
  });

  test('approve with confirm and no message on an interactive loop reports the finalize semantics (#2074)', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'paused' })]);
    mockApprove.mockResolvedValue({ workflowName: 'wf', type: 'interactive_loop' });
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'approve', runId: 'r1abcdef', confirm: true });
    expect(mockApprove).toHaveBeenCalledWith('r1abcdef-1234', undefined);
    expect(out).toContain('no feedback');
    expect(out).toContain('finalizes');
  });

  test('approve with accept:true finalizes even when a message is present (#2074 E)', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'paused' })]);
    mockApprove.mockResolvedValue({ workflowName: 'wf', type: 'interactive_loop' });
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({
      action: 'approve',
      runId: 'r1abcdef',
      confirm: true,
      accept: true,
      message: 'looks good',
    });
    // accept forces the finalize path: no feedback reaches the gate.
    expect(mockApprove).toHaveBeenCalledWith('r1abcdef-1234', undefined);
    expect(out).toContain('finalizes');
  });

  test('approve with a message on an interactive loop records feedback (iterate) (#2074 E)', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'paused' })]);
    mockApprove.mockResolvedValue({ workflowName: 'wf', type: 'interactive_loop' });
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({
      action: 'approve',
      runId: 'r1abcdef',
      confirm: true,
      message: 'redo the check',
    });
    expect(mockApprove).toHaveBeenCalledWith('r1abcdef-1234', 'redo the check');
    expect(out).toContain('another iteration');
  });

  test('approve preview on a signal-bearing gate states the finalize/iterate effect (#2074 E)', async () => {
    mockFindByPrefix.mockResolvedValue([
      makeRun({
        status: 'paused',
        metadata: {
          approval: {
            nodeId: 'refine',
            message: 'gate',
            type: 'interactive_loop',
            iteration: 1,
            completionSignaled: true,
            signaledOutput: 'REPORT',
          },
        },
      }),
    ]);
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    // No confirm → preview. Bare args would finalize.
    const bare = await tool.handler({ action: 'approve', runId: 'r1abcdef' });
    expect(bare).toContain('FINALIZE');
    // A message would iterate.
    const withMsg = await tool.handler({ action: 'approve', runId: 'r1abcdef', message: 'redo' });
    expect(withMsg).toContain('ANOTHER iteration');
    expect(mockApprove).not.toHaveBeenCalled();
  });

  test('reject with confirm and no on-reject prompt reports cancellation', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'paused' })]);
    mockReject.mockResolvedValue({
      workflowName: 'wf',
      cancelled: true,
      maxAttemptsReached: false,
    });
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({
      action: 'reject',
      runId: 'r1abcdef',
      confirm: true,
      message: 'no',
    });
    expect(out).toContain('Rejected and cancelled');
    expect(mockReject).toHaveBeenCalledWith('r1abcdef-1234', 'no');
  });

  test('reject with confirm and an on-reject prompt reports rework, not cancellation', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'paused' })]);
    mockReject.mockResolvedValue({
      workflowName: 'wf',
      cancelled: false,
      maxAttemptsReached: false,
    });
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({
      action: 'reject',
      runId: 'r1abcdef',
      confirm: true,
      message: 'redo it',
    });
    expect(out).toContain('rework');
    expect(out).not.toContain('cancelled');
  });
});

describe('manage_run — resume (recoverable, no confirm)', () => {
  test('resume validates eligibility without confirm and does not restart the run', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'failed' })]);
    mockResume.mockResolvedValue({ id: 'r1abcdef-1234', workflow_name: 'archon-assist' });
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'resume', runId: 'r1abcdef' });
    expect(out).toContain('can resume');
    expect(out).toContain('does not restart automatically');
    expect(mockResume).toHaveBeenCalledWith('r1abcdef-1234');
  });
});

describe('manage_run — error handling', () => {
  test('a thrown DB error is returned as text, never thrown into the agent loop', async () => {
    mockFindByPrefix.mockImplementation(() => Promise.reject(new Error('db down')));
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'get', runId: 'r1abcdef' });
    expect(out).toContain('manage_run error: db down');
  });
});
