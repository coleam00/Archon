// @archon-test-isolated
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
  setSystemTime,
  type Mock,
} from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createMockStore,
  withProviderCapabilities,
  mockClaudeCapabilities,
  mockProviderRegistry,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  persistedEvents,
  dagOptions,
  makeWorkflowRun,
} from '../../test-utils';
import { executeDagWorkflow } from '../../../dag-executor';
import { providerEventEnvelopeSchema } from '../../../schemas/provider-event';
import type { IWorkflowPlatform } from '../../../deps';

let testDir: string;
beforeEach(async () => {
  testDir = join(tmpdir(), `dag-resume-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const commandsDir = join(testDir, '.archon', 'commands');
  await mkdir(commandsDir, { recursive: true });
  await writeFile(join(commandsDir, 'step1.md'), 'Step 1 prompt');
  await writeFile(join(commandsDir, 'step2.md'), 'Step 2 prompt using $step1.output');

  mockSendQueryDag.mockClear();
  mockGetAgentProviderDag.mockClear();

  mockSendQueryDag.mockImplementation(async function* () {
    yield { type: 'agent_message_chunk', text: 'AI response' };
    yield { type: 'result', sessionId: 'session-id' };
  });
});
afterEach(async () => {
  mockGetAgentProviderDag.mockImplementation(() => ({
    sendQuery: mockSendQueryDag,
    checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
    getType: () => 'claude',
    getCapabilities: mockClaudeCapabilities,
  }));
  await removeTempTree(testDir);
});

describe('background task completion gating (#2083)', () => {
  const runSingleNode = async (
    store: ReturnType<typeof createMockStore>,
    platform: IWorkflowPlatform,
    runId: string,
    idleTimeout?: number
  ): Promise<void> => {
    const mockDeps = createMockDeps(store);
    const workflowRun = makeWorkflowRun(runId);
    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-bg-tasks',
        cwd: testDir,
        workflow: {
          name: 'bg-task-test',
          nodes: [
            {
              id: 'step1',
              kind: 'agent',
              source: { kind: 'command', name: 'step1' },
              idle_timeout: idleTimeout,
            },
          ],
        },
        workflowRun,
      })
    );
  };

  const findCompletedEvent = (
    store: ReturnType<typeof createMockStore>
  ): { data: Record<string, unknown> } | undefined => {
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const call = eventCalls.find(
      (c: unknown[]) =>
        (c[0] as { event_type: string }).event_type === 'node_completed' &&
        (c[0] as { step_name: string }).step_name === 'step1'
    );
    return call?.[0] as { data: Record<string, unknown> } | undefined;
  };

  it('waits past a result with live background tasks and captures the follow-up output', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'subtask',
        taskId: 't-1',
        status: 'started',
        taskType: 'local_agent',
        description: 'bg research',
      };
      yield { type: 'agent_message_chunk', text: 'spawned agents' };
      // Turn-level result while t-1 is still live — must NOT complete the node
      yield {
        type: 'result',
        sessionId: 'first-session',
        text: 'first answer',
        structuredOutput: { stale: true },
        cost: 0.1,
        tokens: { input: 10, output: 1 },
      };
      // Post-result: task drains, follow-up turn integrates its output
      yield { type: 'agent_message_chunk', text: ' + integrated task output' };
      yield { type: 'subtask', taskId: 't-1', status: 'completed' };
      yield {
        type: 'result',
        sessionId: 'final-session',
        text: 'final answer',
        cost: 0.3,
        tokens: { input: 20, output: 2 },
      };
    });

    const store = createMockStore();
    const platform = createMockPlatform();
    await runSingleNode(store, platform, 'bg-wait-run');

    const completed = findCompletedEvent(store);
    expect(completed).toBeDefined();
    expect(completed!.data.node_output).toBe('final answer');
    expect(completed!.data.cost_usd).toBe(0.4);
    expect(completed!.data.tokens).toMatchObject({ input: 30, output: 3 });
    expect(completed!.data.session_id).toBe('final-session');
    expect(completed!.data.structured_output).toBeUndefined();
    // Clean drain → no incompleteness recorded
    expect(completed!.data.background_tasks_incomplete).toBeUndefined();
  });

  for (const kind of ['agent', 'loop'] as const) {
    for (const backgroundWork of ['reported', 'unobserved'] as const) {
      it(`handles ${backgroundWork} settlement with live work in a ${kind} node`, async () => {
        mockSendQueryDag.mockImplementation(async function* () {
          yield { type: 'subtask', taskId: 'still-live', status: 'started' };
          yield { type: 'result', sessionId: 's', text: 'Done. <promise>COMPLETE</promise>' };
          yield { type: 'settled' };
        });
        const store = createMockStore();
        const deps = createMockDeps(
          store,
          withProviderCapabilities(mockProviderRegistry, 'claude', {
            ...mockClaudeCapabilities(),
            backgroundWork,
          })
        );
        deps.getAgentProvider = () => ({
          ...mockGetAgentProviderDag('claude'),
          getCapabilities: () => {
            throw new Error('Instance capabilities are not the executor owner');
          },
        });
        await executeDagWorkflow(
          dagOptions({
            deps,
            platform: createMockPlatform(),
            cwd: testDir,
            workflow: {
              name: 'contradictory-settlement',
              nodes: [
                kind === 'agent'
                  ? { id: 'step1', kind, source: { kind: 'command', name: 'step1' } }
                  : {
                      id: 'step1',
                      kind,
                      loop: {
                        prompt: 'Finish the work.',
                        fresh_context: false,
                        until: 'COMPLETE',
                        max_iterations: 1,
                      },
                    },
              ],
            },
            workflowRun: makeWorkflowRun(`contradictory-${kind}-${backgroundWork}`),
          })
        );
        if (backgroundWork === 'reported') {
          const failed = persistedEvents(store).find(event => event.event_type === 'node_failed');
          expect(failed?.data?.failure_kind).toBe('unknown');
          expect(failed?.data?.error).toContain('Subtask(s) still running: still-live.');
          expect(findCompletedEvent(store)).toBeUndefined();
          expect(store.completeWorkflowRun).not.toHaveBeenCalled();
        } else {
          expect(findCompletedEvent(store)).toBeDefined();
          expect(store.failWorkflowRun).not.toHaveBeenCalled();
        }
      });
    }
  }

  it('keeps a quiet live task running beyond the node idle timeout', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'subtask', taskId: 'quiet', status: 'started', description: 'quiet bash' };
      yield { type: 'result', sessionId: 's', text: 'waiting' };
      await new Promise(resolve => setTimeout(resolve, 100));
      yield { type: 'subtask', taskId: 'quiet', status: 'completed' };
      yield { type: 'result', sessionId: 's', text: 'finished' };
      yield { type: 'settled' };
    });
    const store = createMockStore();
    const platform = createMockPlatform();
    const mockDeps = createMockDeps(
      store,
      withProviderCapabilities(mockProviderRegistry, 'claude', {
        ...mockClaudeCapabilities(),
        backgroundWork: 'reported',
      })
    );
    mockDeps.getAgentProvider = () => ({
      ...mockGetAgentProviderDag('claude'),
      getCapabilities: () => {
        throw new Error('Instance capabilities are not the executor owner');
      },
    });
    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-bg-tasks',
        cwd: testDir,
        workflow: {
          name: 'bg-task-test',
          nodes: [
            {
              id: 'step1',
              kind: 'agent',
              source: { kind: 'command', name: 'step1' },
              idle_timeout: 30,
            },
          ],
        },
        workflowRun: makeWorkflowRun('quiet-live-run'),
      })
    );
    expect(findCompletedEvent(store)?.data.node_output).toBe('finished');
    expect(persistedEvents(store).some(event => event.event_type === 'node_failed')).toBe(false);
  });

  // Only a provider that declares `reported` can vouch that a silent subtask is
  // still alive; for any other provider a silent stream is a hung turn.
  for (const kind of ['agent', 'loop'] as const) {
    it(
      `times out a silent ${kind} node whose unobserved provider left a subtask live`,
      async () => {
        let calls = 0;
        let firstAttemptAborted = false;
        mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, options) {
          calls++;
          if (calls > 1) {
            // Complete the retry after the watchdog aborts the first attempt.
            yield { type: 'result', sessionId: 's', text: '<promise>COMPLETE</promise>' };
            yield { type: 'settled' };
            return;
          }
          yield { type: 'subtask', taskId: 'hung', status: 'started', description: 'hung' };
          await new Promise<void>(resolve => {
            // Bounds the test if the watchdog never fires.
            const bound = setTimeout(resolve, 1_000);
            options?.abortSignal?.addEventListener(
              'abort',
              () => {
                firstAttemptAborted = true;
                clearTimeout(bound);
                resolve();
              },
              { once: true }
            );
          });
        });
        const store = createMockStore();
        const deps = createMockDeps(store);
        deps.getAgentProvider = () => ({
          ...mockGetAgentProviderDag('claude'),
          getCapabilities: () => {
            throw new Error('Instance capabilities are not the executor owner');
          },
        });
        await executeDagWorkflow(
          dagOptions({
            deps,
            platform: createMockPlatform(),
            cwd: testDir,
            workflow: {
              name: 'unobserved-silent-subtask',
              nodes: [
                kind === 'agent'
                  ? {
                      id: 'step1',
                      kind,
                      source: { kind: 'command', name: 'step1' },
                      idle_timeout: 30,
                      retry: { max_attempts: 0 },
                    }
                  : {
                      id: 'step1',
                      kind,
                      idle_timeout: 30,
                      retry: { max_attempts: 1, delay_ms: 0 },
                      loop: {
                        prompt: 'Finish the work.',
                        fresh_context: false,
                        until: 'COMPLETE',
                        max_iterations: 1,
                      },
                    },
              ],
            },
            workflowRun: makeWorkflowRun(`unobserved-silent-${kind}`),
          })
        );
        expect(firstAttemptAborted).toBe(true);
        if (kind === 'agent') expect(findCompletedEvent(store)).toBeUndefined();
        else expect(calls).toBe(2);
      },
      testTimeout(10_000)
    );
  }

  it('cancels a never-ending quiet task without waiting for another provider event', async () => {
    let silent = false;
    let providerAborted = false;
    mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, options) {
      yield { type: 'subtask', taskId: 'server', status: 'started', description: 'dev server' };
      yield { type: 'result', sessionId: 's', text: 'started server' };
      silent = true;
      setSystemTime(new Date(Date.now() + 11_000));
      await new Promise<void>(resolve => {
        options?.abortSignal?.addEventListener(
          'abort',
          () => {
            providerAborted = true;
            resolve();
          },
          { once: true }
        );
      });
    });
    const store = createMockStore();
    store.getWorkflowRunStatus.mockImplementation(() =>
      Promise.resolve(silent ? 'cancelled' : 'running')
    );
    try {
      await runSingleNode(store, createMockPlatform(), 'quiet-cancel-run', 30);
    } finally {
      setSystemTime();
    }
    expect(providerAborted).toBe(true);
    expect(findCompletedEvent(store)).toBeUndefined();
    expect(
      persistedEvents(store).find(event => event.event_type === 'node_failed')?.data?.error
    ).toBe('Cancelled by user');
  });

  it('fails the node, naming the live tasks, when the stream dies before settling', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'subtask',
        taskId: 't-orphan',
        status: 'started',
        taskType: 'local_agent',
        description: 'never drains',
      };
      yield { type: 'agent_message_chunk', text: 'partial work' };
      yield { type: 'result', sessionId: 'sid' };
      // Generator ends without the set draining or settling (subprocess death analog)
    });

    const store = createMockStore();
    const platform = createMockPlatform();
    await executeDagWorkflow(
      dagOptions({
        // The raw mock: no settled, as when the subprocess dies.
        deps: { ...createMockDeps(store), getAgentProvider: mockGetAgentProviderDag },
        platform,
        conversationId: 'conv-bg-tasks',
        cwd: testDir,
        workflow: {
          name: 'bg-task-test',
          nodes: [{ id: 'step1', kind: 'agent', source: { kind: 'command', name: 'step1' } }],
        },
        workflowRun: makeWorkflowRun('bg-incomplete-run'),
      })
    );

    expect(findCompletedEvent(store)).toBeUndefined();
    const failed = persistedEvents(store).find(
      event => event.event_type === 'node_failed' && event.step_name === 'step1'
    );
    expect(failed?.data?.error).toContain('Subtask(s) still running: t-orphan.');
    const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(c =>
      String(c[1])
    );
    // One message per incident: the node failure names the tasks; no separate warning.
    expect(sent.some(m => m.includes('output may be missing'))).toBe(false);
  });

  it('suppresses the incompleteness warning when the node is genuinely cancelled with live tasks', async () => {
    // The run is cancelled mid-stream (caught by the throttled status check)
    // while a background task is still live. The stream ends with the task
    // dangling, but the node already returns 'failed — Cancelled by user',
    // so the incompleteness warning must be suppressed as noise.
    // setSystemTime jumps past CANCEL_CHECK_INTERVAL_MS between chunks so the
    // second status check fires deterministically (no real waiting).
    let tasksDelivered = false;
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'subtask',
        taskId: 't-live',
        status: 'started',
        taskType: 'local_agent',
        description: 'still running',
      };
      tasksDelivered = true;
      setSystemTime(new Date(Date.now() + 11_000));
      yield { type: 'agent_message_chunk', text: 'partial work' };
      yield { type: 'agent_message_chunk', text: 'MUST NOT BE REACHED' };
    });

    const store = createMockStore();
    // 'running' until the task set has been delivered, 'cancelled' after —
    // guarantees the abort happens with the task registered as live.
    (store.getWorkflowRunStatus as Mock<() => Promise<string | null>>).mockImplementation(() =>
      Promise.resolve(tasksDelivered ? 'cancelled' : 'running')
    );
    const platform = createMockPlatform();
    try {
      await runSingleNode(store, platform, 'bg-cancelled-run');
    } finally {
      setSystemTime(); // restore the real clock
    }

    // The node failed as cancelled — it never completed
    expect(findCompletedEvent(store)).toBeUndefined();
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failedEvent = eventCalls.find(
      (c: unknown[]) =>
        (c[0] as { event_type: string }).event_type === 'node_failed' &&
        (c[0] as { step_name: string }).step_name === 'step1'
    );
    expect(failedEvent).toBeDefined();
    expect((failedEvent![0] as { data: { error: string } }).data.error).toBe('Cancelled by user');
    // Cancellation exemption: no user-facing incompleteness warning
    const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(c =>
      String(c[1])
    );
    expect(sent.some(m => m.includes('output may be missing'))).toBe(false);
    expect(sent.some(m => m.includes('background agent'))).toBe(false);
  });

  it('does not finish at a result that arrives before its background work is reported — #3524', async () => {
    // The race `settled` exists for: the turn-level result arrives BEFORE the
    // provider reports the background task, so nothing at result time says to
    // wait. Only `settled` says the turn is over.
    let settledReached = false;
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'spawned agents' };
      yield { type: 'result', sessionId: 'sid', cost: 0.1 };
      yield {
        type: 'subtask',
        taskId: 't-1',
        status: 'started',
        taskType: 'local_agent',
        description: 'bg research',
      };
      yield { type: 'agent_message_chunk', text: ' + integrated task output' };
      yield { type: 'subtask', taskId: 't-1', status: 'completed' };
      yield { type: 'result', sessionId: 'sid', cost: 0.3 };
      yield { type: 'settled' };
      settledReached = true;
    });

    const store = createMockStore();
    const platform = createMockPlatform();
    await runSingleNode(store, platform, 'bg-late-report-run');

    const completed = findCompletedEvent(store);
    expect(completed!.data.node_output).toBe('spawned agents + integrated task output');
    expect(completed!.data.cost_usd).toBe(0.4);
    expect(completed!.data.background_tasks_incomplete).toBeUndefined();
    // The engine stopped reading at `settled`, not before and not after.
    expect(settledReached).toBe(false);
  });

  it('stops reading at settled', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'normal output' };
      yield { type: 'result', sessionId: 'sid' };
      yield { type: 'settled' };
      // Anything after settled must NOT be consumed
      yield { type: 'agent_message_chunk', text: ' MUST NOT APPEAR' };
    });

    const store = createMockStore();
    const platform = createMockPlatform();
    await runSingleNode(store, platform, 'bg-none-run');

    const completed = findCompletedEvent(store);
    expect(completed).toBeDefined();
    expect(completed!.data.node_output).toBe('normal output');
    expect(completed!.data.background_tasks_incomplete).toBeUndefined();
  });

  it('persists output_file on a finished subtask', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'delegating' };
      yield {
        type: 'subtask',
        taskId: 't-9',
        status: 'completed',
        summary: 'wrote the report',
        outputFile: '/tmp/task-9-output.md',
      };
      yield { type: 'result', sessionId: 'sid' };
    });

    const store = createMockStore();
    const platform = createMockPlatform();
    await runSingleNode(store, platform, 'bg-output-file-run');

    const subtask = persistedEvents(store)
      .filter(e => e.event_type === 'provider_event')
      .map(e => providerEventEnvelopeSchema.parse(e.data).event)
      .find(event => event.type === 'subtask');
    expect(subtask).toMatchObject({ taskId: 't-9', outputFile: '/tmp/task-9-output.md' });
  });
});
