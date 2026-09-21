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
let executedWorkflow: Parameters<ExecuteDagWorkflow>[0]['workflow'] | undefined;
const mockExecuteDagWorkflow = mock<ExecuteDagWorkflow>(async input => {
  executedWorkflow = input.workflow;
  return undefined;
});
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

runWorkflowEngineContractTests(deps => new InProcessWorkflowEngine(deps), {
  executedWorkflow: () => executedWorkflow,
});
