/**
 * Wires the shared `IWorkflowEngine` contract-test suite
 * (`engine-contract-tests.ts`) against `InProcessWorkflowEngine`
 * (issue #3334).
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

import type { IWorkflowStore } from './store';

// The contract suite drives submit/resume only; those take their store through
// the per-call `deps`, so the constructor-bound store is never reached here.
const contractStore: Partial<IWorkflowStore> = {
  cancelRunningWorkflowRun: async () => ({ cancelled: false }),
};
runWorkflowEngineContractTests(() => new InProcessWorkflowEngine(contractStore as IWorkflowStore));

import { describe, test, expect } from 'bun:test';

// ---------------------------------------------------------------------------
// cancel() — real implementation
// ---------------------------------------------------------------------------

describe('InProcessWorkflowEngine.cancel', () => {
  test('delegates 1:1 to store.cancelRunningWorkflowRun, returning its {cancelled} verbatim', async () => {
    const calls: { id: string; event?: { reason?: string } }[] = [];
    const store: Partial<IWorkflowStore> = {
      cancelRunningWorkflowRun: async (id, event) => {
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

  test('never reaches the unconditional cancelWorkflowRun, so a gate pause survives', async () => {
    // The port's contract is running-only: a run that paused at a gate between
    // a caller's status read and this call must be left alone. Routing through
    // the unconditional store method would overwrite `paused` with `cancelled`.
    let unconditionalCalls = 0;
    const store: Partial<IWorkflowStore> = {
      cancelWorkflowRun: async () => {
        unconditionalCalls += 1;
        return { cancelled: true };
      },
      // Mirrors @archon/core's cancelRunningWorkflowRun against a paused row:
      // the `status = 'running'` predicate matches nothing.
      cancelRunningWorkflowRun: async () => ({ cancelled: false }),
    };

    const result = await new InProcessWorkflowEngine(store as IWorkflowStore).cancel('run-paused');

    expect(result).toEqual({ cancelled: false });
    expect(unconditionalCalls).toBe(0);
  });

  test('is a no-op (never throws) on a second call once the run is no longer running', async () => {
    // Mirrors @archon/core's real cancelRunningWorkflowRun: idempotent, guards
    // status = 'running' — a second call returns {cancelled: false} rather
    // than throwing.
    let calls = 0;
    const store: Partial<IWorkflowStore> = {
      cancelRunningWorkflowRun: async () => {
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
      cancelRunningWorkflowRun: async (_id, event) => {
        received = event;
        return { cancelled: true };
      },
    };

    await new InProcessWorkflowEngine(store as IWorkflowStore).cancel('run-no-reason');

    expect(received).toBeUndefined();
  });
});
