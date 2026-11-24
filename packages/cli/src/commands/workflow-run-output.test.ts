import {
  mockLogger,
  mockRunLiveOwnerClose,
  mockStartRunLiveOwner,
  mockFolderBackendDestroy,
  mockFolderBackendReleaseImages,
  testRunParents,
  commitTestEvent,
  createTestWorkflowHost,
  setMockDetachedStopRequested,
  setFailTestFeedReads,
  resetCommittedTestEvents,
} from '../test-support/workflow-command-harness';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { getArchonHome, getRunArtifactsDirForRoot } from '@archon/paths';
import * as isolation from '@archon/isolation';
import { realReleaseRunVerificationImages } from '../test-support/workflow-harness-checkout';
import { hostname, tmpdir } from 'node:os';
import type { ReleaseVerificationImages } from '@archon/workflows/deps';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from '@archon/workflows/file-store';
import type { IWorkflowStore } from '@archon/workflows/store';
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { WorkflowExecutionHandoffError } from '@archon/workflows/engine-port';
import type { WorkflowExecutionResult } from '@archon/workflows/schemas/workflow';
import {
  workflowRunStatusSchema,
  type WorkflowRunStatus,
} from '@archon/workflows/schemas/workflow-run';
import type { ProviderEvent } from '@archon/provider-contract';
import { resolveWorkflow } from '@archon/workflows/graph-plan';
import {
  finishNodeExecution,
  newNodeInvocation,
  startNodeExecution,
} from '@archon/workflows/node-execution';
import { serializeNodeStateRecord } from '@archon/workflows/node-record-serialization';
import type { NodeStateRecord } from '@archon/workflows/schemas/node-execution';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import { workflowRunCommand } from './workflow-run-owned';
import { presentRunResult } from './workflow-run-output';
import { usageEvents } from '../test-support/usage-fixtures';
import { deadlineWaitCursor } from '@archon/workflows/store';
import { resolveCliExitCode, WorkflowRunFailedError } from '../utils/workflow-exit-code';

const trackTempRootsForOutput = trackTempRoots();

/** An output root in which `runId` recorded a verification build, as `docker build --iidfile` does. */
async function recordedBuildRoot(runId: string): Promise<string> {
  const { VERIFICATION_IMAGE_RECORD_DIR } = await import(
    '../../../core/src/services/cleanup/run-verification-images'
  );
  const root = trackTempRootsForOutput(await mkdtemp(join(getArchonHome(), 'archon-cli-images-')));
  const dir = join(getRunArtifactsDirForRoot(root, runId), VERIFICATION_IMAGE_RECORD_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'check'), 'sha256:built');
  return root;
}

describe('workflowRunCommand — progress rendering', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;

  function setupWorkflowMocks(withAuthoredOutcome = false): void {
    // These need to be set up for each test since workflowRunCommand has many dependencies
    const discoverMock = require('@archon/workflows/workflow-discovery')
      .discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    const workflow = withAuthoredOutcome
      ? makeTestWorkflowWithSource({
          name: 'plan',
          description: 'Plan work',
          returns: 'result',
          result: { outcome: 'ready' },
          nodes: [
            {
              id: 'result',
              command: 'test-command',
              output_format: {
                type: 'object',
                properties: { ready: { type: 'boolean' } },
                required: ['ready'],
              },
            },
          ],
        })
      : makeTestWorkflowWithSource({ name: 'plan', description: 'Plan work' });
    discoverMock.mockResolvedValueOnce({
      workflows: [workflow],
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

  async function runOutcomeFixture(
    execution: WorkflowExecutionResult,
    status: 'completed' | 'failed' | 'paused',
    outcome: 'succeeded' | 'failed' | null = null
  ): Promise<unknown> {
    setupWorkflowMocks(true);
    const { executeWorkflow } = require('@archon/workflows/executor');
    const workflowDb = require('@archon/core/db/workflows');
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce(execution);
    // Paused runs are read for their pause, never for an authored outcome.
    const readsRun = !('handedOff' in execution);
    if (readsRun) {
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: execution.workflowRunId,
        status,
        // The CLI reads completed_outcome; the legacy column stays empty so it cannot stand in.
        outcome: null,
        completed_outcome: outcome,
        metadata: { total_cost_usd: 0.024, total_tokens_in: 8420, total_tokens_out: 2180 },
      });
    }

    const readsBefore = workflowDb.getWorkflowRun.mock.calls.length;
    try {
      const host = createTestWorkflowHost();
      host.deps.releaseRunResources = undefined;
      await workflowRunCommand(host, '/test/path', 'plan', 'hello', {});
      return undefined;
    } catch (error) {
      return error;
    } finally {
      expect(workflowDb.getWorkflowRun.mock.calls.length - readsBefore).toBe(readsRun ? 1 : 0);
    }
  }

  async function runPauseFixture(
    metadata: Record<string, unknown> | Error | null,
    byOperator = false
  ): Promise<string> {
    setupWorkflowMocks();
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-ask',
      paused: true,
      ...(byOperator ? { byOperator: true } : {}),
    });
    const { mockWorkflowRun } = await import('../../../core/src/test/mocks/workflow-run');
    const host = createTestWorkflowHost();
    host.deps.releaseRunResources = undefined;
    host.deps.store.getWorkflowRun = async () => {
      if (metadata instanceof Error) throw metadata;
      return metadata === null
        ? null
        : { ...mockWorkflowRun, id: 'run-ask', status: 'paused', metadata };
    };
    await workflowRunCommand(host, '/test/path', 'plan', 'hello', {});
    return consoleSpy.mock.calls.flat().join('\n');
  }

  const attentionWait = {
    owner: 'node',
    nodeId: 'question',
    kind: 'attention',
    waitingSince: '2026-11-22T10:00:00.000Z',
    pauseId: 'ask-1',
    form: 'message',
    message: 'Which destination should receive the report?',
  } as const;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    resetCommittedTestEvents();
    testRunParents.clear();
    setFailTestFeedReads(false);
    setMockDetachedStopRequested(false);
    mockStartRunLiveOwner.mockClear();
    mockRunLiveOwnerClose.mockClear();
    delete process.env.ARCHON_DETACHED_RUN_OWNER;
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  // Whether a run built images comes from its recorded --iidfile build, never its
  // isolation: an unrecorded run stays silent with Docker down, a recorded one reports.
  it.each([
    ['host', 'unrecorded'],
    ['container', 'unrecorded'],
    ['host', 'recorded'],
    ['container', 'recorded'],
    ['isolation-container', 'recorded'],
  ] as const)(
    'warns about a %s inventory failure only for a recorded run (%s)',
    async (kind, record) => {
      setupWorkflowMocks();
      const { executeWorkflow } = require('@archon/workflows/executor');
      (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
        success: true,
        workflowRunId: 'test-run-id',
      });
      const { mockWorkflowRun } = await import('../../../core/src/test/mocks/workflow-run');
      const { createRunResourceRelease } = await import(
        '../../../core/src/services/cleanup/run-verification-images'
      );
      const container = kind !== 'host';
      const outputRoot =
        record === 'recorded'
          ? await recordedBuildRoot('test-run-id')
          : trackTempRootsForOutput(await mkdtemp(join(getArchonHome(), 'archon-cli-images-')));
      const row = {
        ...mockWorkflowRun,
        id: 'test-run-id',
        status: 'completed' as const,
        output_root: outputRoot,
        metadata: {
          execution_owner: { host: hostname(), pid: process.pid },
          ...(container ? { isolation: 'container', isolation_env_id: 'env-a' } : {}),
        },
      };
      const calls: string[][] = [];
      const runner: isolation.DockerRunner = async args => {
        calls.push(args);
        if (args[0] === 'container' && kind !== 'isolation-container') {
          return { stdout: '', stderr: '' };
        }
        throw new Error('Cannot connect to the Docker daemon');
      };
      const release = spyOn(isolation, 'releaseRunVerificationImages').mockImplementation(
        (id, env) => realReleaseRunVerificationImages(id, env, runner)
      );
      const warning = spyOn(console, 'error').mockImplementation(() => {});
      try {
        const host = createTestWorkflowHost();
        host.deps.releaseRunResources = createRunResourceRelease(
          { getWorkflowRun: async () => row },
          container ? (id, env) => realReleaseRunVerificationImages(id, env, runner) : undefined
        );
        const error = await workflowRunCommand(host, '/test/path', 'plan', 'hello', {}).catch(
          (err: unknown) => err
        );
        const text = warning.mock.calls.flat().join(' ');
        if (record === 'unrecorded') {
          expect(error).toBeUndefined();
          expect(text).not.toContain('verification image');
          expect(text).not.toContain('inconclusive');
          expect(calls).toEqual([]);
          return;
        }
        if (container) {
          expect(error).toBeInstanceOf(Error);
          expect(resolveCliExitCode(error)).toBe(1);
          expect(text).toContain('WARNING: Run test-run-id retained verification images');
          expect(text).not.toContain('cleanup is inconclusive');
        } else {
          expect(error).toBeUndefined();
          expect(text).toContain('Run test-run-id verification image inventory failed');
        }
        expect(calls.map(args => args.slice(0, 2))).toEqual(
          kind === 'isolation-container'
            ? [['container', 'ls']]
            : container
              ? [
                  ['container', 'ls'],
                  ['image', 'ls'],
                ]
              : [['image', 'ls']]
        );
      } finally {
        warning.mockRestore();
        release.mockRestore();
      }
    }
  );

  it.each([false, true])(
    'uses the fresh container backend for foreground cleanup (failure=%s)',
    async fails => {
      const { discoverWorkflowsWithConfig } = require('@archon/workflows/workflow-discovery');
      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
        errors: [],
      });
      const codebaseDb = require('@archon/core/db/codebases');
      (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'cb-folder',
        name: 'folder',
        default_cwd: '/test/path',
        default_branch: null,
        kind: 'folder',
      });
      const { executeWorkflow } = require('@archon/workflows/executor');
      (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(
        async (
          ...args: Parameters<typeof import('@archon/workflows/executor').executeWorkflow>
        ) => {
          expect(args[7]?.container?.backend.releaseVerificationImages).toEqual(
            expect.any(Function)
          );
          return { success: true, workflowRunId: 'test-run-id' };
        }
      );
      const { hostname } = await import('node:os');
      const { mockWorkflowRun } = await import('../../../core/src/test/mocks/workflow-run');
      const { createRunResourceRelease } = await import(
        '../../../core/src/services/cleanup/run-verification-images'
      );
      const row = {
        ...mockWorkflowRun,
        id: 'test-run-id',
        status: 'completed' as const,
        output_root: await recordedBuildRoot('test-run-id'),
        metadata: {
          execution_owner: { host: hostname(), pid: process.pid },
          isolation: 'container',
          isolation_env_id: 'container-env-1',
        },
      };
      const host = createTestWorkflowHost();
      host.deps.store.getWorkflowRun = async () => row;
      const defaultRelease = mock(async () => {
        throw new Error('wrong daemon');
      });
      host.deps.releaseRunResources = createRunResourceRelease(
        { getWorkflowRun: async () => row },
        defaultRelease
      );
      const failure = new Error('backend cleanup failed');
      mockFolderBackendReleaseImages.mockClear();
      mockFolderBackendReleaseImages.mockImplementation(async () => {
        if (fails) throw failure;
      });
      try {
        const error = await workflowRunCommand(host, '/test/path', 'assist', 'go', {
          container: true,
        }).catch((err: unknown) => err);
        if (fails) {
          expect(error).toMatchObject({ cause: failure });
          expect(resolveCliExitCode(error)).toBe(1);
        } else expect(error).toBeUndefined();
        expect(mockFolderBackendReleaseImages.mock.calls).toEqual([
          ['test-run-id', 'container-env-1'],
        ]);
        expect(defaultRelease).not.toHaveBeenCalled();
      } finally {
        mockFolderBackendReleaseImages.mockResolvedValue(undefined);
      }
    }
  );

  it.each([false, true])(
    'releases foreground host images after execution (failure=%s)',
    async fails => {
      setupWorkflowMocks();
      const { executeWorkflow } = require('@archon/workflows/executor');
      let settled = false;
      (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
        settled = true;
        return { success: true, workflowRunId: 'test-run-id' };
      });
      const host = createTestWorkflowHost();
      const failure = new Error('Docker denied image removal');
      const release = mock(async (_runId: string) => {
        expect(settled).toBe(true);
        if (fails) throw failure;
      });
      host.deps.releaseRunResources = release;
      mockFolderBackendDestroy.mockClear();
      const warning = spyOn(console, 'error').mockImplementation(() => {});
      try {
        const execution = workflowRunCommand(host, '/test/path', 'plan', 'hello', {});
        if (fails) {
          const error = await execution.catch((err: unknown) => err);
          expect(error).toBeInstanceOf(Error);
          expect(error).toMatchObject({ cause: failure });
          expect(resolveCliExitCode(error)).toBe(1);
          expect(warning).toHaveBeenCalledWith(
            'WARNING: Run test-run-id retained verification images: Error: Docker denied image removal'
          );
          expect(mockLogger.warn).toHaveBeenCalledWith(
            { err: failure, runId: 'test-run-id' },
            'cli.resource_release_failed'
          );
        } else {
          await execution;
          expect(warning).not.toHaveBeenCalled();
        }
        expect(release).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledWith('test-run-id');
        expect(mockFolderBackendDestroy).not.toHaveBeenCalled();
      } finally {
        warning.mockRestore();
      }
    }
  );

  it.each([...workflowRunStatusSchema.options, null])(
    'reports ownership handoff with observed status %s without claiming approval or completion',
    async observedStatus => {
      const result: WorkflowExecutionResult =
        observedStatus === 'failed' || observedStatus === 'cancelled'
          ? {
              success: false,
              handedOff: true,
              observedStatus,
              workflowRunId: 'run-1',
              error: `Workflow ${observedStatus} after execution ownership changed`,
            }
          : { success: true, handedOff: true, observedStatus, workflowRunId: 'run-1' };
      const error = await runOutcomeFixture(result, 'completed', 'succeeded');
      expect(error instanceof WorkflowRunFailedError).toBe(!result.success);
      expect(consoleSpy).toHaveBeenCalledWith(
        `\nWorkflow execution handed off. Observed status: ${observedStatus ?? 'run removed'}.`
      );
      const text = consoleSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
      expect(text).not.toContain('waiting for approval');
      expect(text).not.toContain('Workflow completed successfully');
      expect(text).not.toContain('Authored outcome:');
    }
  );

  it('renders aligned completed execution and succeeded authored outcome', async () => {
    await runOutcomeFixture({ success: true, workflowRunId: 'run-1' }, 'completed', 'succeeded');

    const text = consoleSpy.mock.calls.flat().join('\n');
    expect(text).toContain('Cost: $0.024');
    expect(text).toContain('Input tokens: 8420');
    expect(text).toContain('Output tokens: 2180');
    expect(consoleSpy).toHaveBeenCalledWith(
      '\nWorkflow finished.\n  Status: completed\n  Authored outcome: succeeded'
    );
  });

  it('renders completed execution separately from a failed authored outcome', async () => {
    await runOutcomeFixture({ success: true, workflowRunId: 'run-1' }, 'completed', 'failed');

    expect(consoleSpy).toHaveBeenCalledWith(
      '\nWorkflow finished.\n  Status: completed\n  Authored outcome: failed'
    );
  });

  it('exits 1 for a failed run and still reports its cost', async () => {
    const thrown = await runOutcomeFixture(
      { success: false, workflowRunId: 'run-1', error: 'later node failed' },
      'failed'
    );

    expect(resolveCliExitCode(thrown)).toBe(1);
    expect(consoleSpy.mock.calls.flat().join('\n')).toContain('Cost: $0.024');
  });

  it('preserves the existing completion text when authored outcome is null', async () => {
    await runOutcomeFixture({ success: true, workflowRunId: 'run-1' }, 'completed', null);

    expect(consoleSpy).toHaveBeenCalledWith('\nWorkflow completed successfully.');
  });

  it('distinguishes an unavailable outcome read from an undeclared outcome', async () => {
    setupWorkflowMocks(true);
    const { executeWorkflow } = require('@archon/workflows/executor');
    const workflowDb = require('@archon/core/db/workflows');
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-1',
    });
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('database unavailable')
    );

    const host = createTestWorkflowHost();
    host.deps.releaseRunResources = undefined;
    await workflowRunCommand(host, '/test/path', 'plan', 'hello', {});

    expect(consoleSpy).toHaveBeenCalledWith(
      '\nWorkflow finished.\n  Status: completed\n  Authored outcome: unavailable — failed to read persisted run'
    );
  });

  it('preserves a failure before run creation without claiming an outcome read failed', async () => {
    setupWorkflowMocks(true);
    const { executeWorkflow } = require('@archon/workflows/executor');
    const workflowDb = require('@archon/core/db/workflows');
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: false,
      error: 'Database error creating workflow run',
    });
    const lookup = workflowDb.getWorkflowRun as ReturnType<typeof mock>;
    const readsBefore = lookup.mock.calls.length;
    let thrown: unknown;
    try {
      const host = createTestWorkflowHost();
      host.deps.releaseRunResources = undefined;
      await workflowRunCommand(host, '/test/path', 'plan', 'hello', {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkflowRunFailedError);
    expect(thrown).toMatchObject({
      message: 'Workflow failed: Database error creating workflow run',
    });
    expect(resolveCliExitCode(thrown)).toBe(1);
    expect(lookup.mock.calls.length).toBe(readsBefore);
    expect(consoleSpy).toHaveBeenCalledWith('  Usage: unavailable (persisted run unavailable)');
    expect(consoleSpy.mock.calls.flat().join('\n')).not.toContain('Authored outcome');
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('reports an attention pause as an ask with its answer command', async () => {
    const text = await runPauseFixture({ pause_cause: 'wait', wait: attentionWait });
    expect(text).toContain('waiting for an answer');
    expect(text).toContain('archon workflow attention run-ask');
    expect(text).toContain('archon workflow approve run-ask <your answer>');
    expect(text).not.toContain('waiting for approval');
    expect(text).not.toContain('Usage');
    expect(text).not.toContain('Authored outcome');
  });

  it.each([undefined, 'approval'] as const)('reports an approval gate (type=%s)', async type => {
    const text = await runPauseFixture({
      pause_cause: 'gate',
      approval: { nodeId: 'review', message: 'Ready to proceed?', pauseId: 'gate-1', type },
    });
    expect(text).toContain('waiting for approval');
    expect(text).toContain('archon workflow approve run-ask --occurrence gate-1 [comment]');
    expect(text).toContain('archon workflow attention run-ask');
    expect(text).not.toContain('interactive input');
  });

  it('reports the recorded interactive-loop gate as input with a feedback command', async () => {
    const text = await runPauseFixture({
      pause_cause: 'gate',
      approval: {
        nodeId: 'revise',
        message: 'Give feedback for the next iteration',
        pauseId: 'loop-1',
        type: 'interactive_loop',
        iteration: 2,
        sessionId: null,
        completionSignaled: false,
        signaledOutput: null,
        signaledStructuredOutput: null,
        iterationOutput: 'Draft report',
        signaledTokens: null,
        signaledCostUsd: null,
        commandSnapshot: 'Revise the report',
      },
    });
    expect(text).toContain('waiting for interactive input');
    expect(text).toContain('archon workflow approve run-ask --occurrence loop-1 <your feedback>');
    expect(text).not.toContain('waiting for approval');
  });

  it.each([
    { form: 'approval', command: 'archon workflow approve run-ask [text]' },
    { form: 'select', command: 'archon workflow respond run-ask email [text]' },
    {
      form: 'multi_select',
      command: 'archon workflow answer run-ask --occurrence ask-1 --choose <id>',
    },
  ] as const)(
    'uses the existing answer command for an attention $form',
    async ({ form, command }) => {
      const text = await runPauseFixture({
        wait: {
          ...attentionWait,
          form,
          options: [{ id: 'email', does: 'Send the report by email' }],
        },
      });
      expect(text).toContain('waiting for an answer');
      expect(text).toContain(command);
      expect(text).not.toContain('waiting for approval');
    }
  );

  it('gives legacy attention waits their usable resume command', async () => {
    const { pauseId: _pauseId, form: _form, ...legacyWait } = attentionWait;
    const text = await runPauseFixture({ wait: legacyWait });
    expect(text).toContain('waiting for an answer');
    expect(text).toContain('archon workflow resume run-ask');
    expect(text).not.toContain('archon workflow approve');
    expect(text).not.toContain('archon workflow answer');
  });

  it.each(['operator', 'source_release'] as const)(
    'does not treat historical wait and gate metadata as the current %s pause',
    async pauseCause => {
      const text = await runPauseFixture({
        pause_cause: pauseCause,
        ...(pauseCause === 'source_release'
          ? { source_release: { nodeId: 'next', releasedAt: '2026-11-22T10:00:00.000Z' } }
          : {}),
        wait: attentionWait,
        approval: { nodeId: 'old-review', message: 'Old gate', type: 'interactive_loop' },
      });
      expect(text).not.toContain('waiting for approval');
      expect(text).not.toContain('waiting for an answer');
      expect(text).not.toContain('interactive input');
      if (pauseCause === 'operator') {
        expect(text).toContain('paused by an operator');
        expect(text).toContain('archon workflow resume run-ask');
      } else expect(text).toContain('archon workflow get run-ask');
    }
  );

  it('preserves an explicit operator pause even when its row is unavailable', async () => {
    const text = await runPauseFixture(new Error('row must not be read'), true);
    expect(text).toContain('paused by an operator');
    expect(text).toContain('archon workflow resume run-ask');
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'missing row', metadata: null },
    { name: 'read failure', metadata: new Error('pause read failed') },
    { name: 'missing metadata', metadata: {} },
    { name: 'malformed gate', metadata: { approval: { nodeId: 'review' } } },
    { name: 'malformed wait', metadata: { wait: { kind: 'attention' } } },
    {
      name: 'unknown gate',
      metadata: { approval: { nodeId: 'review', message: 'Unrecognized gate', type: 'future' } },
    },
  ])('does not invent approval when pause metadata is $name', async ({ metadata }) => {
    const text = await runPauseFixture(metadata);
    expect(text).toContain('Workflow paused');
    expect(text).toContain('archon workflow get run-ask');
    expect(text).not.toContain('waiting for approval');
    expect(text).not.toContain('waiting for an answer');
    expect(text).not.toContain('waiting for interactive input');
    if (metadata instanceof Error)
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: metadata, workflowRunId: 'run-ask' }),
        'cli.workflow_summary_lookup_failed'
      );
  });

  it.each(['attention', 'approval'] as const)(
    'does not ask again for an answered %s pause',
    async kind => {
      const text = await runPauseFixture(
        kind === 'attention'
          ? { wait: { ...attentionWait, answer: { text: 'Email' } } }
          : { approval: { nodeId: 'review', message: 'Ready?', resolved: 'approved' } }
      );
      expect(text).not.toContain('waiting for an answer');
      expect(text).not.toContain('waiting for approval');
      expect(text).toContain('archon workflow get run-ask');
    }
  );

  it('keeps the durable wait cursor and its original destination', async () => {
    const { mockWorkflowRun } = await import('../../../core/src/test/mocks/workflow-run');
    const { CLIAdapter } = await import('../adapters/cli-adapter');
    const wait = {
      owner: 'node',
      nodeId: 'delay',
      kind: 'time',
      waitingSince: '2026-11-22T10:00:00.000Z',
      resumeAt: '2026-11-22T11:00:00.000Z',
      pauseId: 'delay-1',
    } as const;
    const run = { ...mockWorkflowRun, status: 'paused' as const, metadata: { wait } };
    const host = createTestWorkflowHost();
    host.deps.store.getWorkflowRun = mock(async () => run);
    const cursor = deadlineWaitCursor(wait);
    const destination = { kind: 'headless' as const, correlationId: 'original-destination' };
    const continuation = await presentRunResult({
      host,
      workflow: resolveWorkflow({ name: 'delay', description: 'Wait', nodes: [] }),
      result: { success: true, workflowRunId: run.id, paused: true, waitCursor: cursor },
      adapter: new CLIAdapter(),
      conversationId: 'original-conversation',
      destination,
      detachedProcessOwner: false,
    });
    expect(continuation).toEqual({
      run,
      wait: { stepName: 'delay', cursor, signaled: false },
      destination,
    });
    expect(host.deps.store.getWorkflowRun).toHaveBeenCalledTimes(1);
    expect(consoleSpy.mock.calls.flat().join('\n')).toContain("waiting for 'delay' until");
    expect(consoleSpy.mock.calls.flat().join('\n')).not.toContain('waiting for approval');
  });

  const completionUsageCases = [
    {
      kind: 'numbers',
      metadata: { total_cost_usd: 0, total_tokens_in: 12, total_tokens_out: 4 },
      expected: [
        '  Usage (recorded totals):',
        '    Cost: $0',
        '    Input tokens: 12',
        '    Output tokens: 4',
      ],
    },
    {
      kind: 'empty',
      metadata: {},
      expected: [
        '  Usage (recorded totals):',
        '    Cost: unknown',
        '    Input tokens: unknown',
        '    Output tokens: unknown',
      ],
    },
    {
      kind: 'missing',
      metadata: null,
      expected: ['  Usage: unavailable (persisted run unavailable)'],
    },
    {
      kind: 'rejected',
      metadata: null,
      expected: ['  Usage: unavailable (persisted run unavailable)'],
    },
  ];

  it.each(completionUsageCases)(
    'shows usage without a declared outcome: $kind',
    async ({ kind, metadata, expected }) => {
      setupWorkflowMocks();
      const { executeWorkflow } = require('@archon/workflows/executor');
      const workflowDb = require('@archon/core/db/workflows');
      (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
        success: true,
        workflowRunId: 'run-usage',
      });
      const lookup = workflowDb.getWorkflowRun as ReturnType<typeof mock>;
      if (kind === 'rejected') lookup.mockRejectedValueOnce(new Error('summary read failed'));
      else
        lookup.mockResolvedValueOnce(
          metadata === null
            ? null
            : {
                id: 'run-usage',
                status: 'completed',
                outcome: 'failed',
                completed_outcome: 'failed',
                metadata,
              }
        );
      const readsBefore = lookup.mock.calls.length;
      const host = createTestWorkflowHost();
      host.deps.releaseRunResources = undefined;
      await workflowRunCommand(host, '/test/path', 'plan', 'hello', {});
      expect(lookup.mock.calls.length - readsBefore).toBe(1);
      expect(consoleSpy).toHaveBeenCalledWith('\nWorkflow completed successfully.');
      expect(consoleSpy.mock.calls.flat().join('\n')).not.toContain('Authored outcome');
      const text = consoleSpy.mock.calls.flat().join('\n');
      for (const line of expected) expect(text).toContain(line);
    }
  );

  it.each(['missing', 'rejected'] as const)(
    'keeps a failed execution nonzero when the summary is %s',
    async kind => {
      setupWorkflowMocks();
      const { executeWorkflow } = require('@archon/workflows/executor');
      const workflowDb = require('@archon/core/db/workflows');
      (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
        success: false,
        workflowRunId: 'run-missing',
        error: 'execution failed',
      });
      const lookup = workflowDb.getWorkflowRun as ReturnType<typeof mock>;
      if (kind === 'rejected') lookup.mockRejectedValueOnce(new Error('summary unavailable'));
      else lookup.mockResolvedValueOnce(null);
      let thrown: unknown;
      try {
        const host = createTestWorkflowHost();
        host.deps.releaseRunResources = undefined;
        await workflowRunCommand(host, '/test/path', 'plan', 'hello', {});
      } catch (error) {
        thrown = error;
      }
      expect(resolveCliExitCode(thrown)).toBe(1);
      expect(consoleSpy).toHaveBeenCalledWith('  Usage: unavailable (persisted run unavailable)');
    }
  );

  const OWNED_RUN = 'test-run-id';
  const CHILD_RUN = 'child-run-id';

  /** One run and its sub-run as the executor commits them, built by the real serializers. */
  function commitProgressRows(): void {
    const workflow = resolveWorkflow({
      name: 'plan',
      description: 'Plan work',
      nodes: [
        { id: 'plan', kind: 'agent', source: { kind: 'command', name: 'plan-cmd' } },
        { id: 'build', kind: 'exec', runtime: 'sh', script: 'make' },
        { id: 'deploy', kind: 'exec', runtime: 'sh', script: 'make deploy' },
      ],
    });
    const node = (id: string): (typeof workflow.nodes)[number] => {
      const found = workflow.nodes.find(candidate => candidate.id === id);
      if (!found) throw new Error(`fixture has no node ${id}`);
      return found;
    };
    const commitRecord = (record: NodeStateRecord): void => {
      const { workflow_run_id, event_type, step_name, data } = serializeNodeStateRecord(record);
      commitTestEvent({ workflow_run_id, event_type, step_name, data: { ...data } });
    };
    const runNode = (
      runId: string,
      id: string,
      lifecycle: Parameters<typeof finishNodeExecution>[1],
      durationMs: number,
      binding: { provider?: string; model?: string; tier?: 'large' } = {}
    ): void => {
      const start = startNodeExecution({
        runId,
        path: id,
        node: node(id),
        invocation: newNodeInvocation(),
        ...binding,
      });
      if (lifecycle.status !== 'skipped') commitRecord(start);
      commitRecord(finishNodeExecution(start, lifecycle, { durationMs }));
    };
    const providerEvent = (
      step: string,
      attemptId: string,
      seq: number,
      observedAt: string,
      event: ProviderEvent
    ): void => {
      commitTestEvent({
        workflow_run_id: OWNED_RUN,
        event_type: 'provider_event',
        step_name: step,
        data: { attemptId, seq, observedAt, event },
      });
    };

    testRunParents.set(CHILD_RUN, OWNED_RUN);
    commitTestEvent({
      workflow_run_id: OWNED_RUN,
      event_type: 'workflow_started',
      step_name: null,
      data: { workflowName: 'plan', transcriptPath: '/logs/test-run-id.jsonl' },
    });
    commitTestEvent({
      workflow_run_id: OWNED_RUN,
      event_type: 'container_created',
      step_name: 'container',
      data: { containerId: 'abcdef0123456789' },
    });
    runNode(OWNED_RUN, 'plan', { status: 'completed' }, 12_400, {
      provider: 'claude',
      model: 'opus',
      tier: 'large',
    });
    // A call id is unique only within its attempt, so two attempts can repeat one.
    providerEvent('plan', 'attempt-1', 0, '2026-10-02T10:00:00.000Z', {
      type: 'tool_call',
      toolCallId: 'call-1',
      name: 'Bash',
      title: 'ls -la',
    });
    providerEvent('build', 'attempt-2', 0, '2026-10-02T10:00:00.010Z', {
      type: 'tool_call',
      toolCallId: 'call-1',
      name: 'Read',
    });
    providerEvent('plan', 'attempt-1', 1, '2026-10-02T10:00:00.042Z', {
      type: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'failed',
      exitCode: 1,
    });
    providerEvent('build', 'attempt-2', 1, '2026-10-02T10:00:00.110Z', {
      type: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
    });
    // A completion whose start the subscription never saw still names its call.
    providerEvent('plan', 'attempt-1', 2, '2026-10-02T10:00:01.000Z', {
      type: 'tool_call_update',
      toolCallId: 'call-2',
      status: 'completed',
    });
    providerEvent('plan', 'attempt-1', 3, '2026-10-02T10:00:01.000Z', {
      type: 'agent_message_chunk',
      text: 'not a tool line',
    });
    runNode(OWNED_RUN, 'build', { status: 'completed' }, 90_000);
    runNode(
      CHILD_RUN,
      'build',
      { status: 'failed', error: 'output missed its schema', failureKind: 'schema_unmet' },
      1_000
    );
    commitTestEvent({
      workflow_run_id: 'unrelated-run-id',
      event_type: 'node_started',
      step_name: 'unrelated',
      data: {},
    });
    runNode(
      OWNED_RUN,
      'deploy',
      {
        status: 'skipped',
        reason: 'when_condition',
        cause: { kind: 'condition', expr: '$plan.output == deploy' },
      },
      0
    );
    commitRecord({
      runId: OWNED_RUN,
      path: 'plan',
      node: { id: 'plan', kind: 'agent', source: { kind: 'command', name: 'plan-cmd' } },
      cache: { action: 'replayed', output: { text: 'cached plan' } },
    });
    // Rows written before node execution metadata existed are labelled by step name.
    commitTestEvent({
      workflow_run_id: OWNED_RUN,
      event_type: 'node_completed',
      step_name: 'review',
      data: { duration_ms: 500, node_output: 'approved' },
    });
    commitTestEvent({
      workflow_run_id: OWNED_RUN,
      event_type: 'approval_requested',
      step_name: 'review',
      data: { message: 'Please review the changes' },
    });
    commitTestEvent({
      workflow_run_id: OWNED_RUN,
      event_type: 'pause_notice_undelivered',
      step_name: 'review',
      data: { nodeId: 'review', platform: 'cli' },
    });
    commitTestEvent({
      workflow_run_id: OWNED_RUN,
      event_type: 'container_stopped',
      step_name: 'container',
      data: { containerId: 'abcdef0123456789' },
    });
    commitTestEvent({
      workflow_run_id: OWNED_RUN,
      event_type: 'writeback_requested',
      step_name: 'container',
      data: { total_count: 2 },
    });
    commitTestEvent({
      workflow_run_id: OWNED_RUN,
      event_type: 'workflow_completed',
      step_name: null,
      data: {},
    });
  }

  // Recorded from the emitter renderer this replaced, fed the same run's events. The
  // undelivered pause notice line has no emitter counterpart; it reads its row only.
  const PLAIN_PROGRESS = [
    '[workflow] Transcript: /logs/test-run-id.jsonl',
    '[container] created abcdef012345',
    '[plan-cmd] Started  (claude/opus ← large)',
    '[plan-cmd] Completed (12.4s)',
    '[build] Started',
    '[build] Completed (1m30s)',
    '[build] Started',
    '[build] Failed (schema_unmet): output missed its schema',
    '[deploy] Skipped (condition: $plan.output == deploy)',
    '[plan-cmd] Skipped (prior_success)',
    '[review] Completed (500ms)',
    '[review] Waiting for approval: Please review the changes',
    '[review] Pause notice not delivered; the run is still waiting',
    '[container] stopped abcdef012345',
    '[container] writeback_requested',
  ];
  const VERBOSE_TOOL_LINES = [
    '[plan] tool: ls -la (started, call-1)',
    '[build] tool: Read (started, call-1)',
    '[plan] tool: ls -la (42ms, call-1, failed, exit 1)',
    '[build] tool: Read (100ms, call-1, completed)',
    '[plan] tool: call-2 (call-2, completed)',
  ];

  const progressLines = (): string[] =>
    stderrSpy.mock.calls
      .map(([chunk]: [unknown]) => String(chunk))
      .filter((chunk: string) => chunk.startsWith('['))
      .map((chunk: string) => chunk.replace(/\n$/, ''));

  function executeCommitting(commit: () => void): void {
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      commit();
      return { success: true, workflowRunId: OWNED_RUN };
    });
  }

  it('renders the committed rows of the run and its sub-runs', async () => {
    setupWorkflowMocks();
    executeCommitting(commitProgressRows);

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {});

    expect(progressLines()).toEqual(PLAIN_PROGRESS);
  });

  it('adds tool lines with --verbose', async () => {
    setupWorkflowMocks();
    executeCommitting(commitProgressRows);

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
      verbose: true,
    });

    expect(progressLines()).toEqual([
      ...PLAIN_PROGRESS.slice(0, 4),
      ...VERBOSE_TOOL_LINES,
      ...PLAIN_PROGRESS.slice(4),
    ]);
  });

  it('suppresses progress but retains completion usage with --quiet', async () => {
    setupWorkflowMocks();
    executeCommitting(commitProgressRows);
    const host = createTestWorkflowHost();
    const head = spyOn(host.deps.store, 'getWorkflowEventHead');

    await workflowRunCommand(host, '/test/path', 'plan', 'hello', { quiet: true });

    expect(head).not.toHaveBeenCalled();
    expect(progressLines()).toEqual([]);
    expect(consoleSpy).toHaveBeenCalledWith('  Usage: unavailable (persisted run unavailable)');
  });

  it.each([false, true])(
    'prints measured coverage and preserves completed cards or failure semantics, failure=%s',
    async failure => {
      const { createInMemoryWorkflowStore, createInMemoryWorkflowHostStore } = await import(
        '../test-support/workflow-store'
      );
      const store = createInMemoryWorkflowStore(createInMemoryWorkflowHostStore());
      const run = await store.createWorkflowRun({
        workflow_name: 'usage',
        user_message: '',
        metadata: { total_cost_usd: 0.25, total_tokens_in: 8, total_tokens_out: 4 },
      });
      await store.claimPendingWorkflowRun(run.id, '/tmp/usage-fixture');
      for (const event of usageEvents(run.id, true)) await store.persistWorkflowEvent(event);
      if (failure) await store.failWorkflowRun(run.id, 'failed');
      else await store.completeWorkflowRun(run.id, { duration_ms: 1 });
      const host = createTestWorkflowHost();
      host.deps.store = store;
      const { CLIAdapter } = await import('../adapters/cli-adapter');
      const adapter = new CLIAdapter();
      const sent = spyOn(adapter, 'sendMessage').mockResolvedValue(undefined);
      try {
        const result = failure
          ? { success: false as const, workflowRunId: run.id, error: 'failed' }
          : { success: true as const, workflowRunId: run.id, summary: 'Authored summary' };
        const promise = presentRunResult({
          host,
          workflow: resolveWorkflow({ name: 'usage', description: '', nodes: [] }),
          result,
          adapter,
          conversationId: 'conversation',
          destination: { kind: 'headless', correlationId: 'fixture' },
          detachedProcessOwner: false,
        });
        if (failure) await expect(promise).rejects.toBeInstanceOf(WorkflowRunFailedError);
        else await promise;
        const text = consoleSpy.mock.calls.flat().join('\n');
        expect(text).toContain('Cost: $0.25 (1/2 AI nodes; partial)');
        expect(text).toContain('Input tokens: 8 (2/2 AI nodes');
        expect(text).toContain('node unsupported');
        expect(text).not.toContain('completeness unknown');
        if (!failure) {
          expect(sent.mock.calls[0]?.[1]).toContain('Authored summary');
          expect(sent.mock.calls[0]?.[1]).toContain('1/2 AI nodes');
        }
      } finally {
        sent.mockRestore();
      }
    }
  );

  it('renders rows committed before the executor throws', async () => {
    setupWorkflowMocks();
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      commitTestEvent({
        workflow_run_id: OWNED_RUN,
        event_type: 'workflow_started',
        step_name: null,
        data: { transcriptPath: '/logs/test-run-id.jsonl' },
      });
      throw new Error('executor crashed');
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {})
    ).rejects.toThrow('executor crashed');

    expect(progressLines()).toEqual(['[workflow] Transcript: /logs/test-run-id.jsonl']);
  });

  const trackSignalRoot = trackTempRoots();
  type ContainerRunEnd = 'paused' | 'settled' | 'unresolved-writeback' | 'lookup-fails';

  async function signalFailureWriter(
    initialStatus: WorkflowRunStatus | null
  ): Promise<IWorkflowStore['failWorkflowRun']> {
    const failureStore = await createFileWorkflowStore({
      root: trackSignalRoot(await mkdtemp(join(tmpdir(), 'archon-drain-signal-'))),
    });
    const storedRun = await failureStore.createWorkflowRun({
      workflow_name: 'signal',
      user_message: '',
    });
    await failureStore.claimPendingWorkflowRun(storedRun.id);
    if (initialStatus === 'completed')
      await failureStore.completeWorkflowRun(storedRun.id, { duration_ms: 0 });
    else if (initialStatus === 'failed')
      await failureStore.failWorkflowRun(storedRun.id, 'node failed');
    else if (initialStatus === 'cancelled') await failureStore.cancelWorkflowRun(storedRun.id);
    else if (initialStatus !== null)
      await failureStore.updateWorkflowRun(storedRun.id, { status: initialStatus });
    return (_id, error, reason) => failureStore.failWorkflowRun(storedRun.id, error, reason);
  }

  async function expectContainerExecution(
    execution: Promise<unknown>,
    rejection: Error | undefined,
    cleanupError: Error | undefined,
    runFailed: boolean
  ): Promise<void> {
    if (cleanupError) await expect(execution).rejects.toThrow('retained verification images');
    else if (rejection) await expect(execution).rejects.toBe(rejection);
    else if (runFailed) await expect(execution).rejects.toBeInstanceOf(WorkflowRunFailedError);
    else await execution;
  }

  /**
   * A container run that receives a signal during its final progress drain, or with
   * `signalAt: 'lookup'` while the CLI reads the settled run's write-back state. Returns
   * how many times the container was destroyed by the time the signal's cleanup settled.
   */
  async function signalDuringContainerDrain(
    end: ContainerRunEnd,
    signalAt: 'drain' | 'lookup' = 'drain',
    handoffStatus?: WorkflowRunStatus | null,
    rejection?: 'published' | 'pre-publication',
    signal: 'SIGINT' | 'SIGTERM' = 'SIGTERM',
    settledStatus: 'completed' | 'failed' | 'cancelled' = 'completed',
    destroyError?: Error,
    cleanupError?: Error
  ): Promise<number> {
    const { discoverWorkflowsWithConfig } = require('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
      errors: [],
    });
    const codebaseDb = require('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-folder',
      name: 'platform',
      default_cwd: '/test/path',
      default_branch: null,
      kind: 'folder',
    });
    const cause = new Error('required operation failed');
    const failure =
      rejection === 'published' ? new WorkflowExecutionHandoffError(OWNED_RUN, cause) : cause;
    let runSettled = false;
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(
      async (...args: Parameters<typeof import('@archon/workflows/executor').executeWorkflow>) => {
        args[7]?.onExecutionClaimed?.(null);
        runSettled = true;
        if (rejection) throw failure;
        if (handoffStatus !== undefined) {
          return handoffStatus === 'failed' || handoffStatus === 'cancelled'
            ? {
                success: false,
                handedOff: true,
                observedStatus: handoffStatus,
                workflowRunId: OWNED_RUN,
                error: `Workflow ${handoffStatus} after execution ownership changed`,
              }
            : {
                success: true,
                handedOff: true,
                observedStatus: handoffStatus,
                workflowRunId: OWNED_RUN,
              };
        }
        if (end === 'settled' && settledStatus !== 'completed') {
          return { success: false, workflowRunId: OWNED_RUN, error: `Workflow ${settledStatus}` };
        }
        return end === 'paused'
          ? { success: true, workflowRunId: OWNED_RUN, paused: true }
          : { success: true, workflowRunId: OWNED_RUN };
      }
    );
    let exited!: () => void;
    const exitCalled = new Promise<void>(resolve => {
      exited = resolve;
    });
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => exited()) as never);
    mockFolderBackendDestroy.mockClear();
    mockFolderBackendDestroy.mockImplementation(async () => {
      if (destroyError) throw destroyError;
    });
    const signalBefore = process.listeners(signal);
    const host = createTestWorkflowHost();
    const { createRunResourceRelease } = await import(
      '../../../core/src/services/cleanup/run-verification-images'
    );
    const defaultRelease = mock(async () => {
      throw new Error('wrong daemon');
    });
    const output_root = await recordedBuildRoot(OWNED_RUN);
    const release = createRunResourceRelease(
      {
        getWorkflowRun: async id => {
          const run = await host.deps.store.getWorkflowRun(id);
          return run && { ...run, output_root };
        },
      },
      defaultRelease
    );
    mockFolderBackendReleaseImages.mockClear();
    mockFolderBackendReleaseImages.mockImplementation(async () => {
      if (cleanupError) throw cleanupError;
    });
    const releaseRunResources = mock(async (id: string, owner?: ReleaseVerificationImages) => {
      expect(id).toBe(OWNED_RUN);
      expect(mockFolderBackendDestroy.mock.calls.length).toBeGreaterThan(0);
      return release(id, owner);
    });
    host.deps.releaseRunResources = releaseRunResources;
    const initialStatus =
      handoffStatus !== undefined
        ? handoffStatus
        : rejection || end === 'paused'
          ? 'running'
          : settledStatus;
    let status: WorkflowRunStatus | null = initialStatus;
    host.deps.store.getWorkflowRunStatus = async () => status;
    const failStoredRun = await signalFailureWriter(initialStatus);
    const fail = spyOn(host.deps.store, 'failWorkflowRun').mockImplementation(
      async (_id, error, reason) => {
        const result = await failStoredRun(_id, error, reason);
        if (result.failed) status = 'failed';
        return result;
      }
    );
    fail.mockClear();
    let destroyedAtSignal = -1;
    const signalOnce = async (): Promise<void> => {
      if (!runSettled || destroyedAtSignal !== -1) return;
      const handlers = process
        .listeners(signal)
        .filter(listener => !signalBefore.includes(listener));
      for (const listener of handlers) (listener as () => void)();
      if (handlers.length > 0) {
        await exitCalled;
        if (
          status === 'completed' &&
          !destroyError &&
          mockFolderBackendDestroy.mock.calls.length > 0
        ) {
          expect(mockFolderBackendReleaseImages).toHaveBeenCalledWith(OWNED_RUN, 'container-env-1');
        }
      }
      destroyedAtSignal = mockFolderBackendDestroy.mock.calls.length;
    };
    const getRun = host.deps.store.getWorkflowRun.bind(host.deps.store);
    host.deps.store.getWorkflowRun = async id => {
      if (signalAt === 'lookup') await signalOnce();
      if (end === 'lookup-fails') throw new Error('store unavailable');
      if (!runSettled) return getRun(id);
      return {
        id,
        workflow_name: 'assist',
        conversation_id: null,
        parent_conversation_id: null,
        codebase_id: 'cb-folder',
        status: end === 'unresolved-writeback' ? 'failed' : (status ?? 'running'),
        outcome: null,
        completed_outcome: null,
        user_message: 'go',
        metadata:
          end === 'unresolved-writeback'
            ? { pending_writeback: { envId: 'env-1' } }
            : {
                execution_owner: { host: hostname(), pid: process.pid },
                isolation: 'container',
                isolation_env_id: 'container-env-1',
              },
        active_phase_started_at: null,
        started_at: new Date(),
        completed_at: new Date(),
        last_activity_at: null,
        working_path: '/test/path',
        user_id: null,
        parent_run_id: null,
        adopted_from_run_id: null,
        output_root: null,
        checkout_baseline: null,
        item_id: null,
        origin: null,
      };
    };
    const read = host.deps.store.readWorkflowEventsAfter.bind(host.deps.store);
    host.deps.store.readWorkflowEventsAfter = async (after, options) => {
      if (signalAt === 'drain') await signalOnce();
      return read(after, options);
    };

    try {
      const execution = workflowRunCommand(host, '/test/path', 'assist', 'go', { container: true });
      await expectContainerExecution(
        execution,
        rejection ? failure : undefined,
        cleanupError,
        handoffStatus === 'failed' ||
          handoffStatus === 'cancelled' ||
          (handoffStatus === undefined && end === 'settled' && settledStatus !== 'completed')
      );
      if (handoffStatus !== undefined || rejection === 'published' || end === 'paused') {
        expect(mockFolderBackendDestroy).not.toHaveBeenCalled();
        expect(status).toBe(initialStatus);
      } else if (rejection === 'pre-publication') {
        expect(status).toBe('failed');
      }
    } finally {
      exitSpy.mockRestore();
      mockFolderBackendReleaseImages.mockResolvedValue(undefined);
    }
    expect(defaultRelease).not.toHaveBeenCalled();
    expect(releaseRunResources.mock.calls.length).toBe(
      destroyError ? 0 : mockFolderBackendDestroy.mock.calls.length
    );
    if (!rejection && handoffStatus === undefined) expect(fail).not.toHaveBeenCalled();
    return destroyedAtSignal;
  }

  it('surfaces image cleanup failure after successful teardown', async () => {
    await signalDuringContainerDrain(
      'settled',
      'drain',
      undefined,
      undefined,
      'SIGTERM',
      'completed',
      undefined,
      new Error('Docker denied image removal')
    );
  });

  it('retains images when container teardown fails after an execution error', async () => {
    await signalDuringContainerDrain(
      'settled',
      'drain',
      undefined,
      'pre-publication',
      'SIGTERM',
      'completed',
      new Error('container still present')
    );
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it.each(['published', 'handoff', 'paused'] as const)(
      `${signal} during final drain preserves a running successor after a %s exit`,
      async exit => {
        expect(
          await signalDuringContainerDrain(
            exit === 'paused' ? 'paused' : 'settled',
            'drain',
            exit === 'handoff' ? 'running' : undefined,
            exit === 'published' ? 'published' : undefined,
            signal
          )
        ).toBe(0);
      }
    );
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it.each(['published', 'pre-publication'] as const)(
      `${signal} retains cleanup ownership only before publication on a %s rejection`,
      async rejection => {
        expect(
          await signalDuringContainerDrain('settled', 'drain', undefined, rejection, signal)
        ).toBe(rejection === 'published' ? 0 : 1);
      }
    );
  }

  it.each([...workflowRunStatusSchema.options, null])(
    'leaves container cleanup to the successor after handoff (status=%s), including on a signal',
    async status => {
      expect(await signalDuringContainerDrain('settled', 'drain', status)).toBe(0);
    }
  );

  it('a signal during the final drain keeps a paused run its container', async () => {
    expect(await signalDuringContainerDrain('paused')).toBe(0);
  });

  it('a signal during the final drain keeps the container of an unresolved write-back', async () => {
    expect(await signalDuringContainerDrain('unresolved-writeback')).toBe(0);
  });

  it('a signal during the final drain keeps the container when the write-back lookup fails', async () => {
    expect(await signalDuringContainerDrain('lookup-fails')).toBe(0);
  });

  it('a signal during the write-back lookup keeps the container', async () => {
    expect(await signalDuringContainerDrain('settled', 'lookup')).toBe(0);
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it.each(['completed', 'failed', 'cancelled'] as const)(
      `${signal} during final drain destroys the %s execution's container`,
      async status => {
        expect(
          await signalDuringContainerDrain('settled', 'drain', undefined, undefined, signal, status)
        ).toBe(1);
      }
    );
  }

  it('reports a failed final drain without masking the run outcome', async () => {
    setupWorkflowMocks();
    executeCommitting(() => {
      setFailTestFeedReads(true);
    });

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {});

    expect(progressLines()).toEqual([
      '[workflow] Progress output may be incomplete: event feed unavailable',
    ]);
    expect(consoleSpy).toHaveBeenCalledWith('\nWorkflow completed successfully.');
  });

  it('runs the workflow when the progress subscription cannot start', async () => {
    setupWorkflowMocks();
    executeCommitting(commitProgressRows);
    const host = createTestWorkflowHost();
    host.deps.store.getWorkflowEventHead = async () => {
      throw new Error('event feed unavailable');
    };

    await workflowRunCommand(host, '/test/path', 'plan', 'hello', {});

    expect(progressLines()).toEqual([
      '[workflow] Progress output unavailable: event feed unavailable',
    ]);
    expect(consoleSpy).toHaveBeenCalledWith('\nWorkflow completed successfully.');
  });
});

describe('workflowRunCommand — dispatch and result cards', () => {
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
      expect.stringContaining('All steps completed. Branch pushed.'),
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

      // No pause metadata was recorded by this executor fixture.
      expect(consoleSpy.mock.calls.flat().join('\n')).toContain('Workflow paused');
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
