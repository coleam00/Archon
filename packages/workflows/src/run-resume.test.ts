// @archon-test-isolated
/**
 * Resume preparation is a caller-side primitive: callers look up the candidate
 * themselves (by run id, or listResumableRunsByParentConversation for chat) and
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
    completed_outcome: null,
    user_message: 'test message',
    metadata: {},
    active_phase_started_at: null,
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    output_root: null,
    checkout_baseline: null,
    item_id: null,
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
    expect(inspection.priorCompletedNodes.get('work')?.output).toBe('["a","b"]');
    expect(inspection.priorUsage.costUsd).toBe(0);
    expect(inspection.priorUsage.tokens).toBeUndefined();
    expect(inspection.priorUsage.tokensUnknown).toBe(false);
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
    expect(result.priorUsage).toBe(snapshot);
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
      received[name] = result.resumeCause;
      expect(result.priorFailedNodes).toBe(failedNodes);
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
    expect(result.preCreatedRun).toBe(resumed);
    expect(result.priorCompletedNodes).toBe(priorNodes);
    expect(result.priorUsage).toBe(snapshot);
    expect(result.priorNodeSessions.map(row => row.node_id)).toEqual(['n1']);
    expect(store.listWorkflowRunNodeSessions).toHaveBeenCalledWith('prior-failed');
    expect(store.resumeWorkflowRun).toHaveBeenCalledWith('prior-failed');
  });

  it('claims a failed run with no completed nodes so it runs again from its first node', async () => {
    const candidate = makeRun({ id: 'empty-prior', status: 'failed' });
    const resumed = makeRun({ id: 'empty-prior', status: 'running' });
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
    expect(result.preCreatedRun).toBe(resumed);
    expect(result.priorCompletedNodes.size).toBe(0);
    expect(store.resumeWorkflowRun).toHaveBeenCalledWith('empty-prior');
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
    expect(result.priorCompletedNodes).toBe(priorNodes);
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
