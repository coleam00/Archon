/**
 * Tests for workflow commands
 */
import {
  testHome,
  mockLogger,
  mockDetachedTargetStop,
  mockDetachedTargetRelease,
  mockReclaimContainerEnv,
  mockRequestDetachedRunStop,
  mockRunLiveOwnerClose,
  mockAssertDetachedRunProcessOwner,
  mockStartRunLiveOwner,
  noOwnerAnswers,
  mockIsRunOwnerAnswering,
  mockFolderBackendPrepare,
  mockResolveFolderBackend,
  mockCanonicalizeProjectPath,
  mockDiscoverWorkflowsWithConfig,
  capturedSourceOwnerCalls,
  CAPTURED_SOURCE_ROOTS,
  mockResolveContinuationWorkflow,
  mockArtifactsRoot,
  mockGetCurrentBranchStrict,
  mockCreateWorkflowRun,
  mockLookupWorkflowRun,
  mockCancelWorkflowRunCommand,
  mockDeleteNodeSessions,
  spyOnJsonStdout,
  firstJsonPayload,
  captureError,
  type DetachedSpawnOptions,
  firstDetachedSpawnOptions,
  createDetachedChildFixture,
  finishStartupWindow,
  createTestWorkflowHost,
  setMockDetachedStopRequested,
} from '../test-support/workflow-command-harness';
import { prepareWorkflowSource } from '@archon/workflows/run-source';
import type * as WorkflowRunSource from '@archon/workflows/run-source';
import type { AdoptionLane } from '@archon/core/operations/workflow-adoption';
import { toBranchName } from '@archon/git';
import { WorkflowResourceBusyError } from '@archon/workflows/store';
import { createRunAiConfigurationSnapshot } from '@archon/workflows/run-ai-configuration';
import { buildAiProfile } from '@archon/workflows/model-validation';
import type { PreparedRunAiConfiguration } from '@archon/workflows/run-preflight';
import { InvalidCodebaseDefaultCwdError } from '@archon/core/utils/codebase-path';
import { providerRegistry } from '@archon/providers';
import { describe, it, expect, beforeEach, afterEach, spyOn, mock, jest } from 'bun:test';
import {
  existsSync,
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { PassThrough } from 'node:stream';
import {
  DETACHED_RESUME_RECEIPT,
  DETACHED_RESUME_RECEIPT_ENV,
  DETACHED_RESUME_RECEIPT_FD,
} from '../utils/detached-resume-receipt';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getArchonHome, isDocker } from '@archon/paths';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import type { WorkflowRun, WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import {
  makeTestComposedWorkflow,
  makeTestResolvedWorkflow,
  makeTestWorkflow,
  makeTestWorkflowWithSource,
} from '@archon/workflows/test-utils';
import {
  workflowRunCommand,
  workflowResumeCommand,
  workflowAbandonCommand,
  workflowCancelCommand,
  workflowApproveCommand,
  workflowRejectCommand,
  workflowRespondCommand,
  workflowCleanupCommand,
  workflowResetSessionsCommand,
  buildDetachedRunCmd,
  resolveDetachedRunEncryptionEnv,
  maybePrintTierNotice,
  resolveContainerBackendConfig,
  pendingDurableWait,
  hasUnresolvedWriteback,
} from './workflow';
import { DETACHED_RUN_FAILED_EXIT_CODE } from '../utils/workflow-exit-code';

describe('workflowRunCommand — dry-run', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    stdoutSpy = spyOnJsonStdout();
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const dryRun = await import('@archon/workflows/dry-run');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
    (dryRun.loadDryRunStubs as ReturnType<typeof mock>).mockClear();
    (dryRun.writeDryRunStubScaffold as ReturnType<typeof mock>).mockClear();
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockClear();
    (dryRun.formatDryRunTrace as ReturnType<typeof mock>).mockClear();
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockResolvedValue({
      workflow: 'plan',
      outcome: 'completed',
      authoredOutcome: null,
      trace: [],
      missingStubs: [],
      toleratedMissingStubs: [],
      unusedStubs: [],
      summary: 'done',
    });
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      errors: [],
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('runs the simulator before real-run setup and writes one JSON document', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const dryRun = await import('@archon/workflows/dry-run');

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
      dryRun: true,
      stubsPath: 'fixtures.yaml',
      defaultStubs: true,
      execCode: true,
      pauseAtGates: true,
      json: true,
    });

    expect(dryRun.loadDryRunStubs).toHaveBeenCalledWith(join('/test/path', 'fixtures.yaml'));
    expect(dryRun.dryRunWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: 'hello',
        cwd: '/test/path',
        defaultStubs: true,
        execCode: true,
        pauseAtGates: true,
      })
    );
    expect(executeWorkflow).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      workflow: 'plan',
      outcome: 'completed',
    });
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('emits authored outcome in JSON without using it as the exit verdict', async () => {
    const dryRun = await import('@archon/workflows/dry-run');
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflow: 'plan',
      outcome: 'completed',
      authoredOutcome: 'failed',
      trace: [],
      missingStubs: [],
      toleratedMissingStubs: [],
      unusedStubs: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', {
        dryRun: true,
        json: true,
      })
    ).resolves.toBeUndefined();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      outcome: 'completed',
      authoredOutcome: 'failed',
    });
  });

  it('layers acting-user preferences before resolving dry-run model bindings', async () => {
    const previousUserId = process.env.ARCHON_USER_ID;
    process.env.ARCHON_USER_ID = 'dry-run-user';
    try {
      const core = await import('@archon/core');
      const dryRun = await import('@archon/workflows/dry-run');
      (core.loadConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        assistant: 'claude',
        tiers: {},
        aliases: {},
      });
      (core.getUserAiPrefs as ReturnType<typeof mock>).mockResolvedValueOnce({
        defaultProvider: 'codex',
        aliases: {
          '@personal': { provider: 'claude', model: 'opus' },
          '@planner': { provider: 'pi', model: 'openai/gpt-5.6' },
        },
      });

      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
        dryRun: true,
        modelAssignments: ['large=@personal', '@planner=openai/next-model'],
      });

      const options = (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
        aiProfile: {
          defaultProvider: string;
          aliases: Record<string, { provider: string; model: string }>;
        };
      };
      expect(options.aiProfile.defaultProvider).toBe('codex');
      expect(options.aiProfile.aliases.large).toEqual({ provider: 'claude', model: 'opus' });
      expect(options.aiProfile.aliases['@planner']).toEqual({
        provider: 'pi',
        model: 'openai/next-model',
      });
    } finally {
      if (previousUserId === undefined) Reflect.deleteProperty(process.env, 'ARCHON_USER_ID');
      else process.env.ARCHON_USER_ID = previousUserId;
    }
  });

  it('applies the config file and then replaces only the explicit model binding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'archon-cli-dry-run-config-'));
    const configPath = join(dir, 'config.minimax.yaml');
    appendFileSync(
      configPath,
      'tiers:\n  large: { provider: pi, model: minimax/MiniMax-M3 }\nenv:\n  BENCH_MODE: "1"\n'
    );
    try {
      const core = await import('@archon/core');
      const dryRun = await import('@archon/workflows/dry-run');
      (core.loadConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        assistant: 'claude',
        assistants: { claude: {}, pi: {} },
        tiers: {
          small: { provider: 'claude', model: 'haiku' },
          medium: { provider: 'claude', model: 'sonnet' },
          large: { provider: 'claude', model: 'opus' },
        },
        aliases: {},
        envVars: { LOWER: 'kept' },
        commands: {},
      });

      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
        dryRun: true,
        configPath,
        modelAssignments: ['large=openai/gpt-5.6'],
      });

      const options = (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
        config: { envVars?: Record<string, string> };
        aiProfile: {
          aliases: Record<string, { provider: string; model: string }>;
        };
      };
      expect(options.config.envVars).toEqual({ LOWER: 'kept', BENCH_MODE: '1' });
      expect(options.aiProfile.aliases.large).toEqual({
        provider: 'pi',
        model: 'openai/gpt-5.6',
      });
      expect(options.aiProfile.aliases.small).toEqual({
        provider: 'claude',
        model: 'haiku',
      });
      expect(options.aiProfile.aliases.medium).toEqual({
        provider: 'claude',
        model: 'sonnet',
      });
    } finally {
      await removeTempTree(dir);
    }
  });

  it('writes a scaffold from the discovered workflow and exits before simulation', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const dryRun = await import('@archon/workflows/dry-run');

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', {
      dryRun: true,
      stubsInitPath: 'fixtures/generated.yaml',
      json: true,
    });

    expect(dryRun.writeDryRunStubScaffold).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'plan' }),
      join('/test/path', 'fixtures/generated.yaml')
    );
    expect(dryRun.loadDryRunStubs).not.toHaveBeenCalled();
    expect(dryRun.dryRunWorkflow).not.toHaveBeenCalled();
    expect(executeWorkflow).not.toHaveBeenCalled();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toEqual({
      workflow: 'plan',
      stubsPath: join('/test/path', 'fixtures/generated.yaml'),
      nodeCount: 2,
    });
  });

  it('writes the human trace through guaranteed stdout delivery', async () => {
    const dryRun = await import('@archon/workflows/dry-run');

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', { dryRun: true });

    expect(dryRun.formatDryRunTrace).toHaveBeenCalled();
    expect(firstJsonPayload(stdoutSpy)).toBe('DRY RUN TRACE');
  });

  it('fails the dry run when the config is unreadable instead of reporting against defaults', async () => {
    // `loadConfig` returns defaults when there is no config file, so a throw means a
    // MALFORMED one. Swallowing it would print a clean-looking trace claiming every node
    // resolves to the default assistant — a plausible report of a run that cannot happen.
    const dryRun = await import('@archon/workflows/dry-run');
    const core = await import('@archon/core');
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockClear();
    (core.loadConfig as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('bad yaml at .archon/config.yaml:7')
    );

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'go', { dryRun: true })
    ).rejects.toThrow(/bad yaml/);

    expect(dryRun.dryRunWorkflow).not.toHaveBeenCalled();
  });

  it('rejects dry-run-only and incompatible lifecycle flags', async () => {
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', {
        stubsPath: 'fixtures.yaml',
      })
    ).rejects.toThrow('--stubs requires --dry-run');

    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      errors: [],
    });
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', {
        stubsInitPath: 'fixtures.yaml',
      })
    ).rejects.toThrow('--stubs-init requires --dry-run');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      errors: [],
    });
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', { defaultStubs: true })
    ).rejects.toThrow('--default-stubs requires --dry-run');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      errors: [],
    });
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', {
        dryRun: true,
        detach: true,
      })
    ).rejects.toThrow('--dry-run cannot be combined with --detach');
  });

  it('rejects scaffold mode combined with simulation stub options', async () => {
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', {
        dryRun: true,
        stubsInitPath: 'generated.yaml',
        stubsPath: 'overrides.yaml',
      })
    ).rejects.toThrow('--stubs-init cannot be combined with --stubs');

    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      errors: [],
    });
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', {
        dryRun: true,
        stubsInitPath: 'generated.yaml',
        defaultStubs: true,
      })
    ).rejects.toThrow('--stubs-init cannot be combined with --default-stubs');
  });

  it('emits failure JSON before returning a nonzero-worthy error', async () => {
    const dryRun = await import('@archon/workflows/dry-run');
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflow: 'plan',
      outcome: 'failed',
      authoredOutcome: 'succeeded',
      trace: [],
      missingStubs: ['node'],
      toleratedMissingStubs: [],
      unusedStubs: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', {
        dryRun: true,
        json: true,
      })
    ).rejects.toThrow('missing stubs: node');
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      outcome: 'failed',
      authoredOutcome: 'succeeded',
    });
  });

  it('names only blocking missing stubs, never one an all_done join tolerated', async () => {
    const dryRun = await import('@archon/workflows/dry-run');
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflow: 'plan',
      outcome: 'failed',
      trace: [],
      missingStubs: ['join', 'node'],
      toleratedMissingStubs: ['join'],
      unusedStubs: [],
    });

    // The join never blocked anything, so pointing the reader at it alongside the
    // real cause sends them to the wrong node (#2869). One call, one mocked result:
    // asserting the absence in a second call would read the default mock instead.
    const error = await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', {
      dryRun: true,
      json: true,
    }).then(
      () => undefined,
      (thrown: unknown) => thrown as Error
    );
    expect(error?.message).toBe('Dry-run failed; missing stubs: node');
  });

  it('falls back to the generic message when every missing stub was tolerated', async () => {
    const dryRun = await import('@archon/workflows/dry-run');
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflow: 'plan',
      outcome: 'failed',
      trace: [],
      missingStubs: ['join'],
      toleratedMissingStubs: ['join'],
      unusedStubs: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', {
        dryRun: true,
        json: true,
      })
    ).rejects.toThrow('See the trace for details');
  });
});

describe('workflowRunCommand — requires: [github] gate', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let priorArchonUserId: string | undefined;

  beforeEach(async () => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    // Deterministic CLI identity (resolveCliUserId reads ARCHON_USER_ID).
    priorArchonUserId = process.env.ARCHON_USER_ID;
    process.env.ARCHON_USER_ID = 'cli-tester';

    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { isPerUserGitHubEnabled, getDecryptedAccessToken } = await import('@archon/core');
    const usersDb = await import('@archon/core/db/users');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockClear();
    (getDecryptedAccessToken as ReturnType<typeof mock>).mockClear();
    (usersDb.findOrCreateUserByPlatformIdentity as ReturnType<typeof mock>).mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    if (priorArchonUserId === undefined) delete process.env.ARCHON_USER_ID;
    else process.env.ARCHON_USER_ID = priorArchonUserId;
  });

  it('blocks a requires:[github] workflow before any cost when enabled and not connected', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { isPerUserGitHubEnabled, getDecryptedAccessToken } = await import('@archon/core');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'ship', requires: ['github'] }, 'project')],
      errors: [],
    });
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockReturnValueOnce(true);
    (getDecryptedAccessToken as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'ship', 'go', { noWorktree: true })
    ).rejects.toThrow(/connected github identity/i);

    // Hard-blocked before any worktree/AI cost — executeWorkflow never ran.
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('blocks a parent whose requirement came only from a COMPOSED block', async () => {
    // The parent declares no `requires:` of its own — the requirement unions upward from
    // the block during expansion (#1764). Without that union this refusal never happens
    // and the run fails mid-block instead, inside a file the parent cannot inspect.
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { isPerUserGitHubEnabled, getDecryptedAccessToken } = await import('@archon/core');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const composed = makeTestComposedWorkflow(
      [
        makeTestWorkflow({
          name: 'gh-block',
          requires: ['github'],
          nodes: [{ id: 'work', prompt: 'work' }],
        }),
        makeTestWorkflow({ name: 'composes-gh', nodes: [{ id: 'sub', include: 'gh-block' }] }),
      ],
      'composes-gh'
    );
    // The union is what the gate reads — assert it before relying on it.
    expect(composed.requires).toEqual(['github']);

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [{ workflow: composed, source: 'project' }],
      errors: [],
    });
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockReturnValueOnce(true);
    (getDecryptedAccessToken as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'composes-gh', 'go', {
        noWorktree: true,
      })
    ).rejects.toThrow(/connected github identity/i);
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('allows the run when the acting CLI user has a connected GitHub identity', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { isPerUserGitHubEnabled, getDecryptedAccessToken } = await import('@archon/core');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'ship', requires: ['github'] }, 'project')],
      errors: [],
    });
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockReturnValueOnce(true);
    (getDecryptedAccessToken as ReturnType<typeof mock>).mockResolvedValueOnce('gho_token');
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-ok',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'ship', 'go', {
      noWorktree: true,
    });

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on solo installs (per-user GitHub disabled) even when github is required', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { isPerUserGitHubEnabled, getDecryptedAccessToken } = await import('@archon/core');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'ship', requires: ['github'] }, 'project')],
      errors: [],
    });
    // Default mock returns false; be explicit for readability.
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockReturnValueOnce(false);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-ok',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'ship', 'go', {
      noWorktree: true,
    });

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    // Gate short-circuited on the env check — no token lookup happened.
    expect(getDecryptedAccessToken).not.toHaveBeenCalled();
  });

  it('does not resolve GitHub connection for a workflow without requires', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { isPerUserGitHubEnabled, getDecryptedAccessToken } = await import('@archon/core');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' }, 'project')],
      errors: [],
    });
    // Even with per-user GitHub enabled, a workflow with no `requires` skips the lookup.
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockReturnValueOnce(true);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-ok',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'go', {
      noWorktree: true,
    });

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    expect(getDecryptedAccessToken).not.toHaveBeenCalled();
  });

  it('fails closed when the acting CLI user identity cannot be resolved', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { isPerUserGitHubEnabled, getDecryptedAccessToken } = await import('@archon/core');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'ship', requires: ['github'] }, 'project')],
      errors: [],
    });
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockReturnValueOnce(true);

    // No resolvable CLI identity → resolveCliUserId() returns null → treated as
    // "not connected" (fail closed). Clear every identity source for this test.
    const savedUser = process.env.USER;
    const savedUsername = process.env.USERNAME;
    delete process.env.ARCHON_USER_ID;
    delete process.env.USER;
    delete process.env.USERNAME;
    try {
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'ship', 'go', {
          noWorktree: true,
        })
      ).rejects.toThrow(/connected github identity/i);
    } finally {
      if (savedUser !== undefined) process.env.USER = savedUser;
      if (savedUsername !== undefined) process.env.USERNAME = savedUsername;
    }

    // Never resolved a token, and never reached execution.
    expect(getDecryptedAccessToken).not.toHaveBeenCalled();
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('fails closed when the identity/token lookup throws', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { isPerUserGitHubEnabled } = await import('@archon/core');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const usersDb = await import('@archon/core/db/users');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'ship', requires: ['github'] }, 'project')],
      errors: [],
    });
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockReturnValueOnce(true);
    (usersDb.findOrCreateUserByPlatformIdentity as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('db unavailable')
    );

    // Lookup failure is swallowed inside the gate and defaults to "not connected".
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'ship', 'go', { noWorktree: true })
    ).rejects.toThrow(/connected github identity/i);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });
});

describe('workflowRunCommand — --input declared inputs (#2554)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  /** Stub discovery with one workflow declaring a required + a defaulted input. */
  async function stubInputWorkflow(): Promise<void> {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource(
          {
            name: 'review-block',
            inputs: { diff: { required: true }, style: { default: 'strict' } },
          },
          'project'
        ),
      ],
      errors: [],
    });
  }

  it('runs a required-input workflow when --input supplies the value', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    await stubInputWorkflow();
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-ok',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
      noWorktree: true,
      inputs: ['diff=D1'],
    });

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    // Only the supplied value is threaded through; `style` stays a derived default.
    const opts = (executeWorkflow as ReturnType<typeof mock>).mock.calls[0][7] as {
      inputs?: Record<string, string>;
    };
    expect(opts.inputs).toEqual({ diff: 'D1' });
  });

  it('still refuses a required-input workflow when nothing is supplied, before any cost', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    await stubInputWorkflow();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
        noWorktree: true,
      })
    ).rejects.toThrow(/requires input 'diff'/);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('rejects an undeclared --input name before any cost', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    await stubInputWorkflow();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
        noWorktree: true,
        inputs: ['diff=D1', 'stlye=terse'],
      })
    ).rejects.toThrow(/does not declare input 'stlye'/);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('rejects a malformed --input assignment before any cost', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    await stubInputWorkflow();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
        noWorktree: true,
        inputs: ['diff'],
      })
    ).rejects.toThrow(/expected 'name=value'/);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('passes gate-resolved inputs to dryRunWorkflow (#2610)', async () => {
    // Only the SUPPLIED entries travel: the simulator derives declared defaults
    // itself, mirroring the executor's `defaultRunInputs` merge at run start.
    const dryRun = await import('@archon/workflows/dry-run');
    await stubInputWorkflow();
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockClear();

    await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
      dryRun: true,
      inputs: ['diff=D1'],
    });

    expect(dryRun.dryRunWorkflow).toHaveBeenCalledTimes(1);
    const opts = (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mock.calls[0][0] as {
      inputs?: Record<string, string>;
    };
    expect(opts.inputs).toEqual({ diff: 'D1' });
  });

  it('fails a dry run of a required-input workflow at the gate, like a real run', async () => {
    const dryRun = await import('@archon/workflows/dry-run');
    await stubInputWorkflow();
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockClear();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
        dryRun: true,
      })
    ).rejects.toThrow(/requires input 'diff'/);

    expect(dryRun.dryRunWorkflow).not.toHaveBeenCalled();
  });

  it('reports the incompatible flag, not an input error, for --dry-run --resume --input', async () => {
    // The incompatible-flags check must stay ahead of the input gate: with --input no
    // longer in that list, only ordering keeps the triple reporting the flag conflict.
    const dryRun = await import('@archon/workflows/dry-run');
    await stubInputWorkflow();
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockClear();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
        dryRun: true,
        resume: true,
        inputs: ['diff=D1'],
      })
    ).rejects.toThrow(/--dry-run cannot be combined with --resume/);

    expect(dryRun.dryRunWorkflow).not.toHaveBeenCalled();
  });

  it('rejects an undeclared --input name on a dry run at the gate', async () => {
    const dryRun = await import('@archon/workflows/dry-run');
    await stubInputWorkflow();
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockClear();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
        dryRun: true,
        inputs: ['diff=D1', 'stlye=terse'],
      })
    ).rejects.toThrow(/does not declare input 'stlye'/);

    expect(dryRun.dryRunWorkflow).not.toHaveBeenCalled();
  });

  it('does not re-gate a --resume of a required-input workflow', async () => {
    // The gate is deliberately skipped on resume: the run row already carries inputs
    // validated at creation, and a resume supplies nothing. A refactor that hoists
    // `resolveTopLevelInputs` out of the `if (!options.resume)` guard would make every
    // CLI resume of a required-input workflow throw instead — this is what catches it.
    // (The `--input` + `--resume` test below cannot: it fails on the mutual-exclusion
    // check before ever reaching the gate.)
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { hydrateResumableRun } = await import('@archon/workflows/run-resume');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    await stubInputWorkflow();

    (hydrateResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      preCreatedRun: { id: 'run-prior', workflow_name: 'review-block' },
      priorCompletedNodes: new Map([['node-a', 'done']]),
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-resume',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-resume',
      default_cwd: '/repo/root',
      default_branch: 'develop',
    });
    // working_path null keeps the resume on the caller cwd, skipping the existsSync probe.
    (workflowDb.findResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-prior',
      working_path: null,
      workflow_name: 'review-block',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-prior',
    });

    // No --input, and the workflow declares a required one: this must NOT throw.
    await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
      resume: true,
    });

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    // The resume branch carries the row's own inputs; it never re-stamps from a flag.
    const opts = (executeWorkflow as ReturnType<typeof mock>).mock.calls[0][7] as {
      inputs?: Record<string, string>;
    };
    expect(opts.inputs).toBeUndefined();
  });

  it('rejects --input combined with --resume rather than silently ignoring it', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    // Flag validation runs after name resolution (as every other flag check does),
    // so discovery still has to resolve for the conflict to be reached.
    await stubInputWorkflow();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
        resume: true,
        inputs: ['diff=D1'],
      })
    ).rejects.toThrow(/--resume and --input are mutually exclusive/);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });
});

describe('workflowRunCommand — resume with nothing completed (#3154)', () => {
  let tempRoot: string;
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'archon-cli-resume-empty-'));
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { hydrateResumableRun } = await import('@archon/workflows/run-resume');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
    (hydrateResumableRun as ReturnType<typeof mock>).mockClear();
  });

  afterEach(async () => {
    consoleSpy.mockRestore();
    await removeTempTree(tempRoot);
  });

  /**
   * Stub discovery and a dead prior run. `status` drives the run's terminality
   * and `isolationEnvs` seeds the isolation records the resume path matches —
   * empty for an in-place prior run, the surviving worktree record by default.
   */
  async function stubFailedPriorRun(
    status: 'failed' | 'running' | 'paused' = 'failed',
    isolationEnvs: Array<Record<string, unknown>> = [
      {
        id: 'env-1',
        codebase_id: 'cb-resume',
        working_path: tempRoot,
        branch_name: 'fix/issue-3124',
      },
    ]
  ): Promise<void> {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'archon-ship' }, 'project')],
      errors: [],
    });
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    const isolationDb = await import('@archon/core/db/isolation-environments');
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-resume',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-resume',
      default_cwd: '/repo/root',
      default_branch: 'main',
    });
    (workflowDb.findResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-dead',
      working_path: tempRoot,
      workflow_name: 'archon-ship',
      status,
    });
    (isolationDb.listByCodebase as ReturnType<typeof mock>).mockResolvedValueOnce(isolationEnvs);
  }

  it('refuses and names the same-branch relaunch with --supersedes', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { hydrateResumableRun } = await import('@archon/workflows/run-resume');
    await stubFailedPriorRun();
    mockStartRunLiveOwner.mockClear();
    mockRunLiveOwnerClose.mockClear();
    (hydrateResumableRun as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      expect(mockStartRunLiveOwner).toHaveBeenCalledWith('run-dead', {});
      return null;
    });

    const write = spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const close = spyOn(fs, 'closeSync').mockImplementation(() => {});
    process.env[DETACHED_RESUME_RECEIPT_ENV] = '1';
    try {
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'archon-ship', 'go', {
          resume: true,
        })
      ).rejects.toThrow(
        /no completed nodes and no interactive-loop state[\s\S]*archon workflow run archon-ship --branch fix\/issue-3124 --supersedes run-dead/
      );

      expect(write).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(process.env, DETACHED_RESUME_RECEIPT_ENV);
      write.mockRestore();
      close.mockRestore();
    }

    // The refusal is still a refusal: no run is started.
    expect(executeWorkflow).not.toHaveBeenCalled();
    expect(mockRunLiveOwnerClose).toHaveBeenCalledTimes(1);
  });

  it('suggests a fresh in-place relaunch when no isolation record matched', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { hydrateResumableRun } = await import('@archon/workflows/run-resume');
    await stubFailedPriorRun('failed', []);
    (hydrateResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    // An in-place relaunch cannot carry --branch: the prior run's branch is the
    // main checkout's own, so suggesting it would hand the operator a command
    // this same CLI refuses.
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'archon-ship', 'go', {
        resume: true,
      })
    ).rejects.toThrow(
      /^Cannot resume: the prior run for 'archon-ship' has no completed nodes and no interactive-loop state\.\nNothing can be skipped, so start a fresh run instead:\n  archon workflow run archon-ship --supersedes run-dead$/
    );
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('reports a resume refused for capacity as a busy resource, not lost state', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { hydrateResumableRun } = await import('@archon/workflows/run-resume');
    await stubFailedPriorRun('paused');
    (hydrateResumableRun as ReturnType<typeof mock>).mockRejectedValueOnce(
      new WorkflowResourceBusyError('run-dead', { kind: 'run', id: 'holder-1' }, 'paused')
    );

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'archon-ship', 'go', {
        resume: true,
      })
    ).rejects.toThrow(
      /^Cannot resume workflow 'archon-ship' now: Workflow run 'run-dead' cannot resume while resource owner 'holder-1' has priority\. It stays paused;/
    );
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('names the abandon step for a stale-running orphan before the relaunch', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { hydrateResumableRun } = await import('@archon/workflows/run-resume');
    await stubFailedPriorRun('running');
    (hydrateResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    // --supersedes refuses a still-running run, so the message must first release it.
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'archon-ship', 'go', {
        resume: true,
      })
    ).rejects.toThrow(
      /no completed nodes and no interactive-loop state[\s\S]*archon workflow abandon run-dead[\s\S]*archon workflow run archon-ship --branch fix\/issue-3124 --supersedes run-dead/
    );
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  for (const brokenPipe of [false, true]) {
    it(`notifies accepted resume before settlement (broken pipe: ${String(brokenPipe)})`, async () => {
      const { executeWorkflow } = await import('@archon/workflows/executor');
      const { hydrateResumableRun } = await import('@archon/workflows/run-resume');
      await stubFailedPriorRun();
      (hydrateResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        preCreatedRun: { id: 'run-dead', workflow_name: 'archon-ship' },
        priorCompletedNodes: new Map([['triage', 'done']]),
      });
      let settleExecution!: (result: { success: boolean; workflowRunId: string }) => void;
      const execution = new Promise<{ success: boolean; workflowRunId: string }>(resolve => {
        settleExecution = resolve;
      });
      (executeWorkflow as ReturnType<typeof mock>).mockReturnValueOnce(execution);
      const write = spyOn(fs, 'writeFileSync').mockImplementation(() => {
        if (brokenPipe) throw Object.assign(new Error('closed launcher'), { code: 'EPIPE' });
      });
      const close = spyOn(fs, 'closeSync').mockImplementation(() => {});
      process.env[DETACHED_RESUME_RECEIPT_ENV] = '1';
      try {
        let finished = false;
        const command = workflowRunCommand(
          createTestWorkflowHost(),
          '/repo/root',
          'archon-ship',
          'go',
          { resume: true }
        );
        void command.then(() => {
          finished = true;
        });
        for (let attempt = 0; attempt < 100 && write.mock.calls.length === 0; attempt++) {
          await Promise.resolve();
        }
        expect(write).toHaveBeenCalledWith(DETACHED_RESUME_RECEIPT_FD, DETACHED_RESUME_RECEIPT);
        expect(finished).toBe(false);
        expect(process.env[DETACHED_RESUME_RECEIPT_ENV]).toBeUndefined();
        settleExecution({ success: true, workflowRunId: 'run-dead' });
        await command;
        expect(finished).toBe(true);
        expect(write).toHaveBeenCalledTimes(1);
      } finally {
        settleExecution({ success: true, workflowRunId: 'run-dead' });
        Reflect.deleteProperty(process.env, DETACHED_RESUME_RECEIPT_ENV);
        write.mockRestore();
        close.mockRestore();
      }
    });
  }

  it('still resumes when the prior run has completed nodes', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { hydrateResumableRun } = await import('@archon/workflows/run-resume');
    await stubFailedPriorRun();
    (hydrateResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      preCreatedRun: { id: 'run-dead', workflow_name: 'archon-ship' },
      priorCompletedNodes: new Map([['triage', 'done']]),
    });
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-dead',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'archon-ship', 'go', {
      resume: true,
    });

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
  });
});

describe('workflowRunCommand — sparse model bindings (#2481)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  async function stubWorkflow(): Promise<void> {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'bench' }, 'project')],
      errors: [],
    });
  }

  it('passes one sparse tier and alias map to the executor', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    await stubWorkflow();
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-models',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'bench', 'go', {
      noWorktree: true,
      modelAssignments: ['large=openai/gpt-5.6', '@planner=codex/gpt-5.6-sol'],
    });

    const opts = (executeWorkflow as ReturnType<typeof mock>).mock.calls[0][7] as {
      modelOverrideLayer?: unknown;
    };
    expect(opts.modelOverrideLayer).toEqual({
      kind: 'raw',
      overrides: {
        tiers: { large: 'openai/gpt-5.6' },
        aliases: { '@planner': 'codex/gpt-5.6-sol' },
      },
    });
  });

  it('rejects bare and duplicate mappings before execution', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const prepareCallsBefore = (prepareWorkflowSource as ReturnType<typeof mock>).mock.calls.length;
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'bench', 'go', {
        noWorktree: true,
        modelAssignments: ['openai/gpt-5.6'],
      })
    ).rejects.toThrow(/Expected/);
    expect(executeWorkflow).not.toHaveBeenCalled();
    expect((prepareWorkflowSource as ReturnType<typeof mock>).mock.calls).toHaveLength(
      prepareCallsBefore
    );

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'bench', 'go', {
        noWorktree: true,
        modelAssignments: ['large=   '],
      })
    ).rejects.toThrow(/Expected/);
    expect((prepareWorkflowSource as ReturnType<typeof mock>).mock.calls).toHaveLength(
      prepareCallsBefore
    );

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'bench', 'go', {
        noWorktree: true,
        modelAssignments: ['large=x', 'large=y'],
      })
    ).rejects.toThrow(/Duplicate/);
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('refuses new model bindings on resume', async () => {
    await stubWorkflow();
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'bench', 'go', {
        resume: true,
        modelAssignments: ['large=openai/gpt-5.6'],
      })
    ).rejects.toThrow(/--resume and --model/);
  });
});

describe('workflowRunCommand — sparse config file (#2482)', () => {
  let tempRoot: string;
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'archon-cli-run-config-'));
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
  });

  afterEach(async () => {
    consoleSpy.mockRestore();
    await removeTempTree(tempRoot);
  });

  async function stubWorkflow(): Promise<void> {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'bench' }, 'project')],
      errors: [],
    });
  }

  it('passes validated file content beside explicit model mappings', async () => {
    const path = join(tempRoot, 'config.minimax.yaml');
    appendFileSync(
      path,
      'tiers:\n  large: { provider: pi, model: minimax/MiniMax-M3 }\nenv:\n  BENCH: "yes"\n'
    );
    await stubWorkflow();
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-config',
    });

    await workflowRunCommand(createTestWorkflowHost(), tempRoot, 'bench', 'go', {
      noWorktree: true,
      configPath: './config.minimax.yaml',
      modelAssignments: ['large=openai/gpt-5.6'],
    });

    const opts = (executeWorkflow as ReturnType<typeof mock>).mock.calls[0][7] as {
      runConfig?: unknown;
      modelOverrideLayer?: unknown;
    };
    expect(opts.runConfig).toEqual({
      source: { kind: 'cli', label: 'config.minimax.yaml' },
      layer: {
        tiers: { large: { provider: 'pi', model: 'minimax/MiniMax-M3' } },
        envVars: { BENCH: 'yes' },
      },
    });
    expect(opts.modelOverrideLayer).toEqual({
      kind: 'raw',
      overrides: { tiers: { large: 'openai/gpt-5.6' } },
    });
  });

  it('rejects an ineffective key before source capture or execution', async () => {
    const path = join(tempRoot, 'bad.yaml');
    appendFileSync(path, 'commands:\n  folder: custom\n');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const prepareCallsBefore = (prepareWorkflowSource as ReturnType<typeof mock>).mock.calls.length;

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'bench', 'go', {
        configPath: path,
      })
    ).rejects.toThrow("Run config key 'commands' cannot apply");
    expect((prepareWorkflowSource as ReturnType<typeof mock>).mock.calls).toHaveLength(
      prepareCallsBefore
    );
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('refuses config on resume without trying to read the path', async () => {
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'bench', 'go', {
        resume: true,
        configPath: join(tempRoot, 'does-not-exist.yaml'),
      })
    ).rejects.toThrow(/--resume and --config/);
  });
});

describe('workflowRunCommand — continuation and capture ownership (#2646)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    capturedSourceOwnerCalls.length = 0;
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
    mockResolveContinuationWorkflow.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('executes the graph the run froze on `run <name> --resume`, not the one in the checkout', async () => {
    // The name form names its run indirectly, so it used to reach the resumable row only
    // after the graph was already chosen from live discovery — while the executor still
    // fed that graph the frozen commands and scripts. Two vintages in one run, on the one
    // resume form that never carried a run object.
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { hydrateResumableRun } = await import('@archon/workflows/run-resume');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    const frozen = makeTestResolvedWorkflow({ name: 'review-block', description: 'frozen' });
    // What the checkout holds NOW: same name, edited since the run paused. Set as the
    // standing answer rather than a queued one — a continuation must never consume it, and
    // a queued value nothing consumes leaks into the next test.
    const discoverMock = discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverMock.mockClear();
    discoverMock.mockResolvedValue({
      workflows: [makeTestWorkflowWithSource({ name: 'review-block', description: 'edited' })],
      errors: [],
    });
    const frozenContinuation = {
      workflow: frozen,
      roots: CAPTURED_SOURCE_ROOTS,
      workflows: [{ workflow: frozen, source: 'project' as const }],
      errors: [],
    };
    mockResolveContinuationWorkflow
      .mockResolvedValueOnce(frozenContinuation)
      .mockResolvedValueOnce(frozenContinuation);
    (workflowDb.findResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-prior',
      working_path: null,
      workflow_name: 'review-block',
    });
    (hydrateResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      preCreatedRun: { id: 'run-prior', workflow_name: 'review-block' },
      priorCompletedNodes: new Map([['node-a', 'done']]),
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-resume',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-resume',
      default_cwd: '/repo/root',
      default_branch: 'develop',
    });
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-prior',
    });

    try {
      await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
        resume: true,
      });
    } finally {
      discoverMock.mockResolvedValue({ workflows: [], errors: [] });
    }

    // Live discovery never even runs: the continuation carries the discovery it paid for.
    expect(discoverMock).not.toHaveBeenCalled();
    // Host preparation and engine admission both resolve this run's recorded source.
    expect(mockResolveContinuationWorkflow).toHaveBeenCalledTimes(2);
    const continuedRun = mockResolveContinuationWorkflow.mock.calls[0]?.[1] as unknown as {
      id: string;
    };
    expect(continuedRun.id).toBe('run-prior');
    // ...and its answer, not the edited checkout, is what runs.
    const executed = (executeWorkflow as ReturnType<typeof mock>).mock.calls[0][4] as {
      description?: string;
    };
    expect(executed.description).toBe('frozen');
    // A continuation captures nothing: there is nothing new to freeze.
    expect(capturedSourceOwnerCalls).toEqual([]);
  });

  it('hands the capture to the run that starts, and keeps holding it when none does', async () => {
    // The wrapper only protects anything if the run path actually calls its owner. Assert
    // both edges: a dropped `adopt()` deletes a live run's source, and a missing `hold()`
    // strands a full frozen tree under staged-source on every refusal. Under #2690 the
    // run path passes `capturedSourceOwner` through and the (mocked) executor adopts;
    // the implementation override below mirrors that.
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
      errors: [],
    });
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce((...args: unknown[]) => {
      const opts = args[7] as
        | {
            preparedSource?: unknown;
            capturedSourceOwner?: { adopt: () => void };
          }
        | undefined;
      if (opts?.preparedSource) opts.capturedSourceOwner?.adopt();
      return Promise.resolve({ success: true, workflowRunId: 'run-ok' });
    });

    await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'go', {
      noWorktree: true,
    });
    expect(capturedSourceOwnerCalls).toEqual(['hold:/test/capture', 'adopt']);

    capturedSourceOwnerCalls.length = 0;
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [],
      errors: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'go', {
        noWorktree: true,
      })
    ).rejects.toThrow('No workflows found');
    expect(capturedSourceOwnerCalls).toEqual(['hold:/test/capture', 'reclaim:/test/capture']);
  });

  it('reclaims the finalized container capture when backend preparation fails', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { finalizeWorkflowSource } = await import('@archon/workflows/run-source');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-folder',
      name: 'platform',
      default_cwd: '/test/path',
      default_branch: null,
      kind: 'folder',
    });
    (finalizeWorkflowSource as ReturnType<typeof mock>).mockResolvedValueOnce({
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
      },
      anchor: {
        root: '/test/finalized/workflow-source',
        digest: 'test-digest',
        config: {
          load_default_workflows: true,
          load_default_commands: true,
        },
      },
      roots: {
        project: '/test/finalized/workflow-source/project',
        globalWorkflows: '/test/finalized/workflow-source/global/workflows',
        globalCommands: '/test/finalized/workflow-source/global/commands',
        globalScripts: '/test/finalized/workflow-source/global/scripts',
        bundledWorkflows: '/test/finalized/workflow-source/bundled/workflows',
        bundledCommands: '/test/finalized/workflow-source/bundled/commands/defaults',
        kind: 'captured',
        anchor: {
          root: '/test/finalized/workflow-source',
          digest: 'test-digest',
          config: {
            load_default_workflows: true,
            load_default_commands: true,
          },
        },
      },
    });
    mockFolderBackendPrepare.mockRejectedValueOnce(new Error('container unavailable'));

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'go', {
        container: true,
      })
    ).rejects.toThrow('container unavailable');

    expect(capturedSourceOwnerCalls).toEqual([
      'hold:/test/capture',
      'hold:/test/finalized/workflow-source',
      'reclaim:/test/finalized/workflow-source',
    ]);
  });

  it('binds the run artifacts directory into the container, created on the host first', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-folder',
      name: 'platform',
      default_cwd: '/test/path',
      default_branch: null,
      kind: 'folder',
    });
    const expectedArtifacts = join(mockArtifactsRoot, 'artifacts', 'runs', 'test-run-id');
    // Ownership matters: a bind target Docker creates itself is root-owned on a rootful
    // daemon, so the directory must already exist when prepare() is reached.
    let existedAtPrepare: boolean | undefined;
    mockFolderBackendPrepare.mockImplementationOnce((req?: unknown) => {
      const artifactsMount = (req as { artifactsMount?: string } | undefined)?.artifactsMount;
      existedAtPrepare = artifactsMount !== undefined && existsSync(artifactsMount);
      return Promise.resolve({
        cwd: '/test/path',
        execContext: { kind: 'host' as const },
        envId: 'container-env-1',
        overlayMode: 'volume-copy' as const,
      });
    });

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'go', {
      container: true,
    });

    expect(mockFolderBackendPrepare).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMount: '/test/capture',
        artifactsMount: expectedArtifacts,
      })
    );
    expect(existedAtPrepare).toBe(true);
  });
});

describe('workflowRunCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.info.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should throw error when no workflows found', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [],
      errors: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello')
    ).rejects.toThrow('No workflows found in .archon/workflows/');
  });

  it('logs effective discovery root and source breakdown for every run', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist' }, 'bundled'),
        makeTestWorkflowWithSource({ name: 'home-helper' }, 'global'),
        makeTestWorkflowWithSource({ name: 'project-flow' }, 'project'),
      ],
      errors: [],
    });

    await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'hello', {
      noWorktree: true,
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      'Discovery: root=/repo/root workflows=3 bundled=1 global=1 project=1 installed=0'
    );
  });

  it('uses discoveryCwd in the discovery diagnostic when supplied', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' }, 'project')],
      errors: [],
    });

    await workflowRunCommand(createTestWorkflowHost(), '/tmp/worktree', 'assist', 'hello', {
      noWorktree: true,
      discoveryCwd: '/repo/source',
    });

    // The source is captured from the discovery root; discovery then reads that capture,
    // so the call carries the target cwd plus the capture's roots.
    const sourceDiag = await import('@archon/workflows/run-source');
    expect(sourceDiag.prepareWorkflowSource as ReturnType<typeof mock>).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceRoot: '/repo/source' })
    );
    expect(discoverWorkflowsWithConfig).toHaveBeenCalledWith(
      '/test/path',
      expect.any(Function),
      providerRegistry,
      expect.objectContaining({ project: '/test/capture/project' })
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      'Discovery: root=/repo/source workflows=1 bundled=0 global=0 project=1 installed=0'
    );
  });

  it('does not print discovery diagnostic in json mode', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' }, 'project')],
      errors: [],
    });

    try {
      await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'hello', {
        json: true,
        noWorktree: true,
      });
    } catch {
      // Downstream failure is acceptable; this test only verifies diagnostic suppression.
    }

    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Discovery: root='));
  });

  // #2213 — `--json` silences Pino entirely (cli.ts sets the level to 'silent'),
  // so stderr is the only channel left. Note this asserts only the CHANNEL
  // (console.warn, not console.log); the JSON payload itself goes through
  // `writeJsonLine` on the `--detach` branch, covered in the detach describe.
  it('warns on stderr about keys the engine drops, even in json mode', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [
          makeTestWorkflowWithSource({ name: 'assist' }, 'project', [
            "Node 'plan': unknown key 'interactive' will be ignored.",
          ]),
        ],
        errors: [],
      });

      try {
        await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'hello', {
          json: true,
          noWorktree: true,
        });
      } catch {
        // Downstream failure is acceptable; this test only checks the warning.
      }

      expect(warnSpy).toHaveBeenCalledWith("Warning: 'assist' declares keys the engine ignores:");
      expect(warnSpy).toHaveBeenCalledWith(
        "  - Node 'plan': unknown key 'interactive' will be ignored."
      );
      // Never on stdout — a --json caller must still get a parseable payload.
      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('unknown key'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('stays silent when the resolved workflow has no parse warnings', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [
          makeTestWorkflowWithSource({ name: 'assist' }, 'project'),
          // A DIFFERENT workflow's warnings must not leak into this run.
          makeTestWorkflowWithSource({ name: 'other' }, 'project', ["dropped 'interactive'"]),
        ],
        errors: [],
      });

      await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'hello', {
        noWorktree: true,
      });

      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('the engine ignores'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  // #2781 — the deprecation notice rides the same stderr channel as the parse
  // warnings above, with the same --json-purity rationale.
  it('warns on stderr about a deprecated workflow', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [
          makeTestWorkflowWithSource({
            name: 'assist',
            deprecated: { message: 'Switch to the sdlc pack instead.' },
          }),
        ],
        errors: [],
      });

      try {
        await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'hello', {
          noWorktree: true,
        });
      } catch {
        // Downstream failure is acceptable; this test only checks the notice.
      }

      expect(warnSpy).toHaveBeenCalledWith(
        '⚠️ `assist` is deprecated and will be removed in an upcoming release. ' +
          'Switch to the sdlc pack instead. ' +
          'To keep using this workflow after removal, copy the workflow file into your project ' +
          '`.archon/workflows/` or your global `~/.archon/workflows/`.'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('stays silent when the resolved workflow is not deprecated', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist' }, 'project')],
        errors: [],
      });

      try {
        await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'hello', {
          noWorktree: true,
        });
      } catch {
        // Downstream failure is acceptable; this test only checks silence.
      }

      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('will be removed in an upcoming release')
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not print discovery diagnostic in quiet mode', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' }, 'project')],
      errors: [],
    });

    try {
      await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'hello', {
        quiet: true,
        noWorktree: true,
      });
    } catch {
      // Downstream failure is acceptable; this test only verifies diagnostic suppression.
    }

    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Discovery: root='));
  });

  it('should throw error when workflow not found', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'Help' }),
        makeTestWorkflowWithSource({ name: 'plan', description: 'Plan' }),
      ],
      errors: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'nonexistent', 'hello')
    ).rejects.toThrow("Workflow 'nonexistent' not found");
  });

  it('should include available workflows in error when workflow not found', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'Help' }),
        makeTestWorkflowWithSource({ name: 'plan', description: 'Plan' }),
      ],
      errors: [],
    });

    const run = workflowRunCommand(createTestWorkflowHost(), '/test/path', 'nonexistent', 'hello');
    await expect(run).rejects.toThrow('Available workflows:');
    await expect(run).rejects.toThrow('- assist');
    await expect(run).rejects.toThrow('- plan');
  });

  it('should resolve workflow by suffix match', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'acme-assist', description: 'Help' }),
        makeTestWorkflowWithSource({ name: 'archon-plan', description: 'Plan' }),
      ],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-1',
      platform: 'cli',
      platform_conversation_id: 'cli-123',
      title: null,
      is_active: true,
      codebase_id: null,
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test-repo',
      default_cwd: '/test/path',
    });

    // Should resolve successfully — "assist" suffix-matches "acme-assist"
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello');

    // Verify suffix matching tier was used
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ requested: 'assist', matched: 'acme-assist' }),
      'workflow.resolve_suffix_match'
    );
  });

  it('should resolve workflow by substring match', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'acme-smart-pr-review', description: 'Smart review' }),
        makeTestWorkflowWithSource({ name: 'acme-assist', description: 'Help' }),
      ],
      errors: [],
    });

    // "smart" substring-matches only "acme-smart-pr-review"
    // Will fail downstream at executeWorkflow mock, but must NOT throw "not found"
    const error = await workflowRunCommand(
      createTestWorkflowHost(),
      '/test/path',
      'smart',
      'hello'
    ).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('not found');
    expect((error as Error).message).not.toContain('Did you mean');
  });

  it('should prefer case-insensitive exact match over suffix match', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'Help' }),
        makeTestWorkflowWithSource({ name: 'acme-assist', description: 'Long' }),
      ],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-1',
      platform: 'cli',
      platform_conversation_id: 'cli-123',
      title: null,
      is_active: true,
      codebase_id: null,
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test-repo',
      default_cwd: '/test/path',
    });

    // "ASSIST" case-insensitive matches "assist" at tier 2, should not reach suffix tier
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'ASSIST', 'hello');

    // Verify case-insensitive match was used, not suffix match
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ requested: 'ASSIST', matched: 'assist' }),
      'workflow.resolve_case_insensitive_match'
    );
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'workflow.resolve_suffix_match'
    );
  });

  it('should throw ambiguous error for multiple suffix matches', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'archon-review', description: 'Review' }),
        makeTestWorkflowWithSource({ name: 'custom-review', description: 'Custom review' }),
      ],
      errors: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'review', 'hello')
    ).rejects.toThrow("Ambiguous workflow 'review'. Did you mean:");
  });

  it('should throw ambiguous error for multiple substring matches', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'acme-comprehensive-pr-review',
          description: 'Full review',
        }),
        makeTestWorkflowWithSource({ name: 'acme-smart-pr-review', description: 'Smart review' }),
      ],
      errors: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'pr-review', 'hello')
    ).rejects.toThrow("Ambiguous workflow 'pr-review'. Did you mean:");
  });

  it('should throw when codebase lookup fails (isolation is default)', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('ECONNREFUSED')
    );

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello')
    ).rejects.toThrow('Cannot run workflow: project lookup failed');
  });

  it('refuses a failed project lookup with --no-worktree before execution', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    const codebaseDb = await import('@archon/core/db/codebases');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('ECONNREFUSED')
    );
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        noWorktree: true,
      })
    ).rejects.toThrow('project lookup failed');
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('should throw error when workflow execution fails', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: false,
      error: 'Step failed: assist',
    });

    // Use --no-worktree since no codebase is available (isolation would error)
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        noWorktree: true,
      })
    ).rejects.toThrow('Workflow failed: Step failed: assist');
  });

  it('passes --from as a new task branch start point', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      branchName: 'test-adapters',
      fromBranch: 'feature/extract-adapters',
    });

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;

    expect(provider?.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowType: 'task',
        identifier: 'test-adapters',
        taskBranch: {
          kind: 'new',
          branch: 'test-adapters',
          fromBranch: 'feature/extract-adapters',
        },
      }),
      expect.any(Function)
    );
  });

  it('throws when --branch is used with --no-worktree', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });

    // Validation throws before codebase lookup — no need to mock findCodebaseByDefaultCwd
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        branchName: 'test-branch',
        noWorktree: true,
      })
    ).rejects.toThrow('--branch and --no-worktree are mutually exclusive');
  });

  it('throws when --from is used with --no-worktree', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });

    // Validation throws before codebase lookup — no need to mock findCodebaseByDefaultCwd
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        fromBranch: 'dev',
        noWorktree: true,
      })
    ).rejects.toThrow('--from/--from-branch has no effect with --no-worktree');
  });

  // ── Folder projects ──────────────────────────────────────────────────────
  it('registers a folder project and runs in place with --folder', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const core = await import('@archon/core');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    // No codebase found → auto-register as folder (registerFolder mock returns cb-folder)
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-folder',
      name: 'platform',
      default_cwd: '/test/path',
      kind: 'folder',
    });
    const executeSpy = executeWorkflow as ReturnType<typeof mock>;
    const registerSpy = core.registerFolder as ReturnType<typeof mock>;
    const isolation = await import('@archon/isolation');
    const isolationSpy = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const isolationBefore = isolationSpy.mock.calls.length;
    const execBefore = executeSpy.mock.calls.length;
    const registerBefore = registerSpy.mock.calls.length;
    executeSpy.mockResolvedValueOnce({ success: true, workflowRunId: 'run-folder' });

    const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    let printed = '';
    try {
      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'do it', {
        folder: true,
      });
      printed = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    } finally {
      consoleSpy.mockRestore();
    }

    // Explicit folder registration also applies to git roots.
    expect(registerSpy.mock.calls.length).toBe(registerBefore + 1);
    // The run executed in place
    expect(executeSpy.mock.calls.length).toBe(execBefore + 1);
    expect(executeSpy.mock.calls.at(-1)?.[3]).toBe('/test/path');
    expect(isolationSpy.mock.calls.length).toBe(isolationBefore);
    // The in-place notice was printed
    expect(printed).toContain('running in place');
  });

  it('rejects --branch against a registered folder project', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    // Registered folder project resolved by the main lookup (Once — never leak
    // the folder kind into sibling tests via a persistent mock).
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-folder',
      name: 'platform',
      default_cwd: '/test/path',
      kind: 'folder',
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        branchName: 'feature-x',
      })
    ).rejects.toThrow('Worktree options require a git-repo project');
  });

  it('rejects --base against a registered folder project', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-folder',
      name: 'platform',
      default_cwd: '/test/path',
      kind: 'folder',
    });

    // A folder project creates no worktree, so --base cannot drive a cut-from —
    // but it WOULD still reach $BASE_BRANCH. Half-applied is worse than rejected.
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        baseBranch: 'epic/foo',
      })
    ).rejects.toThrow('Worktree options require a git-repo project');
  });

  it('rejects --folder --branch synchronously (flag-based, before any DB/registration)', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const core = await import('@archon/core');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    const registerSpy = core.registerFolder as ReturnType<typeof mock>;
    const registerBefore = registerSpy.mock.calls.length;

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        folder: true,
        branchName: 'x',
      })
    ).rejects.toThrow('Worktree options require a git-repo project');
    // The flag-based guard fires before any registration work.
    expect(registerSpy.mock.calls.length).toBe(registerBefore);
  });

  it('rejects a worktree-pinned workflow against a registered folder project', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'assist',
          description: 'Help',
          worktree: { enabled: true },
        }),
      ],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-folder',
      name: 'platform',
      default_cwd: '/test/path',
      kind: 'folder',
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {})
    ).rejects.toThrow('requires a worktree');
  });

  it('creates worktree with auto-generated branch when no --branch given', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');
    const isolationDb = await import('@archon/core/db/isolation-environments');

    // Snapshot call counts before this test (process-global mocks)
    const findActiveCallsBefore = (isolationDb.findActiveByWorkflow as ReturnType<typeof mock>).mock
      .calls.length;

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    // No branchName, no noWorktree — should auto-isolate
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {});

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;

    // provider.create should have been called with an auto-generated identifier
    expect(provider?.create).toHaveBeenCalled();
    const lastCreateCall = provider?.create.mock.calls.at(-1)?.[0] as {
      identifier: string;
      workflowType: string;
    };
    expect(lastCreateCall.workflowType).toBe('task');
    expect(lastCreateCall.identifier).toMatch(/^assist-\d+$/);

    // findActiveByWorkflow should NOT have been called during this test (no explicit --branch)
    const findActiveCallsAfter = (isolationDb.findActiveByWorkflow as ReturnType<typeof mock>).mock
      .calls.length;
    expect(findActiveCallsAfter).toBe(findActiveCallsBefore);
  });

  it('keeps a failed worktree launch queryable and retains its source without executing nodes', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    const isolation = await import('@archon/isolation');
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-setup',
      default_cwd: '/test/path',
    });
    const create = mock(async () => {
      expect(mockCreateWorkflowRun.mock.calls.at(-1)?.[0]).toMatchObject({ id: 'test-run-id' });
      throw new Error('post-create failed with exit code 7');
    });
    (isolation.getIsolationProvider as ReturnType<typeof mock>).mockReturnValueOnce({
      create,
      healthCheck: async () => true,
    });
    const executeCount = (executeWorkflow as ReturnType<typeof mock>).mock.calls.length;
    capturedSourceOwnerCalls.length = 0;
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'go')
    ).rejects.toThrow('exit code 7');
    expect((executeWorkflow as ReturnType<typeof mock>).mock.calls).toHaveLength(executeCount);
    expect(workflowDb.failWorkflowRun).toHaveBeenCalledWith(
      'test-run-id',
      expect.stringContaining('exit code 7'),
      { exitReason: 'launch_failed' }
    );
    expect(capturedSourceOwnerCalls).toContain('adopt');
    expect(capturedSourceOwnerCalls.some(call => call.startsWith('reclaim:'))).toBe(false);
  });

  it('records a preparation failure before releasing its live-owner lock', async () => {
    const isolation = await import('@archon/isolation');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-owner',
      default_cwd: '/test/path',
    });
    (isolation.configureIsolation as ReturnType<typeof mock>)
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('child resolver configuration failed');
      });
    const closesBefore = mockRunLiveOwnerClose.mock.calls.length;
    (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      expect(mockRunLiveOwnerClose.mock.calls).toHaveLength(closesBefore);
      return { failed: true };
    });
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'go')
    ).rejects.toThrow('child resolver configuration failed');
    expect(mockRunLiveOwnerClose.mock.calls).toHaveLength(closesBefore + 1);
  });

  it('surfaces a classified worktree creation failure, not the raw error', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    // A setup failure whose rollback left a directory behind carries the leftover
    // note beside its message; only the classifier reads it (#3448).
    const failure = Object.assign(new Error('Submodule initialization failed: no network'), {
      cleanupFailure: 'The incomplete workspace at /test/path/wt was left behind',
    });
    (isolation.getIsolationProvider as ReturnType<typeof mock>).mockReturnValueOnce({
      create: mock(() => Promise.reject(failure)),
      healthCheck: mock(() => Promise.resolve(true)),
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {})
    ).rejects.toThrow(/^classified: Submodule initialization failed/);
  });

  it('skips isolation when --no-worktree flag is set', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    // Snapshot provider.create call count before this test
    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const providerBefore = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const createCallsBefore = providerBefore?.create.mock.calls.length ?? 0;

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      noWorktree: true,
    });

    // provider.create should NOT have been called during this test
    const providerAfter = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const createCallsAfter = providerAfter?.create.mock.calls.length ?? 0;
    expect(createCallsAfter).toBe(createCallsBefore);
  });

  // -------------------------------------------------------------------------
  // Auto-registration failure → truthful CLI error
  // -------------------------------------------------------------------------

  it('surfaces auto-registration failures on --resume instead of claiming the repo is invalid', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { registerRepository } = await import('@archon/core');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const gitModule = await import('@archon/git');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (gitModule.findRepoRoot as ReturnType<typeof mock>).mockResolvedValueOnce('/test/path');
    (registerRepository as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error("EACCES: permission denied, mkdir '/home/test/.archon/workspaces/acme'")
    );

    const error = await captureError(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        resume: true,
      })
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Cannot run workflow: project registration failed.');
    expect(error.message).toContain('EACCES: permission denied');
    expect(error.message).not.toContain('Not in a git repository');
  });

  it('falls back to generic workspace hint when registration error has an unrecognized shape', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { registerRepository } = await import('@archon/core');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const gitModule = await import('@archon/git');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (gitModule.findRepoRoot as ReturnType<typeof mock>).mockResolvedValueOnce('/test/path');
    (registerRepository as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error("EACCES: permission denied, mkdir '/home/test/.archon/workspaces/acme'")
    );

    const error = await captureError(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {})
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Cannot run workflow: project registration failed.');
    expect(error.message).toContain('EACCES: permission denied');
    // Path-separator-agnostic check: on Windows path.join normalizes to `\`,
    // on POSIX to `/`. Assert the hint prefix + the final segment separately.
    expect(error.message).toContain('Check your Archon workspace registration under');
    expect(error.message).toMatch(/workspaces\b/);
  });

  // -------------------------------------------------------------------------
  // Workflow-level `worktree.enabled` policy
  // -------------------------------------------------------------------------

  it('skips isolation when workflow YAML pins worktree.enabled: false', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const providerBefore = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const createCallsBefore = providerBefore?.create.mock.calls.length ?? 0;

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'triage',
          description: 'Read-only triage',
          worktree: { enabled: false },
        }),
      ],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    // No flags — policy alone should disable isolation
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'triage', 'go', {});

    const providerAfter = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const createCallsAfter = providerAfter?.create.mock.calls.length ?? 0;
    expect(createCallsAfter).toBe(createCallsBefore);
  });

  it('throws when workflow pins worktree.enabled: false but caller passes --branch', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'triage',
          description: 'Read-only triage',
          worktree: { enabled: false },
        }),
      ],
      errors: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'triage', 'go', {
        branchName: 'feat-x',
      })
    ).rejects.toThrow(/worktree\.enabled: false/);
  });

  it('throws when workflow pins worktree.enabled: false but caller passes --from', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'triage',
          description: 'Read-only triage',
          worktree: { enabled: false },
        }),
      ],
      errors: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'triage', 'go', {
        fromBranch: 'dev',
      })
    ).rejects.toThrow(/worktree\.enabled: false/);
  });

  it('throws when workflow pins worktree.enabled: false but caller passes --base', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'triage',
          description: 'Read-only triage',
          worktree: { enabled: false },
        }),
      ],
      errors: [],
    });

    // A live-checkout run cuts no worktree, so --base can only half-apply:
    // it would still move $BASE_BRANCH. Reject it like --from rather than
    // silently retargeting the PR of a run that has no worktree.
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'triage', 'go', {
        baseBranch: 'epic/foo',
      })
    ).rejects.toThrow(/worktree\.enabled: false/);
  });

  it('accepts worktree.enabled: false + --no-worktree as redundant (no error)', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'triage',
          description: 'Read-only triage',
          worktree: { enabled: false },
        }),
      ],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    // Should not throw — redundant, not contradictory
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'triage', 'go', {
      noWorktree: true,
    });
  });

  it('throws when workflow pins worktree.enabled: true but caller passes --no-worktree', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'build',
          description: 'Requires a worktree',
          worktree: { enabled: true },
        }),
      ],
      errors: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'build', 'go', {
        noWorktree: true,
      })
    ).rejects.toThrow(/worktree\.enabled: true/);
  });

  it('throws when isolation cannot be created due to missing codebase', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const gitModule = await import('@archon/git');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    // No codebase found
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    // Not in a git repo
    (gitModule.findRepoRoot as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {})
    ).rejects.toThrow('Cannot create worktree: not in a git repository');
  });

  it('emits warning when reused worktree has mismatched base branch', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolationDb = await import('@archon/core/db/isolation-environments');
    const gitModule = await import('@archon/git');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (isolationDb.findActiveByWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'env-1',
      working_path: '/worktrees/feat',
      provider: 'worktree',
      branch_name: 'feature-old',
      workflow_type: 'task',
      workflow_id: 'my-feature',
    });
    (gitModule.isAncestorOf as ReturnType<typeof mock>).mockResolvedValueOnce(false);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        branchName: 'my-feature',
      });
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("not based on 'dev'"));
      expect(isolationDb.updateMetadata).toHaveBeenCalledWith(
        'env-1',
        {
          adopted: true,
          worktree_registration_id: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
          ),
        },
        expect.objectContaining({ id: 'env-1' })
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ envId: 'env-1' }),
        'worktree_adopted'
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('warns that --base did not change the cut-from when reusing a worktree', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolationDb = await import('@archon/core/db/isolation-environments');
    const gitModule = await import('@archon/git');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (isolationDb.findActiveByWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'env-1',
      working_path: '/worktrees/feat',
      provider: 'worktree',
      branch_name: 'feature-old',
      workflow_type: 'task',
      workflow_id: 'my-feature',
    });
    // Base is valid, so the mismatch warning stays silent and this test asserts
    // only the reuse notice.
    (gitModule.isAncestorOf as ReturnType<typeof mock>).mockResolvedValueOnce(true);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        branchName: 'my-feature',
        baseBranch: 'epic/foo',
      });
      // Unlike --from (which is fully ignored on reuse), --base is PARTIALLY
      // applied: the cut-from is already fixed, but $BASE_BRANCH still moves.
      // The wording has to say so, or it trades one silent surprise for another.
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('--base epic/foo did not change the cut-from')
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('it still applies to the PR target')
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('validates a reused worktree against --base rather than repo config', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolationDb = await import('@archon/core/db/isolation-environments');
    const gitModule = await import('@archon/git');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (isolationDb.findActiveByWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'env-1',
      working_path: '/worktrees/feat',
      provider: 'worktree',
      branch_name: 'feature-old',
      workflow_type: 'task',
      workflow_id: 'my-feature',
    });
    (gitModule.isAncestorOf as ReturnType<typeof mock>).mockResolvedValueOnce(false);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        branchName: 'my-feature',
        baseBranch: 'epic/foo',
      });
      // Repo config says 'dev'; the dispatch said 'epic/foo'. Checking ancestry
      // against 'dev' would report a mismatch nobody asked about.
      expect(gitModule.isAncestorOf as ReturnType<typeof mock>).toHaveBeenCalledWith(
        '/worktrees/feat',
        'origin/epic/foo'
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("not based on 'epic/foo'")
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('validates an automatic reused worktree against the configured upstream remote', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolationDb = await import('@archon/core/db/isolation-environments');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (isolationDb.findActiveByWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'env-1',
      working_path: '/worktrees/feat',
      provider: 'worktree',
      branch_name: 'feature-valid',
      workflow_type: 'task',
      workflow_id: 'my-feature',
    });
    const core = await import('@archon/core');
    const gitModule = await import('@archon/git');
    (core.loadRepoConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      worktree: { remote: ' upstream ' },
    });
    // isAncestorOf returns true by default — no warning expected
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        branchName: 'my-feature',
      });
      expect(gitModule.getDefaultBranch).toHaveBeenCalledWith('/test/path', 'upstream');
      expect(gitModule.isAncestorOf).toHaveBeenCalledWith('/worktrees/feat', 'upstream/dev');
      const baseBranchWarnCalls = consoleWarnSpy.mock.calls.filter(
        (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('not based on')
      );
      expect(baseBranchWarnCalls).toHaveLength(0);
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('uses codebase default_branch for reuse validation instead of git auto-detection', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolationDb = await import('@archon/core/db/isolation-environments');
    const gitModule = await import('@archon/git');

    const getDefaultBranchCallsBefore = (gitModule.getDefaultBranch as ReturnType<typeof mock>).mock
      .calls.length;

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
      default_branch: 'develop',
    });
    (isolationDb.findActiveByWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'env-1',
      working_path: '/worktrees/feat',
      provider: 'worktree',
      branch_name: 'feature-old',
      workflow_type: 'task',
      workflow_id: 'my-feature',
    });
    (gitModule.isAncestorOf as ReturnType<typeof mock>).mockResolvedValueOnce(false);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        branchName: 'my-feature',
      });
      // Warning names the codebase default branch, not the auto-detected 'dev'
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("not based on 'develop'")
      );
      // The stored default branch short-circuits git auto-detection entirely
      const getDefaultBranchCallsAfter = (gitModule.getDefaultBranch as ReturnType<typeof mock>)
        .mock.calls.length;
      expect(getDefaultBranchCallsAfter).toBe(getDefaultBranchCallsBefore);
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('threads codebase default_branch into provider.create and executeWorkflow opts', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
      default_branch: 'develop',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    // No branchName, no noWorktree — auto-isolates via provider.create
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {});

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const lastCreateCall = provider?.create.mock.calls.at(-1)?.[0] as {
      baseBranch?: string;
    };
    expect(lastCreateCall.baseBranch).toBe('develop');

    // executeWorkflow opts (trailing arg) carry the same fallback for $BASE_BRANCH
    const executeSpy = executeWorkflow as ReturnType<typeof mock>;
    const lastExecuteArgs = executeSpy.mock.calls.at(-1) as unknown[];
    const opts = lastExecuteArgs[lastExecuteArgs.length - 1] as { baseBranch?: string };
    expect(opts.baseBranch).toBe('develop');
  });

  it('rejects --base combined with --no-worktree', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'go', {
        noWorktree: true,
        baseBranch: 'epic/foo',
      })
    ).rejects.toThrow(/--base has no effect with --no-worktree/i);
  });

  it('threads --base override into provider.create (baseOverride) and executeWorkflow opts (PR target)', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
      default_branch: 'develop',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    // --base epic/foo dispatched via the baseBranch option (from the CLI flag)
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      baseBranch: 'epic/foo',
    });

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const lastCreateCall = provider?.create.mock.calls.at(-1)?.[0] as {
      baseBranch?: string;
      baseOverride?: string;
    };
    // Flag flows as the override (wins over config + codebase default in the
    // provider); codebase default stays in the request as the fallback.
    expect(lastCreateCall.baseOverride).toBe('epic/foo');
    expect(lastCreateCall.baseBranch).toBe('develop');

    // PR target / $BASE_BRANCH: the flag rides its own `baseOverride` channel so
    // it outranks `worktree.baseBranch` inside executeWorkflow. `baseBranch`
    // keeps carrying the codebase default as the fallback — the same split the
    // provider request uses above. Asserting the flag in `baseBranch` here would
    // pass while $BASE_BRANCH still resolved to repo config (see the
    // 'prefers baseOverride over repo config baseBranch' test in
    // packages/workflows/src/executor.test.ts, which covers the resolution).
    const executeSpy = executeWorkflow as ReturnType<typeof mock>;
    const lastExecuteArgs = executeSpy.mock.calls.at(-1) as unknown[];
    const opts = lastExecuteArgs[lastExecuteArgs.length - 1] as {
      baseBranch?: string;
      baseOverride?: string;
    };
    expect(opts.baseOverride).toBe('epic/foo');
    expect(opts.baseBranch).toBe('develop');
  });

  it('warns that --base did not change the cut-from when resuming a run', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { hydrateResumableRun } = await import('@archon/workflows/run-resume');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    // A null hydration aborts the resume before executeWorkflow, so the run must
    // carry prior state for this path to reach the dispatch.
    (hydrateResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      preCreatedRun: { id: 'run-prior', workflow_name: 'assist' },
      priorCompletedNodes: new Map([['node-a', 'done']]),
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
      default_branch: 'develop',
    });
    // working_path null keeps the resume on the caller cwd, skipping the
    // existsSync probe (fs is deliberately not mocked in this suite).
    (workflowDb.findResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-prior',
      working_path: null,
      workflow_name: 'assist',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        resume: true,
        baseBranch: 'epic/foo',
      });
      // --resume adopts the prior run's worktree, so its cut-from is as fixed as
      // it is on --branch reuse -- but flagBase still reaches executeWorkflow as
      // baseOverride and moves $BASE_BRANCH. Same half-applied shape, same
      // warning.
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('--base epic/foo did not change the cut-from')
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('it still applies to the PR target')
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('lets --from win the cut-from while --base still drives the PR target', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
      default_branch: 'develop',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      fromBranch: 'origin/release/2.0',
      baseBranch: 'dev',
    });

    // INTENTIONAL, not an oversight: --base sets both halves of "base" by
    // default, and --from is the lever that decouples them. Combining them is
    // how you express "branch from release/2.0, but open the PR against dev" —
    // the one case a single flag cannot say. Making one flag win outright would
    // delete that capability, so this pairing is deliberately left unguarded.
    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const lastCreateCall = provider?.create.mock.calls.at(-1)?.[0] as {
      taskBranch?: { kind: string; fromBranch?: string };
      baseOverride?: string;
    };
    expect(lastCreateCall.taskBranch).toEqual({
      kind: 'new',
      fromBranch: 'origin/release/2.0',
    });
    expect(lastCreateCall.baseOverride).toBe('dev');

    const executeSpy = executeWorkflow as ReturnType<typeof mock>;
    const lastExecuteArgs = executeSpy.mock.calls.at(-1) as unknown[];
    const opts = lastExecuteArgs[lastExecuteArgs.length - 1] as { baseOverride?: string };
    expect(opts.baseOverride).toBe('dev');
  });

  it('threads codebase name into provider.create so single-segment checkout paths resolve', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    // Single-segment checkout path — the stored owner/repo name must reach the
    // provider so worktrees use the registered identity instead of the
    // _local/<basename> path fallback (#2022, #2227).
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      name: 'owner/repo',
      default_cwd: '/workspace',
      default_branch: 'main',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/workspace', 'assist', 'hello', {});

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const lastCreateCall = provider?.create.mock.calls.at(-1)?.[0] as {
      codebaseName?: string;
    };
    expect(lastCreateCall.codebaseName).toBe('owner/repo');
  });

  it('omits baseBranch when the codebase has no stored default_branch', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
      default_branch: null,
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {});

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const lastCreateCall = provider?.create.mock.calls.at(-1)?.[0] as {
      baseBranch?: string;
    };
    expect(lastCreateCall.baseBranch).toBeUndefined();

    const executeSpy = executeWorkflow as ReturnType<typeof mock>;
    const lastExecuteArgs = executeSpy.mock.calls.at(-1) as unknown[];
    const opts = lastExecuteArgs[lastExecuteArgs.length - 1] as { baseBranch?: string };
    expect(opts.baseBranch).toBeUndefined();
  });

  it('sends dispatch message before executeWorkflow with correct metadata', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const { CLIAdapter } = await import('../adapters/cli-adapter');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);

    const callOrder: string[] = [];
    const sendMessage = spyOn(CLIAdapter.prototype, 'sendMessage').mockImplementation(
      async (_id, message) => {
        callOrder.push(message);
      }
    );
    (executeWorkflow as ReturnType<typeof mock>).mockImplementation(async () => {
      callOrder.push('executeWorkflow');
      return { success: true, workflowRunId: 'run-1' };
    });

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      noWorktree: true,
    });

    // Dispatch assistant message fires before executeWorkflow
    expect(callOrder[0]).toContain('Dispatching workflow');
    expect(callOrder[1]).toBe('executeWorkflow');

    expect(sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      'Dispatching workflow: **assist**',
      expect.objectContaining({
        category: 'workflow_dispatch_status',
        workflowDispatch: expect.objectContaining({ workflowName: 'assist' }),
      })
    );
    sendMessage.mockRestore();
  });

  it('sends result card when executeWorkflow returns a summary', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const { CLIAdapter } = await import('../adapters/cli-adapter');
    const sendMessage = spyOn(CLIAdapter.prototype, 'sendMessage').mockResolvedValue(undefined);

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-42',
      summary: 'All steps completed. Branch pushed.',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      noWorktree: true,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      'All steps completed. Branch pushed.',
      expect.objectContaining({
        category: 'workflow_result',
        workflowResult: { workflowName: 'assist', runId: 'run-42' },
      })
    );
    sendMessage.mockRestore();
  });

  it('does not send result card when executeWorkflow has no summary', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const messagesDb = await import('@archon/core/db/messages');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-1',
      // no summary field
    });
    (messagesDb.addMessage as ReturnType<typeof mock>).mockClear();

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      noWorktree: true,
    });

    // Only dispatch addMessage call, no result card
    const resultCalls = (messagesDb.addMessage as ReturnType<typeof mock>).mock.calls.filter(
      (args: unknown[]) => {
        const meta = args[3] as Record<string, unknown> | undefined;
        return meta?.category === 'workflow_result';
      }
    );
    expect(resultCalls).toHaveLength(0);
  });

  it('does not throw and continues to executeWorkflow when dispatch sendMessage fails', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const messagesDb = await import('@archon/core/db/messages');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-1',
    });
    // First addMessage (user message persist) succeeds, second (dispatch) fails
    (messagesDb.addMessage as ReturnType<typeof mock>)
      .mockResolvedValueOnce(undefined) // user message persist succeeds
      .mockRejectedValueOnce(new Error('DB gone')); // dispatch fails (caught inside CLIAdapter)

    // Should not throw — dispatch failure must not block workflow execution
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        noWorktree: true,
      })
    ).resolves.toBeUndefined();

    // executeWorkflow was still called despite dispatch failure
    expect(executeWorkflow).toHaveBeenCalledTimes(1);
  });

  it('does not send result card when workflow is paused even with summary', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const messagesDb = await import('@archon/core/db/messages');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-paused',
      paused: true,
      summary: 'Steps completed so far.',
    });
    (messagesDb.addMessage as ReturnType<typeof mock>).mockClear();

    const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        noWorktree: true,
      });

      // Paused guard fires before summary check — no result card despite having a summary
      const resultCalls = (messagesDb.addMessage as ReturnType<typeof mock>).mock.calls.filter(
        (args: unknown[]) => {
          const meta = args[3] as Record<string, unknown> | undefined;
          return meta?.category === 'workflow_result';
        }
      );
      expect(resultCalls).toHaveLength(0);

      // Confirm paused message was printed
      expect(consoleSpy).toHaveBeenCalledWith('\nWorkflow paused — waiting for approval.');
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe('write command --json output', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
    mockCancelWorkflowRunCommand.mockReset();
    mockCancelWorkflowRunCommand.mockResolvedValue({ cancelled: true });
    mockRequestDetachedRunStop.mockReset();
    mockRequestDetachedRunStop.mockImplementation(noOwnerAnswers);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('JSON reports failure when abandonment loses cancellation', async () => {
    mockLookupWorkflowRun.mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'test',
      conversation_id: 'conv',
      parent_conversation_id: null,
      codebase_id: null,
      status: 'running',
      outcome: null,
      user_message: '',
      metadata: {},
      started_at: new Date(),
      completed_at: null,
      last_activity_at: null,
      working_path: null,
      user_id: null,
      parent_run_id: null,
      adopted_from_run_id: null,
      output_root: null,
      checkout_baseline: null,
      origin: null,
    });
    mockCancelWorkflowRunCommand.mockResolvedValueOnce({ cancelled: false });
    await workflowAbandonCommand(createTestWorkflowHost(), 'run-1', true);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      error: expect.stringContaining('changed before abandonment'),
    });
  });

  it('abandon --json emits a structured cancelled result', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-ab',
      workflow_name: 'implement',
      status: 'running',
      last_activity_at: new Date('2026-09-20T10:00:00.000Z'),
      metadata: { execution_owner: { host: 'build-box', pid: 4242 } },
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      cancelled: true,
    });

    await workflowAbandonCommand(createTestWorkflowHost(), 'run-ab', true);

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toEqual({
      ok: true,
      runId: 'run-ab',
      action: 'abandon',
      status: 'cancelled',
      workflowName: 'implement',
      owner: {
        outcome: 'no_owner_answered',
        thisHost: hostname(),
        recordedHost: 'build-box',
        recordedPid: 4242,
        recordedUid: null,
        lastActivityAt: '2026-09-20T10:00:00.000Z',
      },
    });
  });

  it('abandon --json emits {ok:false} on a not-found run (never throws)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const exitCode = await workflowAbandonCommand(createTestWorkflowHost(), 'missing', true);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      ok: boolean;
      error: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('Workflow run not found');
  });

  it('approve --json records the decision and does NOT auto-resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const discovery = await import('@archon/workflows/workflow-discovery');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      origin: { conversationId: 'conv' },
      id: 'run-ap',
      workflow_name: 'implement',
      status: 'paused',
      working_path: '/tmp/wt',
      codebase_id: 'cb',
      conversation_id: 'conv',
      user_message: 'go',
      metadata: { approval: { nodeId: 'gate', message: 'ok?' } },
    });
    const discoverSpy = discovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await workflowApproveCommand(createTestWorkflowHost(), 'run-ap', 'lgtm', true);

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      ok: true,
      runId: 'run-ap',
      action: 'approve',
      type: 'approval_gate',
      resumable: true,
    });
    // No inline resume → workflowRunCommand (whose first step is discovery) never ran
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it('reject --json reports cancelled + resumable correctly without auto-resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const discovery = await import('@archon/workflows/workflow-discovery');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      origin: { conversationId: 'conv' },
      id: 'run-rj',
      workflow_name: 'implement',
      status: 'paused',
      working_path: '/tmp/wt',
      codebase_id: 'cb',
      conversation_id: 'conv',
      user_message: 'go',
      metadata: { approval: { nodeId: 'gate', message: 'ok?' } },
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      cancelled: true,
    });
    const discoverSpy = discovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await workflowRejectCommand(createTestWorkflowHost(), 'run-rj', 'nope', true);

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    // No onRejectPrompt in approval metadata → run is cancelled, not resumable
    expect(parsed).toMatchObject({
      ok: true,
      runId: 'run-rj',
      action: 'reject',
      cancelled: true,
      resumable: false,
    });
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it('resume --json validates resumability without executing (executed:false)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const discovery = await import('@archon/workflows/workflow-discovery');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-rs',
      workflow_name: 'implement',
      status: 'failed',
      working_path: '/tmp/wt',
    });
    const discoverSpy = discovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    const exitCode = await workflowResumeCommand(createTestWorkflowHost(), 'run-rs', true);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      ok: true,
      runId: 'run-rs',
      action: 'resume',
      executed: false,
      status: 'failed',
    });
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it('resume --json exits nonzero with {ok:false} on a not-found run', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const exitCode = await workflowResumeCommand(createTestWorkflowHost(), 'missing', true);

    expect(exitCode).toBe(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'resume',
    });
  });
});

describe('workflowRunCommand — detach', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    jest.useFakeTimers();
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
    // A real detached launch resolves a project — the pre-flight refuses an isolating
    // run that has no project to isolate (#2872 R1), the same refusal the isolation
    // block makes. Tests that want that refusal override this per invocation.
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue({
      id: 'cb-detach',
      name: 'test/repo',
      default_cwd: '/test/path',
      default_branch: 'main',
      kind: 'repo',
    });
  });

  afterEach(async () => {
    jest.useRealTimers();
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue(null);
  });

  it('spawns a detached child with its pending run and branch and does NOT await executeWorkflow', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });

    const execBefore = (executeWorkflow as ReturnType<typeof mock>).mock.calls.length;
    const child = createDetachedChildFixture();
    const workflowDb = await import('@archon/core/db/workflows');
    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => {
      const created = (workflowDb.createWorkflowRun as ReturnType<typeof mock>).mock.calls.at(
        -1
      )?.[0];
      expect(created?.metadata.ai_configuration).toMatchObject({ version: 1 });
      return child.child;
    });
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    // Capture call data BEFORE mockRestore() — restoring a spy clears its recorded calls.
    let spawnCallCount = 0;
    let spawnCmd: string[] = [];
    let spawnOptions: DetachedSpawnOptions | undefined;
    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        'hello',
        { detach: true }
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnCallCount = spawnSpy.mock.calls.length;
      spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      spawnCmd = (spawnOptions?.cmd ?? []).slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(spawnCallCount).toBe(1);
    // The actual Windows fix: the child must be spawned into its own process
    // group, or the launching shell's teardown kills it (~1s in).
    expect(spawnOptions?.detached).toBe(true);
    expect(spawnOptions?.windowsHide).toBe(true);
    expect(spawnOptions?.env?.ARCHON_DETACHED_RUN_OWNER).toBe('1');
    expect(spawnOptions?.env?.ARCHON_HOME).toBe(testHome);
    const logLine = consoleSpy.mock.calls.find((call: unknown[]) =>
      String(call[0]).startsWith('Child output: ')
    );
    const logPath = String(logLine?.[0]).slice('Child output: '.length);
    expect(dirname(logPath)).toBe(join(testHome, 'logs'));
    expect(readFileSync(logPath, 'utf8')).toContain('--- detached workflow invocation:');
    expect(spawnCmd).not.toContain('--detach');
    expect(spawnCmd).toContain('--branch');
    expect(spawnCmd).not.toContain('--conversation-id');
    expect(spawnCmd).toContain('--cwd');
    const cwdIdx = spawnCmd.indexOf('--cwd');
    expect(spawnCmd[cwdIdx + 1]).toBe('/test/path');
    expect(spawnOptions?.cwd).toBe('/test/path');
    // Generated branch is `assist-<timestamp>`
    const branchIdx = spawnCmd.indexOf('--branch');
    expect(spawnCmd[branchIdx + 1]).toMatch(/^assist-\d+$/);
    // executeWorkflow must NOT run in the detaching parent
    const execAfter = (executeWorkflow as ReturnType<typeof mock>).mock.calls.length;
    expect(execAfter).toBe(execBefore);
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith("Started 'assist' in the background.");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/^Transcript: .*\.jsonl$/));
  });

  it('resolves an adopted run prefix before passing it to the detached child', async () => {
    const adoptedRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (git.findRepoRoot as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    const { resolveWorkflowAdoption } = await import('@archon/core/operations/workflow-adoption');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValue({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    // The parent resolves the declared adoption before forking (#2872), so this test
    // now has to give it a project and a resolvable lane to pass through.
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test/folder',
      default_cwd: '/test/path',
      kind: 'folder',
    });
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: adoptedRunId },
    ]);
    (resolveWorkflowAdoption as ReturnType<typeof mock>).mockResolvedValueOnce({
      adoptedRun: { id: adoptedRunId, status: 'completed', working_path: '/test/worktree' },
      lane: {
        kind: 'reuse-worktree',
        environment: { id: 'env-detached', working_path: '/test/worktree' },
      },
    });

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    let spawnCmd: string[] = [];
    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path/subdir',
        'assist',
        'hello',
        {
          detach: true,
          adoptRunId: '0b1ee8da',
        }
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnCmd = firstDetachedSpawnOptions(spawnSpy).cmd.slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    const adoptIndex = spawnCmd.indexOf('--adopt');
    expect(adoptIndex).toBeGreaterThan(-1);
    expect(spawnCmd[adoptIndex + 1]).toBe(adoptedRunId);
    expect(workflowDb.findWorkflowRunsByIdPrefix).toHaveBeenCalledWith('0b1ee8da', 'cb-1');
    expect(resolveWorkflowAdoption).toHaveBeenCalledWith(expect.objectContaining({ adoptedRunId }));
    expect(mockCreateWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ adopted_from_run_id: adoptedRunId })
    );
    expect(spawnCmd).not.toContain('--branch');
  });

  // #2872 — the launch printed `Started` and exited 0 while the child died on adoption
  // resolution, so no run row was ever created and the failure existed only inside the
  // detached child's log. The refusal has to reach the launching terminal.
  it('refuses an unresolvable --adopt synchronously instead of acking Started (#2872)', async () => {
    // Real timers: pre-fix this path spawns and waits out the startup window, so the
    // assertions below must be reachable rather than parked on an unadvanced fake timer.
    jest.useRealTimers();
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');
    const { resolveWorkflowAdoption } = await import('@archon/core/operations/workflow-adoption');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test/repo',
      default_cwd: '/test/path',
      default_branch: 'main',
      kind: 'repo',
    });
    (resolveWorkflowAdoption as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error(
        "Cannot adopt: no workflow run 'run-missing' exists. Check the id with `workflow runs`."
      )
    );

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    try {
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
          detach: true,
          adoptRunId: 'run-missing',
        })
      ).rejects.toThrow(/Cannot adopt: no workflow run 'run-missing' exists/);
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(consoleSpy).not.toHaveBeenCalledWith("Started 'assist' in the background.");
  });

  it('hands the detached child the sealed validated layer instead of a mutable path', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { unsealWorkflowRunConfig } = await import('@archon/core/config');
    const { workflowRunConfigMetadataSchema } = await import(
      '@archon/workflows/schemas/run-config'
    );
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    const savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    const savedArchonHome = process.env.ARCHON_HOME;
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    delete process.env.ARCHON_HOME;
    process.argv = [
      'bun',
      '/abs/cli.ts',
      'workflow',
      'run',
      'assist',
      '--config',
      '/caller/config.yaml',
      '--detach',
    ];

    let payload: string | undefined;
    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        '',
        {
          detach: true,
          configPath: '/caller/config.yaml',
          detachedRunConfig: {
            source: { kind: 'cli', label: 'config.yaml' },
            layer: { docsPath: 'accepted', envVars: { SNAPSHOT: 'original' } },
          },
        }
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      const spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      const payloadIndex = spawnOptions.cmd.indexOf('--internal-detached-run-config');
      payload = payloadIndex >= 0 ? spawnOptions.cmd[payloadIndex + 1] : undefined;
      expect(spawnOptions.env?.ARCHON_INTERNAL_DETACHED_RUN_CONFIG).toBeUndefined();
      expect(spawnOptions.env?.TOKEN_ENCRYPTION_KEY).toBe('ab'.repeat(32));
      expect(spawnOptions.env?.ARCHON_HOME).toBe('');
      expect(fs.readdirSync(join(testHome, 'logs'))).toHaveLength(1);
    } finally {
      process.argv = savedArgv;
      if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
      if (savedArchonHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = savedArchonHome;
      spawnSpy.mockRestore();
    }

    expect(payload).toBeDefined();
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    try {
      const metadata = workflowRunConfigMetadataSchema.parse(JSON.parse(payload ?? ''));
      expect(unsealWorkflowRunConfig(metadata)).toMatchObject({
        docsPath: 'accepted',
        envVars: { SNAPSHOT: 'original' },
      });
    } finally {
      if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
    }
  });

  // #2213 — the headline `--json` claim. `writeJsonLine` (not console.log) is
  // what emits the payload, and it is only reached on this `--detach` branch,
  // so this is the only place the "stdout stays exactly the payload" guarantee
  // can actually be observed. Asserts the captured stdout still JSON.parse()s
  // while the warning went to stderr.
  it('keeps stdout a parseable JSON payload while warning on stderr', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'Help' }, 'project', [
          "Node 'plan': unknown key 'interactive' will be ignored.",
        ]),
      ],
      errors: [],
    });

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = [
      'bun',
      '/abs/cli.ts',
      'workflow',
      'run',
      'assist',
      'hello',
      '--detach',
      '--json',
    ];

    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        'hello',
        {
          detach: true,
          json: true,
        }
      );
      await finishStartupWindow(commandPromise, spawnSpy);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    // stdout: exactly one line, and it parses.
    const payload = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      ok: boolean;
      action: string;
      workflow: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.action).toBe('run');
    expect(payload.workflow).toBe('assist');
    // The warning reached the user — on stderr, not in the payload.
    expect(warnSpy).toHaveBeenCalledWith("Warning: 'assist' declares keys the engine ignores:");
    expect(JSON.stringify(payload)).not.toContain('unknown key');
    warnSpy.mockRestore();
  });

  it('does NOT pin a --branch on the detached child for a registered folder project', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    // Detach folder probe: exact miss, then path-prefix resolves a folder project.
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-folder',
      name: 'platform',
      default_cwd: '/test/path',
      kind: 'folder',
    });

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];
    let spawnCmd: string[] = [];
    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        'hello',
        { detach: true }
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnCmd = firstDetachedSpawnOptions(spawnSpy).cmd.slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(spawnCmd).not.toContain('--detach');
    expect(spawnCmd).not.toContain('--branch'); // folder project → no worktree branch
    expect(spawnCmd).not.toContain('--conversation-id');
  });

  // #2872 — a continuation already owns a run row, so the ack names it without
  // creating anything. `wait <run-id>` behind `run --resume --detach` needs the id
  // just as much as behind a fresh launch.
  it('--resume --detach acks the continuation run id without creating a row', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const workflowDb = await import('@archon/core/db/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (workflowDb.findResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-paused',
      workflow_name: 'assist',
      working_path: null,
    });
    mockCreateWorkflowRun.mockClear();

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = [
      'bun',
      '/abs/cli.ts',
      'workflow',
      'run',
      'assist',
      'hello',
      '--resume',
      '--detach',
      '--json',
    ];

    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        'hello',
        {
          resume: true,
          detach: true,
          json: true,
        }
      );
      await finishStartupWindow(commandPromise, spawnSpy);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed.runId).toBe('run-paused');
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
  });

  it('--detach --json emits a structured ack', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const tempHome = testHome;
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = [
      'bun',
      '/abs/cli.ts',
      'workflow',
      'run',
      'assist',
      'hello',
      '--detach',
      '--json',
    ];

    let spawnCmd: string[] = [];
    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        'hello',
        {
          detach: true,
          json: true,
        }
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnCmd = firstDetachedSpawnOptions(spawnSpy).cmd.slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: true, action: 'run', detached: true, workflow: 'assist' });
    expect(parsed.conversationId).toBeNull();
    // #2872: the ack hands back the row this launch created, and the child is told to
    // execute that row rather than creating a second one.
    expect(parsed.runId).toBe('run-detached-created');
    expect(parsed.transcriptPath).toBe(
      join(tempHome, 'workspaces', 'test', 'repo', 'logs', 'run-detached-created.jsonl')
    );
    expect(typeof parsed.logPath).toBe('string');
    expect(parsed.logPath).not.toBe(parsed.transcriptPath);
    expect(mockCreateWorkflowRun).toHaveBeenCalled();
    const idIndex = spawnCmd.indexOf('--internal-detached-run-id');
    expect(idIndex).toBeGreaterThan(-1);
    expect(spawnCmd[idIndex + 1]).toBe('run-detached-created');
  });

  // #2872 R1 — the plain launch, with no --folder/--adopt/--supersedes/--resume, is the
  // most common invocation and had no pre-flight refusal at all: an isolating run with
  // no project to isolate sailed past, printed `Started`, and died on the identical
  // check in the child.
  it('refuses an isolating launch whose project lookup fails, before forking', async () => {
    jest.useRealTimers();
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('ECONNREFUSED')
    );

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
          detach: true,
        })
      ).rejects.toThrow(/Cannot run workflow: project lookup failed/);
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
    expect(consoleSpy).not.toHaveBeenCalledWith("Started 'assist' in the background.");
  });

  it('refuses an isolating launch outside a git repository, before forking', async () => {
    jest.useRealTimers();
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    mockCreateWorkflowRun.mockClear();
    (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
          detach: true,
        })
      ).rejects.toThrow(/Cannot create worktree: not in a git repository/);
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
    // Refused before the row exists, so there is nothing to leave behind.
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
    expect(workflowDb.failWorkflowRun).not.toHaveBeenCalled();
  });

  it('still launches without a project when isolation is not wanted', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];
    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        'hello',
        {
          detach: true,
          noWorktree: true,
        }
      );
      await finishStartupWindow(commandPromise, spawnSpy);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }
    expect(consoleSpy).toHaveBeenCalledWith("Started 'assist' in the background.");
  });

  // A one-node workflow that fails legitimately finishes inside the 500 ms startup
  // window on a fast machine. #2914 read the child's non-zero exit as a launch failure,
  // so the same command passed or failed depending on how quickly the machine got
  // through the run — locally it broke `bun run validate` outright. The child now names
  // its run's own failure, and only that reading acks it.
  it('acks a run whose workflow failed inside the startup window', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const workflowDb = await import('@archon/core/db/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        'hello',
        { detach: true }
      );
      for (let attempt = 0; attempt < 200 && spawnSpy.mock.calls.length === 0; attempt++) {
        await Promise.resolve();
      }
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      spawnOptions.onExit?.(child.child, DETACHED_RUN_FAILED_EXIT_CODE, null);
      await commandPromise;
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(consoleSpy).toHaveBeenCalledWith("Started 'assist' in the background.");
    // The run recorded its own failure. A launcher that fails the row here would
    // overwrite the run's reason with a launch failure that never happened.
    expect(workflowDb.failWorkflowRun).not.toHaveBeenCalled();
  });

  // #2872 — the parent is the row's only owner until the child claims it. A child that
  // never starts must not leave a `pending` row nobody can explain.
  it('fails the run row it created when the detached child dies during startup', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const workflowDb = await import('@archon/core/db/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        'hello',
        { detach: true }
      );
      for (let attempt = 0; attempt < 200 && spawnSpy.mock.calls.length === 0; attempt++) {
        await Promise.resolve();
      }
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      spawnOptions.onExit?.(child.child, 1, null);
      await expect(commandPromise).rejects.toThrow(/exit code 1/);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(workflowDb.failWorkflowRun).toHaveBeenCalledWith(
      'run-detached-created',
      expect.stringContaining('Detached launch failed'),
      { exitReason: 'launch_failed' }
    );
    expect(consoleSpy).not.toHaveBeenCalledWith("Started 'assist' in the background.");
  });

  it('rejects an immediate non-zero child exit with the log tail and no success ack', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const tempHome = testHome;
    const conversationId = 'cli-detached-failure';
    const logPath = join(tempHome, 'logs', `detached-run-${conversationId}.log`);
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        'hello',
        {
          detach: true,
          json: true,
          conversationId,
        }
      );
      for (let attempt = 0; attempt < 200 && spawnSpy.mock.calls.length === 0; attempt++) {
        await Promise.resolve();
      }
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      appendFileSync(logPath, 'database unavailable during startup\n');
      const spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      spawnOptions.onExit?.(child.child, 1, null);

      await expect(commandPromise).rejects.toThrow(
        /exit code 1[\s\S]*database unavailable during startup/
      );
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(child.unref).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('writes a delimiter for every invocation sharing a conversation id', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const tempHome = testHome;
    const conversationId = 'cli-shared-conversation';
    const firstChild = createDetachedChildFixture();
    const secondChild = createDetachedChildFixture();
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>)
      .mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
        errors: [],
      })
      .mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
        errors: [],
      });
    const spawnSpy = spyOn(Bun, 'spawn')
      .mockReturnValueOnce(firstChild.child)
      .mockReturnValueOnce(secondChild.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    try {
      const firstRun = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        'hello',
        {
          detach: true,
          conversationId,
        }
      );
      await finishStartupWindow(firstRun, spawnSpy);
      const secondRun = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        'hello',
        {
          detach: true,
          conversationId,
        }
      );
      await finishStartupWindow(secondRun, spawnSpy, 2);

      const log = readFileSync(
        join(tempHome, 'logs', `detached-run-${conversationId}.log`),
        'utf8'
      );
      const delimiters = log
        .split('\n')
        .filter(line => line.startsWith(`--- detached workflow invocation: ${conversationId} at `));
      expect(delimiters).toHaveLength(2);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }
  });

  it('throws (no false success ack) when the detached child fails to spawn', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    // Node's spawn does not throw synchronously on a bad executable — the only
    // synchronous failure signal is an undefined pid.
    const child = createDetachedChildFixture(null);
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    try {
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
          detach: true,
        })
      ).rejects.toThrow(/Failed to start detached workflow child/);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }
    // The success ack must never have been printed.
    const logged: string[] = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(logged).not.toContain("Started 'assist' in the background.");
  });
});

// ---------------------------------------------------------------------------
// #2872 — the detached child executes the run its launcher created. Without this
// the child wrote a SECOND row, so the id the parent acked named nothing.
// ---------------------------------------------------------------------------

describe('workflowRunCommand — detached child adopts the pre-created run (#2872)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  const preCreatedRow = {
    origin: { conversationId: 'conv-1' },
    id: 'run-precreated',
    workflow_name: 'plan',
    conversation_id: 'conv-1',
    status: 'pending',
    working_path: null,
    started_at: new Date(),
    metadata: {},
  };

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    process.env.ARCHON_DETACHED_RUN_OWNER = '1';
    mockStartRunLiveOwner.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    delete process.env.ARCHON_DETACHED_RUN_OWNER;
  });

  it('executes the launcher’s row and files its capture under that id', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan', description: 'Plan work' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test/repo',
      default_cwd: '/test/path',
      kind: 'repo',
    });
    const snapshot = createRunAiConfigurationSnapshot(
      providerRegistry,
      {
        assistant: 'codex',
        commands: {},
        assistants: { claude: {}, codex: { model: 'launch-model' } },
      },
      buildAiProfile('codex'),
      {}
    );
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...preCreatedRow,
      metadata: { ai_configuration: snapshot },
    });
    (prepareWorkflowSource as ReturnType<typeof mock>).mockClear();
    (executeWorkflow as ReturnType<typeof mock>).mockClear();

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
      detachedRunId: 'run-precreated',
      conversationId: 'cli-123',
      noWorktree: true,
    });

    expect(prepareWorkflowSource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId: 'run-precreated' })
    );
    const opts = (executeWorkflow as ReturnType<typeof mock>).mock.calls.at(-1)?.[7] as {
      preCreatedRun?: { id: string };
      preparedAiConfiguration?: PreparedRunAiConfiguration;
      priorCompletedNodes?: unknown;
    };
    expect(opts.preCreatedRun?.id).toBe('run-precreated');
    expect(opts.preparedAiConfiguration?.config.assistant).toBe('codex');
    expect(opts.preparedAiConfiguration?.config.assistants.codex.model).toBe('launch-model');
    // A fresh pre-created row is NOT a resume: prior state would make the executor
    // skip nodes that never ran.
    expect(opts.priorCompletedNodes).toBeUndefined();
    // The live-owner endpoint is keyed on the run this process owns, and only a
    // detached child exposes active stop.
    expect(mockStartRunLiveOwner).toHaveBeenCalledWith('run-precreated', {
      detachedProcessPid: process.pid,
    });
  });

  // #2872 R2 — everything between the handover and the executor claiming the row can
  // throw, and the launcher is gone by then. Without this the row sits `pending`
  // forever and the reason lives only in the child's log: the same silent failure,
  // moved one process later.
  it('fails the handed-over row when it throws before the executor claims it', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan', description: 'Plan work' })],
      errors: [],
    });
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(preCreatedRow);
    // No project resolves, so the isolation gate throws after the row was handed over.
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (workflowDb.getWorkflowRunStatus as ReturnType<typeof mock>).mockResolvedValueOnce('pending');
    (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
        detachedRunId: 'run-precreated',
        conversationId: 'cli-123',
      })
    ).rejects.toThrow(/Cannot create worktree/);

    expect(workflowDb.failWorkflowRun).toHaveBeenCalledWith(
      'run-precreated',
      expect.stringContaining('Detached run failed to start'),
      { exitReason: 'launch_failed' }
    );
  });

  it('leaves a row the executor already claimed to its own lifecycle', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan', description: 'Plan work' })],
      errors: [],
    });
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(preCreatedRow);
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    // The run got as far as executing — its lifecycle is not this handler's to mutate.
    (workflowDb.getWorkflowRunStatus as ReturnType<typeof mock>).mockResolvedValueOnce('running');
    (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
        detachedRunId: 'run-precreated',
        conversationId: 'cli-123',
      })
    ).rejects.toThrow(/Cannot create worktree/);

    expect(workflowDb.failWorkflowRun).not.toHaveBeenCalled();
  });

  // #2872 R3 — the flag names a row this process will execute AS. Both halves are
  // checked: that this really is a detached child, and that the row is claimable.
  it('refuses the flag outside a detached child', async () => {
    delete process.env.ARCHON_DETACHED_RUN_OWNER;

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
        detachedRunId: 'run-precreated',
      })
    ).rejects.toThrow(/set by a detached launch for its own child/);
  });

  it('refuses a row that is not awaiting its first execution', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...preCreatedRow,
      status: 'completed',
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
        detachedRunId: 'run-precreated',
        conversationId: 'cli-123',
      })
    ).rejects.toThrow(/it is completed, not a run awaiting its first execution/);
  });

  it('refuses a row belonging to a different workflow', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const workflowDb = await import('@archon/core/db/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan', description: 'Plan work' })],
      errors: [],
    });
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...preCreatedRow,
      workflow_name: 'something-else',
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
        detachedRunId: 'run-precreated',
        conversationId: 'cli-123',
      })
    ).rejects.toThrow(/belongs to workflow 'something-else', not 'plan'/);
  });

  it('fails loudly when the row its launcher promised is gone', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
        detachedRunId: 'run-vanished',
        conversationId: 'cli-123',
      })
    ).rejects.toThrow(/cannot find the run 'run-vanished'/);
  });
});

describe('workflowRunCommand — durable wait occurrence ownership', () => {
  for (const owner of ['node', 'loop_group'] as const) {
    for (const kind of ['time', 'event'] as const) {
      for (const replacement of ['first-read', 'poll', 'none'] as const) {
        it(`keeps its ${owner} ${kind} occurrence when replacement is ${replacement}`, async () => {
          const discovery = await import('@archon/workflows/workflow-discovery');
          const discover = spyOn(discovery, 'discoverWorkflowsWithConfig').mockResolvedValue({
            workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
            errors: [],
          });
          const host = createTestWorkflowHost();
          const codebases = await import('@archon/core/db/codebases');
          const findCodebase = spyOn(codebases, 'findCodebaseByDefaultCwd').mockResolvedValue({
            id: 'cb-wait',
            ai_assistant_type: null,
            commands: {},
            name: 'wait',
            repository_url: '',
            default_cwd: testHome,
            kind: 'folder',
            default_branch: 'main',
            created_at: new Date(),
            updated_at: new Date(),
          });
          const wait = {
            owner,
            kind,
            ...(owner === 'loop_group'
              ? { bodyWaitId: 'body-wait', iteration: 2, sessionId: null, sessionProvider: null }
              : {}),
            nodeId: 'checks',
            ...(kind === 'event' ? { event: 'checks.complete' } : {}),
            pauseId: 'occurrence-a',
            waitingSince: new Date().toISOString(),
            resumeAt: '',
          };
          const run: WorkflowRun = {
            id: 'run-wait',
            workflow_name: 'plan',
            status: 'paused',
            working_path: testHome,
            metadata: { wait },
            origin: null,
            conversation_id: null,
            parent_conversation_id: null,
            codebase_id: null,
            outcome: null,
            user_message: 'go',
            started_at: new Date(),
            completed_at: null,
            last_activity_at: null,
            user_id: null,
            parent_run_id: null,
            adopted_from_run_id: null,
            output_root: null,
            checkout_baseline: null,
          };
          wait.resumeAt = new Date(Date.now() + 20).toISOString();
          let reads = 0;
          host.deps.store.getWorkflowRun = mock(async () => {
            reads += 1;
            if (reads === 1 && replacement !== 'first-read') return run;
            if (reads > 1)
              clock.mockReturnValue(
                Date.parse(wait.resumeAt) -
                  (replacement === 'none' && (reads === 2 || kind === 'event') ? 1 : 0)
              );
            return {
              ...run,
              metadata: {
                wait: {
                  ...wait,
                  pauseId: replacement !== 'none' ? 'occurrence-b' : 'occurrence-a',
                  ...(kind === 'event' && (replacement !== 'none' || reads > 2)
                    ? { signaledAt: new Date().toISOString() }
                    : {}),
                },
              },
            };
          });
          const submit = spyOn(host.engine, 'submit').mockResolvedValue({
            success: true,
            workflowRunId: run.id,
            paused: true,
            waitCursor: {
              kind: 'wait',
              nodeId: wait.nodeId,
              resumeAt: wait.resumeAt,
              pauseId: wait.pauseId,
            },
          });
          const resume = spyOn(host.engine, 'resume').mockResolvedValue({
            accepted: true,
            runId: run.id,
            settled: Promise.resolve({ success: true, workflowRunId: run.id }),
          });
          const output = spyOn(console, 'log').mockImplementation(() => {});
          const clock = spyOn(Date, 'now').mockReturnValue(Date.parse(wait.resumeAt) - 20);
          try {
            await workflowRunCommand(host, testHome, 'plan', 'go', {
              noWorktree: true,
              quiet: true,
            });
            expect(submit).toHaveBeenCalledTimes(1);
            expect(reads).toBe(replacement === 'first-read' ? 1 : replacement === 'poll' ? 2 : 3);
            if (replacement !== 'none') expect(resume).not.toHaveBeenCalled();
            else
              expect(resume).toHaveBeenCalledWith(
                expect.objectContaining({
                  cursor: {
                    kind: 'wait',
                    nodeId: 'checks',
                    resumeAt: wait.resumeAt,
                    pauseId: 'occurrence-a',
                  },
                })
              );
          } finally {
            submit.mockRestore();
            resume.mockRestore();
            output.mockRestore();
            discover.mockRestore();
            findCodebase.mockRestore();
            clock.mockRestore();
          }
        });
      }
    }
  }
});

describe('pendingDurableWait — which pauses this process owns', () => {
  const run = (status: WorkflowRunStatus, metadata: Record<string, unknown>): WorkflowRun =>
    ({ id: 'run-wait', status, metadata }) as unknown as WorkflowRun;

  it('reads the cursor for a time wait', () => {
    expect(
      pendingDurableWait(
        run('paused', {
          wait: {
            owner: 'node',
            kind: 'time',
            pauseId: 'time-occurrence',
            nodeId: 'cooldown',
            waitingSince: '2026-01-01T00:00:00.000Z',
            resumeAt: '2026-01-01T00:01:00.000Z',
          },
        })
      )
    ).toEqual({
      stepName: 'cooldown',
      cursor: {
        kind: 'wait',
        nodeId: 'cooldown',
        resumeAt: '2026-01-01T00:01:00.000Z',
        pauseId: 'time-occurrence',
      },
      signaled: false,
    });
  });

  it('marks a signaled event wait and names a loop-owned body wait', () => {
    expect(
      pendingDurableWait(
        run('paused', {
          wait: {
            owner: 'loop_group',
            nodeId: 'poll',
            bodyWaitId: 'checks',
            iteration: 2,
            sessionId: null,
            sessionProvider: null,
            kind: 'event',
            event: 'checks.complete',
            waitingSince: '2026-01-01T00:00:00.000Z',
            resumeAt: '2026-01-01T00:05:00.000Z',
            signaledAt: '2026-01-01T00:00:30.000Z',
          },
        })
      )
    ).toEqual({
      stepName: 'poll.checks',
      cursor: { kind: 'wait', nodeId: 'poll', resumeAt: '2026-01-01T00:05:00.000Z' },
      signaled: true,
    });
  });

  it('returns nothing for a running run, an attention wait, or an approval gate', () => {
    expect(pendingDurableWait(run('running', {}))).toBeUndefined();
    expect(
      pendingDurableWait(
        run('paused', {
          wait: {
            owner: 'node',
            kind: 'attention',
            nodeId: 'await-operator',
            waitingSince: '2026-01-01T00:00:00.000Z',
            message: 'Do the outside action',
          },
        })
      )
    ).toBeUndefined();
    expect(
      pendingDurableWait(run('paused', { approval: { nodeId: 'gate', message: 'ok?' } }))
    ).toBeUndefined();
  });
});

describe('workflowApproveCommand / workflowRejectCommand / workflowResumeCommand — detach', () => {
  const trackTempRoot = trackTempRoots();
  let consoleSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    jest.useFakeTimers();
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
  });

  afterEach(() => {
    jest.useRealTimers();
    consoleSpy.mockRestore();
    warnSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  // working_path is deliberately a distro-style path: the child must spawn with
  // the PARENT's cwd (it re-resolves by run-id), because a container run's
  // working_path is unreachable on the host and would ENOENT the spawn.
  const pausedRun = {
    origin: { conversationId: 'conv-123' },
    id: 'run-123',
    status: 'paused',
    workflow_name: 'assist',
    working_path: '/distro/only/path',
    conversation_id: 'conv-123',
    user_message: 'hello',
    metadata: { approval: { nodeId: 'gate', message: 'Approve?' } },
  };

  it('approve --detach spawns a detached child (minus --detach) without changing run state in the parent', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({ ...pausedRun });

    const updateBefore = (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mock.calls
      .length;
    const execBefore = (executeWorkflow as ReturnType<typeof mock>).mock.calls.length;
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'approve', 'run-123', 'ship it', '--detach'];

    let spawnCmd: string[] = [];
    let spawnOptions: DetachedSpawnOptions | undefined;
    try {
      // Signature: (runId, comment, json, cwd, detach) — detach is the 5th arg,
      // layered after upstream's cwd.
      const commandPromise = workflowApproveCommand(
        createTestWorkflowHost(),
        'run-123',
        'ship it',
        undefined,
        undefined,
        true
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      spawnCmd = (spawnOptions?.cmd ?? []).slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(spawnOptions?.detached).toBe(true);
    expect(spawnCmd).not.toContain('--detach');
    expect(spawnCmd).toContain('approve');
    expect(spawnCmd).toContain('run-123');
    // Parent cwd, never the run's working_path (see pausedRun comment above).
    expect(spawnOptions?.cwd).toBe(process.cwd());
    expect(spawnCmd).not.toContain('/distro/only/path');
    // ZERO state mutation in the detaching parent — the child owns the approve
    // (a parent-side approve would record the decision twice).
    expect((workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(
      updateBefore
    );
    expect((executeWorkflow as ReturnType<typeof mock>).mock.calls.length).toBe(execBefore);
    expect(consoleSpy).toHaveBeenCalledWith("Started 'approve' for run run-123 in the background.");
    expect(consoleSpy).toHaveBeenCalledWith(
      `Child output: ${join(testHome, 'logs', 'detached-run-run-123.log')}`
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('approve --detach --json emits a structured ack on stdout without approving', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({ ...pausedRun });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'approve', 'run-123', '--detach', '--json'];

    try {
      const commandPromise = workflowApproveCommand(
        createTestWorkflowHost(),
        'run-123',
        undefined,
        true,
        undefined,
        true
      );
      await finishStartupWindow(commandPromise, spawnSpy);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    // The ack goes through writeJsonLine (flushed stdout), not console.log — a
    // console.log ack can be truncated on a pipe (#2384).
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      ok: true,
      runId: 'run-123',
      action: 'approve',
      detached: true,
      workflowName: 'assist',
    });
    expect(parsed.logPath).toBe(join(testHome, 'logs', 'detached-run-run-123.log'));
  });

  it('--detach --json spawns a child WITHOUT --json (so it continues) and says so in the ack', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({ ...pausedRun });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'approve', 'run-123', '--detach', '--json'];

    let spawnCmd: string[] = [];
    try {
      const commandPromise = workflowApproveCommand(
        createTestWorkflowHost(),
        'run-123',
        undefined,
        true,
        undefined,
        true
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnCmd = firstDetachedSpawnOptions(spawnSpy).cmd.slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    // Both flags are stripped: the child runs the ordinary inline path, which
    // auto-resumes. That is deliberate — --detach exists to host that execution.
    expect(spawnCmd).not.toContain('--detach');
    expect(spawnCmd).not.toContain('--json');
    // ...so the ack must tell the caller it does NOT own continuation.
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: true, detached: true, continues: true });
  });

  it('threads a caller-supplied --cwd to the child instead of the parent process.cwd()', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({ ...pausedRun });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = [
      'bun',
      '/abs/cli.ts',
      'workflow',
      'approve',
      'run-123',
      '--cwd',
      '/caller/repo',
      '--detach',
    ];

    let spawnCmd: string[] = [];
    let spawnOptions: DetachedSpawnOptions | undefined;
    try {
      const commandPromise = workflowApproveCommand(
        createTestWorkflowHost(),
        'run-123',
        undefined,
        undefined,
        '/caller/repo',
        true
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      spawnCmd = (spawnOptions?.cmd ?? []).slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(spawnOptions?.cwd).toBe('/caller/repo');
    // buildDetachedRunCmd appends --cwd LAST (parser is last-wins), so the
    // appended value is what the child actually resolves.
    const lastCwdIdx = spawnCmd.lastIndexOf('--cwd');
    expect(spawnCmd[lastCwdIdx + 1]).toBe('/caller/repo');
  });

  it('approve --detach rejects an immediate non-zero child exit instead of acking success', async () => {
    // The parent awaits spawnDetachedWorkflowRun's startup window (#2279). Without
    // that await the failure arrives as an unhandled rejection AFTER `{ok:true}`
    // has already been printed — the exact hole --detach exists to close.
    const workflowDb = await import('@archon/core/db/workflows');
    const tempHome = testHome;
    const logPath = join(tempHome, 'logs', 'detached-run-run-123.log');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({ ...pausedRun });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'approve', 'run-123', '--detach', '--json'];

    try {
      const commandPromise = workflowApproveCommand(
        createTestWorkflowHost(),
        'run-123',
        undefined,
        true,
        undefined,
        true
      );
      for (let attempt = 0; attempt < 200 && spawnSpy.mock.calls.length === 0; attempt++) {
        await Promise.resolve();
      }
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      appendFileSync(logPath, 'database unavailable during startup\n');
      const spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      spawnOptions.onExit?.(child.child, 1, null);
      await commandPromise;
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    // --json turns the throw into the standard { ok: false } line; either way the
    // caller never sees a success ack for a child that died on startup.
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: false, runId: 'run-123', action: 'approve' });
    expect(String(parsed.error)).toMatch(/exit code 1[\s\S]*database unavailable during startup/);
  });

  it('approve --detach refuses a non-paused run synchronously and spawns nothing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      status: 'running',
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);

    let spawnCallCount = -1;
    try {
      await expect(
        workflowApproveCommand(
          createTestWorkflowHost(),
          'run-123',
          undefined,
          undefined,
          undefined,
          true
        )
      ).rejects.toThrow("Cannot approve run with status 'running'");
      spawnCallCount = spawnSpy.mock.calls.length;
    } finally {
      spawnSpy.mockRestore();
    }
    expect(spawnCallCount).toBe(0);
  });

  it('approve --detach --json reports a refusal as { ok: false } and spawns nothing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      status: 'completed',
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);

    let spawnCallCount = -1;
    try {
      await workflowApproveCommand(
        createTestWorkflowHost(),
        'run-123',
        undefined,
        true,
        undefined,
        true
      );
      spawnCallCount = spawnSpy.mock.calls.length;
    } finally {
      spawnSpy.mockRestore();
    }

    expect(spawnCallCount).toBe(0);
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: false, runId: 'run-123', action: 'approve' });
    expect(String(parsed.error)).toContain("Cannot approve run with status 'completed'");
  });

  it('approve --detach refuses a child_workflow-blocked parent and spawns nothing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      metadata: {
        approval: { nodeId: 'sub', message: 'blocked', type: 'child_workflow', childRunId: 'c-9' },
      },
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowApproveCommand(
          createTestWorkflowHost(),
          'run-123',
          undefined,
          undefined,
          undefined,
          true
        )
      ).rejects.toThrow(
        'Approve or reject the child run instead. Approve it by run id: ' +
          '`archon workflow approve c-9`'
      );
      expect(spawnSpy.mock.calls.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('approve --detach refuses an already-resolved gate and spawns nothing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      metadata: { approval: { nodeId: 'gate', message: 'Approve?', resolved: 'approved' } },
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowApproveCommand(
          createTestWorkflowHost(),
          'run-123',
          undefined,
          undefined,
          undefined,
          true
        )
      ).rejects.toThrow('was already approved and is awaiting resume');
      expect(spawnSpy.mock.calls.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('approve --detach refuses a missing approval context and spawns nothing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      metadata: {},
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowApproveCommand(
          createTestWorkflowHost(),
          'run-123',
          undefined,
          undefined,
          undefined,
          true
        )
      ).rejects.toThrow('Workflow run is paused but missing approval context.');
      expect(spawnSpy.mock.calls.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('approve --detach refuses a run with no recorded working path and spawns nothing', async () => {
    // The child always auto-resumes after approving, and a resume needs a working
    // path. Refuse in the parent rather than letting the child throw into its log.
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      working_path: null,
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowApproveCommand(
          createTestWorkflowHost(),
          'run-123',
          undefined,
          undefined,
          undefined,
          true
        )
      ).rejects.toThrow('has no working path recorded');
      expect(spawnSpy.mock.calls.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('resume --detach refuses a run with no recorded working path and spawns nothing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      status: 'failed',
      working_path: null,
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowResumeCommand(createTestWorkflowHost(), 'run-123', undefined, undefined, true)
      ).rejects.toThrow('has no working path recorded');
      expect(spawnSpy.mock.calls.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('resume --detach refuses a run whose worktree is gone and spawns nothing (#4090)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      status: 'failed',
      working_path: join(tmpdir(), 'archon-removed-worktree-4090'),
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowResumeCommand(createTestWorkflowHost(), 'run-123', undefined, undefined, true)
      ).rejects.toThrow('the working path from the run no longer exists');
      expect(spawnSpy.mock.calls.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'resume --detach reports an unreadable worktree as a filesystem error, not as removed (#4090)',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'archon-unreadable-worktree-'));
      const workingPath = join(root, 'worktree');
      mkdirSync(workingPath);
      chmodSync(root, 0o000);
      const workflowDb = await import('@archon/core/db/workflows');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        ...pausedRun,
        status: 'failed',
        working_path: workingPath,
      });
      const child = createDetachedChildFixture();
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
      try {
        await expect(
          workflowResumeCommand(createTestWorkflowHost(), 'run-123', undefined, undefined, true)
        ).rejects.toMatchObject({ code: 'EACCES' });
        expect(spawnSpy.mock.calls.length).toBe(0);
      } finally {
        spawnSpy.mockRestore();
        chmodSync(root, 0o700);
        await removeTempTree(root);
      }
    }
  );

  it('reject --detach refuses a child_workflow-blocked parent but TOLERATES missing context', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      metadata: {
        approval: { nodeId: 'sub', message: 'blocked', type: 'child_workflow', childRunId: 'c-9' },
      },
    });
    const blockedChild = createDetachedChildFixture();
    let spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(blockedChild.child);
    try {
      await expect(
        workflowRejectCommand(
          createTestWorkflowHost(),
          'run-123',
          undefined,
          undefined,
          undefined,
          true
        )
      ).rejects.toThrow(
        'Reject the child run instead, or abandon this run to discard the whole tree. ' +
          'Reject it by run id: `archon workflow reject c-9`'
      );
      expect(spawnSpy.mock.calls.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
    }

    // reject has no nodeId requirement — a malformed context must still spawn.
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      metadata: {},
    });
    const child = createDetachedChildFixture();
    spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'reject', 'run-123', '--detach'];
    try {
      const commandPromise = workflowRejectCommand(
        createTestWorkflowHost(),
        'run-123',
        undefined,
        undefined,
        undefined,
        true
      );
      await finishStartupWindow(commandPromise, spawnSpy);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }
  });

  it('reject --detach spawns a detached child (minus --detach) without changing run state in the parent', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({ ...pausedRun });

    const updateBefore = (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mock.calls
      .length;
    const execBefore = (executeWorkflow as ReturnType<typeof mock>).mock.calls.length;
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'reject', 'run-123', 'not good', '--detach'];

    let spawnCmd: string[] = [];
    try {
      const commandPromise = workflowRejectCommand(
        createTestWorkflowHost(),
        'run-123',
        'not good',
        undefined,
        undefined,
        true
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnCmd = firstDetachedSpawnOptions(spawnSpy).cmd.slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(spawnCmd).not.toContain('--detach');
    expect(spawnCmd).toContain('reject');
    expect(spawnCmd).toContain('run-123');
    expect((workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(
      updateBefore
    );
    expect((executeWorkflow as ReturnType<typeof mock>).mock.calls.length).toBe(execBefore);
    expect(consoleSpy).toHaveBeenCalledWith("Started 'reject' for run run-123 in the background.");
  });

  it('resume --detach spawns a detached child (minus --detach) and does NOT execute in the parent', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    // resume validates read-only via resumeWorkflowOp, which reads getWorkflowRun;
    // a failed run is resumable.
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      status: 'failed',
      working_path: trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-resume-detach-'))),
    });

    const execBefore = (executeWorkflow as ReturnType<typeof mock>).mock.calls.length;
    const child = new childProcess.ChildProcess();
    const receipt = new PassThrough();
    Object.defineProperty(child, 'stdio', { value: [null, null, null, receipt] });
    Object.defineProperty(child, 'pid', { value: 12345 });
    const spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'resume', 'run-123', '--detach'];

    let spawnCmd: string[] = [];
    try {
      const commandPromise = workflowResumeCommand(
        createTestWorkflowHost(),
        'run-123',
        undefined,
        undefined,
        true
      );
      for (let attempt = 0; attempt < 200 && spawnSpy.mock.calls.length === 0; attempt++) {
        await Promise.resolve();
      }
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(501);
      await Promise.resolve();
      await Promise.resolve();
      expect(consoleSpy).not.toHaveBeenCalledWith(
        "Started 'resume' for run run-123 in the background."
      );
      receipt.write(DETACHED_RESUME_RECEIPT);
      await commandPromise;
      spawnCmd = [...(spawnSpy.mock.calls[0][1] ?? [])];
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
      receipt.destroy();
    }

    expect(spawnCmd).not.toContain('--detach');
    expect(spawnCmd).toContain('resume');
    expect(spawnCmd).toContain('run-123');
    expect((executeWorkflow as ReturnType<typeof mock>).mock.calls.length).toBe(execBefore);
  });

  it('resume --detach fails fast with the executable when the child fails to spawn', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      status: 'failed',
      working_path: trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-resume-detach-'))),
    });

    // Bun's failed spawn: no pid and no receipt pipe; the ENOENT arrives later as an event.
    const child = new childProcess.ChildProcess();
    Object.defineProperty(child, 'stdio', { value: [null, null, null, null] });
    const spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'resume', 'run-123', '--detach'];

    try {
      await expect(
        workflowResumeCommand(createTestWorkflowHost(), 'run-123', undefined, undefined, true)
      ).rejects.toThrow(/Failed to start detached workflow child \(executable: /);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }
    expect(consoleSpy).not.toHaveBeenCalledWith(
      "Started 'resume' for run run-123 in the background."
    );
  });
});

describe('buildDetachedRunCmd', () => {
  // BUNDLED_IS_BINARY is a module-level const (mocked false), so the binary
  // branch is unreachable through spawnDetachedWorkflowRun — exercise both
  // branches directly via the pure builder.

  it('dev mode: keeps [execPath, entryScript], slices argv(2), drops --detach/--json', () => {
    const cmd = buildDetachedRunCmd(
      false,
      '/path/to/bun',
      ['/path/to/bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach', '--json'],
      '/abs/cwd',
      ['--branch', 'assist-123', '--conversation-id', 'cli-1']
    );

    expect(cmd[0]).toBe('/path/to/bun');
    expect(cmd[1]).toBe('/abs/cli.ts');
    expect(cmd).not.toContain('--detach');
    expect(cmd).not.toContain('--json');
    expect(cmd).toContain('assist');
    // --cwd pinned absolute, then extra flags
    const cwdIdx = cmd.indexOf('--cwd');
    expect(cmd[cwdIdx + 1]).toBe('/abs/cwd');
    expect(cmd).toContain('--branch');
    expect(cmd).toContain('--conversation-id');
  });

  // A Bun single-file executable's argv is NOT [binary, ...userArgs]. Bun
  // injects a virtual entry path at argv[1] and reports argv[0] as 'bun':
  //   ['bun', '/$bunfs/root/archon', 'workflow', 'run', ...]
  // Verified against a real `bun build --compile` artifact. The previous
  // fixture modelled a compiled argv with no argv[1] at all, which is why
  // #2248 (detached child dies with `Unknown command: B:/~BUN/root/...`)
  // shipped green.
  // `--input` is the first repeatable flag in the tree (#2554). Nothing here handles
  // repetition specially — argv is forwarded verbatim — so this pins the property a
  // future change to the argv rebuild could silently break, turning a detached run into
  // one that starts with its inputs missing instead of failing.
  it('forwards every repeated --input to the detached child', () => {
    const cmd = buildDetachedRunCmd(
      false,
      '/path/to/bun',
      [
        '/path/to/bun',
        '/abs/cli.ts',
        'workflow',
        'run',
        'review-block',
        '--input',
        'diff=D1',
        '--input',
        'style=terse',
        '--detach',
      ],
      '/abs/cwd',
      []
    );

    expect(cmd.filter(arg => arg === '--input')).toHaveLength(2);
    expect(cmd).toContain('diff=D1');
    expect(cmd).toContain('style=terse');
    expect(cmd).not.toContain('--detach');
  });

  it('binary mode: uses [execPath] only (no duplicated entry arg), drops the Bun SFE virtual argv[1]', () => {
    const cmd = buildDetachedRunCmd(
      true,
      '/usr/local/bin/archon',
      ['bun', '/$bunfs/root/archon', 'workflow', 'run', 'assist', 'hello', '--detach', '--json'],
      '/abs/cwd',
      ['--branch', 'assist-123']
    );

    expect(cmd[0]).toBe('/usr/local/bin/archon');
    // The binary path must appear exactly once — never duplicated as argv[1].
    expect(cmd.filter(arg => arg === '/usr/local/bin/archon')).toHaveLength(1);
    // The virtual entry path must never reach the child: cli.ts parses
    // process.argv.slice(2), so a leaked argv[1] becomes the child's command.
    expect(cmd.some(arg => arg.includes('$bunfs'))).toBe(false);
    expect(cmd[1]).toBe('workflow');
    expect(cmd).not.toContain('--detach');
    expect(cmd).not.toContain('--json');
    const cwdIdx = cmd.indexOf('--cwd');
    expect(cmd[cwdIdx + 1]).toBe('/abs/cwd');
    expect(cmd.slice(cwdIdx + 2)).toEqual(['--branch', 'assist-123']);
  });

  it('binary mode: drops the Windows Bun SFE virtual argv[1] (#2248 repro)', () => {
    const cmd = buildDetachedRunCmd(
      true,
      'C:\\Users\\dev\\archon.exe',
      [
        'bun',
        'B:/~BUN/root/archon-windows-x64.exe',
        'workflow',
        'run',
        'assist',
        'hello',
        '--detach',
        '--json',
      ],
      'C:\\checkout',
      ['--branch', 'assist-123']
    );

    expect(cmd[0]).toBe('C:\\Users\\dev\\archon.exe');
    // The exact token that appeared as `Unknown command: ...` in the report.
    expect(cmd).not.toContain('B:/~BUN/root/archon-windows-x64.exe');
    expect(cmd[1]).toBe('workflow');
    expect(cmd[2]).toBe('run');
  });
});

describe('resolveDetachedRunEncryptionEnv', () => {
  it('pins both absence and a relative home before the child changes cwd', () => {
    expect(resolveDetachedRunEncryptionEnv({}, '/parent/repo')).toEqual({
      TOKEN_ENCRYPTION_KEY: '',
      ARCHON_HOME: '',
      ARCHON_DOCKER: '',
      WORKSPACE_PATH: '',
      HOME: '',
      USERPROFILE: '',
    });
    expect(
      resolveDetachedRunEncryptionEnv(
        { TOKEN_ENCRYPTION_KEY: 'install-key', ARCHON_HOME: './relative-home' },
        '/parent/repo'
      )
    ).toEqual({
      TOKEN_ENCRYPTION_KEY: 'install-key',
      ARCHON_HOME: resolve('/parent/repo', 'relative-home'),
      ARCHON_DOCKER: '',
      WORKSPACE_PATH: '',
      HOME: '',
      USERPROFILE: '',
    });
    expect(resolveDetachedRunEncryptionEnv({ ARCHON_HOME: '~/.archon-custom' }, '/parent')).toEqual(
      {
        TOKEN_ENCRYPTION_KEY: '',
        ARCHON_HOME: join(homedir(), '.archon-custom'),
        ARCHON_DOCKER: '',
        WORKSPACE_PATH: '',
        HOME: '',
        USERPROFILE: '',
      }
    );
    const dockerHandoff = resolveDetachedRunEncryptionEnv(
      { ARCHON_DOCKER: 'true', ARCHON_HOME: '/ignored-custom-home' },
      '/parent'
    );
    expect(dockerHandoff).toEqual({
      TOKEN_ENCRYPTION_KEY: '',
      ARCHON_HOME: '/.archon',
      ARCHON_DOCKER: 'true',
      WORKSPACE_PATH: '',
      HOME: '',
      USERPROFILE: '',
    });
    expect(isDocker(dockerHandoff)).toBe(true);
    expect(getArchonHome(dockerHandoff)).toBe('/.archon');
  });
});

describe('workflowResumeCommand', () => {
  const trackTempRoot = trackTempRoots();
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockLogger.error.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should throw when run not found', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(workflowResumeCommand(createTestWorkflowHost(), 'missing-id')).rejects.toThrow(
      'Workflow run not found: missing-id'
    );
  });

  it('should throw when run is not resumable', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'test',
      status: 'completed',
    });

    await expect(workflowResumeCommand(createTestWorkflowHost(), 'run-1')).rejects.toThrow(
      "Cannot resume run with status 'completed'"
    );
  });

  it('should print resume info and delegate to workflowRunCommand', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'implement',
      status: 'failed',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
    });

    // workflowResumeCommand calls workflowRunCommand internally which needs many
    // mocks. The --resume execution flow is tested separately in workflowRunCommand tests.
    // Here we only verify the initial output by catching the downstream error.
    try {
      await workflowResumeCommand(createTestWorkflowHost(), 'run-1');
    } catch {
      // workflowRunCommand will fail due to missing mocks — that's fine
    }

    // Printed resume message before delegating to workflowRunCommand
    expect(consoleSpy).toHaveBeenCalledWith('Resuming workflow: implement');
    expect(consoleSpy).toHaveBeenCalledWith('Path: /tmp/test-worktree');
  });

  it('should throw when run has no working path', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-no-path',
      workflow_name: 'implement',
      status: 'failed',
      working_path: null,
    });

    await expect(workflowResumeCommand(createTestWorkflowHost(), 'run-no-path')).rejects.toThrow(
      'has no working path recorded'
    );
  });

  it('should pass codebase_id from run record to workflowRunCommand', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'implement',
      status: 'failed',
      user_message: 'add auth',
      working_path: trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-resume-codebase-'))),
      codebase_id: 'cb-existing',
    });

    // Return a matching workflow so workflowRunCommand doesn't throw before codebase lookup
    (
      workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>
    ).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'implement' })],
      errors: [],
    });

    // Simulate getCodebase returning the codebase found by ID
    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-existing',
      name: 'owner/repo',
      default_cwd: '/path/to/main-checkout', // different from working_path
    });

    try {
      await workflowResumeCommand(createTestWorkflowHost(), 'run-1');
    } catch {
      // workflowRunCommand may fail on other mocks — that's fine
    }

    // getCodebase SHOULD have been called with the stored codebase_id
    expect(codebaseDb.getCodebase).toHaveBeenCalledWith('cb-existing');
  });

  it('fails loudly when getCodebase throws during resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-err',
      workflow_name: 'implement',
      status: 'failed',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
      codebase_id: 'cb-bad',
    });

    // getCodebase throws — simulates DB hiccup
    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('connection refused')
    );

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await expect(workflowResumeCommand(createTestWorkflowHost(), 'run-err')).rejects.toThrow(
      "Failed to load codebase 'cb-bad' for workflow run 'run-err'"
    );

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-bad' }),
      'cli.workflow_resume_codebase_lookup_failed'
    );
    expect(discoverSpy).not.toHaveBeenCalledWith(
      '/tmp/test-worktree',
      expect.any(Function),
      providerRegistry
    );
  });

  it('fails loudly when codebase row is missing during resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-missing-codebase',
      workflow_name: 'implement',
      status: 'failed',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
      codebase_id: 'cb-missing',
    });
    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await expect(
      workflowResumeCommand(createTestWorkflowHost(), 'run-missing-codebase')
    ).rejects.toThrow("references codebase 'cb-missing', but that codebase no longer exists");
    expect(discoverSpy).not.toHaveBeenCalledWith(
      '/tmp/test-worktree',
      expect.any(Function),
      providerRegistry
    );
  });

  it('should discover workflows from codebase.default_cwd, not working_path', async () => {
    // Regression test for #1663: when working_path is a worktree or workspace
    // clone that lacks the user's local workflow YAML, discovery must fall back
    // to codebase.default_cwd so the file is still found.
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1663',
      workflow_name: 'my-approval-workflow',
      status: 'failed',
      user_message: 'go',
      working_path: trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-worktree-without-yaml-'))),
      codebase_id: 'cb-with-yaml',
    });

    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-with-yaml',
      name: 'owner/repo',
      default_cwd: '/users/me/source-repo-with-yaml',
    });

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();
    discoverSpy.mockResolvedValueOnce({ workflows: [], errors: [] });

    try {
      await workflowResumeCommand(createTestWorkflowHost(), 'run-1663');
    } catch {
      // downstream failure is acceptable — we only need to assert the discovery cwd
    }

    // A continuation takes no new capture, so discovery still reads the codebase source
    // path directly — #1663's guarantee, unchanged.
    expect(discoverSpy).toHaveBeenCalledWith(
      '/users/me/source-repo-with-yaml',
      expect.any(Function),
      providerRegistry
    );
  });

  it('should fall back to working_path for discovery when codebase_id is missing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    const worktree = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-old-worktree-')));
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-no-codebase',
      workflow_name: 'legacy',
      status: 'failed',
      user_message: 'go',
      working_path: worktree,
      codebase_id: null,
    });

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();
    discoverSpy.mockResolvedValueOnce({ workflows: [], errors: [] });

    try {
      await workflowResumeCommand(createTestWorkflowHost(), 'run-no-codebase');
    } catch {
      // downstream failure is acceptable
    }

    // No codebase → falls back to working_path (preserves existing behavior)
    expect(discoverSpy).toHaveBeenCalledWith(worktree, expect.any(Function), providerRegistry);
  });

  it('resolves a resumed worktree through its Git-proven source checkout (#2127)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const git = await import('@archon/git');
    const { registerRepository } = await import('@archon/core');
    const worktree = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-resume-2127-')));
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-2127',
      workflow_name: 'implement',
      status: 'failed',
      user_message: 'go',
      working_path: worktree,
      codebase_id: null,
    });
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'implement' })],
      errors: [],
    });
    (git.findRepoRoot as ReturnType<typeof mock>).mockResolvedValueOnce(worktree);
    (git.getCanonicalRepoPath as ReturnType<typeof mock>).mockResolvedValueOnce('/registered/root');
    const exact = codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>;
    exact.mockImplementation(async (path: string) =>
      path === '/registered/root'
        ? { id: 'cb-registered', name: 'coleam00/Archon', default_cwd: path, kind: 'repo' }
        : null
    );
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockClear();
    (registerRepository as ReturnType<typeof mock>).mockClear();
    try {
      await workflowResumeCommand(createTestWorkflowHost(), 'run-2127').catch(() => {
        // Only the codebase resolution is under test; what runs after it is not.
      });
      expect(exact).toHaveBeenCalledWith('/registered/root');
      expect(codebaseDb.findCodebaseByPathPrefix).toHaveBeenCalledWith(worktree);
      expect(registerRepository).not.toHaveBeenCalled();
    } finally {
      exact.mockReset().mockResolvedValue(null);
    }
  });

  // Cleanup removes a failed run's worktree once its outcome is settled (#4090). Codebase
  // resolution on the missing path used to fail first, as "Database lookup failed".
  it('refuses a run whose worktree is gone before resolving its codebase (#4090)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const git = await import('@archon/git');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-4090',
      workflow_name: 'implement',
      status: 'failed',
      user_message: 'go',
      working_path: join(tmpdir(), 'archon-removed-worktree-4090'),
      codebase_id: null,
    });
    const findRepoRoot = git.findRepoRoot as ReturnType<typeof mock>;
    findRepoRoot.mockClear();

    await expect(workflowResumeCommand(createTestWorkflowHost(), 'run-4090')).rejects.toThrow(
      'the working path from the run no longer exists'
    );
    expect(findRepoRoot).not.toHaveBeenCalled();
  });
});

describe('workflowApproveCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockLogger.error.mockClear();
    // Earlier suites can leave queued run lookups behind; each test queues its own.
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockReset();
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue(null);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should throw when run not found', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(workflowApproveCommand(createTestWorkflowHost(), 'missing-id')).rejects.toThrow(
      'Workflow run not found: missing-id'
    );
  });

  // #3488: the refusal core throws names no command, so the CLI adds its own spelling
  // on both of its error surfaces — propagation (human) and the --json envelope.
  it('spells the child-run redirect for the CLI on both error surfaces', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const blockedParent = {
      id: 'run-blocked',
      workflow_name: 'implement',
      status: 'paused',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
      codebase_id: 'cb-existing',
      metadata: {
        approval: {
          nodeId: 'sub',
          message: 'blocked',
          type: 'child_workflow',
          childRunId: 'child-42',
        },
      },
    };

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(blockedParent);
    await expect(workflowApproveCommand(createTestWorkflowHost(), 'run-blocked')).rejects.toThrow(
      'Approve it by run id: `archon workflow approve child-42`'
    );

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(blockedParent);
    const stdoutSpy = spyOnJsonStdout();
    try {
      await workflowApproveCommand(createTestWorkflowHost(), 'run-blocked', undefined, true);
      const payload = JSON.parse(firstJsonPayload(stdoutSpy)) as { ok: boolean; error: string };
      expect(payload.ok).toBe(false);
      expect(payload.error).toContain('archon workflow approve child-42');
      expect(payload.error).not.toContain('/workflow ');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('should pass codebase_id from run record to workflowRunCommand', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');
    const core = await import('@archon/core');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-approve-1',
      workflow_name: 'implement',
      status: 'paused',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
      codebase_id: 'cb-existing',
      metadata: { approval: { nodeId: 'review-node' } },
    });

    (core.createWorkflowStore as ReturnType<typeof mock>).mockReturnValueOnce({
      createWorkflowEvent: mock(() => Promise.resolve()),
    });

    (
      workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>
    ).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'implement' })],
      errors: [],
    });

    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-existing',
      name: 'owner/repo',
      default_cwd: '/path/to/main-checkout',
    });

    try {
      await workflowApproveCommand(createTestWorkflowHost(), 'run-approve-1');
    } catch {
      // downstream failure is acceptable
    }

    expect(codebaseDb.getCodebase).toHaveBeenCalledWith('cb-existing');
  });

  it('fails loudly when codebase row is missing during approve auto-resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');
    const core = await import('@archon/core');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-approve-missing-codebase',
      workflow_name: 'implement',
      status: 'paused',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
      codebase_id: 'cb-missing',
      metadata: { approval: { type: 'approval', nodeId: 'review-node', message: 'Approve?' } },
    });
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (core.createWorkflowStore as ReturnType<typeof mock>).mockReturnValueOnce({
      createWorkflowEvent: mock(() => Promise.resolve()),
    });
    const getCodebaseMock = codebaseDb.getCodebase as ReturnType<typeof mock>;
    getCodebaseMock.mockReset();
    getCodebaseMock.mockResolvedValueOnce(null);

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await expect(
      workflowApproveCommand(createTestWorkflowHost(), 'run-approve-missing-codebase')
    ).rejects.toThrow(
      "Approved but failed to resume workflow 'implement': Workflow run 'run-approve-missing-codebase' references codebase 'cb-missing', but that codebase no longer exists"
    );
    expect(discoverSpy).not.toHaveBeenCalledWith(
      '/tmp/test-worktree',
      expect.any(Function),
      providerRegistry
    );
  });

  it('fails with recorded-approval recovery when getCodebase throws during approve auto-resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');
    const core = await import('@archon/core');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-approve-codebase-error',
      workflow_name: 'implement',
      status: 'paused',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
      codebase_id: 'cb-bad',
      metadata: { approval: { type: 'approval', nodeId: 'review-node', message: 'Approve?' } },
    });
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (core.createWorkflowStore as ReturnType<typeof mock>).mockReturnValueOnce({
      createWorkflowEvent: mock(() => Promise.resolve()),
    });
    const getCodebaseMock = codebaseDb.getCodebase as ReturnType<typeof mock>;
    getCodebaseMock.mockReset();
    getCodebaseMock.mockRejectedValueOnce(new Error('database offline'));

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await expect(
      workflowApproveCommand(createTestWorkflowHost(), 'run-approve-codebase-error')
    ).rejects.toThrow(
      "Approved but failed to resume workflow 'implement': Failed to load codebase 'cb-bad' for workflow run 'run-approve-codebase-error': database offline\n" +
        'Cannot safely discover workflows from the run worktree because project workflow files may be missing.\n' +
        'Fix the codebase lookup problem, then retry.\n' +
        "The approval was recorded. Run 'bun run cli workflow resume run-approve-codebase-error' to retry."
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-bad' }),
      'cli.workflow_approve_codebase_lookup_failed'
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-approve-codebase-error' }),
      'cli.workflow_approve_resume_failed'
    );
    expect(discoverSpy).not.toHaveBeenCalledWith(
      '/tmp/test-worktree',
      expect.any(Function),
      providerRegistry
    );
  });

  it('should pass original platform conversation ID through to workflowRunCommand', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const conversationsDb = await import('@archon/core/db/conversations');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      origin: { conversationId: 'db-uuid-original' },
      id: 'run-approve-conv',
      workflow_name: 'implement',
      status: 'paused',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
      codebase_id: 'cb-existing',
      conversation_id: 'db-uuid-original',
      metadata: { approval: { nodeId: 'review-node', message: 'Approve?' } },
    });

    // Return a conversation with the original platform ID
    (conversationsDb.getConversationById as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'db-uuid-original',
      platform_type: 'cli',
      platform_conversation_id: 'cli-original-123',
    });

    (
      workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>
    ).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'implement' })],
      errors: [],
    });

    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-existing',
      name: 'owner/repo',
      default_cwd: '/path/to/main-checkout',
    });

    // Clear call history before our test so we can assert precisely
    (conversationsDb.getOrCreateConversation as ReturnType<typeof mock>).mockClear();

    try {
      await workflowApproveCommand(createTestWorkflowHost(), 'run-approve-conv');
    } catch {
      // downstream failure is acceptable — we only need to reach getOrCreateConversation
    }

    // Verify the original platform conversation ID was passed through
    expect(conversationsDb.getConversationById).toHaveBeenCalledWith('db-uuid-original');
    expect(conversationsDb.getOrCreateConversation).not.toHaveBeenCalled();
  });

  it('should discover workflows from codebase.default_cwd, not working_path', async () => {
    // Regression test for #1663: auto-resume after approve must look up the
    // workflow YAML in the source repo (codebase.default_cwd), not the
    // worktree/workspace working_path that may lack the file.
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');
    const core = await import('@archon/core');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-approve-1663',
      workflow_name: 'my-approval-workflow',
      status: 'paused',
      user_message: 'go',
      working_path: '/tmp/worktree-without-yaml',
      codebase_id: 'cb-with-yaml',
      metadata: { approval: { nodeId: 'gate', message: 'Approve?' } },
    });

    (core.createWorkflowStore as ReturnType<typeof mock>).mockReturnValueOnce({
      createWorkflowEvent: mock(() => Promise.resolve()),
    });

    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-with-yaml',
      name: 'owner/repo',
      default_cwd: '/users/me/source-repo-with-yaml',
    });

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();
    discoverSpy.mockResolvedValueOnce({ workflows: [], errors: [] });

    try {
      await workflowApproveCommand(createTestWorkflowHost(), 'run-approve-1663');
    } catch {
      // downstream failure is acceptable
    }

    expect(discoverSpy).toHaveBeenCalledWith(
      '/users/me/source-repo-with-yaml',
      expect.any(Function),
      providerRegistry
    );
  });
});

describe('workflowAbandonCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockRequestDetachedRunStop.mockReset();
    mockRequestDetachedRunStop.mockImplementation(noOwnerAnswers);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should throw when run not found', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(workflowAbandonCommand(createTestWorkflowHost(), 'missing-id')).rejects.toThrow(
      'Workflow run not found: missing-id'
    );
  });

  it('should throw when run is not abandonable', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'test',
      status: 'completed',
    });

    await expect(workflowAbandonCommand(createTestWorkflowHost(), 'run-1')).rejects.toThrow(
      "Cannot abandon run with status 'completed'"
    );
  });

  it('should abandon a running workflow', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'implement',
      status: 'running',
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      cancelled: true,
    });

    await workflowAbandonCommand(createTestWorkflowHost(), 'run-1');

    expect(workflowDb.cancelWorkflowRun).toHaveBeenCalledWith('run-1', {
      cancel_reason: 'operator',
    });
    expect(consoleSpy).toHaveBeenCalledWith('Abandoned workflow run: run-1');
  });

  for (const json of [false, true]) {
    it(`reports container reclaim failure in ${json ? 'JSON' : 'text'} output`, async () => {
      const workflowDb = await import('@archon/core/db/workflows');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'run-1',
        workflow_name: 'implement',
        status: 'paused',
        metadata: { isolation: 'container', isolation_env_id: 'env-a' },
      });
      (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        cancelled: true,
      });
      mockReclaimContainerEnv.mockRejectedValueOnce(new Error('docker down'));
      const stdout = spyOnJsonStdout();
      try {
        await workflowAbandonCommand(createTestWorkflowHost(), 'run-1', json);
        const output = json
          ? stdout.mock.calls.map((call: unknown[]) => String(call[0])).join('')
          : consoleSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
        expect(output).toContain('Could not reclaim container environment env-a');
        expect(output).toContain('resources may remain allocated');
        if (json) expect(JSON.parse(output).cleanupWarnings).toHaveLength(1);
      } finally {
        stdout.mockRestore();
      }
    });
  }

  it('stops a live owner before recording cancelled and says so', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const order: string[] = [];
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'implement',
      status: 'running',
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockReset();
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockImplementation(async () => {
      order.push('cancel-state');
      return { cancelled: true };
    });
    mockRequestDetachedRunStop.mockImplementationOnce(async () => ({
      pid: 42,
      stop: async () => {
        order.push('terminate');
      },
      release: mockDetachedTargetRelease,
    }));

    await workflowAbandonCommand(createTestWorkflowHost(), 'run-1');

    expect(order).toEqual(['terminate', 'cancel-state']);
    expect(consoleSpy).toHaveBeenCalledWith("Stopped the run's live owner process (pid 42) first.");
    expect(consoleSpy).toHaveBeenCalledWith('Abandoned workflow run: run-1');
  });

  it('prints the recorded owner facts when no owner answers', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'implement',
      status: 'running',
      last_activity_at: new Date('2026-09-20T10:00:00.000Z'),
      metadata: { execution_owner: { host: 'build-box', pid: 4242 } },
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      cancelled: true,
    });

    await workflowAbandonCommand(createTestWorkflowHost(), 'run-1');

    const printed = (consoleSpy.mock.calls as unknown[][]).map(call => String(call[0]));
    expect(printed).toContain('Recorded owner: host build-box, pid 4242.');
    expect(printed).toContain('Last activity: 2026-09-20T10:00:00.000Z.');
    expect(printed.some(line => line.startsWith('The recorded owner is on another host'))).toBe(
      true
    );
    // The facts come before the cancellation line.
    expect(printed.indexOf('Recorded owner: host build-box, pid 4242.')).toBeLessThan(
      printed.indexOf('Abandoned workflow run: run-1')
    );
  });

  it('fails with the reason and leaves the run when the owner cannot be stopped', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'implement',
      status: 'running',
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockClear();
    mockRequestDetachedRunStop.mockImplementationOnce(async () => ({
      pid: 42,
      stop: () => Promise.reject(new Error('process still exists')),
      release: mockDetachedTargetRelease,
    }));

    await expect(workflowAbandonCommand(createTestWorkflowHost(), 'run-1')).rejects.toThrow(
      'Could not stop the live owner of run run-1 (pid 42): process still exists. The run was not changed.'
    );
    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
  });
});

describe('workflowCancelCommand', () => {
  const runId = '12345678-1234-1234-1234-123456789abc';
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
    mockRequestDetachedRunStop.mockReset();
    mockRequestDetachedRunStop.mockResolvedValue({
      pid: 4242,
      stop: mockDetachedTargetStop,
      release: mockDetachedTargetRelease,
    });
    mockDetachedTargetStop.mockReset();
    mockDetachedTargetStop.mockResolvedValue();
    mockDetachedTargetRelease.mockClear();
    mockReclaimContainerEnv.mockReset();
    mockReclaimContainerEnv.mockResolvedValue();

    const workflowDb = require('@archon/core/db/workflows');
    const isolationDb = require('@archon/core/db/isolation-environments');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockReset();
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockReset();
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      cancelled: true,
    });
    (workflowDb.findChildRuns as ReturnType<typeof mock>).mockReset();
    (workflowDb.findChildRuns as ReturnType<typeof mock>).mockResolvedValue([]);
    (isolationDb.getById as ReturnType<typeof mock>).mockReset();
    (isolationDb.getById as ReturnType<typeof mock>).mockResolvedValue(null);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('stops the live process tree before recording cancellation', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    const order: string[] = [];
    const row = { id: runId, workflow_name: 'implement', status: 'running' };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue(row);
    mockRequestDetachedRunStop.mockImplementation(async () => {
      order.push('owner');
      return {
        pid: 4242,
        stop: async () => {
          order.push('terminate');
        },
        release: mockDetachedTargetRelease,
      };
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockImplementation(async () => {
      order.push('cancel-state');
      return { cancelled: true };
    });

    await workflowCancelCommand(createTestWorkflowHost(), runId);

    expect(order).toEqual(['owner', 'terminate', 'cancel-state']);
    expect(mockRequestDetachedRunStop).toHaveBeenCalledWith(runId);
    expect(consoleSpy).toHaveBeenCalledWith(
      'Host process tree stopped before run state was changed.'
    );
  });

  it('leaves run state unchanged when no live detached owner answers', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'running',
    });
    mockRequestDetachedRunStop.mockRejectedValue(
      new Error('No live detached owner; run unchanged')
    );

    const exitCode = await workflowCancelCommand(createTestWorkflowHost(), runId, true);

    expect(exitCode).toBe(1);
    expect(mockDetachedTargetStop).not.toHaveBeenCalled();
    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      runId,
      action: 'cancel',
      error: 'No live detached owner; run unchanged',
    });
  });

  it('leaves run state unchanged when process-tree termination fails', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'running',
    });
    mockDetachedTargetStop.mockRejectedValue(new Error('process still exists'));

    const exitCode = await workflowCancelCommand(createTestWorkflowHost(), runId, true);

    expect(exitCode).toBe(1);

    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'cancel',
      error: expect.stringContaining('(pid 4242): process still exists. The run was not changed.'),
    });
  });

  it('confirms container teardown before recording cancellation', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    const isolationDb = require('@archon/core/db/isolation-environments');
    const order: string[] = [];
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'running',
      metadata: { isolation: 'container', isolation_env_id: 'container-env-1' },
    });
    (isolationDb.getById as ReturnType<typeof mock>).mockResolvedValue({
      id: 'container-env-1',
      provider: 'container',
    });
    mockDetachedTargetStop.mockImplementation(async (): Promise<void> => {
      order.push('terminate-owner');
    });
    mockReclaimContainerEnv.mockImplementation(async (): Promise<void> => {
      order.push('reclaim-container');
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockImplementation(
      async (): Promise<{ cancelled: boolean }> => {
        order.push('cancel-state');
        return { cancelled: true };
      }
    );

    await workflowCancelCommand(createTestWorkflowHost(), runId, true);

    expect(order).toEqual([
      'terminate-owner',
      'reclaim-container',
      'cancel-state',
      'reclaim-container',
    ]);
    expect(mockReclaimContainerEnv).toHaveBeenCalledTimes(2);
    expect(mockReclaimContainerEnv).toHaveBeenCalledWith(
      'container-env-1',
      expect.objectContaining({ getById: expect.any(Function) })
    );
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: true,
      processStopped: true,
      status: 'cancelled',
    });
  });

  it('leaves state unchanged when container teardown cannot be confirmed', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    const isolationDb = require('@archon/core/db/isolation-environments');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'running',
      metadata: { isolation: 'container', isolation_env_id: 'container-env-1' },
    });
    (isolationDb.getById as ReturnType<typeof mock>).mockResolvedValue({
      id: 'container-env-1',
      provider: 'container',
    });
    mockReclaimContainerEnv.mockRejectedValue(new Error('docker daemon unavailable'));

    await workflowCancelCommand(createTestWorkflowHost(), runId, true);

    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'cancel',
      error: expect.stringContaining(
        'isolation container could not be confirmed stopped. Run state was not changed'
      ),
    });
  });

  it('does not stop the owner when container tracking is unavailable', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    const isolationDb = require('@archon/core/db/isolation-environments');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'running',
      metadata: { isolation: 'container', isolation_env_id: 'missing-env' },
    });
    (isolationDb.getById as ReturnType<typeof mock>).mockResolvedValue(null);

    await workflowCancelCommand(createTestWorkflowHost(), runId, true);

    expect(mockRequestDetachedRunStop).not.toHaveBeenCalled();
    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'cancel',
      error: expect.stringContaining('Cannot confirm the isolation container'),
    });
  });

  it('does not stop the owner when a container run has no tracking ID', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    const isolationDb = require('@archon/core/db/isolation-environments');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'running',
      metadata: { isolation: 'container' },
    });

    await workflowCancelCommand(createTestWorkflowHost(), runId, true);

    expect(isolationDb.getById).not.toHaveBeenCalled();
    expect(mockRequestDetachedRunStop).not.toHaveBeenCalled();
    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'cancel',
      error: expect.stringContaining('container tracking ID is missing'),
    });
  });

  it('does not report cancellation when the state transition loses a race', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>)
      .mockResolvedValueOnce({
        id: runId,
        workflow_name: 'implement',
        status: 'running',
      })
      .mockResolvedValueOnce({
        id: runId,
        workflow_name: 'implement',
        status: 'completed',
      });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      cancelled: false,
    });

    await workflowCancelCommand(createTestWorkflowHost(), runId, true);

    expect(mockDetachedTargetStop).toHaveBeenCalledTimes(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'cancel',
      error: expect.stringContaining(
        'The run status is completed; it was not reported as cancelled'
      ),
    });
  });

  it('refuses a non-running run without contacting a process owner', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'cancelled',
    });

    await expect(workflowCancelCommand(createTestWorkflowHost(), runId)).rejects.toThrow(
      "Cannot cancel run with status 'cancelled'"
    );
    expect(mockRequestDetachedRunStop).not.toHaveBeenCalled();
    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
  });

  it('points at abandon, with the recorded owner facts, when no owner answers', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'running',
      last_activity_at: null,
      metadata: { execution_owner: { host: 'build-box', pid: 4242 } },
    });
    mockRequestDetachedRunStop.mockImplementation(noOwnerAnswers);

    await workflowCancelCommand(createTestWorkflowHost(), runId, true);

    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
    const { error } = JSON.parse(firstJsonPayload(stdoutSpy)) as { error: string };
    expect(error).toContain('Recorded owner: host build-box, pid 4242.');
    expect(error).toContain(`Abandon it: archon workflow abandon ${runId}`);
  });

  it("cancels cooperatively a sub-run with no owner of its own whose root's owner answers", async () => {
    const workflowDb = require('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'running',
      parent_run_id: 'root-run',
    });
    (workflowDb.getRunAncestry as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: 'root-run', status: 'running', parent_run_id: null },
    ]);
    mockRequestDetachedRunStop.mockImplementation(noOwnerAnswers);
    mockIsRunOwnerAnswering.mockResolvedValueOnce(true);

    await workflowCancelCommand(createTestWorkflowHost(), runId, true);

    expect(mockRequestDetachedRunStop).toHaveBeenCalledWith(runId);
    expect(mockIsRunOwnerAnswering).toHaveBeenCalledWith('root-run');
    expect(workflowDb.cancelWorkflowRun).toHaveBeenCalledWith(runId, { cancel_reason: 'operator' });
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: true,
      status: 'cancelled',
      processStopped: false,
    });
  });
});

describe('workflowCleanupCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should print deletion count when runs are deleted', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.deleteOldWorkflowRuns as ReturnType<typeof mock>).mockResolvedValueOnce({
      count: 5,
    });

    const host = createTestWorkflowHost();
    const prune = mock(async () => ({ count: 7 }));
    host.deps.store.pruneStateRevisions = prune;
    await workflowCleanupCommand(host, 30);
    expect(prune).toHaveBeenCalledWith(30);
    expect(consoleSpy).toHaveBeenCalledWith('Pruned 7 state revision(s) older than 30 days.');

    expect(consoleSpy).toHaveBeenCalledWith('Deleted 5 workflow run(s) older than 30 days.');
  });

  it('should print no-op message when count is 0', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.deleteOldWorkflowRuns as ReturnType<typeof mock>).mockResolvedValueOnce({
      count: 0,
    });

    await workflowCleanupCommand(createTestWorkflowHost(), 7);

    expect(consoleSpy).toHaveBeenCalledWith('No workflow runs older than 7 days to clean up.');
  });

  it('reports committed run deletion when state pruning fails', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.deleteOldWorkflowRuns as ReturnType<typeof mock>).mockResolvedValueOnce({
      count: 5,
    });
    const host = createTestWorkflowHost();
    host.deps.store.pruneStateRevisions = mock(async () => {
      throw new Error('state unavailable');
    });
    await expect(workflowCleanupCommand(host, 7)).rejects.toThrow(
      'Deleted 5 workflow run(s) older than 7 days, but failed to prune state revisions: state unavailable'
    );
  });

  it('should throw when deleteOldWorkflowRuns fails', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.deleteOldWorkflowRuns as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('disk full')
    );

    await expect(workflowCleanupCommand(createTestWorkflowHost(), 7)).rejects.toThrow(
      'Failed to clean up workflow history: disk full'
    );
  });
});

describe('workflowRejectCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockLogger.error.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should throw when run not found', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(workflowRejectCommand(createTestWorkflowHost(), 'missing-id')).rejects.toThrow();
  });

  it('should throw when run is not paused', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'my-wf',
      status: 'running',
      metadata: {},
    });

    await expect(workflowRejectCommand(createTestWorkflowHost(), 'run-1')).rejects.toThrow(
      'Cannot reject run'
    );
  });

  it('cancels immediately when no on_reject configured', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const core = await import('@archon/core');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-plain',
      workflow_name: 'plain-wf',
      status: 'paused',
      user_message: 'build it',
      working_path: '/repo',
      codebase_id: null,
      metadata: { approval: { type: 'approval', nodeId: 'gate', message: 'Approve?' } },
    });
    (core.createWorkflowStore as ReturnType<typeof mock>).mockReturnValueOnce({
      createWorkflowEvent: mock(() => Promise.resolve()),
    });

    await workflowRejectCommand(createTestWorkflowHost(), 'run-plain', 'not good');

    // Terminal reject resolves + cancels atomically (#2113); the audit event
    // rides the same transaction (#2146).
    expect(workflowDb.resolveAndCancelApprovalGate).toHaveBeenCalledWith(
      'run-plain',
      [
        {
          event_type: 'approval_received',
          step_name: 'gate',
          data: {
            via: 'cli',
            occurrence: expect.any(String),
            decision: 'rejected',
            reason: 'not good',
          },
        },
      ],
      { step_name: 'gate', reason: 'approval_rejected' },
      undefined
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Rejected and cancelled'));
  });

  it('plain mode: rejecting with no reason defaults structured output text to "Rejected" (#2740)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-new-mode',
      workflow_name: 'new-mode-wf',
      status: 'paused',
      user_message: 'build it',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          decisionsAuthored: true,
        },
      },
    });

    try {
      await workflowRejectCommand(createTestWorkflowHost(), 'run-new-mode');
    } catch {
      // A new-mode reject stays resumable and auto-resumes inline; the
      // downstream workflowRunCommand failure (no workflow discovered in this
      // unit test's fake cwd) is acceptable here — this test only cares about
      // what was recorded before that point.
    }

    // No `reason` argument at all — rejectWorkflow records the 'Rejected'
    // default on the new-mode structured output (#2740).
    const structuredOutput = { decision: 'reject', text: 'Rejected' };
    expect(workflowDb.resolveApprovalGate).toHaveBeenCalledWith(
      'run-new-mode',
      {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          decisionsAuthored: true,
          resolved: 'rejected',
          answeredVia: 'cli',
          answeredAt: expect.any(String),
        },
      },
      [
        {
          event_type: 'node_completed',
          step_name: 'gate',
          data: {
            node_output: JSON.stringify(structuredOutput),
            approval_decision: 'rejected',
            structured_output: structuredOutput,
          },
        },
        {
          event_type: 'approval_received',
          step_name: 'gate',
          data: {
            via: 'cli',
            occurrence: expect.any(String),
            decision: 'rejected',
            reason: 'Rejected',
          },
        },
      ],
      undefined
    );
  });

  it('--json mode: rejecting with no reason defaults structured output text to "Rejected" (#2740)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const jsonStdoutSpy = spyOnJsonStdout();

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-new-mode-json',
      workflow_name: 'new-mode-wf',
      status: 'paused',
      user_message: 'build it',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          decisionsAuthored: true,
        },
      },
    });

    await workflowRejectCommand(createTestWorkflowHost(), 'run-new-mode-json', undefined, true);

    const structuredOutput = { decision: 'reject', text: 'Rejected' };
    expect(workflowDb.resolveApprovalGate).toHaveBeenCalledWith(
      'run-new-mode-json',
      expect.objectContaining({
        approval: expect.objectContaining({ resolved: 'rejected' }),
      }),
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'node_completed',
          step_name: 'gate',
          data: expect.objectContaining({ structured_output: structuredOutput }),
        }),
      ]),
      undefined
    );
    const parsed = JSON.parse(firstJsonPayload(jsonStdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: true, runId: 'run-new-mode-json', action: 'reject' });
    jsonStdoutSpy.mockRestore();
  });

  it('updates metadata and auto-resumes when on_reject configured and under limit', async () => {
    const workflowDb = await import('@archon/core/db/workflows');

    const runData = {
      id: 'run-on-reject',
      workflow_name: 'my-wf',
      status: 'paused',
      user_message: 'build it',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(runData);

    try {
      await workflowRejectCommand(createTestWorkflowHost(), 'run-on-reject', 'needs work');
    } catch {
      // downstream workflowRunCommand failure is acceptable in this unit test
    }

    // Stays 'paused' (no status write) — rework staged atomically via the CAS on
    // the approval context (#2075/#2113), with the audit event in the same
    // transaction (#2146)
    expect(workflowDb.resolveApprovalGate).toHaveBeenCalledWith(
      'run-on-reject',
      {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
          resolved: 'rejected',
          answeredVia: 'cli',
          answeredAt: expect.any(String),
        },
        rejection_reason: 'needs work',
        rejection_count: 1,
      },
      [
        {
          event_type: 'approval_received',
          step_name: 'gate',
          data: {
            via: 'cli',
            occurrence: expect.any(String),
            decision: 'rejected',
            reason: 'needs work',
          },
        },
      ],
      undefined
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Rejected workflow'));
  });

  it('should pass original platform conversation ID through on reject-resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const conversationsDb = await import('@archon/core/db/conversations');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    const runData = {
      origin: { conversationId: 'db-uuid-reject' },
      id: 'run-reject-conv',
      workflow_name: 'my-wf',
      status: 'paused',
      user_message: 'build it',
      working_path: '/repo',
      codebase_id: null,
      conversation_id: 'db-uuid-reject',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    };
    // rejectWorkflow reads the run twice internally (getRunOrThrow + updateWorkflowRun check)
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(runData);

    // Return a conversation with the original platform ID
    (conversationsDb.getConversationById as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'db-uuid-reject',
      platform_type: 'cli',
      platform_conversation_id: 'cli-reject-456',
    });

    (
      workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>
    ).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'my-wf' })],
      errors: [],
    });

    // Clear call history before our test so we can assert precisely
    (conversationsDb.getOrCreateConversation as ReturnType<typeof mock>).mockClear();

    try {
      await workflowRejectCommand(createTestWorkflowHost(), 'run-reject-conv', 'needs work');
    } catch {
      // downstream workflowRunCommand failure is acceptable — we only need to reach getOrCreateConversation
    }

    // Verify the original platform conversation ID was passed through
    expect(conversationsDb.getConversationById).toHaveBeenCalledWith('db-uuid-reject');
    expect(conversationsDb.getOrCreateConversation).not.toHaveBeenCalled();
  });

  it('cancels when max attempts reached', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const core = await import('@archon/core');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-max',
      workflow_name: 'my-wf',
      status: 'paused',
      user_message: 'build it',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 2,
      },
    });
    (core.createWorkflowStore as ReturnType<typeof mock>).mockReturnValueOnce({
      createWorkflowEvent: mock(() => Promise.resolve()),
    });

    await workflowRejectCommand(createTestWorkflowHost(), 'run-max', 'still bad');

    // Terminal reject resolves + cancels atomically (#2113); the audit event
    // rides the same transaction (#2146).
    expect(workflowDb.resolveAndCancelApprovalGate).toHaveBeenCalledWith(
      'run-max',
      [
        {
          event_type: 'approval_received',
          step_name: 'gate',
          data: {
            via: 'cli',
            occurrence: expect.any(String),
            decision: 'rejected',
            reason: 'still bad',
          },
        },
      ],
      { step_name: 'gate', reason: 'approval_rejected' },
      undefined
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('max attempts reached'));
  });

  it('throws when on_reject configured but working_path is null', async () => {
    const workflowDb = await import('@archon/core/db/workflows');

    const runData = {
      id: 'run-no-path',
      workflow_name: 'my-wf',
      status: 'paused',
      user_message: 'build it',
      working_path: null,
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(runData);
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);

    await expect(
      workflowRejectCommand(createTestWorkflowHost(), 'run-no-path', 'bad')
    ).rejects.toThrow('no working path');
  });

  it('should discover workflows from codebase.default_cwd on reject-resume, not working_path', async () => {
    // Regression for #1663: reject with on_reject configured re-invokes
    // workflowRunCommand. Discovery must use the source repo, not the worktree.
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    const runData = {
      id: 'run-reject-1663',
      workflow_name: 'my-approval-workflow',
      status: 'paused',
      user_message: 'go',
      working_path: '/tmp/worktree-without-yaml',
      codebase_id: 'cb-with-yaml',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(runData);
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);

    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-with-yaml',
      name: 'owner/repo',
      default_cwd: '/users/me/source-repo-with-yaml',
    });

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();
    discoverSpy.mockResolvedValueOnce({ workflows: [], errors: [] });

    try {
      await workflowRejectCommand(createTestWorkflowHost(), 'run-reject-1663', 'needs work');
    } catch {
      // downstream failure is acceptable
    }

    // A continuation takes no new capture, so discovery still reads the codebase source
    // path directly — #1663's guarantee, unchanged.
    expect(discoverSpy).toHaveBeenCalledWith(
      '/users/me/source-repo-with-yaml',
      expect.any(Function),
      providerRegistry
    );
  });

  it('fails loudly when getCodebase throws during reject auto-resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    const runData = {
      id: 'run-reject-codebase-error',
      workflow_name: 'my-approval-workflow',
      status: 'paused',
      user_message: 'go',
      working_path: '/tmp/worktree-without-yaml',
      codebase_id: 'cb-bad',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(runData);
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    const getCodebaseMock = codebaseDb.getCodebase as ReturnType<typeof mock>;
    getCodebaseMock.mockReset();
    getCodebaseMock.mockRejectedValueOnce(new Error('database offline'));

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await expect(
      workflowRejectCommand(createTestWorkflowHost(), 'run-reject-codebase-error', 'needs work')
    ).rejects.toThrow(
      "Rejected but failed to resume workflow 'my-approval-workflow': Failed to load codebase 'cb-bad' for workflow run 'run-reject-codebase-error'"
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-bad' }),
      'cli.workflow_reject_codebase_lookup_failed'
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-reject-codebase-error' }),
      'cli.workflow_reject_resume_failed'
    );
    expect(discoverSpy).not.toHaveBeenCalledWith(
      '/tmp/worktree-without-yaml',
      expect.any(Function),
      providerRegistry
    );
  });

  it('fails with recorded-rejection recovery when codebase row is missing during reject auto-resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    const runData = {
      id: 'run-reject-missing-codebase',
      workflow_name: 'my-approval-workflow',
      status: 'paused',
      user_message: 'go',
      working_path: '/tmp/worktree-without-yaml',
      codebase_id: 'cb-missing',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(runData);
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    const getCodebaseMock = codebaseDb.getCodebase as ReturnType<typeof mock>;
    getCodebaseMock.mockReset();
    getCodebaseMock.mockResolvedValueOnce(null);

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await expect(
      workflowRejectCommand(createTestWorkflowHost(), 'run-reject-missing-codebase', 'needs work')
    ).rejects.toThrow(
      "Rejected but failed to resume workflow 'my-approval-workflow': Workflow run 'run-reject-missing-codebase' references codebase 'cb-missing', but that codebase no longer exists.\n" +
        'Cannot safely discover workflows from the run worktree because project workflow files may be missing.\n' +
        'Re-register the project or restore the codebase row, then retry.\n' +
        "The rejection was recorded. Run 'bun run cli workflow resume run-reject-missing-codebase' to retry."
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-reject-missing-codebase' }),
      'cli.workflow_reject_resume_failed'
    );
    expect(discoverSpy).not.toHaveBeenCalledWith(
      '/tmp/worktree-without-yaml',
      expect.any(Function),
      providerRegistry
    );
  });

  it('should fall back to working_path for discovery on reject when codebase_id is missing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    const runData = {
      id: 'run-reject-no-codebase',
      workflow_name: 'legacy',
      status: 'paused',
      user_message: 'go',
      working_path: '/tmp/old-worktree',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(runData);
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();
    discoverSpy.mockResolvedValueOnce({ workflows: [], errors: [] });

    try {
      await workflowRejectCommand(createTestWorkflowHost(), 'run-reject-no-codebase', 'bad');
    } catch {
      // downstream failure is acceptable
    }

    // No codebase → falls back to working_path (preserves existing behavior)
    expect(discoverSpy).toHaveBeenCalledWith(
      '/tmp/old-worktree',
      expect.any(Function),
      providerRegistry
    );
  });
});

// #2707 step 2 — the general drive verb. `approve`/`reject` are sugar (delegated
// directly to the existing commands); any other decision resolves through the new
// declared-decision path.
describe('workflowRespondCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it.each([
    ['approve', false],
    ['reject', false],
    ['approve', true],
    ['reject', true],
  ] as const)('refuses undeclared %s through commands (detach=%s)', async (decision, detach) => {
    const workflowDb = await import('@archon/core/db/workflows');
    const run = {
      id: 'run-undeclared',
      workflow_name: 'guided',
      status: 'paused',
      user_message: 'go',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Choose',
          decisions: [{ id: 'accept' }, { id: 'revise' }],
          decisionsAuthored: true,
        },
      },
    };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue(run);
    const resolve = workflowDb.resolveApprovalGate as ReturnType<typeof mock>;
    const cancel = workflowDb.resolveAndCancelApprovalGate as ReturnType<typeof mock>;
    resolve.mockClear();
    cancel.mockClear();
    const host = createTestWorkflowHost();
    const dedicated = decision === 'approve' ? workflowApproveCommand : workflowRejectCommand;
    for (const respond of [
      () => dedicated(host, run.id, 'feedback', false, undefined, detach),
      () => workflowRespondCommand(host, run.id, decision, 'feedback', false, undefined, detach),
    ]) {
      await expect(respond()).rejects.toThrow(
        `does not declare decision '${decision}'. Declared decisions: accept, revise.`
      );
      expect(run.status).toBe('paused');
      expect(resolve).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['approve', false],
    ['reject', false],
    ['revise', false],
    ['approve', true],
    ['reject', true],
    ['revise', true],
  ] as const)(
    'refuses a stale --occurrence for %s before acknowledging anything (detach=%s)',
    async (decision, detach) => {
      const workflowDb = await import('@archon/core/db/workflows');
      const run = {
        id: 'run-stale-occurrence',
        workflow_name: 'guided',
        status: 'paused',
        user_message: 'go',
        working_path: '/repo',
        codebase_id: null,
        metadata: {
          approval: {
            type: 'approval',
            nodeId: 'gate',
            pauseId: 'pause-two',
            message: 'Choose',
            decisions: [{ id: 'approve' }, { id: 'reject' }, { id: 'revise' }],
            decisionsAuthored: true,
          },
        },
      };
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue(run);
      const resolve = workflowDb.resolveApprovalGate as ReturnType<typeof mock>;
      const cancel = workflowDb.resolveAndCancelApprovalGate as ReturnType<typeof mock>;
      resolve.mockClear();
      cancel.mockClear();
      await expect(
        workflowRespondCommand(
          createTestWorkflowHost(),
          run.id,
          decision,
          'feedback',
          false,
          undefined,
          detach,
          'pause-one'
        )
      ).rejects.toThrow("It is now awaiting occurrence 'pause-two'.");
      expect(resolve).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    }
  );

  it("delegates 'approve' to the exact same resolution as workflowApproveCommand", async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-respond-approve',
      workflow_name: 'guided',
      status: 'paused',
      user_message: 'go',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          decisions: [{ id: 'approve' }, { id: 'revise' }],
          decisionsAuthored: true,
        },
      },
    });

    try {
      await workflowRespondCommand(
        createTestWorkflowHost(),
        'run-respond-approve',
        'approve',
        'looks good'
      );
    } catch {
      // downstream workflowRunCommand failure is acceptable in this unit test
    }

    expect(workflowDb.resolveApprovalGate).toHaveBeenCalledWith(
      'run-respond-approve',
      expect.objectContaining({
        approval: expect.objectContaining({ resolved: 'approved' }),
      }),
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'node_completed',
          data: expect.objectContaining({
            structured_output: { decision: 'approve', text: 'looks good' },
          }),
        }),
      ]),
      undefined
    );
  });

  it('resolves a declared non-default decision with the caller-supplied id', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-respond-revise',
      workflow_name: 'guided',
      status: 'paused',
      user_message: 'go',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          decisions: [{ id: 'approve' }, { id: 'revise' }],
          decisionsAuthored: true,
        },
      },
    });

    try {
      await workflowRespondCommand(
        createTestWorkflowHost(),
        'run-respond-revise',
        'revise',
        'needs more detail'
      );
    } catch {
      // downstream workflowRunCommand failure is acceptable in this unit test
    }

    expect(workflowDb.resolveApprovalGate).toHaveBeenCalledWith(
      'run-respond-revise',
      expect.objectContaining({ approval_response: 'revise' }),
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'node_completed',
          data: expect.objectContaining({
            structured_output: { decision: 'revise', text: 'needs more detail' },
          }),
        }),
      ]),
      undefined
    );
  });

  it('rejects a decision the gate does not declare, naming the actual options', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-respond-invalid',
      workflow_name: 'guided',
      status: 'paused',
      user_message: 'go',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          decisions: [{ id: 'approve' }, { id: 'revise' }],
          decisionsAuthored: true,
        },
      },
    });
    const resolveGateSpy = workflowDb.resolveApprovalGate as ReturnType<typeof mock>;
    resolveGateSpy.mockClear();

    await expect(
      workflowRespondCommand(
        createTestWorkflowHost(),
        'run-respond-invalid',
        'escalate',
        'not sure'
      )
    ).rejects.toThrow(/does not declare decision 'escalate'.*approve, revise/s);

    expect(resolveGateSpy).not.toHaveBeenCalled();
  });

  it('spells the child-run redirect for the CLI', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-respond-blocked',
      workflow_name: 'guided',
      status: 'paused',
      user_message: 'go',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'child_workflow',
          nodeId: 'sub',
          message: 'blocked',
          childRunId: 'child-55',
        },
      },
    });

    await expect(
      workflowRespondCommand(
        createTestWorkflowHost(),
        'run-respond-blocked',
        'revise',
        'needs more detail'
      )
    ).rejects.toThrow('Approve it by run id: `archon workflow approve child-55`');
  });

  it('--detach validates read-only via assertRespondable before forking', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-respond-detach',
      workflow_name: 'guided',
      status: 'completed',
      working_path: '/repo',
      metadata: {},
    });
    const spawnSpy = spyOn(Bun, 'spawn');

    try {
      await expect(
        workflowRespondCommand(
          createTestWorkflowHost(),
          'run-respond-detach',
          'revise',
          undefined,
          false,
          undefined,
          true
        )
      ).rejects.toThrow(/Only paused runs can be approved/);
    } finally {
      spawnSpy.mockRestore();
    }
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Signal cleanup guard (#1123) — SIGTERM/SIGINT handlers must be run-scoped,
// status-guarded, and removed once executeWorkflow settles.
// ---------------------------------------------------------------------------

describe('workflowRunCommand — signal cleanup guard (#1123)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  function setupWorkflowMocks(): void {
    const discoverMock = require('@archon/workflows/workflow-discovery')
      .discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverMock.mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan', description: 'Plan work' })],
      errors: [],
    });

    const conversationDb = require('@archon/core/db/conversations');
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-1',
      platform: 'cli',
      platform_conversation_id: 'cli-123',
      title: null,
      is_active: true,
      codebase_id: null,
    });

    const codebaseDb = require('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test-repo',
      default_cwd: '/test/path',
    });
  }

  /** Flush the cleanup handler's fire-and-forget promise chain. */
  async function settleCleanup(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  /** The SIGTERM listeners added since `baseline` (i.e. by the command under test). */
  function addedSigtermListeners(baseline: readonly unknown[]): Array<() => void> {
    return process.listeners('SIGTERM').filter(listener => !baseline.includes(listener)) as Array<
      () => void
    >;
  }

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    // The cleanup chain ends in process.exit(1) — neuter it so invoking the
    // handler in-process doesn't kill the test runner.
    exitSpy = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    setMockDetachedStopRequested(false);
    mockAssertDetachedRunProcessOwner.mockReset();
    mockAssertDetachedRunProcessOwner.mockImplementation(() => undefined);
    mockStartRunLiveOwner.mockClear();
    mockRunLiveOwnerClose.mockClear();

    const workflowsDb = require('@archon/core/db/workflows');
    (workflowsDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();
    (workflowsDb.getActiveWorkflowRun as ReturnType<typeof mock>).mockClear();
    (workflowsDb.getWorkflowRunStatus as ReturnType<typeof mock>).mockReset();
    (workflowsDb.getWorkflowRunStatus as ReturnType<typeof mock>).mockResolvedValue(null);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    delete process.env.ARCHON_DETACHED_RUN_OWNER;
  });

  it('removes SIGTERM/SIGINT handlers once executeWorkflow settles (no leak, no stacking)', async () => {
    const sigtermBaseline = process.listenerCount('SIGTERM');
    const sigintBaseline = process.listenerCount('SIGINT');

    let duringRunSigterm = 0;
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementation(async () => {
      duringRunSigterm = process.listenerCount('SIGTERM');
      return { success: true, workflowRunId: 'run-1' };
    });

    setupWorkflowMocks();
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {});
    expect(duringRunSigterm).toBe(sigtermBaseline + 1);
    expect(mockStartRunLiveOwner).toHaveBeenCalledWith('test-run-id', {});
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBaseline);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);

    // A second invocation in the same process must not stack handlers either.
    setupWorkflowMocks();
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {});
    expect(duringRunSigterm).toBe(sigtermBaseline + 1);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBaseline);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);

    (executeWorkflow as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve({ success: true, workflowRunId: 'test-run-id' })
    );
  });

  it('does not fail the run when it is paused at a new gate at signal time', async () => {
    const workflowsDb = require('@archon/core/db/workflows');
    // The run this process drives has committed its pause at the next gate.
    (workflowsDb.getWorkflowRunStatus as ReturnType<typeof mock>).mockResolvedValue('paused');

    const sigtermBefore = process.listeners('SIGTERM');
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      // The signal lands while the handler is still registered.
      const [handler] = addedSigtermListeners(sigtermBefore);
      expect(handler).toBeDefined();
      handler();
      await settleCleanup();
      return { success: true, workflowRunId: 'run-1', paused: true };
    });

    setupWorkflowMocks();
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {});

    // Paused-at-gate is an external transition the signal handler must respect.
    expect(workflowsDb.failWorkflowRun).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('still fails the run on a genuine mid-run interrupt (legacy behavior)', async () => {
    const workflowsDb = require('@archon/core/db/workflows');
    (workflowsDb.getWorkflowRunStatus as ReturnType<typeof mock>).mockResolvedValue('running');
    const shutdownOrder: string[] = [];
    mockRunLiveOwnerClose.mockImplementationOnce(async () => {
      shutdownOrder.push('owner-close');
    });
    exitSpy.mockImplementationOnce((() => {
      shutdownOrder.push('exit');
    }) as never);

    const sigtermBefore = process.listeners('SIGTERM');
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      const [handler] = addedSigtermListeners(sigtermBefore);
      expect(handler).toBeDefined();
      handler();
      await settleCleanup();
      return { success: false, workflowRunId: 'run-1', error: 'interrupted' };
    });

    setupWorkflowMocks();
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {})
    ).rejects.toThrow('Workflow failed');

    expect(workflowsDb.failWorkflowRun).toHaveBeenCalledWith(
      'test-run-id',
      'Process terminated (SIGTERM)',
      { exitReason: 'process_terminated', signal: 'SIGTERM' }
    );
    expect(shutdownOrder).toEqual(['owner-close', 'exit']);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('lets an exact-run cancel controller own the lifecycle transition', async () => {
    const workflowsDb = require('@archon/core/db/workflows');
    process.env.ARCHON_DETACHED_RUN_OWNER = '1';
    // A detached child learns its run from the row its launcher handed over (#2872) —
    // the only shape the CLI produces for a fresh detached run.
    (workflowsDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'test-run-id',
      workflow_name: 'plan',
      status: 'pending',
      working_path: null,
      metadata: {},
    });

    const sigtermBefore = process.listeners('SIGTERM');
    const { executeWorkflow } = require('@archon/workflows/executor');
    // Captured inside the run, once the signal handler has settled: the assertion is
    // that the SIGNAL path never consulted status, which a global "never called" no
    // longer isolates now that the startup-failure net reads it on the way out.
    let statusReadsAtSignalTime = -1;
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      setMockDetachedStopRequested(true);
      const [handler] = addedSigtermListeners(sigtermBefore);
      expect(handler).toBeDefined();
      handler();
      await settleCleanup();
      statusReadsAtSignalTime = (workflowsDb.getWorkflowRunStatus as ReturnType<typeof mock>).mock
        .calls.length;
      return { success: false, workflowRunId: 'test-run-id', error: 'interrupted' };
    });

    setupWorkflowMocks();
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
        detachedRunId: 'test-run-id',
      })
    ).rejects.toThrow('Workflow failed');

    expect(mockStartRunLiveOwner).toHaveBeenCalledWith('test-run-id', {
      detachedProcessPid: process.pid,
    });
    expect(statusReadsAtSignalTime).toBe(0);
    expect(workflowsDb.failWorkflowRun).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockRunLiveOwnerClose).toHaveBeenCalledTimes(1);
  });

  it('rejects a detached marker when this process does not own its process group', async () => {
    process.env.ARCHON_DETACHED_RUN_OWNER = '1';
    mockAssertDetachedRunProcessOwner.mockImplementationOnce(() => {
      throw new Error('does not own process group');
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {})
    ).rejects.toThrow('does not own process group');

    expect(mockStartRunLiveOwner).not.toHaveBeenCalled();
    expect(process.env.ARCHON_DETACHED_RUN_OWNER).toBeUndefined();
  });

  it('uses the source-reserved run id before workflow_started is emitted', async () => {
    const workflowsDb = require('@archon/core/db/workflows');
    (workflowsDb.getWorkflowRunStatus as ReturnType<typeof mock>).mockResolvedValue('running');

    const sigtermBefore = process.listeners('SIGTERM');
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      // No workflow_started event is needed: source capture reserved the exact id
      // before execution or its live-owner endpoint became visible.
      const [handler] = addedSigtermListeners(sigtermBefore);
      expect(handler).toBeDefined();
      handler();
      await settleCleanup();
      return { success: true, workflowRunId: 'run-1' };
    });

    setupWorkflowMocks();
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {});

    expect(workflowsDb.failWorkflowRun).toHaveBeenCalledWith(
      'test-run-id',
      'Process terminated (SIGTERM)',
      { exitReason: 'process_terminated', signal: 'SIGTERM' }
    );
    expect(workflowsDb.getActiveWorkflowRun).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('workflowResetSessionsCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
    mockDeleteNodeSessions.mockClear();
    mockDeleteNodeSessions.mockResolvedValue({ deleted: 0 });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('refuses a cross-scope reset without --scope and without --yes', async () => {
    await expect(
      workflowResetSessionsCommand(createTestWorkflowHost(), 'feature-dev', {})
    ).rejects.toThrow(/Refusing/);
    expect(mockDeleteNodeSessions).not.toHaveBeenCalled();
  });

  it('proceeds across all scopes when --yes is given (no scope filter)', async () => {
    mockDeleteNodeSessions.mockResolvedValueOnce({ deleted: 4 });

    await workflowResetSessionsCommand(createTestWorkflowHost(), 'feature-dev', { yes: true });

    expect(mockDeleteNodeSessions).toHaveBeenCalledWith({
      workflow_name: 'feature-dev',
      scope_key: undefined,
      node_id: undefined,
    });
    const calls: string[] = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(calls.some(c => c.includes('4') && c.includes('across all scopes'))).toBe(true);
  });

  it('proceeds with --scope and no --yes, narrowing to that scope', async () => {
    mockDeleteNodeSessions.mockResolvedValueOnce({ deleted: 1 });

    await workflowResetSessionsCommand(createTestWorkflowHost(), 'feature-dev', {
      scope: 'conv-1',
      node: 'planner',
    });

    expect(mockDeleteNodeSessions).toHaveBeenCalledWith({
      workflow_name: 'feature-dev',
      scope_key: 'conv-1',
      node_id: 'planner',
    });
  });

  it('emits machine-readable JSON when --json is set', async () => {
    mockDeleteNodeSessions.mockResolvedValueOnce({ deleted: 2 });

    await workflowResetSessionsCommand(createTestWorkflowHost(), 'feature-dev', {
      scope: 'conv-1',
      json: true,
    });

    expect(firstJsonPayload(stdoutSpy)).toBe(
      JSON.stringify({ workflow: 'feature-dev', deleted: 2, scope: 'conv-1', node: null })
    );
  });
});

describe('maybePrintTierNotice', () => {
  const { loadConfig, getUserAiPrefs } = require('@archon/core') as {
    loadConfig: ReturnType<typeof mock>;
    getUserAiPrefs: ReturnType<typeof mock>;
  };
  const { readTierNoticeState, markTierNoticeShown } = require('@archon/paths') as {
    readTierNoticeState: ReturnType<typeof mock>;
    markTierNoticeShown: ReturnType<typeof mock>;
  };

  let stderrSpy: ReturnType<typeof spyOn>;

  function makeTierWorkflow(nodeModel?: string, workflowModel?: string) {
    return makeTestWorkflow({
      name: 'tier-test',
      ...(workflowModel !== undefined ? { model: workflowModel } : {}),
      nodes: [
        { id: 'n1', command: 'test-cmd', ...(nodeModel !== undefined ? { model: nodeModel } : {}) },
      ],
    });
  }

  beforeEach(() => {
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    (readTierNoticeState as ReturnType<typeof mock>).mockReturnValue(null);
    (markTierNoticeShown as ReturnType<typeof mock>).mockClear();
    // assistant: 'claude' — a provider WITH built-in tier defaults, so the
    // notice has something truthful to announce (the no-built-ins case is
    // covered by its own test below).
    (loadConfig as ReturnType<typeof mock>).mockResolvedValue({
      defaults: {},
      tiers: {},
      assistant: 'claude',
    });
    (getUserAiPrefs as ReturnType<typeof mock>).mockResolvedValue({});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('prints nothing and returns when quiet=true', async () => {
    const workflow = makeTierWorkflow('large');
    await maybePrintTierNotice(createTestWorkflowHost(), workflow, '/cwd', undefined, true);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });

  it('prints nothing when no nodes use tier keywords', async () => {
    const workflow = makeTierWorkflow(undefined);
    await maybePrintTierNotice(createTestWorkflowHost(), workflow, '/cwd', undefined, false);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });

  it('detects workflow-level tier keyword even when no per-node model is set', async () => {
    const workflow = makeTierWorkflow(undefined, 'large');
    await maybePrintTierNotice(createTestWorkflowHost(), workflow, '/cwd', undefined, false);
    expect(stderrSpy).toHaveBeenCalled();
    expect(markTierNoticeShown).toHaveBeenCalledWith('0.0.0-test');
  });

  it('prints nothing when the used tier is explicitly configured in install config', async () => {
    (loadConfig as ReturnType<typeof mock>).mockResolvedValue({
      defaults: {},
      tiers: { large: { provider: 'claude', model: 'opus' } },
    });
    const workflow = makeTierWorkflow('large');
    await maybePrintTierNotice(createTestWorkflowHost(), workflow, '/cwd', undefined, false);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });

  it('prints nothing when the notice was already shown for this version', async () => {
    (readTierNoticeState as ReturnType<typeof mock>).mockReturnValue({
      shownForVersion: '0.0.0-test',
    });
    const workflow = makeTierWorkflow('large');
    await maybePrintTierNotice(createTestWorkflowHost(), workflow, '/cwd', undefined, false);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });

  it('prints the notice and marks shown when tier is unconfigured and not yet shown', async () => {
    const workflow = makeTierWorkflow('large');
    await maybePrintTierNotice(createTestWorkflowHost(), workflow, '/cwd', undefined, false);
    expect(stderrSpy).toHaveBeenCalled();
    const written = stderrSpy.mock.calls[0][0] as string;
    expect(written).toContain('model tiers');
    expect(markTierNoticeShown).toHaveBeenCalledWith('0.0.0-test');
  });

  it('prints nothing for a provider with no built-in tier defaults (and keeps the notice unshown)', async () => {
    (loadConfig as ReturnType<typeof mock>).mockResolvedValue({
      defaults: {},
      tiers: {},
      assistant: 'pi',
    });
    const workflow = makeTierWorkflow('large');
    await maybePrintTierNotice(createTestWorkflowHost(), workflow, '/cwd', undefined, false);
    // No built-ins exist, so claiming "using built-in defaults" would be false —
    // the run's tier-resolution error owns the guidance. Not marked shown, so a
    // later provider switch still gets its one-time notice.
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });

  it('returns silently when loadConfig throws', async () => {
    (loadConfig as ReturnType<typeof mock>).mockRejectedValue(new Error('parse error'));
    const workflow = makeTierWorkflow('large');
    await expect(
      maybePrintTierNotice(createTestWorkflowHost(), workflow, '/cwd', undefined, false)
    ).resolves.toBeUndefined();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });

  it('prints nothing when user prefs already configure the tier', async () => {
    (getUserAiPrefs as ReturnType<typeof mock>).mockResolvedValue({
      tiers: { large: { provider: 'claude', model: 'claude-opus-4-8' } },
    });
    const workflow = makeTierWorkflow('large');
    await maybePrintTierNotice(createTestWorkflowHost(), workflow, '/cwd', 'user-1', false);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });
});

describe('hasUnresolvedWriteback (H2 teardown-preserve decision)', () => {
  it('true when the gate was raised but never resolved (failed/partial apply)', () => {
    expect(hasUnresolvedWriteback({ pending_writeback: { envId: 'e' } })).toBe(true);
  });
  it('false once the write-back resolved (applied/discarded)', () => {
    expect(
      hasUnresolvedWriteback({ pending_writeback: { envId: 'e' }, writeback_resolved: true })
    ).toBe(false);
  });
  it('false for a run that never raised a write-back gate', () => {
    expect(hasUnresolvedWriteback({ isolation: 'container' })).toBe(false);
    expect(hasUnresolvedWriteback(undefined)).toBe(false);
  });
});

describe('resolveContainerBackendConfig', () => {
  it('applies defaults when config is absent', () => {
    const cfg = resolveContainerBackendConfig(undefined);
    expect(cfg).toEqual({
      image: 'archon-runner:latest',
      network: 'bridge',
      memoryMb: 4096,
      pidsLimit: 512,
    });
  });

  it('passes through valid values', () => {
    const cfg = resolveContainerBackendConfig({
      image: '  my-runner:1  ',
      network: 'none',
      memoryMb: 2048,
      pidsLimit: 256,
    });
    expect(cfg).toEqual({
      image: 'my-runner:1',
      network: 'none',
      memoryMb: 2048,
      pidsLimit: 256,
    });
  });

  it('rejects a non bridge/none network (no silent --network host)', () => {
    expect(() => resolveContainerBackendConfig({ network: 'host' })).toThrow(/bridge.*none/);
  });

  it('rejects a fractional memoryMb (docker --memory needs an integer)', () => {
    expect(() => resolveContainerBackendConfig({ memoryMb: 512.5 })).toThrow(/positive integer/);
  });

  it('rejects a non-integer / non-positive pidsLimit', () => {
    expect(() => resolveContainerBackendConfig({ pidsLimit: 10.5 })).toThrow(/positive integer/);
    expect(() => resolveContainerBackendConfig({ pidsLimit: 0 })).toThrow(/positive integer/);
  });
});

describe('workflowRunCommand — adopt lane source recapture (#2660/#2747)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  const trackTempRoot = trackTempRoots();

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  function adoptedEnvironment(): import('@archon/isolation').IsolationEnvironmentRow {
    return {
      id: 'env-9',
      codebase_id: 'cb-adopt',
      workflow_type: 'task',
      workflow_id: 'adopt',
      provider: 'worktree',
      working_path: '/wt/adopted',
      branch_name: 'feature/adopted',
      status: 'active',
      metadata: {},
      created_at: new Date('2026-01-01'),
      created_by_platform: 'cli',
      created_by_user_id: null,
    };
  }

  function setupAdoptMocks(
    lane: Exclude<AdoptionLane, { kind: 'in-place' }> = {
      kind: 'reuse-worktree',
      environment: adoptedEnvironment(),
    }
  ): void {
    const discoverMock = require('@archon/workflows/workflow-discovery')
      .discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    const prepareMock = require('@archon/workflows/run-source').prepareWorkflowSource as ReturnType<
      typeof mock
    >;
    discoverMock.mockReset();
    prepareMock.mockClear();
    // First discovery runs against the invoking checkout; the second must run against
    // the adopted lane's worktree and resolve the branch's vintage of the workflow.
    discoverMock
      .mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Parent vintage' })],
        errors: [],
      })
      .mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Branch vintage' })],
        errors: [],
      });

    const conversationDb = require('@archon/core/db/conversations');
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-adopt',
      platform_type: 'cli',
      platform_conversation_id: 'cli-adopt',
      title: null,
      is_active: true,
      codebase_id: null,
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValue(undefined);
    const codebaseDb = require('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-adopt',
      name: 'test-repo',
      default_cwd: '/test/path',
      kind: 'repo',
    });

    if (lane.kind === 'reuse-worktree') {
      (
        require('@archon/core/db/isolation-environments').getById as ReturnType<typeof mock>
      ).mockResolvedValueOnce({
        ...lane.environment,
      });
    }
    const adoption = require('@archon/core/operations/workflow-adoption');
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockResolvedValueOnce({
      adoptedRun: { id: 'run-old' },
      lane,
    });
  }

  // Keep source-capture I/O real: equal run IDs replace one physical directory.
  // This exposes cleanup deleting the replacement even with the executor mocked.
  async function stageRealCapture(
    tempRoot: string,
    opts: { sourceRoot: string; runId?: string }
  ): Promise<WorkflowRunSource.PreparedWorkflowSource> {
    const runId = opts.runId ?? randomUUID();
    const captureRoot = join(tempRoot, 'staged-source', runId);
    await removeTempTree(captureRoot);
    mkdirSync(captureRoot, { recursive: true });
    const anchor = {
      root: captureRoot,
      digest: `digest-${opts.sourceRoot}`,
      config: { load_default_workflows: true, load_default_commands: true },
    };
    const manifest = {
      version: 1 as const,
      engine_version: 'test',
      origin: opts.sourceRoot,
      captured_at: new Date().toISOString(),
      digest: anchor.digest,
      file_count: 0,
      byte_count: 0,
      scopes: [],
      source_config: anchor.config,
    };
    writeFileSync(join(captureRoot, 'manifest.json'), JSON.stringify(manifest));
    const roots: WorkflowRunSource.WorkflowSourceRoots = {
      project: join(captureRoot, 'project'),
      globalWorkflows: join(captureRoot, 'global', 'workflows'),
      globalCommands: join(captureRoot, 'global', 'commands'),
      globalScripts: join(captureRoot, 'global', 'scripts'),
      bundledWorkflows: join(captureRoot, 'bundled', 'workflows'),
      bundledCommands: join(captureRoot, 'bundled', 'commands', 'defaults'),
      installed: { kind: 'captured', captureRoot },
      kind: 'captured',
      anchor,
    };
    return { runId, origin: opts.sourceRoot, manifest, anchor, roots };
  }

  it('adopts a normal run from a unique short run id prefix', async () => {
    const adoptedRunId = '0b1ee8da-1111-2222-3333-444455556666';
    (git.findRepoRoot as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    const adoption = await import('@archon/core/operations/workflow-adoption');
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockClear();
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockClear();
    setupAdoptMocks();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockReset();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-adopt',
      name: 'test-folder',
      default_cwd: '/test/path',
      kind: 'folder',
    });
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: adoptedRunId },
    ]);

    await workflowRunCommand(createTestWorkflowHost(), '/test/path/subdir', 'assist', 'hello', {
      adoptRunId: '0b1ee8da',
    });

    expect(workflowDb.findWorkflowRunsByIdPrefix).toHaveBeenCalledWith('0b1ee8da', 'cb-adopt');
    expect(adoption.resolveWorkflowAdoption).toHaveBeenCalledWith(
      expect.objectContaining({ adoptedRunId })
    );
  });

  it('rejects an ambiguous adopted run prefix with its candidates', async () => {
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    const adoption = await import('@archon/core/operations/workflow-adoption');
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockClear();
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockClear();
    setupAdoptMocks();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-adopt',
      name: 'test-repo',
      default_cwd: '/test/path',
      kind: 'repo',
    });
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: '0b1ee8da-1111-2222-3333-444455556666' },
      { id: '0b1ee8da-9999-8888-7777-666655554444' },
    ]);

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        adoptRunId: '0b1ee8da',
      })
    ).rejects.toThrow(
      '0b1ee8da-1111-2222-3333-444455556666\n  0b1ee8da-9999-8888-7777-666655554444'
    );
    expect(adoption.resolveWorkflowAdoption).not.toHaveBeenCalled();
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockReset();
  });

  it('passes a full adopted run id through unchanged', async () => {
    const adoptedRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const workflowDb = await import('@archon/core/db/workflows');
    const adoption = await import('@archon/core/operations/workflow-adoption');
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockClear();
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockClear();
    setupAdoptMocks();

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      adoptRunId: adoptedRunId,
    });

    expect(workflowDb.findWorkflowRunsByIdPrefix).not.toHaveBeenCalled();
    expect(adoption.resolveWorkflowAdoption).toHaveBeenCalledWith(
      expect.objectContaining({ adoptedRunId })
    );
  });

  it.each(['missing', 'mismatched', 'replaced', 'switched', 'detached'] as const)(
    'refuses a %s adoption environment before lane capture or execution',
    async reason => {
      setupAdoptMocks();
      const isolationDb = await import('@archon/core/db/isolation-environments');
      const getById = isolationDb.getById as ReturnType<typeof mock>;
      getById.mockReset();
      if (reason === 'switched' || reason === 'detached') {
        mockGetCurrentBranchStrict.mockResolvedValueOnce(reason === 'switched' ? 'other' : null);
      }
      getById.mockResolvedValueOnce(
        reason === 'missing'
          ? null
          : reason === 'replaced'
            ? { ...adoptedEnvironment(), metadata: { worktree_registration_id: 'replacement' } }
            : {
                ...adoptedEnvironment(),
                working_path: reason === 'mismatched' ? '/foreign/worktree' : '/wt/adopted',
              }
      );
      (isolationDb.updateMetadata as ReturnType<typeof mock>).mockClear();
      const { executeWorkflow } = await import('@archon/workflows/executor');
      (executeWorkflow as ReturnType<typeof mock>).mockClear();
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
          adoptRunId: 'run-old',
        })
      ).rejects.toThrow(
        reason === 'missing'
          ? 'Isolation environment env-9 not found'
          : reason === 'replaced'
            ? 'changed during adoption'
            : reason === 'switched' || reason === 'detached'
              ? 'expected branch'
              : 'does not match'
      );
      expect(executeWorkflow).not.toHaveBeenCalled();
      expect(isolationDb.updateMetadata).not.toHaveBeenCalled();
      const captures = (prepareWorkflowSource as ReturnType<typeof mock>).mock.calls;
      expect(
        captures.every(call => (call[1] as { sourceRoot: string }).sourceRoot === '/test/path')
      ).toBe(true);
    }
  );

  it('re-freezes workflow source from the inherited worktree on the reuse-worktree lane', async () => {
    setupAdoptMocks();
    const isolationDb = await import('@archon/core/db/isolation-environments');
    (isolationDb.updateMetadata as ReturnType<typeof mock>).mockClear();
    const { executeWorkflow } = await import('@archon/workflows/executor');

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      adoptRunId: 'run-old',
    });

    const prepareCalls = (prepareWorkflowSource as ReturnType<typeof mock>).mock.calls;
    expect(prepareCalls).toHaveLength(2);
    expect((prepareCalls[0][1] as { sourceRoot: string }).sourceRoot).toBe('/test/path');
    expect((prepareCalls[1][1] as { sourceRoot: string }).sourceRoot).toBe('/wt/adopted');
    // The executor receives the branch-vintage graph, not the parent checkout's.
    const executed = (executeWorkflow as ReturnType<typeof mock>).mock.calls.at(-1) as unknown[];
    expect((executed[4] as { description: string }).description).toBe('Branch vintage');
    expect(executed[3]).toBe('/wt/adopted');
    expect((isolationDb.updateMetadata as ReturnType<typeof mock>).mock.calls).toEqual([
      [
        'env-9',
        {
          adopted: true,
          worktree_registration_id: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
          ),
        },
        expect.objectContaining({ id: 'env-9' }),
      ],
    ]);
  });

  it('checks out the exact adopted branch when the prior worktree is gone', async () => {
    setupAdoptMocks({
      kind: 'checkout-branch',
      taskBranch: { kind: 'existing', branch: toBranchName('feature/live-pr') },
    });
    const isolation = await import('@archon/isolation');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const create = mock(() =>
      Promise.resolve({
        provider: 'worktree' as const,
        id: '/wt/recreated',
        workingPath: '/wt/recreated',
        branchName: 'feature/live-pr',
        status: 'active' as const,
        createdAt: new Date(),
        metadata: { provenance: 'adopted', adopted: true },
      })
    );
    (isolation.getIsolationProvider as ReturnType<typeof mock>).mockReturnValueOnce({
      create,
      healthCheck: mock(() => Promise.resolve(true)),
    });

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      adoptRunId: 'run-old',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowType: 'task',
        taskBranch: { kind: 'existing', branch: toBranchName('feature/live-pr') },
      }),
      expect.any(Function)
    );
    const executed = (executeWorkflow as ReturnType<typeof mock>).mock.calls.at(-1) as unknown[];
    expect(executed[3]).toBe('/wt/recreated');
    const opts = executed.at(-1) as { adoptedFromRunId?: string };
    expect(opts.adoptedFromRunId).toBe('run-old');
  });

  it('preserves an explicit source when adoption recreates the prior branch checkout', async () => {
    setupAdoptMocks({
      kind: 'checkout-branch',
      taskBranch: { kind: 'existing', branch: toBranchName('feature/live-pr') },
    });
    const isolation = await import('@archon/isolation');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (isolation.getIsolationProvider as ReturnType<typeof mock>).mockReturnValueOnce({
      create: mock(() =>
        Promise.resolve({
          provider: 'worktree' as const,
          id: '/wt/recreated',
          workingPath: '/wt/recreated',
          branchName: 'feature/live-pr',
          status: 'active' as const,
          createdAt: new Date(),
          metadata: { provenance: 'adopted', adopted: true },
        })
      ),
      healthCheck: mock(() => Promise.resolve(true)),
    });

    // Explicit selection matters even when it names the invoking checkout.
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      adoptRunId: 'run-old',
      discoveryCwd: '/test/path',
    });

    expect(prepareWorkflowSource).toHaveBeenCalledTimes(1);
    expect(prepareWorkflowSource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceRoot: '/test/path' })
    );
    const executed = (executeWorkflow as ReturnType<typeof mock>).mock.calls.at(-1) as unknown[];
    expect(executed[3]).toBe('/wt/recreated');
    expect((executed[4] as { description: string }).description).toBe('Parent vintage');
  });

  it('re-judges the declared-input gate against the branch vintage after recapture', async () => {
    // The parent checkout's YAML declares no inputs, so the invocation gate on entry
    // passes an input-less call; only the adopted branch's YAML requires one.
    setupAdoptMocks();
    const discoverMock = require('@archon/workflows/workflow-discovery')
      .discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverMock.mockReset();
    discoverMock
      .mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Parent vintage' })],
        errors: [],
      })
      .mockResolvedValueOnce({
        workflows: [
          makeTestWorkflowWithSource({
            name: 'assist',
            description: 'Branch vintage',
            inputs: { diff: { required: true } },
          }),
        ],
        errors: [],
      });
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        adoptRunId: 'run-old',
      })
    ).rejects.toThrow(/requires input/);
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it(
    'preserves the replacement capture when a detached child recaptures onto its own ' +
      'pre-created run id (real files, #3217)',
    async () => {
      // Both capture calls use the detached child's pre-created run ID.
      setupAdoptMocks();
      const workflowDb = await import('@archon/core/db/workflows');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'run-detached-child',
        workflow_name: 'assist',
        status: 'pending',
      });
      const prepareMock = prepareWorkflowSource as ReturnType<typeof mock>;

      const tempRoot = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-recapture-same-root-')));
      // Matches the mocked DETACHED_RUN_OWNER_ENV value the SUT reads from
      // '../utils/detached-run-control' (mocked at the top of this file).
      const ownerEnvVar = 'ARCHON_DETACHED_RUN_OWNER';
      const previousOwnerEnv = process.env[ownerEnvVar];
      process.env[ownerEnvVar] = '1';
      try {
        prepareMock
          .mockImplementationOnce((_deps: unknown, opts: { sourceRoot: string; runId?: string }) =>
            stageRealCapture(tempRoot, opts)
          )
          .mockImplementationOnce((_deps: unknown, opts: { sourceRoot: string; runId?: string }) =>
            stageRealCapture(tempRoot, opts)
          );

        await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
          adoptRunId: 'run-old',
          detachedRunId: 'run-detached-child',
        });

        const calls = prepareMock.mock.calls;
        expect(calls).toHaveLength(2);
        expect((calls[0][1] as { runId?: string }).runId).toBe('run-detached-child');
        expect((calls[1][1] as { runId?: string }).runId).toBe('run-detached-child');

        const replacementRoot = join(tempRoot, 'staged-source', 'run-detached-child');
        const manifestPath = join(replacementRoot, 'manifest.json');
        // The assertion the old code fails: the recapture's own cleanup deleted this
        // file right after writing it, because stale.anchor.root === replacement's.
        expect(existsSync(manifestPath)).toBe(true);
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { origin: string };
        expect(manifest.origin).toBe('/wt/adopted');
      } finally {
        if (previousOwnerEnv === undefined) delete process.env[ownerEnvVar];
        else process.env[ownerEnvVar] = previousOwnerEnv;
      }
    }
  );

  it('still cleans up the superseded staged capture when the replacement lands at a different root', async () => {
    // Ordinary adoption uses separate roots and must reclaim the first capture.
    setupAdoptMocks();
    const prepareMock = prepareWorkflowSource as ReturnType<typeof mock>;

    const tempRoot = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-recapture-distinctroot-')));
    const capturedRoots: string[] = [];
    prepareMock
      .mockImplementationOnce(
        async (_deps: unknown, opts: { sourceRoot: string; runId?: string }) => {
          const prepared = await stageRealCapture(tempRoot, opts);
          capturedRoots.push(prepared.anchor.root);
          return prepared;
        }
      )
      .mockImplementationOnce(
        async (_deps: unknown, opts: { sourceRoot: string; runId?: string }) => {
          const prepared = await stageRealCapture(tempRoot, opts);
          capturedRoots.push(prepared.anchor.root);
          return prepared;
        }
      );

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      adoptRunId: 'run-old',
    });

    expect(capturedRoots).toHaveLength(2);
    const [originalRoot, replacementRoot] = capturedRoots;
    expect(originalRoot).not.toBe(replacementRoot);
    // The superseded original is reclaimed...
    expect(existsSync(originalRoot as string)).toBe(false);
    // ...and the replacement it was superseded BY survives.
    expect(existsSync(join(replacementRoot as string, 'manifest.json'))).toBe(true);
  });
});

describe('workflowRunCommand — supersedes run-id prefix resolution (#2990)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  // The suites above leave queued mockOnce values and call history behind on the shared
  // module mocks. Re-install the module-mock defaults so this describe starts from a
  // clean queue and leaves one behind for the suites after it.
  function resetSharedMocks(): void {
    const discoverMock = require('@archon/workflows/workflow-discovery')
      .discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverMock.mockReset();
    discoverMock.mockImplementation(() => Promise.resolve({ workflows: [], errors: [] }));
    const codebaseDb = require('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockReset();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(null)
    );
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockReset();
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(null)
    );
    const conversationDb = require('@archon/core/db/conversations');
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockReset();
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve({
        id: 'conv-123',
        platform_type: 'cli',
        platform_conversation_id: 'cli-123',
      })
    );
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockReset();
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(undefined)
    );
    const workflowDb = require('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockReset();
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(null)
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockReset();
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([])
    );
    mockCreateWorkflowRun.mockReset();
    mockCreateWorkflowRun.mockImplementation(
      (data: {
        workflow_name: string;
        origin?: import('@archon/workflows/schemas/workflow-run').WorkflowRunOrigin;
      }) =>
        Promise.resolve({
          origin: data.origin ?? null,
          id: 'run-detached-created',
          workflow_name: data.workflow_name,
          conversation_id: data.origin?.conversationId ?? null,
          status: 'pending',
          working_path: null,
          started_at: new Date(),
          metadata: {},
        })
    );
    const adoption = require('@archon/core/operations/workflow-adoption');
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockReset();
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.reject(new Error('adoption not expected'))
    );
  }

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    resetSharedMocks();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    resetSharedMocks();
  });

  function setupSupersedesMocks(): void {
    const discoverMock = require('@archon/workflows/workflow-discovery')
      .discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverMock.mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    const codebaseDb = require('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-sup',
      name: 'test-repo',
      default_cwd: '/test/path',
      kind: 'repo',
    });
  }

  it('supersedes a run from a unique short run-id prefix', async () => {
    const supersededRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const workflowDb = await import('@archon/core/db/workflows');
    setupSupersedesMocks();
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: supersededRunId },
    ]);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: supersededRunId,
      status: 'completed',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      supersedesRunId: '0b1ee8da',
      noWorktree: true,
    });

    expect(workflowDb.findWorkflowRunsByIdPrefix).toHaveBeenCalledWith('0b1ee8da', 'cb-sup');
    // The terminality check sees the resolved full id, not the typed prefix.
    expect(workflowDb.getWorkflowRun).toHaveBeenCalledWith(supersededRunId);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Superseding run ${supersededRunId}`)
    );
  });

  it('rejects an ambiguous supersedes run prefix with its candidates', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const adoption = await import('@archon/core/operations/workflow-adoption');
    setupSupersedesMocks();
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: '0b1ee8da-1111-2222-3333-444455556666' },
      { id: '0b1ee8da-9999-8888-7777-666655554444' },
    ]);

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        supersedesRunId: '0b1ee8da',
        noWorktree: true,
      })
    ).rejects.toThrow(
      '0b1ee8da-1111-2222-3333-444455556666\n  0b1ee8da-9999-8888-7777-666655554444'
    );
    expect(workflowDb.getWorkflowRun).not.toHaveBeenCalled();
    expect(adoption.resolveWorkflowAdoption).not.toHaveBeenCalled();
  });

  it('passes a full supersedes run id through unchanged', async () => {
    const supersededRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const workflowDb = await import('@archon/core/db/workflows');
    setupSupersedesMocks();
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: supersededRunId,
      status: 'completed',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      supersedesRunId: supersededRunId,
      noWorktree: true,
    });

    expect(workflowDb.findWorkflowRunsByIdPrefix).not.toHaveBeenCalled();
    expect(workflowDb.getWorkflowRun).toHaveBeenCalledWith(supersededRunId);
  });

  it('keeps the unknown-id refusal for a prefix that matches nothing', async () => {
    setupSupersedesMocks();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        supersedesRunId: 'deadbeef',
        noWorktree: true,
      })
    ).rejects.toThrow("Cannot supersede: no workflow run 'deadbeef' exists.");
  });

  it('still refuses a supersedes run that is not terminal', async () => {
    const supersededRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const workflowDb = await import('@archon/core/db/workflows');
    setupSupersedesMocks();
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: supersededRunId },
    ]);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: supersededRunId,
      status: 'running',
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        supersedesRunId: '0b1ee8da',
        noWorktree: true,
      })
    ).rejects.toThrow(`Cannot supersede run '${supersededRunId}': it is still running.`);
  });

  it('resolves a supersedes run prefix before passing it to the detached child', async () => {
    const supersededRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    // The detach pre-flight resolves the project the same way the adopt pre-flight
    // does: a subdir cwd misses the exact default-cwd lookup, then the path-prefix
    // lookup resolves the covering folder project.
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test/folder',
      default_cwd: '/test/path',
      kind: 'folder',
    });
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: supersededRunId },
    ]);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: supersededRunId,
      status: 'completed',
    });

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    let spawnCmd: string[] = [];
    // finishStartupWindow advances the 500 ms startup window on fake timers.
    jest.useFakeTimers();
    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path/subdir',
        'assist',
        'hello',
        {
          detach: true,
          supersedesRunId: '0b1ee8da',
        }
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnCmd = firstDetachedSpawnOptions(spawnSpy).cmd.slice();
    } finally {
      jest.useRealTimers();
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    const supIndex = spawnCmd.indexOf('--supersedes');
    expect(supIndex).toBeGreaterThan(-1);
    expect(spawnCmd[supIndex + 1]).toBe(supersededRunId);
    expect(workflowDb.findWorkflowRunsByIdPrefix).toHaveBeenCalledWith('0b1ee8da', 'cb-1');
    expect(mockCreateWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ adopted_from_run_id: supersededRunId })
    );
  });

  it('refuses a non-terminal supersedes run in the detach pre-flight before forking', async () => {
    const supersededRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test/folder',
      default_cwd: '/test/path',
      kind: 'folder',
    });
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: supersededRunId },
    ]);
    // Argument-aware on purpose: the queued-value mocks are argument-blind, which
    // would let terminality pass here even if it ran on the raw prefix.
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockImplementation(async (id: string) =>
      id === supersededRunId ? { id: supersededRunId, status: 'running' } : null
    );

    const spawnSpy = spyOn(Bun, 'spawn');
    try {
      // The refusal names the resolved full id, so terminality is checked on the
      // resolution, not on the raw prefix.
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/test/path/subdir', 'assist', 'hello', {
          detach: true,
          supersedesRunId: '0b1ee8da',
        })
      ).rejects.toThrow(`Cannot supersede run '${supersededRunId}': it is still running.`);
    } finally {
      spawnSpy.mockRestore();
    }

    // The refusal reached the parent: no child was forked and no pending run row
    // was left behind for a launch that cannot proceed (#2872).
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
  });
});

const git = await import('@archon/git');
const codebases = await import('@archon/core/db/codebases');
const core = await import('@archon/core');
const executor = await import('@archon/workflows/executor');

const runConversationDb = await import('@archon/core/db/conversations');

describe('run codebase resolution', () => {
  const childRoot = '/parent/projects/child';
  const child = { id: 'cb-child', name: 'owner/child', default_cwd: childRoot, kind: 'repo' };
  const parent = { id: 'cb-parent', name: 'owner/parent', default_cwd: '/parent', kind: 'repo' };
  let consoleSpy: ReturnType<typeof spyOn>;

  function resetLookups(): void {
    (git.findRepoRoot as ReturnType<typeof mock>).mockReset().mockResolvedValue(null);
    (git.getCanonicalRepoPath as ReturnType<typeof mock>)
      .mockReset()
      .mockImplementation(async (path: string) => path);
    (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>)
      .mockReset()
      .mockResolvedValue(null);
    (codebases.findCodebaseByPathPrefix as ReturnType<typeof mock>)
      .mockReset()
      .mockResolvedValue(null);
    (codebases.getCodebase as ReturnType<typeof mock>).mockReset().mockResolvedValue(null);
    (core.registerRepository as ReturnType<typeof mock>).mockReset().mockResolvedValue({
      codebaseId: 'cb-auto',
      name: 'test/repo',
      defaultCwd: '/test/path',
      alreadyExisted: false,
    });
  }

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    resetLookups();
    (runConversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockClear();
    mockCreateWorkflowRun.mockClear();
    (executor.executeWorkflow as ReturnType<typeof mock>).mockClear();
    mockDiscoverWorkflowsWithConfig.mockReset().mockResolvedValue({
      workflows: [makeTestWorkflowWithSource({ name: 'probe' })],
      errors: [],
    });
    (git.findRepoRoot as ReturnType<typeof mock>).mockResolvedValue(childRoot);
    (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockImplementation(
      async (path: string) => (path === '/parent' ? parent : null)
    );
    (codebases.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValue(parent);
    (core.registerRepository as ReturnType<typeof mock>).mockResolvedValue({
      codebaseId: child.id,
      name: child.name,
      defaultCwd: childRoot,
      alreadyExisted: false,
    });
    (codebases.getCodebase as ReturnType<typeof mock>).mockImplementation(async (id: string) =>
      id === child.id ? child : null
    );
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    resetLookups();
  });

  function expectChildExecution(): void {
    expect(runConversationDb.getOrCreateConversation).not.toHaveBeenCalled();
    expect(
      (executor.executeWorkflow as ReturnType<typeof mock>).mock.calls.at(-1)?.[7]
    ).toMatchObject({ codebaseId: child.id });
  }

  it('passes the registration choice while leaving this run base unset', async () => {
    await workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', {
      noWorktree: true,
      registrationBaseBranch: 'release',
    });
    expect(core.registerRepository).toHaveBeenCalledWith(childRoot, { baseBranch: 'release' });
    expectChildExecution();
  });

  it.each([{ noWorktree: true }, { detach: true }])(
    'refuses to launch when a newly registered project cannot be read back (%j)',
    async options => {
      (codebases.getCodebase as ReturnType<typeof mock>).mockResolvedValue(null);
      await expect(
        workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', options)
      ).rejects.toThrow('cb-child');
      expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
      expect(executor.executeWorkflow).not.toHaveBeenCalled();
    }
  );

  it.each(['missing', 'error'] as const)(
    'requires the supplied project ID when its lookup is %s',
    async mode => {
      const lookup = codebases.getCodebase as ReturnType<typeof mock>;
      if (mode === 'error') lookup.mockRejectedValue(new Error('stored project lookup failed'));
      else lookup.mockResolvedValue(null);
      (core.registerRepository as ReturnType<typeof mock>).mockClear();
      await expect(
        workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', {
          noWorktree: true,
          codebaseId: 'stored-project',
        })
      ).rejects.toThrow(
        mode === 'error'
          ? 'Cannot run workflow: project lookup failed.\nError: stored project lookup failed'
          : /^Project "stored-project" no longer exists\.$/
      );
      expect(core.registerRepository).not.toHaveBeenCalled();
      expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
      expect(executor.executeWorkflow).not.toHaveBeenCalled();
    }
  );

  it('uses the supplied project ID even when the path matches another project', async () => {
    (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue(parent);
    await workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', {
      noWorktree: true,
      codebaseId: child.id,
    });
    expectChildExecution();
  });

  it('a registration failure is fatal instead of running unregistered', async () => {
    (core.registerRepository as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error("EACCES: permission denied, mkdir '/w/_local/child'")
    );
    const error = await captureError(
      workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', { noWorktree: true })
    );
    expect(error.message).toContain('Cannot run workflow: project registration failed.');
    expect(error.message).toContain('Check your Archon workspace registration');
    expect(executor.executeWorkflow).not.toHaveBeenCalled();
  });

  it('reports a registration refusal without a workspace hint', async () => {
    const { ProjectRegistrationError } = await import('@archon/core/handlers/clone');
    (core.registerRepository as ReturnType<typeof mock>).mockRejectedValueOnce(
      new ProjectRegistrationError('Project "acme/app" is already registered at /prod/app')
    );
    const error = await captureError(
      workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', { noWorktree: true })
    );
    expect(error.message).toBe(
      'Cannot run workflow: project registration failed.\n' +
        'Error: Project "acme/app" is already registered at /prod/app'
    );
    expect(executor.executeWorkflow).not.toHaveBeenCalled();
  });

  it('explicit registration failure is fatal even without worktrees', async () => {
    (core.registerRepository as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error("Configured base branch 'unknown' not found on remote 'origin'")
    );
    await expect(
      workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', {
        noWorktree: true,
        registrationBaseBranch: 'unknown',
      })
    ).rejects.toThrow("Configured base branch 'unknown'");
    expect(executor.executeWorkflow).not.toHaveBeenCalled();
  });

  it('rejects a registration choice for an existing project', async () => {
    (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue(child);
    await expect(
      workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', {
        noWorktree: true,
        registrationBaseBranch: 'release',
      })
    ).rejects.toThrow('already registered');
    expect(core.registerRepository).not.toHaveBeenCalled();
  });

  it('rejects a registration choice for a folder project', async () => {
    (core.registerFolder as ReturnType<typeof mock>).mockClear();
    (git.findRepoRoot as ReturnType<typeof mock>).mockResolvedValue(null);
    await expect(
      workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', {
        noWorktree: true,
        folder: true,
        registrationBaseBranch: 'release',
      })
    ).rejects.toThrow('Folder projects have no base branch');
    expect(core.registerFolder).not.toHaveBeenCalled();
  });

  for (const incompatible of [
    { resume: true },
    { adoptRunId: 'old' },
    { supersedesRunId: 'old' },
    { dryRun: true },
  ]) {
    it(`rejects registration choice with ${Object.keys(incompatible)[0]}`, async () => {
      await expect(
        workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', {
          ...incompatible,
          registrationBaseBranch: 'release',
        })
      ).rejects.toThrow('initial registration');
      expect(core.registerRepository).not.toHaveBeenCalled();
    });
  }

  it('registers an unregistered child from its nearest Git root', async () => {
    await workflowRunCommand(createTestWorkflowHost(), `${childRoot}/tools`, 'probe', 'go', {
      noWorktree: true,
    });
    expect(core.registerRepository).toHaveBeenCalledWith(childRoot, { baseBranch: undefined });
    expectChildExecution();
  });

  it('registers the child even when the workflow disables worktrees', async () => {
    mockDiscoverWorkflowsWithConfig.mockResolvedValue({
      workflows: [makeTestWorkflowWithSource({ name: 'probe', worktree: { enabled: false } })],
      errors: [],
    });
    await workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go');
    expect(core.registerRepository).toHaveBeenCalledWith(childRoot, { baseBranch: undefined });
    expectChildExecution();
  });

  it('registers the child during detached preflight and attributes the pending run', async () => {
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(createDetachedChildFixture().child);
    jest.useFakeTimers();
    try {
      const command = workflowRunCommand(
        createTestWorkflowHost(),
        `${childRoot}/tools`,
        'probe',
        'go',
        {
          detach: true,
          noWorktree: true,
        }
      );
      await finishStartupWindow(command, spawnSpy);
      expect(runConversationDb.getOrCreateConversation).not.toHaveBeenCalled();
      expect(mockCreateWorkflowRun).toHaveBeenCalledWith(
        expect.objectContaining({ codebase_id: child.id })
      );
      expect(core.registerRepository).toHaveBeenCalledWith(childRoot, { baseBranch: undefined });
    } finally {
      jest.useRealTimers();
      spawnSpy.mockRestore();
    }
  });

  for (const cwd of [childRoot, `${childRoot}/tools`]) {
    it(`reuses the registered repository from ${cwd}`, async () => {
      (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockImplementation(
        async (path: string) => (path === childRoot ? child : path === '/parent' ? parent : null)
      );
      await workflowRunCommand(createTestWorkflowHost(), cwd, 'probe', 'go', { noWorktree: true });
      expect(core.registerRepository).not.toHaveBeenCalled();
      expectChildExecution();
    });
  }

  it('maps a linked worktree subdirectory to the registered primary checkout', async () => {
    const worktree = '/parent/worktrees/child-probe';
    (git.findRepoRoot as ReturnType<typeof mock>).mockResolvedValue(worktree);
    (git.getCanonicalRepoPath as ReturnType<typeof mock>).mockImplementation(
      async (path: string) => (path === worktree ? childRoot : path)
    );
    (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockImplementation(
      async (path: string) => (path === childRoot ? child : path === '/parent' ? parent : null)
    );
    await workflowRunCommand(createTestWorkflowHost(), `${worktree}/tools`, 'probe', 'go', {
      noWorktree: true,
    });
    expect(core.registerRepository).not.toHaveBeenCalled();
    expectChildExecution();
  });

  it('uses the resolver for canonical lookup and passes the Git top level to registration', async () => {
    // Git prints `C:/...` on Windows while `default_cwd` is stored canonically.
    const gitSpelling = 'C:/parent/projects/child';
    (git.findRepoRoot as ReturnType<typeof mock>).mockResolvedValue(gitSpelling);
    mockCanonicalizeProjectPath.mockImplementation(async (path: string) =>
      path === gitSpelling ? childRoot : path
    );
    try {
      await workflowRunCommand(createTestWorkflowHost(), `${childRoot}/tools`, 'probe', 'go', {
        noWorktree: true,
      });
      expect(codebases.findCodebaseByDefaultCwd).toHaveBeenCalledWith(childRoot);
      expect(codebases.findCodebaseByDefaultCwd).not.toHaveBeenCalledWith(gitSpelling);
      expect(core.registerRepository).toHaveBeenCalledWith(gitSpelling, { baseBranch: undefined });
      expectChildExecution();
    } finally {
      mockCanonicalizeProjectPath.mockReset().mockImplementation(async (path: string) => path);
    }
  });

  for (const options of [
    { folder: true, noWorktree: true },
    { folder: true, detach: true },
  ]) {
    it(`explicit folder lookup failure stops execution before registration (${JSON.stringify(options)})`, async () => {
      const registerFolder = core.registerFolder as ReturnType<typeof mock>;
      registerFolder.mockClear();
      (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockRejectedValueOnce(
        new Error('registration lookup unavailable')
      );
      await expect(
        workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', options)
      ).rejects.toThrow('registration lookup unavailable');
      expect(registerFolder).not.toHaveBeenCalled();
      expect(core.registerRepository).not.toHaveBeenCalled();
      expect(executor.executeWorkflow).not.toHaveBeenCalled();
      expect(git.findRepoRoot).not.toHaveBeenCalled();
    });
  }

  it('retains prefix resolution for a non-Git folder subdirectory', async () => {
    (git.findRepoRoot as ReturnType<typeof mock>).mockResolvedValue(null);
    (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue(null);
    (codebases.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValue({
      id: 'cb-folder',
      name: 'folder',
      default_cwd: '/folder',
      kind: 'folder',
    });
    await workflowRunCommand(createTestWorkflowHost(), '/folder/tools', 'probe', 'go');
    expect(codebases.findCodebaseByPathPrefix).toHaveBeenCalledWith('/folder/tools');
    expect(core.registerRepository).not.toHaveBeenCalled();
    expect(
      (executor.executeWorkflow as ReturnType<typeof mock>).mock.calls.at(-1)?.[7]
    ).toMatchObject({ codebaseId: 'cb-folder' });
  });

  it('preserves a legacy path error during registration without falling back', async () => {
    const error = new InvalidCodebaseDefaultCwdError('legacy', 'projects/repo');
    (core.registerRepository as ReturnType<typeof mock>).mockRejectedValueOnce(error);
    await expect(
      workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', { noWorktree: true })
    ).rejects.toThrow(error.message);
    expect(executor.executeWorkflow).not.toHaveBeenCalled();
  });

  for (const options of [{ noWorktree: true }, { detach: true }, { codebaseId: 'legacy' }]) {
    it(`treats an invalid stored path as terminal with ${JSON.stringify(options)}`, async () => {
      const error = new InvalidCodebaseDefaultCwdError('legacy', 'projects/repo');
      if ('codebaseId' in options) {
        (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue(null);
        (codebases.getCodebase as ReturnType<typeof mock>).mockRejectedValueOnce(error);
      } else {
        (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockRejectedValueOnce(
          error
        );
      }
      await expect(
        workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', options)
      ).rejects.toThrow(error.message);
      expect(core.registerRepository).not.toHaveBeenCalled();
      expect(executor.executeWorkflow).not.toHaveBeenCalled();
    });
  }

  it('surfaces checkout identity errors without parent fallback or registration', async () => {
    (git.getCanonicalRepoPath as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('checkout identity unavailable')
    );
    await expect(
      workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go')
    ).rejects.toThrow('checkout identity unavailable');
    expect(core.registerRepository).not.toHaveBeenCalled();
  });
});

describe('detached registration branch choice', () => {
  it('preserves a flag-looking positional message after the argument delimiter', () => {
    const cmd = buildDetachedRunCmd(
      true,
      '/archon',
      [
        '/archon',
        '/entry',
        'workflow',
        'run',
        'test',
        '--base-branch',
        'release',
        '--',
        '--base-branch',
      ],
      '/repo',
      ['--conversation-id', 'conv']
    );
    expect(cmd.slice(-2)).toEqual(['--', '--base-branch']);
    expect(cmd.indexOf('--conversation-id')).toBeLessThan(cmd.indexOf('--'));
  });
  for (const binary of [true, false]) {
    for (const choice of [['--base-branch', 'release'], ['--base-branch=release']]) {
      it(`consumes registration choice before the child in binary=${binary} syntax=${choice[0]}`, () => {
        const cmd = buildDetachedRunCmd(
          binary,
          '/bun',
          ['/bun', '/cli.ts', 'workflow', 'run', 'test', '--detach', ...choice, '--base', 'dev'],
          '/repo',
          []
        );
        expect(cmd).not.toContain('--base-branch');
        expect(cmd).not.toContain('--base-branch=release');
        expect(cmd).not.toContain('release');
        expect(cmd).toContain('--base');
        expect(cmd).toContain('dev');
      });
    }
  }
});

describe('workflow run credential launch refusal', () => {
  it.each(
    [false, true].flatMap(detach => [
      { detach, adopt: false },
      { detach, adopt: true },
    ])
  )('blocks before isolation, title generation and spawning (%j)', async ({ detach, adopt }) => {
    const adapter = await import('@archon/core/workflows/store-adapter');
    const original = adapter.createWorkflowDeps;
    const createDeps = spyOn(adapter, 'createWorkflowDeps').mockImplementation(() => ({
      ...original(),
      isPerUserProviderKeysEnabled: () => true,
      getUserProviderCredential: async (_userId, vendor) => ({
        kind: 'api_key',
        getStatus: async () =>
          adopt && vendor === 'anthropic'
            ? { state: 'usable', source: 'archon' }
            : {
                state: 'unusable',
                source: 'archon',
                evidence: 'stored credential unreadable',
              },
      }),
    }));
    const isolation = await import('@archon/isolation');
    const core = await import('@archon/core');
    const codebases = await import('@archon/core/db/codebases');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    mockDiscoverWorkflowsWithConfig.mockImplementation(async path => ({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'credential-run',
          provider: adopt && path === '/adopted/snapshot' ? 'codex' : 'claude',
        }),
      ],
      errors: [],
    }));
    const adoptedRunId = '11111111-1111-1111-1111-111111111111';
    if (adopt) {
      const { resolveWorkflowAdoption } = await import('@archon/core/operations/workflow-adoption');
      (resolveWorkflowAdoption as ReturnType<typeof mock>).mockResolvedValueOnce({
        adoptedRun: { id: adoptedRunId, status: 'completed', working_path: '/old' },
        lane: { kind: 'checkout-branch', taskBranch: { kind: 'existing', branch: 'feature/dead' } },
      });
    }
    (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue({
      id: 'cb',
      name: 'test/repo',
      default_cwd: '/test/path',
      kind: 'repo',
    });
    (core.generateAndSetTitle as ReturnType<typeof mock>).mockClear();
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
    (isolation.getIsolationProvider as ReturnType<typeof mock>).mockClear();
    mockResolveFolderBackend.mockClear();
    const spawn = spyOn(Bun, 'spawn');
    try {
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/test/path', 'credential-run', 'go', {
          detach,
          ...(adopt ? { adoptRunId: adoptedRunId } : {}),
        })
      ).rejects.toThrow(
        `Credential preflight failed for provider '${adopt ? 'codex' : 'claude'}' (vendor '${adopt ? 'openai' : 'anthropic'}'): credential cannot be used: stored credential unreadable`
      );
      expect(isolation.getIsolationProvider).not.toHaveBeenCalled();
      expect(mockResolveFolderBackend).not.toHaveBeenCalled();
      expect(core.generateAndSetTitle).not.toHaveBeenCalled();
      expect(executeWorkflow).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
      createDeps.mockRestore();
    }
  });
});
