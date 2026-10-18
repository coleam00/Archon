// @archon-test-isolated
/**
 * Resume preparation is a caller-side primitive: callers look up the candidate
 * themselves (via findResumableRun or findResumableRunByParentConversation) and
 * call hydrateResumableRun to turn it into the form executeWorkflow expects.
 */
import { describe, expect, it, mock } from 'bun:test';

const mockLogFn = mock(() => {});
const mockLogger = { debug: mockLogFn, info: mockLogFn, warn: mockLogFn, error: mockLogFn };
const actualPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({ ...actualPaths, createLogger: mock(() => mockLogger) }));

import { hydrateResumableRun, inspectResumableRun, type ResumeStoreDeps } from './run-resume';
import type { WorkflowRun } from './schemas';

type ResumeStore = ResumeStoreDeps['store'];

function makeStore(overrides: Partial<ResumeStore> = {}): ResumeStore {
  return {
    getDagResumeSnapshot: mock<ResumeStore['getDagResumeSnapshot']>(() => {
      throw new Error('Unexpected getDagResumeSnapshot');
    }),
    listWorkflowRunNodeSessions: mock<ResumeStore['listWorkflowRunNodeSessions']>(async () => []),
    resumeWorkflowRun: mock<ResumeStore['resumeWorkflowRun']>(() => {
      throw new Error('Unexpected resumeWorkflowRun');
    }),
    ...overrides,
  };
}

function makeDeps(store: ResumeStore): ResumeStoreDeps {
  return { store };
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    origin: { conversationId: 'conv-1' },
    id: 'run-123',
    workflow_name: 'test-workflow',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    outcome: null,
    user_message: 'test message',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    output_root: null,
    checkout_baseline: null,
    adopted_from_run_id: null,
    ...overrides,
  };
}

describe('hydrateResumableRun', () => {
  it('inspects resumable state without claiming the run', async () => {
    const candidate = makeRun({ id: 'read-only-prior', status: 'paused' });
    const priorNodes = new Map([['n1', { output: 'out1' }]]);
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: priorNodes,
        fanOutSnapshots: new Map(),
        unresolvedNodeStarts: new Set<string>(),
        budget: { workUnits: 0, spendUsd: 0 },
        tokens: { input: 4, output: 1 },
        costUsd: 0.1,
      })),
    });

    const result = await inspectResumableRun(makeDeps(store), candidate);

    expect(result).toEqual({
      priorCompletedNodes: priorNodes,
      priorUsage: { tokens: { input: 4, output: 1 }, costUsd: 0.1 },
    });
    expect(store.resumeWorkflowRun).not.toHaveBeenCalled();
    expect(store.listWorkflowRunNodeSessions).not.toHaveBeenCalled();
  });

  it('returns hydrated run + prior outputs for a candidate with completed nodes', async () => {
    const candidate = makeRun({ id: 'prior-failed', status: 'failed' });
    const resumed = makeRun({ id: 'prior-failed', status: 'running' });
    const priorNodes = new Map([['n1', { output: 'out1' }]]);
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: priorNodes,
        fanOutSnapshots: new Map(),
        unresolvedNodeStarts: new Set<string>(),
        budget: { workUnits: 0, spendUsd: 0 },
        tokens: { input: 40, output: 4 },
        costUsd: 0.75,
      })),
      listWorkflowRunNodeSessions: mock(async () => [
        {
          workflow_run_id: 'prior-failed',
          node_id: 'n1',
          provider: 'claude',
          provider_session_id: 'session-n1',
          created_at: '2026-08-19T00:00:00Z',
          updated_at: '2026-08-19T00:00:00Z',
        },
        {
          workflow_run_id: 'prior-failed',
          node_id: 'not-completed',
          provider: 'claude',
          provider_session_id: 'must-be-filtered',
          created_at: '2026-08-19T00:00:00Z',
          updated_at: '2026-08-19T00:00:00Z',
        },
      ]),
      resumeWorkflowRun: mock(async () => resumed),
    });
    const deps = makeDeps(store);
    const result = await hydrateResumableRun(deps, candidate);
    expect(result).not.toBeNull();
    expect(result?.preCreatedRun).toBe(resumed);
    expect(result?.priorCompletedNodes).toBe(priorNodes);
    expect(result?.priorUsage).toEqual({ tokens: { input: 40, output: 4 }, costUsd: 0.75 });
    expect(result?.priorNodeSessions.map(row => row.node_id)).toEqual(['n1']);
    expect(store.listWorkflowRunNodeSessions).toHaveBeenCalledWith('prior-failed');
    expect(store.resumeWorkflowRun).toHaveBeenCalledWith('prior-failed');
  });

  it('returns null when candidate has no completed nodes and no interactive-loop state', async () => {
    const candidate = makeRun({ id: 'empty-prior', status: 'failed' });
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: new Map(),
        fanOutSnapshots: new Map(),
        unresolvedNodeStarts: new Set<string>(),
        budget: { workUnits: 0, spendUsd: 0 },
        tokens: { input: 0, output: 0 },
        costUsd: 0,
      })),
    });
    const deps = makeDeps(store);
    const result = await hydrateResumableRun(deps, candidate);
    expect(result).toBeNull();
    // Must not transition the run — there is nothing to resume.
    expect(store.resumeWorkflowRun).not.toHaveBeenCalled();
  });

  it('hydrates fan-out-only recovery state before any inner node completed', async () => {
    const fanOutSnapshots = new Map([
      [
        'fan',
        [
          {
            ordinal: 0,
            identity: 'instance-a',
            item: 'a',
            inputs: { item: 'a' },
          },
        ],
      ],
    ]);
    const candidate = makeRun({ id: 'fan-out-only', status: 'failed' });
    const resumed = makeRun({ id: 'fan-out-only', status: 'running' });
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: new Map(),
        fanOutSnapshots,
        unresolvedNodeStarts: new Set(['fan__instance-a']),
        budget: { workUnits: 0, spendUsd: 0 },
        tokens: { input: 0, output: 0 },
        costUsd: 0,
      })),
      resumeWorkflowRun: mock(async () => resumed),
    });

    const result = await hydrateResumableRun(makeDeps(store), candidate);

    expect(result).not.toBeNull();
    expect(store.resumeWorkflowRun).toHaveBeenCalledWith('fan-out-only');
  });

  it('returns hydrated run when interactive-loop state is present even with zero completed nodes', async () => {
    const candidate = makeRun({
      id: 'paused-loop',
      status: 'paused',
      metadata: {
        approval: { type: 'interactive_loop', nodeId: 'loop-1', message: 'Iterate?', iteration: 2 },
      },
    });
    const resumed = makeRun({ id: 'paused-loop', status: 'running' });
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: new Map(),
        fanOutSnapshots: new Map(),
        unresolvedNodeStarts: new Set<string>(),
        budget: { workUnits: 0, spendUsd: 0 },
        tokens: { input: 0, output: 0 },
        costUsd: 0,
      })),
      resumeWorkflowRun: mock(async () => resumed),
    });
    const deps = makeDeps(store);
    const result = await hydrateResumableRun(deps, candidate);
    expect(result).not.toBeNull();
    expect(result?.priorCompletedNodes.size).toBe(0);
    expect(store.resumeWorkflowRun).toHaveBeenCalledWith('paused-loop');
  });

  it.each([
    [
      'first-node wait',
      'paused',
      {
        wait: {
          owner: 'node',
          nodeId: 'delay',
          kind: 'time',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-24T11:00:00.000Z',
        },
      },
    ],
    [
      'first-node quota continuation',
      'failed',
      {
        scheduled_resume: {
          reason: 'quota',
          resumeAt: '2026-08-24T11:00:00.000Z',
          deadlineAt: '2026-08-25T11:00:00.000Z',
          attempt: 1,
          maxAttempts: 1,
          error: 'usage limit reached',
        },
      },
    ],
  ] as const)('hydrates a %s with zero completed nodes', async (_label, status, metadata) => {
    const candidate = makeRun({ id: 'first-node-continuation', status, metadata });
    const resumed = makeRun({ id: 'first-node-continuation', status: 'running', metadata });
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: new Map(),
        fanOutSnapshots: new Map(),
        unresolvedNodeStarts: new Set<string>(),
        budget: { workUnits: 0, spendUsd: 0 },
        tokens: { input: 0, output: 0 },
        costUsd: 0,
      })),
      resumeWorkflowRun: mock(async () => resumed),
    });

    const result = await hydrateResumableRun(makeDeps(store), candidate);

    expect(result).not.toBeNull();
    expect(result?.priorCompletedNodes.size).toBe(0);
    expect(store.resumeWorkflowRun).toHaveBeenCalledWith('first-node-continuation');
  });

  it('#2714 regression: resumes a first-node legacy on_reject gate with a genuinely staged rework, even with zero completed nodes', async () => {
    // rejectWorkflow's stage-rework path (workflow-operations.ts) never writes
    // node_completed — it only stamps metadata.approval.resolved/rejection_reason
    // on the run. Before the reRunsOwnNodeOnResume fix, a first-node gate in
    // this state was unresumable: priorCompletedNodes.size === 0 and the old
    // hasReRunGateState check omitted 'approval' entirely.
    const candidate = makeRun({
      id: 'paused-first-gate',
      status: 'paused',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review',
          message: 'Please review',
          resolved: 'rejected',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
        },
        rejection_reason: 'needs more tests',
        rejection_count: 1,
      },
    });
    const resumed = makeRun({ id: 'paused-first-gate', status: 'running' });
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: new Map(),
        fanOutSnapshots: new Map(),
        unresolvedNodeStarts: new Set<string>(),
        budget: { workUnits: 0, spendUsd: 0 },
        tokens: { input: 0, output: 0 },
        costUsd: 0,
      })),
      resumeWorkflowRun: mock(async () => resumed),
    });
    const deps = makeDeps(store);
    const result = await hydrateResumableRun(deps, candidate);
    expect(result).not.toBeNull();
    expect(result?.priorCompletedNodes.size).toBe(0);
    expect(store.resumeWorkflowRun).toHaveBeenCalledWith('paused-first-gate');
  });

  it('#2714: an unresolved (not-yet-rejected) legacy on_reject gate with zero completed nodes is NOT resumable', async () => {
    // A fresh pause (nobody has rejected it yet) has onRejectPrompt set but no
    // rejection_reason and resolved !== 'rejected' — there is nothing staged
    // to re-run, so this must still return null (approve/reject, not resume,
    // is the correct next action).
    const candidate = makeRun({
      id: 'paused-unresolved-gate',
      status: 'paused',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review',
          message: 'Please review',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
        },
      },
    });
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: new Map(),
        fanOutSnapshots: new Map(),
        unresolvedNodeStarts: new Set<string>(),
        budget: { workUnits: 0, spendUsd: 0 },
        tokens: { input: 0, output: 0 },
        costUsd: 0,
      })),
    });
    const deps = makeDeps(store);
    const result = await hydrateResumableRun(deps, candidate);
    expect(result).toBeNull();
    expect(store.resumeWorkflowRun).not.toHaveBeenCalled();
  });

  it('#2707 new-mode gate needs no carve-out: resolving it writes node_completed, so priorCompletedNodes already covers resume', async () => {
    // A new-mode gate (no onRejectPrompt) never stages anything outside a
    // node_completed event — this is the structural closure argument for
    // #2714: the bug's mechanism (resolved-but-zero-completed-nodes) cannot
    // occur for this path. Simulated here via the ORDINARY completed-nodes
    // route, not the gate-state carve-out.
    const candidate = makeRun({ id: 'paused-new-mode-gate', status: 'paused' });
    const resumed = makeRun({ id: 'paused-new-mode-gate', status: 'running' });
    const priorNodes = new Map([
      ['review', { output: JSON.stringify({ decision: 'reject', text: 'needs changes' }) }],
    ]);
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: priorNodes,
        fanOutSnapshots: new Map(),
        unresolvedNodeStarts: new Set<string>(),
        budget: { workUnits: 0, spendUsd: 0 },
        tokens: { input: 0, output: 0 },
        costUsd: 0,
      })),
      resumeWorkflowRun: mock(async () => resumed),
    });
    const deps = makeDeps(store);
    const result = await hydrateResumableRun(deps, candidate);
    expect(result).not.toBeNull();
    expect(result?.priorCompletedNodes).toBe(priorNodes);
  });

  it('propagates DB errors from getDagResumeSnapshot (no silent fallback)', async () => {
    const candidate = makeRun({ id: 'prior-failed', status: 'failed' });
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => {
        throw new Error('DB read failed');
      }),
    });
    const deps = makeDeps(store);
    await expect(hydrateResumableRun(deps, candidate)).rejects.toThrow('DB read failed');
  });

  it('propagates DB errors from resumeWorkflowRun (no silent fallback)', async () => {
    const candidate = makeRun({ id: 'prior-failed', status: 'failed' });
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: new Map([['n1', { output: 'v1' }]]),
        fanOutSnapshots: new Map(),
        unresolvedNodeStarts: new Set<string>(),
        budget: { workUnits: 0, spendUsd: 0 },
        tokens: { input: 0, output: 0 },
        costUsd: 0,
      })),
      resumeWorkflowRun: mock(async () => {
        throw new Error('DB write failed');
      }),
    });
    const deps = makeDeps(store);
    await expect(hydrateResumableRun(deps, candidate)).rejects.toThrow('DB write failed');
  });
});
