// @archon-test-isolated
import type * as WorkflowRunSource from '@archon/workflows/run-source';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { buildAiProfile } from '@archon/workflows/model-validation';
import { providerRegistry } from '@archon/providers';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers/in-process';
mock.module('../../workflows/branch-launch-source', () => ({
  withBranchLaunchSource: async (
    _repo: string,
    _branch: string,
    prepare: (path: string) => Promise<unknown>
  ) => prepare('/adopted/snapshot'),
}));
import { mock, describe, test, expect, beforeEach, spyOn } from 'bun:test';
import {
  ISOLATION_PROVIDER_TYPES,
  ISOLATION_WORKFLOW_TYPES,
  ENVIRONMENT_STATUSES,
  WORKTREE_REMOVAL_OWNER,
  WorktreeRemovalInProgressError,
} from '@archon/isolation/types';
import { createMockLogger } from '../../test/mocks/logger';
import { MockPlatformAdapter } from '../../test/mocks/platform';
import type { Conversation, Codebase, IPlatformAdapter } from '../../types';
import type {
  IsolationEnvironmentRow,
  IsolationResolver,
  ResolvedIsolation,
} from '@archon/isolation';
import { toBranchName, toRepoPath } from '@archon/git';
const realVerifyWorktreeOwnership = (await import('@archon/git')).verifyWorktreeOwnership;
const mockVerifyWorktreeOwnership = mock<typeof realVerifyWorktreeOwnership>(async () => {});
const mockGetCurrentBranchStrict = mock(async (): Promise<string | null> => 'issue-42');
mock.module('@archon/git', () => ({
  getCurrentBranchStrict: mockGetCurrentBranchStrict,
  verifyWorktreeOwnership: mockVerifyWorktreeOwnership,
}));
// Type-only imports are erased at runtime, so these do not load './background'
// (or the workflow engine) before the mock.module() calls below take effect.
import type { WorkflowRoutingContext } from './background';
import type { PreparedWorkflowSource } from '@archon/workflows/run-source';
import type * as WorkflowExecutor from '@archon/workflows/executor';
import type * as RunLiveOwnerModule from '../../services/run-live-owner';
import { TerminalStatusWriteError } from '@archon/workflows/terminal-status-write';
import type { ResolvedWorkflow, WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import type { IWorkflowStore } from '@archon/workflows/store';
import {
  makeTestComposedWorkflow,
  makeTestResolvedWorkflow,
  makeTestWorkflow,
  withObservableCapturedSource,
} from '@archon/workflows/test-utils';

// ─── Mock setup (BEFORE importing module under test) ─────────────────────────

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  captureApprovalResolved: () => undefined,
  createLogger: mock(() => mockLogger),
  getArchonWorkspacesPath: mock(() => '/home/test/.archon/workspaces'),
  ensureArchonWorkspacesPath: mock(() => Promise.resolve('/home/test/.archon/workspaces')),
  getArchonHome: mock(() => '/home/test/.archon'),
  getCredentialKeyPath: mock(() => '/home/test/.archon/credential-key'),
  // Required by @archon/git (loaded via isolation-resolver.ts's toBranchName import).
  getProjectWorktreesPath: mock(
    (owner: string, repo: string) => `/home/test/.archon/workspaces/${owner}/${repo}/worktrees`
  ),
  // Required by @archon/git worktree.ts (shared identity resolution, #2227).
  parseOwnerRepo: mock((name: string) => {
    const parts = name.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return { owner: parts[0], repo: parts[1] };
  }),
  resolveRepoProjectIdentity: mock((name: string, cwd: string) => {
    const parts = name.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) return { owner: parts[0], repo: parts[1] };
    const repo = cwd.split('/').filter(Boolean).pop() ?? '';
    return repo === '' || repo === '.' || repo === '..' ? null : { owner: '_local', repo };
  }),
}));

// DB mocks
const runLiveOwnerCalls: string[] = [];
const mockCloseRunLiveOwner = mock(() => {
  runLiveOwnerCalls.push('close');
  return Promise.resolve();
});
const mockStartRunLiveOwner = mock<typeof RunLiveOwnerModule.startRunLiveOwner>(runId => {
  runLiveOwnerCalls.push(`start:${runId}`);
  return Promise.resolve({
    close: mockCloseRunLiveOwner,
    isStopRequested: () => false,
    registerTerminationPreparation: () => () => undefined,
  });
});
mock.module('../../services/run-live-owner', () => ({
  startRunLiveOwner: mockStartRunLiveOwner,
}));

const mockUpdateConversation = mock(() => Promise.resolve());
const mockGetOrCreateConversation = mock<
  typeof import('../../db/conversations').getOrCreateConversation
>(async () => makeConversation());
mock.module('../../db/conversations', () => ({
  getOrCreateConversation: mockGetOrCreateConversation,
  getConversationByPlatformId: mock(() => Promise.resolve(null)),
  updateConversation: mockUpdateConversation,
  touchConversation: mock(() => Promise.resolve()),
}));

const mockGetCodebase = mock((): Promise<Codebase | null> => Promise.resolve(null));
mock.module('../../db/codebases', () => ({
  getCodebase: mockGetCodebase,
  listCodebases: mock(() => Promise.resolve([])),
  createCodebase: mock(() => Promise.resolve({ id: 'new-codebase-id' })),
}));

const mockAdoptionMetadata = mock<typeof import('../../db/isolation-environments').updateMetadata>(
  async () => {}
);
const mockAdoptedEnv = mock(async (): Promise<IsolationEnvironmentRow | null> => makeEnvRow());
const mockUpdateIsolationStatus = mock(() => Promise.resolve());
mock.module('../../db/isolation-environments', () => ({
  getById: mockAdoptedEnv,
  updateMetadata: mockAdoptionMetadata,
  createIsolationStore: mock(() => ({
    updateStatus: mockUpdateIsolationStatus,
  })),
}));

mock.module('../../db/sessions', () => ({
  getActiveSession: mock(() => Promise.resolve(null)),
  createSession: mock(() => Promise.resolve(null)),
  updateSession: mock(() => Promise.resolve()),
  deactivateSession: mock(() => Promise.resolve()),
  transitionSession: mock(() => Promise.resolve(null)),
}));

mock.module('../../handlers/command-handler', () => ({
  handleCommand: mock(() => Promise.resolve({ message: '', modified: false, success: true })),
  parseCommand: mock((msg: string) => ({
    command: msg.split(/\s+/)[0].substring(1),
    args: msg.split(/\s+/).slice(1),
  })),
}));

registerBuiltinProviders();
registerCommunityProviders();

mock.module('@archon/providers', () => ({
  providerRegistry,
  isRegisteredProvider: () => true,
  getRegistration: () => ({
    parseConfig: (raw: Record<string, unknown>) => raw,
    credentials: { vendorFor: () => 'anthropic' },
  }),
  getAgentProvider: mock(() => null),
  getRegisteredProviders: mock(() => []),
  // credentials/delivery (#1955) imports these from '@archon/providers'.
  PI_PROVIDER_ENV_VARS: { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' },
  PI_AMBIENT_VENDORS: ['amazon-bedrock', 'google-vertex'],
}));

const mockCreateWorkflowRun = mock<IWorkflowStore['createWorkflowRun']>(() => {
  runLiveOwnerCalls.push('create');
  return Promise.resolve({
    origin: { conversationId: 'worker-conv-1', parentConversationId: 'parent-conv' },
    id: 'run-1',
    workflow_name: 'bg-workflow',
    conversation_id: 'worker-conv-1',
    parent_conversation_id: 'parent-conv',
    codebase_id: 'cb-1',
    status: 'pending',
    outcome: null,
    user_message: 'run it',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: '/parent/cwd',
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
  });
});
const mockFailWorkflowRun = mock<IWorkflowStore['failWorkflowRun']>(() =>
  Promise.resolve({ failed: true })
);
mock.module('../../workflows/store-adapter', () => ({
  createWorkflowDeps: mock(() => ({
    providers: providerRegistry,
    store: {
      createWorkflowRun: mockCreateWorkflowRun,
      failWorkflowRun: mockFailWorkflowRun,
      updateWorkflowRun: mock(async () => {}),
      getCodebaseEnvVars: async () => ({}),
    },
    sealRunConfig: (_layer: unknown, source: unknown) => ({
      version: 1,
      ciphertext: 'sealed',
      source,
      keys: [],
    }),
    getAgentProvider: () => ({
      checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
    }),
    loadConfig: async () => ({ assistant: 'claude', assistants: { claude: {} }, commands: {} }),
  })),
}));

mock.module('../../config/config-loader', () => ({
  loadConfig: mock(() => Promise.resolve({})),
  loadRepoConfig: mock(() => Promise.resolve(null)),
}));

const mockResolveWorkflowSourceRoot = mock(
  (): Promise<string | undefined> => Promise.resolve(undefined)
);
mock.module('../../utils/workflow-source-root', () => ({
  resolveWorkflowSourceRoot: mockResolveWorkflowSourceRoot,
}));

mock.module('../../services/cleanup-service', () => ({
  getWorktreeStatusBreakdown: mock(() => Promise.resolve({ active: 0, stale: 0, merged: 0 })),
  STALE_THRESHOLD_DAYS: 7,
}));

// Mock @archon/isolation — shared resolve mock so tests can control return values
const mockResolve = mock<IsolationResolver['resolve']>(() =>
  Promise.resolve({ status: 'none', cwd: '/workspace' })
);

const mockReleaseUnlinked = mock<IsolationResolver['releaseUnlinked']>(() => Promise.resolve());

class MockIsolationResolver {
  resolve = mockResolve;
  releaseUnlinked = mockReleaseUnlinked;
  constructor(_deps: unknown) {}
}

const { worktreeRegistrationMetadata } = await import('@archon/isolation');
mock.module('@archon/isolation', () => ({
  ISOLATION_PROVIDER_TYPES,
  ISOLATION_WORKFLOW_TYPES,
  ENVIRONMENT_STATUSES,
  WORKTREE_REMOVAL_OWNER,
  WorktreeRemovalInProgressError,
  worktreeRegistrationMetadata,
  IsolationResolver: MockIsolationResolver,
  IsolationBlockedError: class IsolationBlockedError extends Error {
    constructor(
      message: string,
      public reason?: string
    ) {
      super(message);
      this.name = 'IsolationBlockedError';
    }
  },
  configureIsolation: mock(() => undefined),
  getIsolationProvider: mock(() => ({})),
  classifyIsolationError: (err: Error) => err.message,
}));

mock.module('../prompt-builder', () => ({
  buildOrchestratorPrompt: mock(() => 'prompt'),
  buildProjectScopedPrompt: mock(() => 'prompt'),
}));

mock.module('../../utils/error-formatter', () => ({
  classifyAndFormatError: mock((err: Error) => `⚠️ Error: ${err.message}`),
}));

mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mock(() => Promise.resolve({ workflows: [], errors: [] })),
}));
// Resolves to a paused result so dispatchBackgroundWorkflow's fire-and-forget
// tail is a no-op (no result card is surfaced to the parent conversation).
// Mirrors the real executor's adopt site (#2690): setup awaits happen before rename,
// then `capturedSourceOwner.adopt()` is called. One regression test holds that await
// open to prove the background dispatch does not reclaim before adoption.
let deferExecuteWorkflowAdoption = false;
let releaseExecuteWorkflowAdoption: (() => void) | undefined;
const mockExecuteWorkflow = mock<typeof WorkflowExecutor.executeWorkflow>(async (...args) => {
  const opts = args[7];
  if (deferExecuteWorkflowAdoption) {
    await new Promise<void>(resolve => {
      releaseExecuteWorkflowAdoption = resolve;
    });
  }
  if (opts?.preparedSource) opts.capturedSourceOwner?.adopt();
  return { success: true, paused: true, workflowRunId: 'run-1' };
});
const mockPrepareWorkflowSource = mock<typeof WorkflowRunSource.prepareWorkflowSource>(
  (): Promise<PreparedWorkflowSource> =>
    Promise.resolve({
      runId: 'prepared-run-id',
      origin: '/origin',
      manifest: {
        version: 1,
        engine_version: 'test',
        origin: '/origin',
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
      anchor: {
        root: '/capture',
        digest: 'test-digest',
        config: {
          load_default_workflows: true,
          load_default_commands: true,
        },
      },
      roots: {
        project: '/capture/project',
        globalWorkflows: '/capture/global/workflows',
        globalCommands: '/capture/global/commands',
        globalScripts: '/capture/global/scripts',
        bundledWorkflows: '/capture/bundled/workflows',
        bundledCommands: '/capture/bundled/commands/defaults',
        installed: { kind: 'captured', captureRoot: '/capture' },
        kind: 'captured',
        anchor: {
          root: '/capture',
          digest: 'test-digest',
          config: {
            load_default_workflows: true,
            load_default_commands: true,
          },
        },
      },
    })
);
const mockRecordSelectedWorkflow = mock<typeof WorkflowRunSource.recordSelectedWorkflow>(() =>
  Promise.resolve()
);
const capturedSourceOwnerCalls: string[] = [];

mock.module('@archon/workflows/executor', () => ({
  executeWorkflow: mockExecuteWorkflow,
}));
mock.module('@archon/workflows/run-resume', () => ({
  hydrateResumableRun: mock(() => Promise.resolve(null)),
}));
mock.module('@archon/workflows/run-source', () => ({
  finalizeWorkflowSource: mock(
    async (_deps: unknown, source: WorkflowRunSource.PreparedWorkflowSource) => source
  ),
  preparedWorkflowSourceRecord: (source: WorkflowRunSource.PreparedWorkflowSource) => ({
    version: 1,
    root: source.anchor.root,
    origin: source.origin,
    captured_at: source.manifest.captured_at,
    digest: source.manifest.digest,
    source_config: source.anchor.config,
    file_count: source.manifest.file_count,
    byte_count: source.manifest.byte_count,
  }),
  // Bun merges module mocks: stub each capture export to avoid real I/O.
  prepareWorkflowSource: mockPrepareWorkflowSource,
  recordSelectedWorkflow: mockRecordSelectedWorkflow,
  disposeWorkflowSource: mock(() => Promise.resolve()),
  resolveContinuationWorkflow: mock(() => Promise.resolve(undefined)),
  withCapturedSource: mock((body: Parameters<typeof withObservableCapturedSource>[1]) =>
    withObservableCapturedSource(capturedSourceOwnerCalls, body)
  ),
}));
mock.module('@archon/workflows/router', () => ({
  findWorkflow: mock(() => undefined),
  // Statically imported by the background dispatch path; a named import must link even
  // when the test never exercises it.
  resolveWorkflowName: mock(() => undefined),
}));
mock.module('@archon/workflows/utils/tool-formatter', () => ({
  formatToolCall: mock(() => ''),
}));

mock.module('fs', () => ({
  existsSync: mock(() => true),
  // token-crypto.ts imports these from node:fs for the auto-provisioned credential
  // key. readFileSync returns a valid 64-hex key so getEncryptionKey() resolves
  // without any real disk write when the per-user credential path is exercised.
  readFileSync: mock(() => 'a'.repeat(64)),
  writeFileSync: mock(() => undefined),
  mkdirSync: mock(() => undefined),
  chmodSync: mock(() => undefined),
}));

mock.module('../../services/title-generator', () => ({
  generateAndSetTitle: mock(() => Promise.resolve()),
}));

// ─── Import module under test AFTER all mocks ────────────────────────────────

const { dispatchBackgroundWorkflow } = await import('./background');

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeEnvRow(overrides?: Partial<IsolationEnvironmentRow>): IsolationEnvironmentRow {
  return {
    id: 'env-1',
    codebase_id: 'cb-1',
    workflow_type: 'issue',
    workflow_id: '42',
    provider: 'worktree',
    working_path: '/worktrees/issue-42',
    branch_name: 'issue-42',
    status: 'active',
    created_at: new Date(),
    created_by_platform: 'web',
    created_by_user_id: null,
    metadata: {},
    ...overrides,
  };
}

// The resolver always reports the environment's own working path as `cwd`.
// Deriving it here stops a call site from setting the two to different values.
function resolvedIsolation(
  method: ResolvedIsolation['method'],
  env: IsolationEnvironmentRow = makeEnvRow()
): ResolvedIsolation {
  return { status: 'resolved', env, cwd: env.working_path, method };
}

type CreatedMethod = Extract<ResolvedIsolation['method'], { type: 'created' }>;

function createdMethod(overrides?: Partial<CreatedMethod>): CreatedMethod {
  return {
    type: 'created',
    creationId: '58e2e55c-b565-4cca-8786-4bc9b86d6fa8',
    canonicalRepoPath: toRepoPath('/workspace/test-repo'),
    branchCreated: true,
    ...overrides,
  };
}

function makeConversation(overrides?: Partial<Conversation>): Conversation {
  return {
    id: 'conv-1',
    platform_type: 'web',
    platform_conversation_id: 'web-conv-1',
    codebase_id: 'cb-1',
    cwd: '/workspace',
    isolation_env_id: null,
    ai_assistant_type: 'claude',
    title: null,
    hidden: false,
    deleted_at: null,
    last_activity_at: null,
    user_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeCodebase(overrides?: Partial<Codebase>): Codebase {
  return {
    id: 'cb-1',
    name: 'test-repo',
    repository_url: 'https://github.com/test/test-repo.git',
    default_cwd: '/workspace/test-repo',
    default_branch: null,
    ai_assistant_type: 'claude',
    kind: 'repo',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('dispatchBackgroundWorkflow', () => {
  const track = trackTempRoots();
  let platform: MockPlatformAdapter;

  function makeWorkflow(overrides?: Partial<WorkflowDefinition>): ResolvedWorkflow {
    return makeTestResolvedWorkflow({
      name: 'bg-workflow',
      description: 'background dispatch test workflow',
      nodes: [],
      ...overrides,
    });
  }

  function makeRoutingCtx(overrides?: Partial<WorkflowRoutingContext>): WorkflowRoutingContext {
    return {
      platform,
      conversationId: 'parent-conv',
      cwd: '/parent/cwd',
      originalMessage: 'run it',
      conversationDbId: 'parent-db-id',
      codebaseId: 'cb-1',
      availableWorkflows: [],
      ...overrides,
    };
  }

  /** Let the fire-and-forget execution tail settle before the test ends. */
  async function flushBackgroundExecution(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    platform = new MockPlatformAdapter();
    deferExecuteWorkflowAdoption = false;
    releaseExecuteWorkflowAdoption?.();
    releaseExecuteWorkflowAdoption = undefined;
    capturedSourceOwnerCalls.length = 0;
    runLiveOwnerCalls.length = 0;
    mockStartRunLiveOwner.mockClear();
    mockCloseRunLiveOwner.mockClear();
    mockResolve.mockClear();
    mockUpdateConversation.mockClear();
    mockCreateWorkflowRun.mockClear();
    mockFailWorkflowRun.mockClear();
    mockExecuteWorkflow.mockClear();
    mockPrepareWorkflowSource.mockClear();
    mockResolveWorkflowSourceRoot.mockClear();
    mockResolveWorkflowSourceRoot.mockResolvedValue(undefined);
    mockLogger.info.mockClear();
    mockGetOrCreateConversation.mockClear();
    mockGetOrCreateConversation.mockResolvedValue(
      makeConversation({ id: 'worker-conv-1', platform_conversation_id: 'web-worker-1' })
    );
    mockGetCodebase.mockResolvedValue(makeCodebase());
  });

  test('credential refusal prevents worker isolation and engine submission', async () => {
    const adapter = await import('../../workflows/store-adapter');
    const original = adapter.createWorkflowDeps();
    const factory = spyOn(adapter, 'createWorkflowDeps').mockImplementation(() => ({
      ...original,
      isPerUserProviderKeysEnabled: () => true,
      getUserProviderCredential: async () => ({
        kind: 'api_key',
        getStatus: async () => ({ state: 'unusable', source: 'archon', evidence: 'cannot read' }),
      }),
    }));
    try {
      await expect(
        dispatchBackgroundWorkflow(
          makeRoutingCtx({ userId: 'origin' }),
          makeTestResolvedWorkflow({
            name: 'credential-run',
            nodes: [{ id: 'one', prompt: 'do work' }],
          })
        )
      ).rejects.toThrow(
        "provider 'claude' (vendor 'anthropic'): credential cannot be used: cannot read"
      );
      expect(mockResolve).not.toHaveBeenCalled();
      expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    } finally {
      factory.mockRestore();
      (adapter.createWorkflowDeps as ReturnType<typeof mock>).mockImplementation(() => original);
    }
  });

  for (const structured of [false, true]) {
    for (const fails of [false, true]) {
      test(`new adapter background lifecycle, structured=${structured}, fails=${fails}`, async () => {
        platform.getPlatformType.mockReturnValue('matrix-chat');
        const finalize = mock(async () => {});
        const prepare = mock<NonNullable<IPlatformAdapter['prepareBackgroundConversation']>>(
          async () => finalize
        );
        const sendStructuredEvent = mock(async () => {});
        if (fails) mockExecuteWorkflow.mockRejectedValueOnce(new Error('execution failed'));
        await dispatchBackgroundWorkflow(
          makeRoutingCtx({
            platform: {
              ...platform,
              prepareBackgroundConversation: prepare,
              ...(structured ? { sendStructuredEvent } : {}),
            },
          }),
          makeWorkflow()
        );
        await flushBackgroundExecution();
        const workerId = mockGetOrCreateConversation.mock.calls[0]?.[1];
        expect(mockGetOrCreateConversation.mock.calls[0]?.[0]).toBe('matrix-chat');
        expect(mockGetOrCreateConversation.mock.calls[0]?.[2]).toBe('cb-1');
        expect(workerId).toStartWith('matrix-chat-worker-');
        expect(prepare).toHaveBeenCalledWith({
          workerConversationId: workerId,
          parentConversationId: 'parent-conv',
          conversationDbId: 'worker-conv-1',
        });
        expect(finalize).toHaveBeenCalledTimes(1);
        expect(sendStructuredEvent).toHaveBeenCalledTimes(structured ? 1 : 0);
        if (structured)
          expect(sendStructuredEvent).toHaveBeenCalledWith('parent-conv', {
            type: 'workflow_dispatch',
            workerConversationId: workerId,
            workflowName: 'bg-workflow',
          });
        expect(platform.sendMessage).toHaveBeenCalledWith(
          'parent-conv',
          expect.stringContaining('(background)'),
          expect.anything()
        );
        if (fails)
          expect(platform.sendMessage).toHaveBeenCalledWith(
            'parent-conv',
            expect.stringContaining('execution failed'),
            expect.anything()
          );
      });
    }
  }

  test('nothing is prepared when source preparation fails', async () => {
    const prepare = mock<NonNullable<IPlatformAdapter['prepareBackgroundConversation']>>(
      async () => async () => {}
    );
    mockPrepareWorkflowSource.mockRejectedValueOnce(new Error('capture failed'));
    await dispatchBackgroundWorkflow(
      makeRoutingCtx({ platform: { ...platform, prepareBackgroundConversation: prepare } }),
      makeWorkflow()
    );
    await flushBackgroundExecution();
    expect(prepare).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test.each(['own', 'composed'] as const)(
    'a workflow with its %s approval gate dispatches in the background',
    async origin => {
      const gate = { id: 'gate', approval: { message: 'Approve?' } };
      const block = makeTestWorkflow({ name: 'gate-blk', nodes: [gate] });
      const workflow =
        origin === 'own'
          ? makeTestComposedWorkflow(
              [makeTestWorkflow({ name: 'bg-gate', nodes: [gate], worktree: { enabled: false } })],
              'bg-gate'
            )
          : makeTestComposedWorkflow(
              [
                block,
                makeTestWorkflow({
                  name: 'bg-gate',
                  nodes: [{ id: 'inc', include: 'gate-blk' }],
                  worktree: { enabled: false },
                }),
              ],
              'bg-gate'
            );

      await dispatchBackgroundWorkflow(makeRoutingCtx(), workflow);
      await flushBackgroundExecution();
      expect(mockGetOrCreateConversation).toHaveBeenCalled();
      expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    }
  );

  test.each(['running', 'completed', 'failed', 'cancelled'] as const)(
    'background handoff observed as %s uses the failure channel only on failure',
    async observedStatus => {
      const failed = observedStatus === 'failed' || observedStatus === 'cancelled';
      mockExecuteWorkflow.mockResolvedValueOnce(
        failed
          ? {
              success: false,
              handedOff: true,
              workflowRunId: 'run-1',
              observedStatus,
              error: `Workflow ${observedStatus} after execution ownership changed`,
            }
          : { success: true, handedOff: true, workflowRunId: 'run-1', observedStatus }
      );
      await dispatchBackgroundWorkflow(
        makeRoutingCtx(),
        makeWorkflow({ worktree: { enabled: false } })
      );
      await flushBackgroundExecution();
      const cards = platform.sendMessage.mock.calls.filter(
        call => call[2]?.category === 'workflow_result'
      );
      if (failed) {
        expect(cards).toEqual([
          [
            'parent-conv',
            `Workflow **bg-workflow** failed: Workflow ${observedStatus} after execution ownership changed`,
            {
              category: 'workflow_result',
              segment: 'new',
              workflowResult: { workflowName: 'bg-workflow', runId: 'run-1' },
            },
          ],
        ]);
      } else expect(cards).toEqual([]);
      expect(mockFailWorkflowRun).not.toHaveBeenCalled();
    }
  );

  // #2910: a rejected terminal write means the row still says 'running' and the run's
  // real outcome is unknown. Both sides of the branch are asserted — an ordinary
  // rejection keeps its compensating write and its "failed" card; a terminal-write
  // rejection gets neither, because a second write over the channel that just failed
  // would either fail again or bury the real error.
  test('marks the run failed and says so when execution rejects with an ordinary error', async () => {
    const workflow = makeWorkflow({ worktree: { enabled: false } });
    mockExecuteWorkflow.mockRejectedValueOnce(new Error('exec boom'));
    mockFailWorkflowRun.mockImplementationOnce(async () => {
      runLiveOwnerCalls.push('fail');
      return { failed: true };
    });

    await dispatchBackgroundWorkflow(makeRoutingCtx(), workflow);
    await flushBackgroundExecution();

    expect(mockFailWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockFailWorkflowRun.mock.calls[0]?.[0]).toBe('run-1');
    expect(mockCloseRunLiveOwner).toHaveBeenCalledTimes(1);
    expect(runLiveOwnerCalls).toEqual(['start:prepared-run-id', 'create', 'fail', 'close']);
    const sent = platform.sendMessage.mock.calls.map(c => c[1]);
    expect(sent.some(m => m.includes('failed: exec boom'))).toBe(true);
  });

  test('does not compensate or claim failure when the terminal write rejects', async () => {
    const workflow = makeWorkflow({ worktree: { enabled: false } });
    mockExecuteWorkflow.mockRejectedValueOnce(
      new TerminalStatusWriteError(new Error('db is gone'))
    );

    await dispatchBackgroundWorkflow(makeRoutingCtx(), workflow);
    await flushBackgroundExecution();

    expect(mockFailWorkflowRun).not.toHaveBeenCalled();
    const sent = platform.sendMessage.mock.calls.map(c => c[1]);
    expect(sent.some(m => m.includes('final status could not be saved'))).toBe(true);
    expect(sent.some(m => m.includes('failed: Failed to persist'))).toBe(false);
  });

  test('worktree.enabled: false skips isolation and runs in the parent cwd', async () => {
    const workflow = makeWorkflow({ worktree: { enabled: false } });

    await dispatchBackgroundWorkflow(makeRoutingCtx(), workflow);

    // Policy opt-out: no isolation resolution attempted at all.
    expect(mockResolve).not.toHaveBeenCalled();
    // The run executes in the parent conversation's cwd (live checkout).
    expect(mockCreateWorkflowRun).toHaveBeenCalledTimes(1);
    const runRow = mockCreateWorkflowRun.mock.calls[0]?.[0];
    expect(runRow?.working_path).toBeUndefined();
    expect(mockExecuteWorkflow.mock.calls.at(-1)?.[3]).toBe('/parent/cwd');
    // Operators can distinguish live-checkout runs from worktree runs in logs.
    expect(mockLogger.info).toHaveBeenCalledWith(
      { workflowName: 'bg-workflow', conversationId: 'parent-conv', codebaseId: 'cb-1' },
      'workflow.worktree_disabled_by_policy'
    );

    await flushBackgroundExecution();
  });

  test('retains the prepared run source before detached execution starts', async () => {
    // The run already owns its source when deferred engine submission starts.
    const workflow = makeWorkflow({ worktree: { enabled: false } });
    deferExecuteWorkflowAdoption = true;

    try {
      await dispatchBackgroundWorkflow(makeRoutingCtx(), workflow);

      expect(capturedSourceOwnerCalls).toEqual(['hold:/capture', 'hold:/capture', 'adopt']);
      expect(runLiveOwnerCalls).toEqual(['start:prepared-run-id', 'create']);
      expect(mockCloseRunLiveOwner).not.toHaveBeenCalled();

      releaseExecuteWorkflowAdoption?.();
      await flushBackgroundExecution();
      expect(capturedSourceOwnerCalls).toEqual(['hold:/capture', 'hold:/capture', 'adopt']);
      expect(runLiveOwnerCalls).toEqual(['start:prepared-run-id', 'create', 'close']);
    } finally {
      deferExecuteWorkflowAdoption = false;
      releaseExecuteWorkflowAdoption?.();
      releaseExecuteWorkflowAdoption = undefined;
    }
  });

  test('keeps holding the capture when the dispatch gives up after taking it', async () => {
    // No run exists to own the bytes, so the wrapper must reclaim them — one leaked tree
    // per failed dispatch otherwise, on the console's default path.
    mockRecordSelectedWorkflow.mockRejectedValueOnce(new Error('capture manifest is read-only'));
    const workflow = makeWorkflow({ worktree: { enabled: false } });

    await dispatchBackgroundWorkflow(makeRoutingCtx(), workflow);

    expect(capturedSourceOwnerCalls).toEqual(['hold:/capture', 'reclaim:/capture']);
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
  });

  // This path PRE-CREATES the run row (so the console can fetch it immediately), which
  // means the executor's own `if (!workflowRun)` stamp never fires here — the values
  // have to be written onto the row below. It is also the console's default path for
  // non-interactive workflows, so losing the stamp would silently start every
  // console-supplied run with its inputs missing rather than failing (#2554).
  test('stamps caller-supplied declared inputs onto the pre-created run row', async () => {
    const workflow = makeWorkflow({ worktree: { enabled: false } });

    await dispatchBackgroundWorkflow(makeRoutingCtx({ inputs: { diff: 'D1' } }), workflow);

    expect(mockCreateWorkflowRun).toHaveBeenCalledTimes(1);
    const runRow = mockCreateWorkflowRun.mock.calls[0]?.[0];
    expect(runRow?.metadata?.inputs).toEqual({ diff: 'D1' });

    await flushBackgroundExecution();
  });

  test('fresh background supersede persists provenance on the pre-created row', async () => {
    await dispatchBackgroundWorkflow(
      makeRoutingCtx({ supersedesRunId: 'replaced-run' }),
      makeWorkflow({ worktree: { enabled: false } })
    );

    expect(mockCreateWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockCreateWorkflowRun.mock.calls[0][0]).toMatchObject({
      adopted_from_run_id: 'replaced-run',
      metadata: { continuation: { mode: 'supersede' } },
    });
    await flushBackgroundExecution();
  });

  test('writes no inputs key on the pre-created row when none are supplied', async () => {
    // Bare-run parity with the executor-level row: a run that supplied nothing must
    // look exactly as it did before #2554.
    const workflow = makeWorkflow({ worktree: { enabled: false } });

    await dispatchBackgroundWorkflow(makeRoutingCtx(), workflow);

    const runRow = mockCreateWorkflowRun.mock.calls[0]?.[0];
    expect(runRow?.metadata).not.toHaveProperty('inputs');

    await flushBackgroundExecution();
  });

  test('background adoption records inherited policy before handing off to the executor', async () => {
    const adapter = await import('../../workflows/store-adapter');
    const original = adapter.createWorkflowDeps();
    const snapshot = {
      version: 1 as const,
      assistant: 'codex',
      assistants: { codex: { model: 'launch-model' } },
      baseAiProfile: buildAiProfile('codex'),
      modelOverrides: {},
    };
    const ancestor = {
      ...(await mockCreateWorkflowRun({
        workflow_name: 'ancestor',
        origin: { conversationId: 'conv' },
        user_message: '',
      })),
      user_id: 'old-actor',
      metadata: { ai_configuration: snapshot },
    };
    mockCreateWorkflowRun.mockClear();
    const factory = spyOn(adapter, 'createWorkflowDeps').mockImplementation(() => ({
      ...original,
      store: { ...original.store, getWorkflowRun: async () => ancestor },
    }));
    try {
      await dispatchBackgroundWorkflow(
        makeRoutingCtx({ adoptRunId: 'ancestor', userId: 'new-actor' }),
        makeWorkflow({ worktree: { enabled: false } })
      );
      await flushBackgroundExecution();
      const row = mockCreateWorkflowRun.mock.calls[0]?.[0];
      expect(row?.metadata?.ai_configuration).toEqual(snapshot);
      expect(row?.origin?.userId).toBe('new-actor');
      const prepared = mockExecuteWorkflow.mock.calls[0]?.[7]?.preparedAiConfiguration;
      expect(prepared?.config.assistant).toBe('codex');
      expect(prepared?.config.assistants.codex.model).toBe('launch-model');
      expect(prepared?.executionUserId).toBe('new-actor');
    } finally {
      factory.mockRestore();
      (adapter.createWorkflowDeps as ReturnType<typeof mock>).mockImplementation(() => original);
    }
  });

  test('reads launch AI config from the registered checkout, not the parent worktree', async () => {
    // The parent conversation already sits in a worktree, which holds only committed
    // config; the registered checkout carries an uncommitted codex selection.
    const adapter = await import('../../workflows/store-adapter');
    const original = adapter.createWorkflowDeps();
    const loadConfig = mock(async (cwd?: string) => ({
      ...(await original.loadConfig(cwd)),
      assistant: cwd === '/workspace/test-repo' ? 'codex' : 'claude',
    }));
    const factory = spyOn(adapter, 'createWorkflowDeps').mockImplementation(() => ({
      ...original,
      loadConfig,
    }));
    try {
      await dispatchBackgroundWorkflow(
        makeRoutingCtx({ cwd: '/worktrees/parent' }),
        makeWorkflow({ worktree: { enabled: false } })
      );
      await flushBackgroundExecution();
      expect(loadConfig).toHaveBeenCalledWith('/workspace/test-repo');
      expect(loadConfig).not.toHaveBeenCalledWith('/worktrees/parent');
      const row = mockCreateWorkflowRun.mock.calls[0]?.[0];
      expect(row?.metadata?.ai_configuration).toMatchObject({ assistant: 'codex' });
    } finally {
      factory.mockRestore();
      (adapter.createWorkflowDeps as ReturnType<typeof mock>).mockImplementation(() => original);
    }
  });

  test('passes sparse model bindings to the executor for a pre-created background run', async () => {
    const workflow = makeWorkflow({ worktree: { enabled: false } });

    await dispatchBackgroundWorkflow(
      makeRoutingCtx({ modelOverrides: { tiers: { large: 'openai/gpt-5.6' } } }),
      workflow
    );
    await flushBackgroundExecution();

    const opts = mockExecuteWorkflow.mock.calls[0]?.[7];
    expect(opts?.modelOverrideLayer).toEqual({
      kind: 'raw',
      overrides: { tiers: { large: 'openai/gpt-5.6' } },
    });
  });

  test('passes validated run config to the executor for a pre-created background run', async () => {
    const workflow = makeWorkflow({ worktree: { enabled: false } });
    const runConfig = {
      source: { kind: 'http' as const, label: 'inline' },
      layer: { docsPath: 'handbook' },
    };

    await dispatchBackgroundWorkflow(makeRoutingCtx({ runConfig }), workflow);
    await flushBackgroundExecution();

    const opts = mockExecuteWorkflow.mock.calls[0]?.[7];
    expect(opts?.runConfig).toEqual(runConfig);
  });

  test('terminalizes a pre-created row when executor setup rejects the run config', async () => {
    const workflow = makeWorkflow({ worktree: { enabled: false } });
    mockExecuteWorkflow.mockRejectedValueOnce(new Error('invalid run config provider'));

    await dispatchBackgroundWorkflow(makeRoutingCtx(), workflow);
    await flushBackgroundExecution();

    expect(mockFailWorkflowRun).toHaveBeenCalledWith('run-1', 'invalid run config provider', {
      exitReason: 'unhandled_error',
    });
  });

  test('default policy still resolves isolation for the worker', async () => {
    const workflow = makeWorkflow();
    mockResolve.mockResolvedValueOnce(
      resolvedIsolation(
        createdMethod(),
        makeEnvRow({ working_path: '/worktrees/bg-1', branch_name: 'bg-1' })
      )
    );

    await dispatchBackgroundWorkflow(makeRoutingCtx(), workflow);

    // Without an explicit opt-out, the worker gets its own per-run task checkout.
    expect(mockResolve).toHaveBeenCalledTimes(1);
    const { hints } = mockResolve.mock.calls[0]?.[0] as { hints: { workflowType: string } };
    expect(hints.workflowType).toBe('task');
    expect(mockCreateWorkflowRun).toHaveBeenCalledTimes(1);
    const runRow = mockCreateWorkflowRun.mock.calls[0]?.[0];
    expect(runRow?.working_path).toBeUndefined();
    expect(mockExecuteWorkflow.mock.calls.at(-1)?.[3]).toBe('/worktrees/bg-1');
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'workflow.worktree_disabled_by_policy'
    );

    await flushBackgroundExecution();
  });

  test('hands the executor the cut-from commit of a branch this dispatch created', async () => {
    mockResolve.mockResolvedValueOnce(
      resolvedIsolation(
        createdMethod({ cutFromCommit: 'c'.repeat(40) }),
        makeEnvRow({ working_path: '/worktrees/bg-1', branch_name: 'bg-1' })
      )
    );

    await dispatchBackgroundWorkflow(makeRoutingCtx(), makeWorkflow());
    await flushBackgroundExecution();

    expect(mockExecuteWorkflow.mock.calls[0]?.[7]?.cutFromCommit).toBe('c'.repeat(40));
    expect(mockExecuteWorkflow.mock.calls[0]?.[7]?.ownedWorktree).toEqual({
      envId: 'env-1',
      creationId: '58e2e55c-b565-4cca-8786-4bc9b86d6fa8',
    });
  });

  test('a reused worktree carries no cut-from commit', async () => {
    mockResolve.mockResolvedValueOnce(
      resolvedIsolation(
        { type: 'workflow_reuse' },
        makeEnvRow({ working_path: '/worktrees/bg-1', branch_name: 'bg-1' })
      )
    );

    await dispatchBackgroundWorkflow(makeRoutingCtx(), makeWorkflow());
    await flushBackgroundExecution();

    expect(mockExecuteWorkflow.mock.calls[0]?.[7]).not.toHaveProperty('cutFromCommit');
    expect(mockExecuteWorkflow.mock.calls[0]?.[7]?.ownedWorktree).toBeUndefined();
  });

  test('surviving-worktree adoption warns and records the background handover once', async () => {
    mockAdoptionMetadata.mockClear();
    mockLogger.warn.mockClear();
    const env = makeEnvRow();
    mockAdoptedEnv.mockResolvedValueOnce(env);
    await dispatchBackgroundWorkflow(
      makeRoutingCtx({
        adoptionLane: { kind: 'reuse-worktree', environment: env },
      }),
      makeWorkflow()
    );
    expect(mockAdoptionMetadata.mock.calls).toEqual([
      [
        env.id,
        {
          adopted: true,
          worktree_registration_id: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
          ),
        },
        env,
      ],
    ]);
    expect(
      mockLogger.warn.mock.calls.filter(([, event]) => event === 'worktree_adopted')
    ).toHaveLength(1);
    expect(mockExecuteWorkflow.mock.calls.at(-1)?.[3]).toBe(env.working_path);
  });

  test.each(['other', null])(
    'background adoption refuses branch %s before capture',
    async branch => {
      const env = makeEnvRow();
      mockAdoptedEnv.mockResolvedValueOnce(env);
      mockGetCurrentBranchStrict.mockResolvedValueOnce(branch);
      mockAdoptionMetadata.mockClear();
      mockPrepareWorkflowSource.mockClear();
      await expect(
        dispatchBackgroundWorkflow(
          makeRoutingCtx({ adoptionLane: { kind: 'reuse-worktree', environment: env } }),
          makeWorkflow()
        )
      ).rejects.toThrow('expected branch');
      expect(mockAdoptionMetadata).not.toHaveBeenCalled();
      expect(mockPrepareWorkflowSource).not.toHaveBeenCalled();
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
      expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
    }
  );

  test('surviving-worktree adoption refuses a missing environment before submission', async () => {
    mockAdoptedEnv.mockResolvedValueOnce(null);
    mockAdoptionMetadata.mockClear();
    await expect(
      dispatchBackgroundWorkflow(
        makeRoutingCtx({
          adoptionLane: {
            kind: 'reuse-worktree',
            environment: makeEnvRow({ id: 'missing', working_path: '/missing' }),
          },
        }),
        makeWorkflow()
      )
    ).rejects.toThrow('Isolation environment missing not found');
    expect(mockAdoptionMetadata).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockUpdateConversation.mock.calls).not.toContainEqual([
      'worker-conv-1',
      expect.objectContaining({ isolation_env_id: expect.any(String) }),
    ]);
  });

  test('background adoption refuses a lane path that differs from its environment before capture', async () => {
    const env = makeEnvRow();
    mockAdoptedEnv.mockResolvedValueOnce(env);
    mockAdoptionMetadata.mockClear();
    mockLogger.warn.mockClear();
    await expect(
      dispatchBackgroundWorkflow(
        makeRoutingCtx({
          adoptionLane: {
            kind: 'reuse-worktree',
            environment: { ...env, working_path: '/foreign/worktree' },
          },
        }),
        makeWorkflow()
      )
    ).rejects.toThrow('does not match');
    expect(mockPrepareWorkflowSource).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockAdoptionMetadata).not.toHaveBeenCalled();
    expect(
      mockLogger.warn.mock.calls.filter(([, event]) => event === 'worktree_adopted')
    ).toHaveLength(0);
  });

  test('background adoption refuses a same-path replacement before capture', async () => {
    const selected = makeEnvRow({ metadata: { worktree_registration_id: 'selected' } });
    mockAdoptedEnv.mockResolvedValueOnce({
      ...selected,
      metadata: { worktree_registration_id: 'replacement' },
    });
    mockAdoptionMetadata.mockClear();
    mockLogger.warn.mockClear();
    await expect(
      dispatchBackgroundWorkflow(
        makeRoutingCtx({
          adoptionLane: {
            kind: 'reuse-worktree',
            environment: selected,
          },
        }),
        makeWorkflow()
      )
    ).rejects.toThrow('changed during adoption');
    expect(mockPrepareWorkflowSource).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockAdoptionMetadata).not.toHaveBeenCalled();
    expect(
      mockLogger.warn.mock.calls.filter(([, event]) => event === 'worktree_adopted')
    ).toHaveLength(0);
  });

  test('background adoption refuses a worktree from another clone of the same codebase', async () => {
    const root = track(
      await realpath(await mkdtemp(join(tmpdir(), 'archon-background-adoption-')))
    );
    const repo = join(root, 'repo');
    const foreignClone = join(root, 'foreign-clone');
    const worktree = join(root, 'foreign-worktree');
    function git(...args: string[]): void {
      execFileSync('git', args, {
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
          GIT_CONFIG_NOSYSTEM: '1',
        },
        stdio: 'pipe',
      });
    }
    git('init', '-q', '-b', 'main', repo);
    git(
      '-C',
      repo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-qm',
      'seed'
    );
    git('clone', '-q', repo, foreignClone);
    git('-C', foreignClone, 'worktree', 'add', '-qb', 'adopted', worktree);
    const codebase = makeCodebase({ default_cwd: repo });
    const env = makeEnvRow({
      codebase_id: codebase.id,
      working_path: worktree,
      branch_name: 'adopted',
      metadata: { adopted: false, worktree_creation_id: 'original-proof' },
    });
    const original = structuredClone(env);
    mockGetCodebase.mockResolvedValueOnce(codebase);
    mockAdoptedEnv.mockResolvedValueOnce(env);
    mockGetCurrentBranchStrict.mockResolvedValueOnce('adopted');
    mockVerifyWorktreeOwnership.mockImplementationOnce(realVerifyWorktreeOwnership);
    mockAdoptionMetadata.mockClear();
    mockLogger.warn.mockClear();
    await expect(
      dispatchBackgroundWorkflow(
        makeRoutingCtx({
          adoptionLane: { kind: 'reuse-worktree', environment: env },
        }),
        makeWorkflow()
      )
    ).rejects.toThrow('belongs to a different clone');
    expect(env).toEqual(original);
    expect(mockAdoptionMetadata).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockUpdateConversation.mock.calls).not.toContainEqual([
      'worker-conv-1',
      expect.objectContaining({ isolation_env_id: expect.any(String) }),
    ]);
    expect(
      mockLogger.warn.mock.calls.filter(([, event]) => event === 'worktree_adopted')
    ).toHaveLength(0);
  });

  test('missing-worktree adoption materializes the exact branch for a background run', async () => {
    mockResolveWorkflowSourceRoot.mockResolvedValue('/canonical/repo');
    const workflow = makeWorkflow();
    mockResolve.mockResolvedValueOnce(
      resolvedIsolation(
        { type: 'provider_adoption' },
        makeEnvRow({
          working_path: '/worktrees/feature-adopted',
          branch_name: 'feature/adopted',
        })
      )
    );

    await dispatchBackgroundWorkflow(
      makeRoutingCtx({
        adoptionLane: {
          kind: 'checkout-branch',
          taskBranch: { kind: 'existing', branch: toBranchName('feature/adopted') },
        },
      }),
      workflow
    );

    const resolveRequest = mockResolve.mock.calls[0]?.[0];
    expect(resolveRequest?.hints).toMatchObject({
      workflowType: 'task',
      taskBranch: { kind: 'existing', branch: 'feature/adopted' },
    });
    const runRow = mockCreateWorkflowRun.mock.calls[0]?.[0];
    expect(runRow?.working_path).toBeUndefined();
    expect(mockExecuteWorkflow.mock.calls.at(-1)?.[3]).toBe('/worktrees/feature-adopted');
    const captureArgs = mockPrepareWorkflowSource.mock.calls.at(-1);
    expect(captureArgs?.[1].sourceRoot).toBe('/adopted/snapshot');
    expect(mockResolveWorkflowSourceRoot).not.toHaveBeenCalledWith('/worktrees/feature-adopted');

    await flushBackgroundExecution();
    expect(mockExecuteWorkflow.mock.calls[0]?.[7]?.ownedWorktree).toBeUndefined();
  });
});
