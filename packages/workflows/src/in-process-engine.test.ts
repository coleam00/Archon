/**
 * Wires the shared `IWorkflowEngine` contract-test suite
 * (`engine-contract-tests.ts`) against `InProcessWorkflowEngine`
 * (issue #3334, M1).
 *
 * Mock setup mirrors `executor.test.ts`'s "Mock ... / Import after mocks"
 * convention — `InProcessWorkflowEngine` delegates straight through to the
 * real `executeWorkflow`/`hydrateResumableRun`, so the same fs/git/dag-executor
 * seams need stubbing here too. This file deliberately does NOT mock
 * `./executor` or `@archon/workflows/executor` itself.
 */
import { mock } from 'bun:test';

// --- Mock logger ---
const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  parseOwnerRepo: mock(() => null),
  resolveRepoProjectIdentity: mock(() => null),
  getRunArtifactsPath: mock(() => '/tmp/artifacts'),
  getProjectLogsPath: mock(() => '/tmp/logs'),
  getProjectArtifactsPath: mock(() => '/tmp/artifacts-root'),
  resolveProjectStorageKey: mock(() => ({ kind: 'cwd', cwd: '/tmp/ops' })),
  getProjectStoragePaths: mock(() => ({
    root: '/tmp/ws',
    artifactsRoot: '/tmp/ws/artifacts',
    logsDir: '/tmp/ws/logs',
    stateRoot: '/tmp/ws/state',
    workflowSourceRoot: '/tmp/ws/workflow-source',
  })),
  getStoragePathsForRoot: mock((root: string) => ({
    root,
    artifactsRoot: `${root}/artifacts`,
    logsDir: `${root}/logs`,
    stateRoot: `${root}/state`,
    workflowSourceRoot: `${root}/workflow-source`,
  })),
  isInsideArchonHome: mock(() => true),
  slugifyFolderName: mock((name: string) => name),
  getFolderRunArtifactsPath: mock(
    (slug: string, runId: string) => `/tmp/_folder/${slug}/artifacts/runs/${runId}`
  ),
  getFolderProjectLogsPath: mock((slug: string) => `/tmp/_folder/${slug}/logs`),
  getFolderProjectArtifactsPath: mock((slug: string) => `/tmp/_folder/${slug}/artifacts`),
  getScopeArtifactsPath: mock(
    (root: string, wf: string, scope: string) => `${root}/scopes/${wf}/${scope}`
  ),
  captureWorkflowInvoked: mock(() => {}),
  captureWorkflowCompleted: mock(() => {}),
}));

mock.module('@archon/git', () => ({
  getDefaultBranch: mock(async () => 'main'),
  toRepoPath: mock((p: string) => p),
}));

// --- Mock dag-executor: the DAG loop itself is out of scope for this suite
// (dag-executor.test.ts / subrun.test.ts own that); this suite only proves
// the InProcessWorkflowEngine -> executeWorkflow/hydrateResumableRun wiring. ---
type ExecuteDagWorkflow = typeof import('./dag-executor').executeDagWorkflow;
const mockExecuteDagWorkflow = mock<ExecuteDagWorkflow>(async () => undefined);
mock.module('./dag-executor', () => ({
  executeDagWorkflow: mockExecuteDagWorkflow,
  childOutcomeFromRun: mock((run: { id: string; status: string }) => ({
    childRunId: run.id,
    status: run.status,
  })),
}));

mock.module('./logger', () => ({
  logWorkflowStart: mock(async () => {}),
  logWorkflowError: mock(async () => {}),
}));

const mockEmitter = {
  registerRun: mock(() => {}),
  unregisterRun: mock(() => {}),
  emit: mock(() => {}),
};
mock.module('./event-emitter', () => ({
  getWorkflowEventEmitter: mock(() => mockEmitter),
}));

// --- Bootstrap provider registry (after path mocks), same as executor.test.ts ---
import {
  registerBuiltinProviders,
  registerCommunityProviders,
  clearRegistry,
} from '@archon/providers';
clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();

// --- Import after mocks ---
import { InProcessWorkflowEngine } from './in-process-engine';
import { runWorkflowEngineContractTests } from './engine-contract-tests';

runWorkflowEngineContractTests(() => new InProcessWorkflowEngine());

// ---------------------------------------------------------------------------
// subscribe() — real implementation (#3334 M6)
// ---------------------------------------------------------------------------
import { describe, test, expect, afterEach } from 'bun:test';
import type { IWorkflowStore, PersistedWorkflowEvent } from './store';
import type { WorkflowEvent } from './engine-port';
import type { WorkflowRun } from './schemas';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Minimal fake `IWorkflowStore` — only the reads `subscribe()` uses. */
function makeFakeStore(ancestry: Map<string, string[]> = new Map()): {
  store: IWorkflowStore;
  push: (row: {
    workflow_run_id: string;
    event_type: string;
    step_name?: string | null;
    data?: Record<string, unknown>;
    created_at?: string;
  }) => void;
} {
  const events: PersistedWorkflowEvent[] = [];
  let seq = 0;
  const push: ReturnType<typeof makeFakeStore>['push'] = row => {
    seq += 1;
    events.push({
      id: `evt-${String(seq)}`,
      workflow_run_id: row.workflow_run_id,
      event_type: row.event_type as PersistedWorkflowEvent['event_type'],
      step_name: row.step_name ?? null,
      data: row.data ?? {},
      event_order: seq,
      created_at: row.created_at ?? '2026-01-01 00:00:00',
    });
  };
  const store: Partial<IWorkflowStore> = {
    getMaxEventOrder: async (workflowRunId: string): Promise<number> => {
      const orders = events
        .filter(e => e.workflow_run_id === workflowRunId)
        .map(e => e.event_order);
      return orders.length > 0 ? Math.max(...orders) : 0;
    },
    getGlobalMaxEventOrder: async (): Promise<number> => {
      const orders = events.map(e => e.event_order);
      return orders.length > 0 ? Math.max(...orders) : 0;
    },
    listWorkflowEventsAfter: async (afterEventOrder: number, limit: number) =>
      events
        .filter(e => e.event_order > afterEventOrder)
        .sort((a, b) => a.event_order - b.event_order)
        .slice(0, limit),
    getRunAncestry: async (runId: string): Promise<WorkflowRun[]> =>
      (ancestry.get(runId) ?? []).map(id => ({ id }) as WorkflowRun),
  };
  return { store: store as IWorkflowStore, push };
}

describe('InProcessWorkflowEngine.subscribe', () => {
  const unsubscribes: (() => void)[] = [];
  afterEach(() => {
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  });

  test('descendant sub-run events reach a subscription on the parent run id', async () => {
    const parentRunId = 'run-parent';
    const childRunId = 'run-child';
    const { store, push } = makeFakeStore(new Map([[childRunId, [parentRunId]]]));

    const received: WorkflowEvent[] = [];
    const unsubscribe = new InProcessWorkflowEngine(store).subscribe(
      parentRunId,
      event => received.push(event),
      5
    );
    unsubscribes.push(unsubscribe);

    // Let the subscription anchor its cursor (no events exist for either run yet)
    // before any events land — mirrors the real CLI ordering, where `subscribe()`
    // is called well before `submit()`'s first event write.
    await sleep(20);

    push({
      workflow_run_id: parentRunId,
      event_type: 'node_started',
      step_name: 'top-node',
      data: {},
    });
    push({
      workflow_run_id: childRunId,
      event_type: 'node_started',
      step_name: 'child-node',
      data: {},
    });
    // A run unrelated to the parent's ancestry chain must NOT leak through.
    push({
      workflow_run_id: 'run-unrelated',
      event_type: 'node_started',
      step_name: 'other-node',
      data: {},
    });

    await sleep(60);

    const nodeIds = received
      .filter(
        (e): e is Extract<WorkflowEvent, { type: 'node_started' }> => e.type === 'node_started'
      )
      .map(e => e.nodeId);
    expect(nodeIds).toContain('top-node');
    expect(nodeIds).toContain('child-node');
    expect(nodeIds).not.toContain('other-node');
  });

  test('a same-second event burst is delivered exactly once each, in event_order', async () => {
    const runId = 'run-burst';
    const { store, push } = makeFakeStore();

    const received: WorkflowEvent[] = [];
    const unsubscribe = new InProcessWorkflowEngine(store).subscribe(
      runId,
      event => received.push(event),
      5
    );
    unsubscribes.push(unsubscribe);

    // Let the subscription anchor its cursor (no events exist yet) before the
    // burst lands, so none of the burst rows are treated as pre-existing history.
    await sleep(20);

    // SQLite's `created_at` has 1-second resolution — every row below shares the
    // exact same timestamp, only `event_order` distinguishes them.
    const SAME_SECOND = '2026-01-01 00:00:00';
    for (let i = 0; i < 5; i++) {
      push({
        workflow_run_id: runId,
        event_type: 'node_completed',
        step_name: `node-${String(i)}`,
        data: { duration_ms: i },
        created_at: SAME_SECOND,
      });
    }

    await sleep(80);

    const completed = received.filter(
      (e): e is Extract<WorkflowEvent, { type: 'node_completed' }> => e.type === 'node_completed'
    );
    expect(completed.map(e => e.nodeId)).toEqual([
      'node-0',
      'node-1',
      'node-2',
      'node-3',
      'node-4',
    ]);
    // Exactly once each — a duplicate would show a repeated nodeId or a longer array.
    expect(completed).toHaveLength(5);
  });

  test('does not replay events written before the subscription started', async () => {
    const runId = 'run-history';
    const { store, push } = makeFakeStore();
    push({ workflow_run_id: runId, event_type: 'node_started', step_name: 'pre-existing' });

    const received: WorkflowEvent[] = [];
    const unsubscribe = new InProcessWorkflowEngine(store).subscribe(
      runId,
      event => received.push(event),
      5
    );
    unsubscribes.push(unsubscribe);

    await sleep(40);

    expect(received).toHaveLength(0);
  });

  test(
    "does not replay a descendant sub-run's pre-existing events, even though they " +
      "out-rank the subscribed run's own max event_order",
    async () => {
      const parentRunId = 'run-parent-2';
      const childRunId = 'run-child-2';
      const { store, push } = makeFakeStore(new Map([[childRunId, [parentRunId]]]));

      // The child run already has history (e.g. from an earlier attempt) with a
      // HIGHER event_order than anything the parent run has ever written (the
      // parent has written nothing yet) — `getMaxEventOrder(parentRunId)` would
      // return 0 and wrongly treat this pre-existing child event as new.
      push({
        workflow_run_id: childRunId,
        event_type: 'node_started',
        step_name: 'old-child-node',
      });

      const received: WorkflowEvent[] = [];
      const unsubscribe = new InProcessWorkflowEngine(store).subscribe(
        parentRunId,
        event => received.push(event),
        5
      );
      unsubscribes.push(unsubscribe);

      await sleep(40);

      expect(received).toHaveLength(0);
    }
  );

  test(
    'anchors the cursor before subscribe() returns, so an event published ' +
      'immediately afterward (before the first poll tick) is still delivered',
    async () => {
      const runId = 'run-immediate';
      const { store, push } = makeFakeStore();

      const received: WorkflowEvent[] = [];
      const unsubscribe = new InProcessWorkflowEngine(store).subscribe(
        runId,
        event => received.push(event),
        5
      );
      unsubscribes.push(unsubscribe);

      // No `await sleep()` here on purpose: this event is pushed synchronously
      // right after `subscribe()` returns, before the first 5ms interval tick.
      push({ workflow_run_id: runId, event_type: 'node_started', step_name: 'immediate-node' });

      await sleep(40);

      const nodeIds = received
        .filter(
          (e): e is Extract<WorkflowEvent, { type: 'node_started' }> => e.type === 'node_started'
        )
        .map(e => e.nodeId);
      expect(nodeIds).toContain('immediate-node');
    }
  );
});

// ---------------------------------------------------------------------------
// cancel() — real implementation (#3334 M7)
// ---------------------------------------------------------------------------

describe('InProcessWorkflowEngine.cancel', () => {
  test('requires a store-bound engine instance', async () => {
    const engine = new InProcessWorkflowEngine();
    await expect(engine.cancel('run-1')).rejects.toThrow(/store-bound engine instance/);
  });

  test('delegates 1:1 to store.cancelWorkflowRun, returning its {cancelled} verbatim', async () => {
    const calls: { id: string; event?: { reason?: string } }[] = [];
    const store: Partial<IWorkflowStore> = {
      cancelWorkflowRun: async (id, event) => {
        calls.push({ id, event });
        return { cancelled: true };
      },
    };

    const result = await new InProcessWorkflowEngine(store as IWorkflowStore).cancel(
      'run-42',
      'operator stop'
    );

    expect(result).toEqual({ cancelled: true });
    expect(calls).toEqual([{ id: 'run-42', event: { reason: 'operator stop' } }]);
  });

  test('is a no-op (never throws) on a second call once the run is already terminal', async () => {
    // Mirrors @archon/core's real cancelWorkflowRun: idempotent, guards
    // status NOT IN ('completed', 'cancelled') — a double-cancel returns
    // {cancelled: false} rather than throwing.
    let calls = 0;
    const store: Partial<IWorkflowStore> = {
      cancelWorkflowRun: async () => {
        calls += 1;
        return { cancelled: calls === 1 };
      },
    };
    const engine = new InProcessWorkflowEngine(store as IWorkflowStore);

    const first = await engine.cancel('run-double');
    const second = await engine.cancel('run-double');

    expect(first).toEqual({ cancelled: true });
    expect(second).toEqual({ cancelled: false });
  });

  test('omits the event arg entirely when no reason is given', async () => {
    let received: unknown = 'unset';
    const store: Partial<IWorkflowStore> = {
      cancelWorkflowRun: async (_id, event) => {
        received = event;
        return { cancelled: true };
      },
    };

    await new InProcessWorkflowEngine(store as IWorkflowStore).cancel('run-no-reason');

    expect(received).toBeUndefined();
  });
});
