import {
  mockLogger,
  mockRunLiveOwnerClose,
  mockStartRunLiveOwner,
  mockFolderBackendDestroy,
  testRunParents,
  commitTestEvent,
  createTestWorkflowHost,
  setMockDetachedStopRequested,
  setFailTestFeedReads,
  resetCommittedTestEvents,
} from '../test-support/workflow-command-harness';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import { resolveCliExitCode, WorkflowRunFailedError } from '../utils/workflow-exit-code';

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
          outcome_field: 'ready',
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
    outcome: 'succeeded' | 'failed' | null
  ): Promise<unknown> {
    setupWorkflowMocks(true);
    const { executeWorkflow } = require('@archon/workflows/executor');
    const workflowDb = require('@archon/core/db/workflows');
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce(execution);
    if (!('handedOff' in execution)) {
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: execution.workflowRunId,
        status,
        outcome,
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
      expect(workflowDb.getWorkflowRun.mock.calls.length - readsBefore).toBe(
        'handedOff' in execution ? 0 : 1
      );
    }
  }

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

  it('keeps a successful foreground host workflow successful without Docker', async () => {
    setupWorkflowMocks();
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'test-run-id',
    });
    const { hostname } = await import('node:os');
    const { mockWorkflowRun } = await import('../../../core/src/test/mocks/workflow-run');
    const { createRunResourceRelease } = await import(
      '../../../core/src/services/cleanup/run-verification-images'
    );
    const host = createTestWorkflowHost();
    const row = {
      ...mockWorkflowRun,
      id: 'test-run-id',
      status: 'completed' as const,
      metadata: { execution_owner: { host: hostname(), pid: process.pid } },
    };
    const previousPath = process.env.PATH;
    process.env.PATH = '';
    try {
      host.deps.releaseRunResources = createRunResourceRelease({ getWorkflowRun: async () => row });
      await expect(
        workflowRunCommand(host, '/test/path', 'plan', 'hello', {})
      ).resolves.toBeUndefined();
    } finally {
      process.env.PATH = previousPath;
    }
  });

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

    expect(consoleSpy).toHaveBeenCalledWith('  Usage (recorded totals; completeness unknown):');
    expect(consoleSpy).toHaveBeenCalledWith('    Cost: $0.024');
    expect(consoleSpy).toHaveBeenCalledWith('    Input tokens: 8420');
    expect(consoleSpy).toHaveBeenCalledWith('    Output tokens: 2180');
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

  it('keeps a failed execution non-zero when the authored outcome succeeded', async () => {
    const thrown = await runOutcomeFixture(
      { success: false, workflowRunId: 'run-1', error: 'later node failed' },
      'failed',
      'succeeded'
    );

    expect(resolveCliExitCode(thrown)).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith('    Cost: $0.024');
    expect(consoleSpy).toHaveBeenCalledWith(
      '\nWorkflow finished.\n  Status: failed\n  Authored outcome: succeeded'
    );
  });

  it('renders a persisted succeeded outcome while execution is paused', async () => {
    await runOutcomeFixture(
      { success: true, paused: true, workflowRunId: 'run-1' },
      'paused',
      'succeeded'
    );

    expect(consoleSpy.mock.calls.flat().join('\n')).not.toContain('Usage');
    expect(consoleSpy).toHaveBeenCalledWith(
      '\nWorkflow paused — waiting for approval.\n  Status: paused\n  Authored outcome: succeeded'
    );
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

  it('does not look up usage for an approval pause without an authored outcome', async () => {
    setupWorkflowMocks();
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-paused',
      paused: true,
    });
    const workflowDb = require('@archon/core/db/workflows');
    const lookup = workflowDb.getWorkflowRun as ReturnType<typeof mock>;
    const readsBefore = lookup.mock.calls.length;
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {});
    expect(lookup.mock.calls.length).toBe(readsBefore);
    expect(consoleSpy.mock.calls.flat().join('\n')).not.toContain('Usage');
  });

  const completionUsageCases = [
    {
      kind: 'numbers',
      metadata: { total_cost_usd: 0, total_tokens_in: 12, total_tokens_out: 4 },
      expected: [
        '  Usage (recorded totals; completeness unknown):',
        '    Cost: $0',
        '    Input tokens: 12',
        '    Output tokens: 4',
      ],
    },
    {
      kind: 'empty',
      metadata: {},
      expected: [
        '  Usage (recorded totals; completeness unknown):',
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
      for (const line of expected) expect(consoleSpy).toHaveBeenCalledWith(line);
      if (kind === 'rejected')
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ err: expect.any(Error), workflowRunId: 'run-usage' }),
          'cli.workflow_summary_lookup_failed'
        );
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
    runNode(CHILD_RUN, 'build', { status: 'failed', error: 'timeout exceeded' }, 1_000);
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
    '[build] Failed: timeout exceeded',
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
    const releaseRunResources = mock(async (id: string) => {
      expect(id).toBe(OWNED_RUN);
      expect(mockFolderBackendDestroy.mock.calls.length).toBeGreaterThan(0);
      if (cleanupError) throw cleanupError;
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
      if (handlers.length > 0) await exitCalled;
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
        user_message: 'go',
        metadata: end === 'unresolved-writeback' ? { pending_writeback: { envId: 'env-1' } } : {},
        started_at: new Date(),
        completed_at: new Date(),
        last_activity_at: null,
        working_path: '/test/path',
        user_id: null,
        parent_run_id: null,
        adopted_from_run_id: null,
        output_root: null,
        checkout_baseline: null,
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
    }
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
