/** Fakes for the `@archon/workflows` engine: discovery, source capture, execution and dry runs. */
import type * as WorkflowRunSource from '@archon/workflows/run-source';
import { afterAll, mock } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import type * as WorkflowDiscovery from '@archon/workflows/workflow-discovery';
import { withObservableCapturedSource } from '@archon/workflows/test-utils';

export const mockDiscoverWorkflowsWithConfig = mock<
  typeof WorkflowDiscovery.discoverWorkflowsWithConfig
>(() => Promise.resolve({ workflows: [], errors: [] }));
mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mockDiscoverWorkflowsWithConfig,
}));
mock.module('@archon/workflows/fixture-runner', () => ({
  runFixtures: mock(() => Promise.resolve({ results: [], passed: 0, failed: 0 })),
  formatFixtureReport: mock(() => 'FIXTURE REPORT'),
}));
/**
 * Ownership calls the run path makes on its capture, in order.
 *
 * `withCapturedSource` is stubbed as a faithful pass-through rather than mocked away: the
 * wrapper's whole job is that an unadopted capture gets reclaimed, and a stub that swallows
 * the owner would let a dropped `adopt()` — which deletes a live run's source — pass here.
 */
export const capturedSourceOwnerCalls: string[] = [];
/** The full owned roots shape a continuation carries — shared between the prepare and
 *  continuation mocks so the two cannot drift on which fields a `ResolvedContinuation`
 *  promises its consumer. */
export const CAPTURED_SOURCE_ROOTS: WorkflowRunSource.WorkflowSourceRoots = {
  project: '/test/capture/project',
  globalWorkflows: '/test/capture/global/workflows',
  globalCommands: '/test/capture/global/commands',
  globalScripts: '/test/capture/global/scripts',
  bundledWorkflows: '/test/capture/bundled/workflows',
  bundledCommands: '/test/capture/bundled/commands/defaults',
  installed: { kind: 'captured', captureRoot: '/test/capture' },
  kind: 'captured',
  anchor: {
    root: '/test/capture',
    digest: 'test-digest',
    config: {
      load_default_workflows: true,
      load_default_commands: true,
    },
  },
};
export const mockResolveContinuationWorkflow = mock<
  typeof WorkflowRunSource.resolveContinuationWorkflow
>(
  // Default: the run predates captures, so the caller keeps live discovery — what the
  // resume tests already assume. Tests that care about the frozen graph override
  // it per invocation.
  () => Promise.resolve(undefined)
);

export const mockArtifactsRoot = mkdtempSync(join(tmpdir(), 'archon-cli-container-artifacts-'));
afterAll(async () => {
  await removeTempTree(mockArtifactsRoot);
});

mock.module('@archon/workflows/executor', () => ({
  // Mirrors the real executor's adopt site (#2690): rename happens, then the wrap's
  // `capturedSourceOwner.adopt()` is called. For a continuation (no `preparedSource`)
  // the executor takes the legacy branch and does not adopt, so the wrap reclaims.
  executeWorkflow: mock((...args: unknown[]) => {
    const opts = args[7] as
      | {
          preparedSource?: unknown;
          capturedSourceOwner?: { adopt: () => void };
        }
      | undefined;
    if (opts?.preparedSource) opts.capturedSourceOwner?.adopt();
    return Promise.resolve({ success: true, workflowRunId: 'test-run-id' });
  }),
}));
mock.module('@archon/workflows/run-resume', () => ({
  hydrateResumableRun: mock(() => Promise.resolve(null)),
}));
mock.module('@archon/workflows/run-source', () => ({
  withCapturedSource: mock((body: Parameters<typeof withObservableCapturedSource>[1]) =>
    withObservableCapturedSource(capturedSourceOwnerCalls, body)
  ),
  resolveContinuationWorkflow: mockResolveContinuationWorkflow,
  // Stub capture so routing tests do not freeze real source trees.
  prepareWorkflowSource: mock(() =>
    Promise.resolve({
      runId: 'test-run-id',
      origin: '/test/path',
      manifest: {
        version: 1,
        engine_version: 'test',
        origin: '/test/path',
        captured_at: '2026-08-21T00:00:00.000Z',
        digest: 'test-digest',
        file_count: 0,
        byte_count: 0,
        scopes: [],
        source_config: {
          load_default_workflows: true,
          load_default_commands: true,
        },
      },
      anchor: CAPTURED_SOURCE_ROOTS.anchor,
      roots: CAPTURED_SOURCE_ROOTS,
    })
  ),
  recordSelectedWorkflow: mock(() => Promise.resolve()),
  disposeWorkflowSource: mock(() => Promise.resolve()),
  finalizeWorkflowSource: mock((_deps: unknown, prepared: unknown) => Promise.resolve(prepared)),
  preparedWorkflowSourceRecord: (
    prepared: import('@archon/workflows/run-source').PreparedWorkflowSource
  ) => ({
    version: 1,
    root: prepared.anchor.root,
    origin: prepared.origin,
    captured_at: prepared.manifest.captured_at,
    digest: prepared.manifest.digest,
    source_config: prepared.anchor.config,
    file_count: prepared.manifest.file_count,
    byte_count: prepared.manifest.byte_count,
  }),
}));
mock.module('@archon/workflows/run-paths', () => ({
  // The container dispatch resolves the run's artifacts directory to bind it into the
  // container and creates it on the host first, so hand it a real, reclaimed temp path.
  resolveProjectPaths: mock(() =>
    Promise.resolve({
      artifactsDir: join(mockArtifactsRoot, 'artifacts', 'runs', 'test-run-id'),
      workflowSourceDir: join(mockArtifactsRoot, 'workflow-source', 'runs', 'test-run-id'),
      logDir: join(mockArtifactsRoot, 'logs'),
      artifactsRoot: join(mockArtifactsRoot, 'artifacts'),
      stateDir: join(mockArtifactsRoot, 'state'),
      outputRoot: mockArtifactsRoot,
      identityResolution: 'resolved' as const,
    })
  ),
}));
mock.module('@archon/workflows/dry-run', () => ({
  loadDryRunStubs: mock(() => Promise.resolve({ node: 'stubbed output' })),
  writeDryRunStubScaffold: mock(() => Promise.resolve({ first: 'TODO', second: 'TODO' })),
  dryRunWorkflow: mock(() =>
    Promise.resolve({
      workflow: 'plan',
      outcome: 'completed',
      authoredOutcome: null,
      trace: [
        {
          nodeId: 'node',
          nodeType: 'command',
          state: 'stubbed',
          resolvedText: 'command:test-command',
          output: 'stubbed output',
        },
      ],
      missingStubs: [],
      toleratedMissingStubs: [],
      unusedStubs: [],
      summary: 'stubbed output',
    })
  ),
  formatDryRunTrace: mock(() => 'DRY RUN TRACE'),
}));

mock.module('@archon/workflows/event-emitter', () => ({
  getWorkflowEventEmitter: mock(() => ({ emit: mock(() => undefined) })),
}));
