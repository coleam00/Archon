import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type {
  ApprovalOperationResult,
  RejectionOperationResult,
} from '../operations/workflow-operations';

const CODEBASE_ID = 'proj-1';

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
function approvalResult(type: ApprovalOperationResult['type']): ApprovalOperationResult {
  return {
    workflowName: 'wf',
    workingPath: null,
    userMessage: null,
    codebaseId: CODEBASE_ID,
    conversationId: 'conv-1',
    type,
  };
}

function rejectionResult(
  overrides: Partial<RejectionOperationResult> = {}
): RejectionOperationResult {
  return {
    workflowName: 'wf',
    workingPath: null,
    userMessage: null,
    codebaseId: CODEBASE_ID,
    conversationId: 'conv-1',
    cancelled: true,
    maxAttemptsReached: false,
    writeBack: false,
    newMode: false,
    ...overrides,
  };
}

const mockApprove = mock<(_id: string, _comment?: string) => Promise<ApprovalOperationResult>>(() =>
  Promise.resolve(approvalResult('approval_gate'))
);
const mockReject = mock<(_id: string, _reason?: string) => Promise<RejectionOperationResult>>(() =>
  Promise.resolve(rejectionResult())
);
const mockResume = mock((_id: string) => Promise.resolve({ id: 'r1abcdef', workflow_name: 'wf' }));
// #2707 step 2 — respondToWorkflow can return either result shape depending on
// `decision`; each test sets its own resolved/rejected value explicitly (mockReset()
// in beforeEach clears any per-test override, same as every other mock here).
const mockRespond = mock<
  (
    _id: string,
    _decision: string,
    _text?: string
  ) => Promise<ApprovalOperationResult | RejectionOperationResult>
>(() => Promise.resolve(approvalResult('approval_gate')));

mock.module('../operations/workflow-operations', () => ({
  abandonWorkflow: mockAbandon,
  approveWorkflow: mockApprove,
  rejectWorkflow: mockReject,
  respondToWorkflow: mockRespond,
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

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'r1abcdef-1234',
    workflow_name: 'archon-assist',
    status: 'running',
    started_at: new Date('2026-06-01T00:00:00.000Z'),
    completed_at: null,
    metadata: {},
    codebase_id: CODEBASE_ID,
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    outcome: null,
    user_message: 'Run the workflow',
    last_activity_at: new Date('2026-06-01T00:00:00.000Z'),
    working_path: null,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    ...overrides,
  };
}

// A run paused on an interactive_loop gate. The node and prompt are fixed so each
// test varies only the signalling state the tool is meant to report on.
function makeLoopGateRun(gate: {
  iteration: number;
  completionSignaled: boolean;
  signaledOutput: string | null;
}): WorkflowRun {
  return makeRun({
    status: 'paused',
    metadata: {
      approval: { nodeId: 'refine', message: 'gate', type: 'interactive_loop', ...gate },
    },
  });
}

beforeEach(() => {
  for (const m of [
    mockFindByPrefix,
    mockListDashboardRuns,
    mockAbandon,
    mockApprove,
    mockReject,
    mockRespond,
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

  test('list renders authored outcome beside contradictory execution status', async () => {
    mockListDashboardRuns.mockResolvedValue({
      runs: [
        {
          id: 'abcdef1234',
          workflow_name: 'wf',
          status: 'completed',
          outcome: 'failed',
          current_step_name: null,
          total_steps: 3,
        },
      ],
    });
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'list' });
    expect(out).toContain('completed');
    expect(out).toContain('authored outcome: failed');
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

  test('get renders a succeeded authored outcome beside paused status', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'paused', outcome: 'succeeded' })]);
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'get', runId: 'r1abcdef' });
    expect(out).toContain('status: paused');
    expect(out).toContain('authored outcome: succeeded');
  });

  test('get preserves the prior detail shape when outcome is undeclared', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'completed' })]);
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'get', runId: 'r1abcdef' });
    expect(out).not.toContain('authored outcome:');
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
      makeLoopGateRun({
        iteration: 3,
        completionSignaled: true,
        signaledOutput: 'validation PASS — all 42 checks green',
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
      makeLoopGateRun({ iteration: 1, completionSignaled: false, signaledOutput: null }),
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
    mockApprove.mockResolvedValue(approvalResult('approval_gate'));
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
    mockApprove.mockResolvedValue(approvalResult('interactive_loop'));
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'approve', runId: 'r1abcdef', confirm: true });
    expect(mockApprove).toHaveBeenCalledWith('r1abcdef-1234', undefined);
    expect(out).toContain('no feedback');
    expect(out).toContain('completion condition was met');
    expect(out).not.toContain('completion signal');
  });

  test('approve with accept:true finalizes even when a message is present (#2074 E)', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'paused' })]);
    mockApprove.mockResolvedValue(approvalResult('interactive_loop'));
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
    mockApprove.mockResolvedValue(approvalResult('interactive_loop'));
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

  test('approve preview on a completed-condition gate states the finalize/iterate effect (#2074 E)', async () => {
    mockFindByPrefix.mockResolvedValue([
      makeLoopGateRun({ iteration: 1, completionSignaled: true, signaledOutput: 'REPORT' }),
    ]);
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    // No confirm → preview. Bare args would finalize.
    const bare = await tool.handler({ action: 'approve', runId: 'r1abcdef' });
    expect(bare).toContain('completion condition was met');
    expect(bare).not.toContain('completionSignaled');
    expect(bare).toContain('FINALIZE');
    // A message would iterate.
    const withMsg = await tool.handler({ action: 'approve', runId: 'r1abcdef', message: 'redo' });
    expect(withMsg).toContain('completion condition was met');
    expect(withMsg).not.toContain('completionSignaled');
    expect(withMsg).toContain('ANOTHER iteration');
    expect(mockApprove).not.toHaveBeenCalled();
  });

  test('reject with confirm and no on-reject prompt reports cancellation', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'paused' })]);
    mockReject.mockResolvedValue(rejectionResult());
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

  test('reject with no message defaults the rejection text to "Rejected"', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'paused' })]);
    mockReject.mockResolvedValue(rejectionResult());
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    await tool.handler({ action: 'reject', runId: 'r1abcdef', confirm: true });
    expect(mockReject).toHaveBeenCalledWith('r1abcdef-1234', 'Rejected');
  });

  test('reject with confirm and an on-reject prompt reports rework, not cancellation', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'paused' })]);
    mockReject.mockResolvedValue(rejectionResult({ cancelled: false }));
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

  // #2707 step 2 — the general drive verb, extended to manage_run so an agent's only
  // "not this" affordance on a gate declaring decisions beyond approve/reject isn't a
  // full cancel it never asked for.
  test('respond without confirm previews the human gate and does NOT mutate', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'paused' })]);
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'respond', runId: 'r1abcdef', decision: 'revise' });
    expect(out).toContain('confirm: true');
    expect(out).toContain('human gate');
    expect(mockRespond).not.toHaveBeenCalled();
  });

  test('respond requires a decision even with confirm:true', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'paused' })]);
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({ action: 'respond', runId: 'r1abcdef', confirm: true });
    expect(out).toContain('requires a decision');
    expect(mockRespond).not.toHaveBeenCalled();
  });

  test('respond with a non-default decision resolves through respondToWorkflow, not a cancel', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'paused' })]);
    mockRespond.mockResolvedValue(approvalResult('approval_gate'));
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({
      action: 'respond',
      runId: 'r1abcdef',
      decision: 'revise',
      confirm: true,
      message: 'needs more detail',
    });
    expect(mockRespond).toHaveBeenCalledWith('r1abcdef-1234', 'revise', 'needs more detail');
    expect(out).toContain("Responded 'revise'");
    expect(out).not.toContain('cancel');
  });

  test('respond with decision=reject still cancels — sugar produces the same outcome shape as action=reject', async () => {
    // respondToWorkflow('reject', ...) delegates internally to rejectWorkflow — from
    // the tool's perspective this is just the RejectionOperationResult shape coming
    // back through respondToWorkflow instead of rejectWorkflow directly.
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'paused' })]);
    mockRespond.mockResolvedValue(rejectionResult());
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({
      action: 'respond',
      runId: 'r1abcdef',
      decision: 'reject',
      confirm: true,
      message: 'no',
    });
    expect(out).toContain('Rejected and cancelled');
    expect(mockRespond).toHaveBeenCalledWith('r1abcdef-1234', 'reject', 'no');
  });

  test('an undeclared decision surfaces as an error, never a silent cancel', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'paused' })]);
    mockRespond.mockImplementation(() =>
      Promise.reject(
        new Error(
          "Run r1abcdef-1234's gate does not declare decision 'bogus'. Declared decisions: approve, revise."
        )
      )
    );
    const tool = buildManageRunTool({ codebaseId: CODEBASE_ID });
    const out = await tool.handler({
      action: 'respond',
      runId: 'r1abcdef',
      decision: 'bogus',
      confirm: true,
    });
    expect(out).toContain("does not declare decision 'bogus'");
    expect(out).toContain('Declared decisions: approve, revise');
  });
});

// Resolving a gate and continuing the run are two halves of one action (#2565).
// A tool that only resolved would leave every gate the agent decides stranded.
describe('manage_run — gate continuation', () => {
  /** `accepts: false` models an orchestrator that already has a run queued. */
  function makeCtx(accepts = true) {
    const resolved: { run: WorkflowRun; action: 'approve' | 'reject' | 'respond' }[] = [];
    return {
      resolved,
      ctx: {
        codebaseId: CODEBASE_ID,
        onGateResolved: (run: WorkflowRun, action: 'approve' | 'reject' | 'respond') => {
          resolved.push({ run, action });
          return accepts;
        },
      },
    };
  }

  test('approve hands the run to the continuation and says the run moves on', async () => {
    const run = makeRun({ status: 'paused' });
    mockFindByPrefix.mockResolvedValue([run]);
    mockApprove.mockResolvedValue(approvalResult('approval_gate'));
    const { resolved, ctx } = makeCtx();

    const out = await buildManageRunTool(ctx).handler({
      action: 'approve',
      runId: 'r1abcdef',
      confirm: true,
    });

    expect(resolved).toEqual([{ run, action: 'approve' }]);
    expect(out).toContain('continues from here');
  });

  test('a reject that stages a rework continues; one that cancels does not', async () => {
    const run = makeRun({ status: 'paused' });
    mockFindByPrefix.mockResolvedValue([run]);
    const { resolved, ctx } = makeCtx();

    mockReject.mockResolvedValue(rejectionResult({ cancelled: false }));
    const rework = await buildManageRunTool(ctx).handler({
      action: 'reject',
      runId: 'r1abcdef',
      confirm: true,
      message: 'redo',
    });
    expect(resolved).toEqual([{ run, action: 'reject' }]);
    expect(rework).toContain('continues from here');

    // A cancelled run is already in its terminal state — nothing to continue.
    mockReject.mockResolvedValue(rejectionResult());
    const cancelled = await buildManageRunTool(ctx).handler({
      action: 'reject',
      runId: 'r1abcdef',
      confirm: true,
      message: 'drop it',
    });
    expect(resolved).toHaveLength(1);
    expect(cancelled).toContain('Nothing further runs');
  });

  test('a preview call resolves nothing, so it never schedules a continuation', async () => {
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'paused' })]);
    const { resolved, ctx } = makeCtx();

    await buildManageRunTool(ctx).handler({ action: 'approve', runId: 'r1abcdef' });

    expect(resolved).toHaveLength(0);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  test('a container run is never handed to the continuation — it points at the CLI', async () => {
    // executeWorkflow fails a resume it cannot rewire, so scheduling one would
    // fail the run to say what the reply says for free.
    mockFindByPrefix.mockResolvedValue([
      makeRun({ status: 'paused', metadata: { isolation: 'container' } }),
    ]);
    mockApprove.mockResolvedValue(approvalResult('approval_gate'));
    const { resolved, ctx } = makeCtx();

    const out = await buildManageRunTool(ctx).handler({
      action: 'approve',
      runId: 'r1abcdef',
      confirm: true,
    });

    expect(mockApprove).toHaveBeenCalled(); // the decision is still recorded
    expect(resolved).toHaveLength(0);
    expect(out).toContain('isolation container');
    expect(out).toContain('archon workflow resume r1abcdef-1234');
    expect(out).not.toContain('continues from here');
  });

  test('a declined continuation is reported as a manual resume, not as silence', async () => {
    // The orchestrator continues ONE run per turn. A gate it declines must reach
    // the agent as words, or the run is resolved and stranded with no signal.
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'paused' })]);
    mockApprove.mockResolvedValue(approvalResult('approval_gate'));
    const { ctx } = makeCtx(false);

    const out = await buildManageRunTool(ctx).handler({
      action: 'approve',
      runId: 'r1abcdef',
      confirm: true,
    });

    expect(out).toContain('stays paused');
    expect(out).toContain('/workflow resume r1abcdef-1234');
  });

  test('without a continuation the tool names the manual resume instead of implying one', async () => {
    // Silence here would read as "handled" and strand the run invisibly.
    mockFindByPrefix.mockResolvedValue([makeRun({ status: 'paused' })]);
    mockApprove.mockResolvedValue(approvalResult('approval_gate'));

    const out = await buildManageRunTool({ codebaseId: CODEBASE_ID }).handler({
      action: 'approve',
      runId: 'r1abcdef',
      confirm: true,
    });

    expect(out).toContain('stays paused');
    expect(out).toContain('/workflow resume r1abcdef-1234');
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
