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
import type { DagResumeSnapshot } from './store';
import { foldDagResumeSnapshot } from './dag-resume-snapshot';
import { fanOutOutcome } from './schemas/fan-out-outcome';

type ResumeStore = ResumeStoreDeps['store'];

function makeStore(overrides: Partial<ResumeStore> = {}): ResumeStore {
  return {
    listEventsForRuns: mock<ResumeStore['listEventsForRuns']>(async () => new Map()),
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
  it('inspects legacy zero-cost fan-out output without per-child attribution', async () => {
    const candidate = makeRun({ status: 'failed' });
    const store = makeStore({
      getDagResumeSnapshot: mock(async runId =>
        foldDagResumeSnapshot(
          [
            {
              step_name: 'work',
              event_type: 'node_completed',
              data: {
                type: 'workflow',
                node_output: '["a","b"]',
                cost_usd: 0,
                fan_out_outcome: fanOutOutcome([
                  { index: 0, outcome: 'completed', child_run_id: 'a' },
                  { index: 1, outcome: 'completed', child_run_id: 'b' },
                ]),
              },
            },
          ],
          runId
        )
      ),
    });
    const inspection = await inspectResumableRun(makeDeps(store), candidate);
    expect(inspection?.priorCompletedNodes.get('work')?.output).toBe('["a","b"]');
    expect(inspection?.priorUsage.costUsd).toBe(0);
    expect(inspection?.priorUsage.tokens).toBeUndefined();
    expect(inspection?.priorUsage.tokensUnknown).toBe(false);
    expect(store.resumeWorkflowRun).not.toHaveBeenCalled();
  });

  it('inspects resumable state without claiming the run', async () => {
    const candidate = makeRun({ id: 'read-only-prior', status: 'paused' });
    const priorNodes = new Map([['n1', { output: 'out1' }]]);
    const snapshot: DagResumeSnapshot = {
      completedNodeOutputs: priorNodes,
      fanOutSnapshots: new Map(),
      failedNodes: new Map(),
      unresolvedNodeStarts: new Set<string>(),
      budget: { workUnits: 0, spendUsd: 0 },
      tokens: { input: 4, output: 1 },
      costUsd: 0.1,
    };
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => snapshot),
    });

    const result = await inspectResumableRun(makeDeps(store), candidate);

    expect(result).toEqual({
      priorCompletedNodes: priorNodes,
      priorFailedNodes: new Map(),
      priorUsage: snapshot,
    });
    expect(result?.priorUsage).toBe(snapshot);
    expect(store.resumeWorkflowRun).not.toHaveBeenCalled();
    expect(store.listWorkflowRunNodeSessions).not.toHaveBeenCalled();
  });

  it('names why it resumes from the cause the consumed pause recorded', async () => {
    const failedNodes = new Map([['flaky', { error: 'exit 1' }]]);
    const snapshot = {
      completedNodeOutputs: new Map([['report', { output: 'saw' }]]),
      failedNodes,
      fanOutSnapshots: new Map(),
      unresolvedNodeStarts: new Set<string>(),
      budget: { workUnits: 0, spendUsd: 0 },
      costUsd: 0,
    };
    const since = '2026-10-19T10:00:00.000Z';
    const later = '2026-10-19T11:00:00.000Z';
    const gate = { type: 'approval', nodeId: 'review', message: 'Ok?', pauseId: 'g-1' };
    const cases = [
      {
        name: 'an approval gate',
        status: 'paused',
        metadata: { approval: gate, pause_cause: 'gate' },
        cause: 'continue_after_wait',
      },
      {
        name: 'a time wait',
        status: 'paused',
        metadata: {
          wait: {
            owner: 'node',
            nodeId: 't',
            kind: 'time',
            pauseId: 't-1',
            waitingSince: since,
            resumeAt: later,
          },
          pause_cause: 'wait',
        },
        cause: 'continue_after_wait',
      },
      {
        name: 'an event wait',
        status: 'paused',
        metadata: {
          wait: {
            owner: 'node',
            nodeId: 'e',
            kind: 'event',
            pauseId: 'e-1',
            event: 'deploy',
            waitingSince: since,
            resumeAt: later,
          },
          pause_cause: 'wait',
        },
        cause: 'continue_after_wait',
      },
      {
        name: 'a child workflow',
        status: 'paused',
        metadata: {
          approval: { type: 'child_workflow', nodeId: 'sub', message: 'child', childRunId: 'c-1' },
          pause_cause: 'child',
        },
        cause: 'continue_after_wait',
      },
      {
        name: 'a fan-out',
        status: 'paused',
        metadata: { pause_cause: 'child' },
        cause: 'continue_after_wait',
      },
      {
        name: 'a loop-owned wait',
        status: 'paused',
        metadata: {
          wait: {
            owner: 'loop_group',
            nodeId: 'loop',
            bodyWaitId: 'ask',
            iteration: 2,
            sessionId: null,
            sessionProvider: null,
            kind: 'attention',
            waitingSince: since,
            message: 'Ok?',
          },
          pause_cause: 'wait',
        },
        cause: 'continue_after_wait',
      },
      // A resolved gate's context outlives it: approve, a later node fails, the operator
      // resumes, the source is unreadable and the run is released. The release is the
      // pause being continued, so the failures it stopped on run again.
      {
        name: 'a source release after an earlier gate',
        status: 'paused',
        metadata: {
          approval: { ...gate, resolved: 'approved' },
          source_release: { nodeId: 'check', releaseId: 'r-1', releasedAt: since },
          pause_cause: 'source_release',
        },
        cause: 'retry_failed',
      },
      {
        name: 'a provider-limit pause',
        status: 'paused',
        metadata: {
          wait: {
            owner: 'node',
            nodeId: 'flaky',
            kind: 'quota',
            pauseId: 'q-1',
            waitingSince: since,
            resumeAt: later,
          },
          pause_cause: 'quota',
        },
        cause: 'retry_failed',
      },
      {
        name: 'a pause with no recorded cause',
        status: 'paused',
        metadata: { approval: gate },
        cause: 'retry_failed',
      },
      { name: 'a failed run', status: 'failed', metadata: {}, cause: 'retry_failed' },
    ] as const;
    const received: Record<string, string | undefined> = {};
    for (const { name, status, metadata } of cases) {
      const store = makeStore({
        getDagResumeSnapshot: mock(async () => snapshot),
        // The compare-and-swap returns the resumed row; the cause is read from it.
        resumeWorkflowRun: mock(async () => makeRun({ status: 'running', metadata })),
      });
      const result = await hydrateResumableRun(makeDeps(store), makeRun({ status, metadata }));
      received[name] = result?.resumeCause;
      expect(result?.priorFailedNodes).toBe(failedNodes);
    }
    expect(received).toEqual(Object.fromEntries(cases.map(({ name, cause }) => [name, cause])));
  });

  it('returns hydrated run + prior outputs for a candidate with completed nodes', async () => {
    const candidate = makeRun({ id: 'prior-failed', status: 'failed' });
    const resumed = makeRun({ id: 'prior-failed', status: 'running' });
    const priorNodes = new Map([['n1', { output: 'out1' }]]);
    const snapshot: DagResumeSnapshot = {
      completedNodeOutputs: priorNodes,
      fanOutSnapshots: new Map(),
      failedNodes: new Map(),
      unresolvedNodeStarts: new Set<string>(),
      budget: { workUnits: 0, spendUsd: 0 },
      tokens: { input: 40, output: 4 },
      costUsd: 0.75,
    };
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => snapshot),
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
    expect(result?.priorUsage).toBe(snapshot);
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
        failedNodes: new Map(),
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

  it.each([
    { events: [], resumable: false },
    { events: ['source_released'], resumable: true },
    { events: ['node_started', 'source_released'], resumable: true },
    { events: ['source_released', 'node_started'], resumable: false },
  ])('inspects failed zero-node source recovery: %j', async ({ events, resumable }) => {
    const candidate = makeRun({ status: 'failed' });
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: new Map(),
        fanOutSnapshots: new Map(),
        failedNodes: new Map(),
        unresolvedNodeStarts: new Set<string>(),
        budget: { workUnits: 0, spendUsd: 0 },
        costUsd: 0,
      })),
      listEventsForRuns: mock(
        async () =>
          new Map([
            [
              candidate.id,
              events.map((event_type, index) => ({
                id: String(index),
                workflow_run_id: candidate.id,
                event_type,
                step_index: null,
                step_name: 'first',
                data: {},
                created_at: '2026-10-22T10:00:00Z',
              })),
            ],
          ])
      ),
    });
    expect((await inspectResumableRun(makeDeps(store), candidate)) !== null).toBe(resumable);
    expect(store.listEventsForRuns).toHaveBeenCalledWith(
      [candidate.id],
      ['source_released', 'node_started']
    );
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
        failedNodes: new Map(),
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
        failedNodes: new Map(),
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
        failedNodes: new Map(),
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
        failedNodes: new Map(),
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
        failedNodes: new Map(),
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
        failedNodes: new Map(),
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
        failedNodes: new Map(),
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
