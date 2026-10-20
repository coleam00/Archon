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
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
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
import { resolveCliExitCode } from '../utils/workflow-exit-code';

describe('workflowRunCommand — progress rendering', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;

  type OutcomeExecutionResult =
    | { success: true; workflowRunId: string; paused?: true }
    | { success: false; workflowRunId: string; error: string };

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
    execution: OutcomeExecutionResult,
    status: 'completed' | 'failed' | 'paused',
    outcome: 'succeeded' | 'failed' | null,
    metadata: Record<string, unknown> = {}
  ): Promise<unknown> {
    setupWorkflowMocks(true);
    const { executeWorkflow } = require('@archon/workflows/executor');
    const workflowDb = require('@archon/core/db/workflows');
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce(execution);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: execution.workflowRunId,
      status,
      outcome,
      metadata,
    });

    try {
      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {});
      return undefined;
    } catch (error) {
      return error;
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

  it('renders aligned completed execution and succeeded authored outcome', async () => {
    await runOutcomeFixture({ success: true, workflowRunId: 'run-1' }, 'completed', 'succeeded', {
      total_cost_usd: 0.05,
      total_tokens_in: 100,
      total_tokens_out: 20,
    });
    expect(consoleSpy).toHaveBeenCalledWith('  Cost: $0.05');
    expect(consoleSpy).toHaveBeenCalledWith('  Input tokens: 100');
    expect(consoleSpy).toHaveBeenCalledWith('  Output tokens: 20');

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
      'succeeded',
      { total_cost_usd: 0.05, total_tokens_in: 100, total_tokens_out: 20 }
    );

    expect(resolveCliExitCode(thrown)).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith('  Cost: $0.05');
    expect(consoleSpy).toHaveBeenCalledWith('  Input tokens: 100');
    expect(consoleSpy).toHaveBeenCalledWith('  Output tokens: 20');
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

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {});

    expect(consoleSpy).toHaveBeenCalledWith(
      '\nWorkflow finished.\n  Status: completed\n  Authored outcome: unavailable — failed to read persisted run'
    );
  });

  it.each([
    [
      { total_cost_usd: 0.024, total_tokens_in: 8420, total_tokens_out: 2180 },
      '$0.024',
      '8420',
      '2180',
    ],
    [{ total_cost_usd: 0, total_tokens_in: 0, total_tokens_out: 0 }, '$0', '0', '0'],
    [{ total_cost_usd: 0.1 + 0.2 }, '$0.3', 'unknown', 'unknown'],
    [{ total_cost_usd: 1e-15 }, '$1e-15', 'unknown', 'unknown'],
    [{}, 'unknown', 'unknown', 'unknown'],
    [{ total_cost_usd: null, total_tokens_in: 10, total_tokens_out: 2 }, 'unknown', '10', '2'],
    [
      { total_cost_usd: 'free', total_tokens_in: 'unknown', total_tokens_out: 3 },
      'unknown',
      'unknown',
      '3',
    ],
    [
      { total_tokens_unknown: true, total_tokens_in: null, total_tokens_out: null },
      'unknown',
      'unknown',
      'unknown',
    ],
  ])(
    'prints persisted completion usage without a declared outcome for %j',
    async (metadata, cost, input, output) => {
      setupWorkflowMocks();
      const { executeWorkflow } = require('@archon/workflows/executor');
      const workflowDb = require('@archon/core/db/workflows');
      (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
        success: true,
        workflowRunId: 'run-usage',
      });
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'run-usage',
        status: 'completed',
        outcome: null,
        metadata,
      });

      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {});

      expect(consoleSpy).toHaveBeenCalledWith(`  Cost: ${cost}`);
      expect(consoleSpy).toHaveBeenCalledWith(`  Input tokens: ${input}`);
      expect(consoleSpy).toHaveBeenCalledWith(`  Output tokens: ${output}`);
    }
  );

  it.each([
    { lookup: 'rejected', success: true },
    { lookup: 'missing', success: true },
    { lookup: 'rejected', success: false },
    { lookup: 'missing', success: false },
  ] as const)(
    'reports unavailable persisted usage for $lookup lookup after success=$success',
    async ({ lookup, success }) => {
      setupWorkflowMocks();
      const { executeWorkflow } = require('@archon/workflows/executor');
      const workflowDb = require('@archon/core/db/workflows');
      (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
        success,
        workflowRunId: 'run-unavailable',
        ...(!success ? { error: 'node failed' } : {}),
      });
      const getRun = workflowDb.getWorkflowRun as ReturnType<typeof mock>;
      if (lookup === 'rejected') getRun.mockRejectedValueOnce(new Error('store unavailable'));
      else getRun.mockResolvedValueOnce(null);

      const completion = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'plan',
        'hello',
        {}
      );
      if (success) await completion;
      else await expect(completion).rejects.toThrow('node failed');

      expect(consoleSpy).toHaveBeenCalledWith(
        success ? '\nWorkflow completed successfully.' : '\nWorkflow finished.'
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        '  Usage: unavailable — failed to read persisted run'
      );
      expect(consoleSpy).not.toHaveBeenCalledWith('  Cost: unknown');
      expect(consoleSpy).not.toHaveBeenCalledWith('  Input tokens: unknown');
      expect(consoleSpy).not.toHaveBeenCalledWith('  Output tokens: unknown');
      if (lookup === 'rejected') {
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ workflowRunId: 'run-unavailable', err: expect.any(Error) }),
          'cli.workflow_run_lookup_failed'
        );
      }
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

  it('neither subscribes nor renders with --quiet', async () => {
    setupWorkflowMocks();
    executeCommitting(commitProgressRows);
    const host = createTestWorkflowHost();
    const head = spyOn(host.deps.store, 'getWorkflowEventHead');

    await workflowRunCommand(host, '/test/path', 'plan', 'hello', { quiet: true });

    expect(head).not.toHaveBeenCalled();
    expect(progressLines()).toEqual([]);
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

  type ContainerRunEnd = 'paused' | 'settled' | 'unresolved-writeback' | 'lookup-fails';

  /**
   * A container run that receives SIGTERM during its final progress drain, or with
   * `signalAt: 'lookup'` while the CLI reads the settled run's write-back state. Returns
   * how many times the container was destroyed by the time the signal's cleanup settled.
   */
  async function signalDuringContainerDrain(
    end: ContainerRunEnd,
    signalAt: 'drain' | 'lookup' = 'drain'
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
    let runSettled = false;
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      runSettled = true;
      return end === 'paused'
        ? { success: true, workflowRunId: OWNED_RUN, paused: true }
        : { success: true, workflowRunId: OWNED_RUN };
    });
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    mockFolderBackendDestroy.mockClear();
    const sigtermBefore = process.listeners('SIGTERM');
    const host = createTestWorkflowHost();
    let destroyedAtSignal = -1;
    const signalOnce = async (): Promise<void> => {
      if (!runSettled || destroyedAtSignal !== -1) return;
      for (const listener of process.listeners('SIGTERM')) {
        if (!sigtermBefore.includes(listener)) (listener as () => void)();
      }
      for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
      destroyedAtSignal = mockFolderBackendDestroy.mock.calls.length;
    };
    const getRun = host.deps.store.getWorkflowRun.bind(host.deps.store);
    host.deps.store.getWorkflowRun = async id => {
      if (signalAt === 'lookup') await signalOnce();
      if (end === 'lookup-fails') throw new Error('store unavailable');
      if (end !== 'unresolved-writeback') return getRun(id);
      return {
        id,
        workflow_name: 'assist',
        conversation_id: null,
        parent_conversation_id: null,
        codebase_id: 'cb-folder',
        status: 'failed',
        outcome: null,
        user_message: 'go',
        metadata: { pending_writeback: { envId: 'env-1' } },
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
      await workflowRunCommand(host, '/test/path', 'assist', 'go', { container: true });
    } finally {
      exitSpy.mockRestore();
    }
    return destroyedAtSignal;
  }

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

  it('a signal during the final drain still destroys a settled run its container', async () => {
    expect(await signalDuringContainerDrain('settled')).toBe(1);
  });

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
