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
  mockLogFn,
  mockLogger,
  createMockStore,
  mockClaudeCapabilities,
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
import type { DagNode } from '../../../schemas';
import type { IWorkflowPlatform } from '../../../deps';
import type { IWorkflowStore } from '../../../store';
import { buildAiProfile } from '../../../model-validation';

describe('loop node execution', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-loop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  it('records the subtasks and hooks a loop iteration streams', async () => {
    const store = createMockStore();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'subtask', taskId: 't-1', status: 'started', description: 'research' };
      yield {
        type: 'hook',
        hookId: 'h-1',
        hookName: 'PreToolUse',
        hookEvent: 'PreToolUse',
        status: 'succeeded',
      };
      yield { type: 'subtask', taskId: 't-1', status: 'completed', summary: 'found it' };
      yield { type: 'agent_message_chunk', text: 'Done. <promise>COMPLETE</promise>' };
      yield { type: 'result', sessionId: 'loop-sess-activity' };
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform: createMockPlatform(),
        cwd: testDir,
        workflow: {
          name: 'dag-loop-activity',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do a task. When done, output <promise>COMPLETE</promise>.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun: makeWorkflowRun('loop-activity-run'),
      })
    );

    const recorded = persistedEvents(store)
      .filter(e => e.event_type === 'provider_event')
      .map(e => providerEventEnvelopeSchema.parse(e.data).event.type);
    expect(recorded).toEqual(['subtask', 'hook', 'subtask', 'agent_message_chunk']);
  });

  it('numbers every iteration of a loop attempt from one sequence', async () => {
    const store = createMockStore();
    let iteration = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      iteration += 1;
      yield { type: 'tool_call', toolCallId: `call-${String(iteration)}`, name: 'read_file' };
      yield {
        type: 'tool_call_update',
        toolCallId: `call-${String(iteration)}`,
        status: 'completed',
      };
      yield {
        type: 'agent_message_chunk',
        text: iteration === 2 ? 'Done. <promise>COMPLETE</promise>' : 'working',
      };
      yield { type: 'result', sessionId: `loop-sess-seq-${String(iteration)}` };
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'dag-loop-seq',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do a task. When done, output <promise>COMPLETE</promise>.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun: makeWorkflowRun('loop-seq-run'),
      })
    );

    expect(iteration).toBe(2);
    const envelopes = persistedEvents(store)
      .filter(e => e.event_type === 'provider_event')
      .map(e => providerEventEnvelopeSchema.parse(e.data));
    expect(envelopes.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(envelopes.map(e => e.attemptId)).size).toBe(1);
  });

  it.each([
    ['zero', { max_attempts: 1, delay_ms: 0 }, [0], true, 'transient'],
    ['default', undefined, [3000, 6000], false, 'transient'],
    ['declared default delay', { max_attempts: 3 }, [3000, 6000, 12000], false, 'transient'],
    ['configured', { max_attempts: 3, delay_ms: 17 }, [17, 34, 68], false, 'transient'],
    [
      'capacity',
      { max_attempts: 1, delay_ms: 0 },
      [45000, 90000, 180000, 300000, 300000],
      false,
      'overloaded',
    ],
    [
      'rate limit',
      { max_attempts: 1, delay_ms: 0 },
      [45000, 45000, 45000, 45000, 45000],
      false,
      'rate_limited',
    ],
  ] as const)(
    'uses the %s loop iteration retry policy',
    async (_name, retry, delays, recover, failureClass) => {
      const realSetTimeout = globalThis.setTimeout;
      const realRandom = Math.random;
      Math.random = () => 0.5;
      let waiting = false;
      const waitRequests: number[][] = [];
      globalThis.setTimeout = ((fn: () => void, delay?: number) => {
        if (waiting) {
          waitRequests.at(-1)!.push(delay ?? 0);
          return realSetTimeout(fn, recover ? delay : 0);
        }
        return realSetTimeout(fn, delay);
      }) as typeof setTimeout;
      try {
        let calls = 0;
        mockSendQueryDag.mockImplementation(async function* () {
          waiting = false;
          calls++;
          if (recover && calls === 2) {
            yield { type: 'result', sessionId: 'recovered', text: '<promise>COMPLETE</promise>' };
          } else {
            yield {
              type: 'result',
              isError: true,
              errors: ['opaque transient failure'],
              failure: { class: failureClass, evidence: 'opaque transient failure' },
            };
          }
        });
        const store = createMockStore();
        const createEvent = store.createWorkflowEvent;
        store.createWorkflowEvent = mock(async event => {
          await createEvent(event);
          if (event.event_type === 'node_retry_scheduled') {
            waiting = true;
            waitRequests.push([]);
          }
        });
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            platform: createMockPlatform(),
            cwd: testDir,
            workflow: {
              name: 'loop-retry-policy',
              nodes: [
                {
                  id: 'my-loop',
                  kind: 'loop',
                  ...(retry ? { retry } : {}),
                  loop: {
                    prompt: 'Work',
                    until: 'COMPLETE',
                    max_iterations: 2,
                    fresh_context: false,
                  },
                },
              ],
            },
            workflowRun: makeWorkflowRun('loop-retry-policy-run'),
          })
        );
        expect(calls).toBe(delays.length + 1);
        const events = store.createWorkflowEvent.mock.calls
          .map(([event]) => event)
          .filter(event => event.event_type === 'node_retry_scheduled');
        expect(events.map(event => event.data?.delay_ms)).toEqual([...delays]);
        expect(events.map(event => event.data?.max_retries)).toEqual(
          delays.map(() => (failureClass === 'transient' ? (retry?.max_attempts ?? 2) : 5))
        );
        expect(events.map(event => event.data?.iteration)).toEqual(delays.map(() => 1));
        expect(waitRequests.map(requests => requests.reduce((a, b) => a + b, 0))).toEqual([
          ...delays,
        ]);
        if (recover) {
          expect(waitRequests).toEqual([[]]);
          expect(store.completeWorkflowRun).toHaveBeenCalled();
        } else {
          // Only a rate limit that outlasts its retries pauses on the provider-limit wait;
          // every other class still fails the run.
          if (failureClass === 'rate_limited') {
            expect(store.failWorkflowRun).not.toHaveBeenCalled();
            expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
              'loop-retry-policy-run',
              expect.objectContaining({ kind: 'quota', nodeId: 'my-loop' }),
              { kind: 'started', stepName: 'my-loop' }
            );
          } else {
            expect(store.failWorkflowRun).toHaveBeenCalled();
            expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
          }
          const failed = store.persistWorkflowEvent.mock.calls
            .map(([event]) => event)
            .find(event => event.event_type === 'node_failed');
          expect(failed?.data).toMatchObject({
            failure_kind: failureClass,
            provider_failure: { class: failureClass, evidence: 'opaque transient failure' },
            error: expect.stringContaining('opaque transient failure'),
          });
        }
      } finally {
        globalThis.setTimeout = realSetTimeout;
        Math.random = realRandom;
      }
    }
  );

  it('resets the retry budget after a successful iteration', async () => {
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      if (calls % 2 === 1) {
        yield {
          type: 'result',
          isError: true,
          failure: { class: 'transient', evidence: 'temporary' },
          errors: ['temporary'],
        };
      } else {
        yield {
          type: 'result',
          sessionId: 'loop-session',
          text: calls === 4 ? '<promise>COMPLETE</promise>' : 'Keep working',
        };
      }
    });
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform: createMockPlatform(),
        cwd: testDir,
        workflow: {
          name: 'iteration-budget',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              retry: { max_attempts: 1, delay_ms: 0 },
              loop: {
                prompt: 'Work',
                until: 'COMPLETE',
                max_iterations: 2,
                fresh_context: false,
              },
            },
          ],
        },
        workflowRun: makeWorkflowRun('iteration-budget-run'),
      })
    );
    expect(calls).toBe(4);
    expect(store.completeWorkflowRun).toHaveBeenCalled();
    expect(
      persistedEvents(store)
        .filter(event => event.event_type === 'node_retry_scheduled')
        .map(event => event.data)
    ).toEqual([
      expect.objectContaining({ iteration: 1, retry_attempt: 1, max_retries: 1, delay_ms: 0 }),
      expect.objectContaining({ iteration: 2, retry_attempt: 1, max_retries: 1, delay_ms: 0 }),
    ]);
    expect(
      persistedEvents(store)
        .filter(event => event.event_type === 'loop_iteration_completed')
        .map(event => event.data?.iteration)
    ).toEqual([1, 2]);
  });

  it(
    'retries an iteration whose typed transient failure reads as fatal — #3520',
    async () => {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(async function* () {
        callCount++;
        if (callCount === 1) {
          yield {
            type: 'result',
            isError: true,
            errorSubtype: 'error_during_execution',
            errors: ['403 forbidden from the upstream gateway'],
            failure: {
              class: 'transient',
              evidence: '403 forbidden from the upstream gateway',
            },
          };
          return;
        }
        yield {
          type: 'agent_message_chunk',
          text: 'Did the task. <promise>COMPLETE</promise>',
        };
        yield { type: 'result', sessionId: 'loop-typed-retry-sess' };
      });

      const store = createMockStore();
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          platform: createMockPlatform(),
          cwd: testDir,
          workflow: {
            name: 'loop-typed-retry',
            nodes: [
              {
                id: 'my-loop',
                kind: 'loop',
                retry: { max_attempts: 1, delay_ms: 0 },
                loop: {
                  fresh_context: false,
                  prompt: 'Complete the task.',
                  until: 'COMPLETE',
                  max_iterations: 3,
                },
              },
            ],
          },
          workflowRun: makeWorkflowRun('loop-typed-retry-run'),
        })
      );

      expect(callCount).toBe(2);
      expect(store.completeWorkflowRun).toHaveBeenCalled();
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
    },
    testTimeout(10_000)
  );

  it('does not retry an iteration whose untyped error reads as a rate limit', async () => {
    // The loop catch-all is its own site: an error that is not a NodeFailure is
    // unknown there too, whatever its message says. Clamp the sleep so a regression
    // to text classification fails fast instead of waiting out the rate-limit backoff.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 1)) as typeof setTimeout;
    try {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(async function* () {
        callCount++;
        throw new Error('429 too many requests: provider overloaded');
      });

      const store = createMockStore();
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          platform: createMockPlatform(),
          cwd: testDir,
          workflow: {
            name: 'loop-untyped-error',
            nodes: [
              {
                id: 'my-loop',
                kind: 'loop',
                retry: { max_attempts: 1, delay_ms: 0 },
                loop: {
                  fresh_context: false,
                  prompt: 'Complete the task.',
                  until: 'COMPLETE',
                  max_iterations: 3,
                },
              },
            ],
          },
          workflowRun: makeWorkflowRun('loop-untyped-error-run'),
        })
      );

      expect(callCount).toBe(1);
      expect(
        persistedEvents(store).filter(event => event.event_type === 'node_retry_scheduled')
      ).toHaveLength(0);
      expect(store.failWorkflowRun).toHaveBeenCalled();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it('records a failed iteration’s typed failure on the loop node, unchanged', async () => {
    const failure = { class: 'auth', evidence: 'Invalid API key' } as const;
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'result', isError: true, errors: [failure.evidence], failure };
    });

    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform: createMockPlatform(),
        cwd: testDir,
        workflow: {
          name: 'loop-typed-failure',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              retry: { max_attempts: 1, delay_ms: 0 },
              loop: {
                fresh_context: false,
                prompt: 'Complete the task.',
                until: 'COMPLETE',
                max_iterations: 3,
              },
            },
          ],
        },
        workflowRun: makeWorkflowRun('loop-typed-failure-run'),
      })
    );

    const failed = persistedEvents(store).find(
      event => event.event_type === 'node_failed' && event.step_name === 'my-loop'
    );
    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    expect(
      persistedEvents(store).filter(event => event.event_type === 'node_retry_scheduled')
    ).toHaveLength(0);
    expect(failed?.data?.failure_kind).toBe('fatal');
    expect(failed?.data?.provider_failure).toEqual(failure);
  });

  it('names the cost cap when a loop iteration hits its spend limit', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'error_max_budget_usd',
        failure: { class: 'budget_exceeded', evidence: 'error_max_budget_usd' },
      };
    });

    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform: createMockPlatform(),
        cwd: testDir,
        workflow: {
          name: 'loop-budget',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              maxBudgetUsd: 1.5,
              loop: {
                fresh_context: false,
                prompt: 'Complete the task.',
                until: 'COMPLETE',
                max_iterations: 3,
              },
            },
          ],
        },
        workflowRun: makeWorkflowRun('loop-budget-run'),
      })
    );

    const failed = persistedEvents(store).find(
      event => event.event_type === 'node_failed' && event.step_name === 'my-loop'
    );
    expect(failed?.data?.error).toContain("Loop 'my-loop' iteration 1 exceeded cost cap of $1.50.");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'my-loop', iteration: 1, maxBudgetUsd: 1.5 }),
      'dag.node_budget_cap_exceeded'
    );
  });

  it('completes on <promise>COMPLETE</promise> signal in first iteration', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Did the task. <promise>COMPLETE</promise>' };
      yield { type: 'result', sessionId: 'loop-session-1' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-test',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do a task. When done, output <promise>COMPLETE</promise>.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // Should have called sendQuery exactly once (completed on iteration 1)
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    // Workflow should be marked completed with node counts metadata
    const completeCalls = (
      mockDeps.store.completeWorkflowRun as Mock<IWorkflowStore['completeWorkflowRun']>
    ).mock.calls;
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0][1]?.duration_ms).toBeNumber();
    expect(completeCalls[0][2]).toEqual({
      node_counts: { completed: 1, failed: 0, skipped: 0, total: 1 },
    });
    expect(mockDeps.store.createWorkflowEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'workflow_completed' })
    );
  });

  it('records requested model/tier on node_started and the resolved model on node_completed (#2314)', async () => {
    // Loop nodes own their sendQuery loop, so they need their own half of the
    // #2314 record: the requested alias on node_started, the concrete model
    // the provider reported on node_completed.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Did the task. <promise>COMPLETE</promise>' };
      yield {
        type: 'result',
        sessionId: 'loop-model-sid',
        resolvedModel: { id: 'claude-opus-5-20260501' },
        tokens: { input: 100, output: 10 },
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-model-run');
    const aiProfile = buildAiProfile('claude', {
      repoTiers: { large: { provider: 'claude', model: 'opus', effort: 'max' } },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-model-usage',
          nodes: [
            {
              id: 'my-loop',
              model: 'large',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do a task. When done, output <promise>COMPLETE</promise>.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
        aiProfile,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls as Array<
      [{ event_type: string; step_name: string; data?: Record<string, unknown> }]
    >;
    const startedEvent = eventCalls.find(
      ([arg]) => arg.event_type === 'node_started' && arg.step_name === 'my-loop'
    );
    expect(startedEvent).toBeDefined();
    expect(startedEvent?.[0].data?.provider).toBe('claude');
    expect(startedEvent?.[0].data?.model).toBe('opus');
    expect(startedEvent?.[0].data?.tier).toBe('large');
    expect(startedEvent?.[0].data?.effort).toBe('max');

    const completedEvent = eventCalls.find(
      ([arg]) => arg.event_type === 'node_completed' && arg.step_name === 'my-loop'
    );
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.[0].data?.model_usage).toEqual({
      requested: 'opus',
      resolved: 'claude-opus-5-20260501',
    });
    expect(completedEvent?.[0].data?.tokens).toEqual({ input: 100, output: 10 });
  });

  it('omits model_usage on node_completed when the provider reports no resolved model (#2314)', async () => {
    // Codex cannot report a concrete model — absence must stay absent rather
    // than being back-filled with the requested alias.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Did the task. <promise>COMPLETE</promise>' };
      yield { type: 'result', sessionId: 'loop-no-model-sid' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-no-model-run');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-no-model-usage',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do a task. When done, output <promise>COMPLETE</promise>.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls as Array<
      [{ event_type: string; step_name: string; data?: Record<string, unknown> }]
    >;
    const completedEvent = eventCalls.find(
      ([arg]) => arg.event_type === 'node_completed' && arg.step_name === 'my-loop'
    );
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.[0].data).not.toHaveProperty('model_usage');
    expect(completedEvent?.[0].data).not.toHaveProperty('tokens');
  });

  it('clears a resolved model when a later result omits it, rather than reporting the stale one', async () => {
    // Pi/Copilot reask loops emit several result chunks and Pi omits resolvedModel
    // when its later assistant message carries no responseModel. A guarded
    // assignment would leave the FIRST chunk's model recorded as the node's answer
    // -- fabricated attribution, which is the defect #2314 exists to prevent.
    // Two results in ONE iteration, via the background-task wait (same shape as the
    // #2083 cost test): the first reports a model, the final one does not.
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'subtask',
        taskId: 't-1',
        status: 'started',
        taskType: 'local_agent',
        description: 'bg work',
      };
      yield { type: 'agent_message_chunk', text: 'Done. <promise>COMPLETE</promise>' };
      yield { type: 'result', sessionId: 'stale-sid', resolvedModel: { id: 'claude-haiku-4-5' } };
      yield { type: 'subtask', taskId: 't-1', status: 'completed' };
      // Final result reports NO model, so the node must record none -- not
      // 'claude-haiku-4-5' retained from the earlier chunk.
      yield { type: 'result', sessionId: 'stale-sid' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-stale-model-run');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-stale-model',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do a task. When done, output <promise>COMPLETE</promise>.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls as Array<
      [{ event_type: string; step_name: string; data?: Record<string, unknown> }]
    >;
    const completedEvent = eventCalls.find(
      ([arg]) => arg.event_type === 'node_completed' && arg.step_name === 'my-loop'
    );
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.[0].data).not.toHaveProperty('model_usage');
  });

  it('ends an iteration on settled, not at a result reported before its background work — #3524', async () => {
    // The completion signal only arrives after the first result; an iteration that
    // stopped at that result would never see it and burn another iteration.
    let settledReached = false;
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Working.' };
      yield { type: 'result', sessionId: 'loop-sid' };
      yield {
        type: 'subtask',
        taskId: 't-1',
        status: 'started',
        taskType: 'local_agent',
        description: 'bg work',
      };
      yield { type: 'subtask', taskId: 't-1', status: 'completed' };
      yield { type: 'agent_message_chunk', text: ' Done. <promise>COMPLETE</promise>' };
      yield { type: 'result', sessionId: 'loop-sid' };
      yield { type: 'settled' };
      settledReached = true;
    });

    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform: createMockPlatform(),
        cwd: testDir,
        workflow: {
          name: 'dag-loop-late-report',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do a task. When done, output <promise>COMPLETE</promise>.',
                until: 'COMPLETE',
                max_iterations: 1,
              },
            },
          ],
        },
        workflowRun: makeWorkflowRun('loop-late-report-run'),
      })
    );

    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    expect(store.completeWorkflowRun).toHaveBeenCalled();
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(settledReached).toBe(false);
  });

  it('fails an iteration whose stream ends after its result without settling — #3524', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Done. <promise>COMPLETE</promise>' };
      yield { type: 'result', sessionId: 'loop-sid' };
    });

    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: { ...createMockDeps(store), getAgentProvider: mockGetAgentProviderDag },
        platform: createMockPlatform(),
        cwd: testDir,
        workflow: {
          name: 'dag-loop-unsettled',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do a task. When done, output <promise>COMPLETE</promise>.',
                until: 'COMPLETE',
                max_iterations: 3,
              },
            },
          ],
        },
        workflowRun: makeWorkflowRun('loop-unsettled-run'),
      })
    );

    const failed = persistedEvents(store).find(
      event => event.event_type === 'node_failed' && event.step_name === 'my-loop'
    );
    expect(failed?.data?.failure_kind).toBe('unknown');
    expect(failed?.data?.error).toBe(
      'Loop iteration 1 failed: the provider stream ended without signalling that its turn settled. Its work may be incomplete.'
    );
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
    // Like any failed iteration, it is recorded as one.
    expect(
      persistedEvents(store).some(
        event => event.event_type === 'loop_iteration_failed' && event.data?.iteration === 1
      )
    ).toBe(true);
  });

  it('sums per-result cost when background work wakes another turn', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'subtask',
        taskId: 't-1',
        status: 'started',
        taskType: 'local_agent',
        description: 'bg work',
      };
      yield { type: 'agent_message_chunk', text: 'Done. <promise>COMPLETE</promise>' };
      // Providers report each result's own spend.
      yield { type: 'result', sessionId: 'loop-sid', cost: 0.1 };
      yield { type: 'subtask', taskId: 't-1', status: 'completed' };
      yield { type: 'result', sessionId: 'loop-sid', cost: 0.3 };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-bg-cost-run');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-bg-cost',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do a task. When done, output <promise>COMPLETE</promise>.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completedEvent = eventCalls.find(
      (c: unknown[]) =>
        (c[0] as { event_type: string }).event_type === 'node_completed' &&
        (c[0] as { step_name: string }).step_name === 'my-loop'
    );
    expect(completedEvent).toBeDefined();
    expect((completedEvent![0] as { data: { cost_usd?: number } }).data.cost_usd).toBe(0.4);
  });

  it('keeps a finite loop cost when a later result in the same iteration is non-finite', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'subtask',
        taskId: 't-1',
        status: 'started',
        taskType: 'local_agent',
        description: 'bg work',
      };
      yield { type: 'agent_message_chunk', text: 'Done. <promise>COMPLETE</promise>' };
      yield { type: 'result', sessionId: 'loop-sid', cost: 0.1 };
      yield { type: 'subtask', taskId: 't-1', status: 'completed' };
      yield { type: 'result', sessionId: 'loop-sid', cost: Number.NaN };
    });

    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'dag-loop-nan-cost',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do a task. When done, output <promise>COMPLETE</promise>.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun: makeWorkflowRun('loop-nan-cost-run'),
      })
    );

    const completedEvent = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_completed' &&
        (call[0] as { step_name: string }).step_name === 'my-loop'
    );
    expect(completedEvent).toBeDefined();
    expect((completedEvent![0] as { data: { cost_usd?: number } }).data.cost_usd).toBe(0.1);
    expect(
      (mockLogFn as unknown as Mock<(obj: unknown, msg?: string) => void>).mock.calls.some(
        call => call[1] === 'loop_node.usage_cost_non_finite_ignored'
      )
    ).toBe(true);
  });

  it('records the cross-iteration union of dangling background tasks on node_completed (#2083)', async () => {
    // Iterations 1 and 2 each end with a different task still live (subprocess
    // death analog); iteration 3 finishes cleanly and signals completion. The
    // node_completed event must carry the UNION of dangling ids — last-iteration
    // reporting would hide t-a and t-b behind the clean final iteration.
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        yield {
          type: 'subtask',
          taskId: 't-a',
          status: 'started',
          taskType: 'local_agent',
          description: 'never drains',
        };
        yield { type: 'agent_message_chunk', text: 'first pass' };
        yield { type: 'result', sessionId: 'sid-1' };
        // Generator ends with t-a live
      } else if (callCount === 2) {
        yield {
          type: 'subtask',
          taskId: 't-b',
          status: 'started',
          taskType: 'local_agent',
          description: 'never drains',
        };
        yield { type: 'agent_message_chunk', text: 'second pass' };
        yield { type: 'result', sessionId: 'sid-2' };
        // Generator ends with t-b live
      } else {
        yield { type: 'agent_message_chunk', text: 'All done! <promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: 'sid-3' };
      }
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-bg-union-run');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-bg-union',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do a task. When done, output <promise>COMPLETE</promise>.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(3);
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completedEvent = eventCalls.find(
      (c: unknown[]) =>
        (c[0] as { event_type: string }).event_type === 'node_completed' &&
        (c[0] as { step_name: string }).step_name === 'my-loop'
    );
    expect(completedEvent).toBeDefined();
    const data = (completedEvent![0] as { data: Record<string, unknown> }).data;
    expect(data.background_tasks_incomplete).toEqual(['t-a', 't-b']);
  });

  it('omits background_tasks_incomplete from node_completed when every iteration drains cleanly', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'subtask',
        taskId: 't-1',
        status: 'started',
        taskType: 'local_agent',
        description: 'bg work',
      };
      yield { type: 'agent_message_chunk', text: 'Done. <promise>COMPLETE</promise>' };
      yield { type: 'result', sessionId: 'sid-clean' };
      yield { type: 'subtask', taskId: 't-1', status: 'completed' };
      yield { type: 'result', sessionId: 'sid-clean' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-bg-clean-run');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-bg-clean',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do a task. When done, output <promise>COMPLETE</promise>.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completedEvent = eventCalls.find(
      (c: unknown[]) =>
        (c[0] as { event_type: string }).event_type === 'node_completed' &&
        (c[0] as { step_name: string }).step_name === 'my-loop'
    );
    expect(completedEvent).toBeDefined();
    expect(
      (completedEvent![0] as { data: Record<string, unknown> }).data.background_tasks_incomplete
    ).toBeUndefined();
  });

  it('cancellation mid-stream aborts the iteration and suppresses the incompleteness warning', async () => {
    // Mirrors the AI-node cancellation-exemption test: the run is cancelled
    // while an iteration is streaming with a live background task. The new
    // mid-stream status check must abort the iteration (previously the loop
    // only noticed cancellation BETWEEN iterations), fail the node with the
    // observed status, and suppress the incompleteness warning.
    let tasksDelivered = false;
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'subtask',
        taskId: 't-loop',
        status: 'started',
        taskType: 'local_agent',
        description: 'still running',
      };
      tasksDelivered = true;
      setSystemTime(new Date(Date.now() + 11_000));
      yield { type: 'agent_message_chunk', text: 'working' };
      yield { type: 'agent_message_chunk', text: 'MUST NOT BE REACHED' };
    });

    const store = createMockStore();
    // 'running' for the between-iteration check, 'cancelled' once the task
    // set has been delivered mid-stream.
    (store.getWorkflowRunStatus as Mock<() => Promise<string | null>>).mockImplementation(() =>
      Promise.resolve(tasksDelivered ? 'cancelled' : 'running')
    );
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-bg-cancel-run');

    try {
      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          cwd: testDir,
          workflow: {
            name: 'dag-loop-bg-cancel',
            nodes: [
              {
                id: 'my-loop',
                kind: 'loop',
                loop: {
                  fresh_context: false,
                  prompt: 'Do tasks.',
                  until: 'COMPLETE',
                  max_iterations: 5,
                },
              },
            ],
          },
          workflowRun,
        })
      );
    } finally {
      setSystemTime(); // restore the real clock
    }

    // Aborted during iteration 1 — no second iteration
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    // The loop never completed
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completedEvent = eventCalls.find(
      (c: unknown[]) =>
        (c[0] as { event_type: string }).event_type === 'node_completed' &&
        (c[0] as { step_name: string }).step_name === 'my-loop'
    );
    expect(completedEvent).toBeUndefined();
    const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(c =>
      String(c[1])
    );
    // The stop is surfaced with the observed status…
    expect(sent.some(m => m.includes('stopped during iteration 1 (cancelled)'))).toBe(true);
    // …and the incompleteness warning is suppressed as noise
    expect(sent.some(m => m.includes('output may be missing'))).toBe(false);
  });

  it('completes after multiple iterations', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      if (callCount < 3) {
        yield { type: 'agent_message_chunk', text: `Iteration ${String(callCount)} progress` };
        yield { type: 'result', sessionId: `loop-session-${String(callCount)}` };
      } else {
        yield { type: 'agent_message_chunk', text: 'All done! <promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: `loop-session-${String(callCount)}` };
      }
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-multi',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do next task.',
                until: 'COMPLETE',
                max_iterations: 10,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(3);
  });

  it('substitutes $LOOP_PREV_OUTPUT with previous iteration output (empty on iter 1)', async () => {
    // Iteration 1 emits a distinctive output, iteration 2 emits the completion signal.
    // We then assert the prompt sent to the AI: iteration 1 strips $LOOP_PREV_OUTPUT
    // to empty, iteration 2 receives iteration 1's cleaned output.
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        yield { type: 'agent_message_chunk', text: 'Iter1 output: 2 type errors in users.ts' };
        yield { type: 'result', sessionId: 'loop-session-1' };
      } else {
        yield { type: 'agent_message_chunk', text: 'All fixed. <promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: 'loop-session-2' };
      }
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-prev-output',
          nodes: [
            {
              id: 'fix-loop',
              kind: 'loop',
              loop: {
                prompt: 'Previous output: <<$LOOP_PREV_OUTPUT>>. Fix and emit COMPLETE.',
                until: 'COMPLETE',
                max_iterations: 5,
                fresh_context: true,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    const promptIter1 = mockSendQueryDag.mock.calls[0][0] as string;
    const promptIter2 = mockSendQueryDag.mock.calls[1][0] as string;
    // Iteration 1: $LOOP_PREV_OUTPUT substitutes to empty string.
    expect(promptIter1).toContain('Previous output: <<>>.');
    // Iteration 2: receives iteration 1's cleaned output.
    expect(promptIter2).toContain('Previous output: <<Iter1 output: 2 type errors in users.ts>>.');
  });

  it('strips <promise> tags from $LOOP_PREV_OUTPUT (uses cleaned output)', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        // Iteration 1 includes a non-completion XML tag in its output. The cleaned
        // output (after stripCompletionTags) drops <promise>...</promise> blocks.
        // We use a non-matching signal here so iteration 1 does NOT complete.
        yield {
          type: 'agent_message_chunk',
          text: 'Real work output. <promise>NOT_DONE_YET</promise>',
        };
        yield { type: 'result', sessionId: 'loop-session-1' };
      } else {
        yield { type: 'agent_message_chunk', text: 'Done. <promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: 'loop-session-2' };
      }
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-prev-clean',
          nodes: [
            {
              id: 'fix-loop',
              kind: 'loop',
              loop: {
                prompt: 'PREV=[$LOOP_PREV_OUTPUT]',
                until: 'COMPLETE',
                max_iterations: 5,
                fresh_context: true,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    const promptIter2 = mockSendQueryDag.mock.calls[1][0] as string;
    // The previous-output payload must be the *cleaned* output — no <promise> tags.
    expect(promptIter2).toContain('PREV=[Real work output.');
    expect(promptIter2).not.toContain('<promise>');
  });

  it('$LOOP_PREV_OUTPUT is empty on the first iteration after interactive resume', async () => {
    // Regression guard for the resume-from-approval path: when an interactive
    // loop pauses at the approval gate, the prior `lastIterationOutput` lives
    // in a separate process and is not persisted. On resume, the executor must
    // substitute $LOOP_PREV_OUTPUT to '' on the first resumed iteration —
    // never to whatever the paused run produced.
    //
    // Wirasm-suggested shape (PR #1367 review): two executeDagWorkflow calls.
    // The first call pauses at the gate after iteration 1; the second call
    // resumes with metadata.approval populated and runs iteration 2.

    // ---- Call 1: fresh run, iteration 1 emits no completion → pauses at gate
    mockSendQueryDag.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: 'Iter1 output: 2 type errors in users.ts' };
      yield { type: 'result', sessionId: 'loop-session-1' };
    });
    const mockDeps1 = createMockDeps();
    const platform1 = createMockPlatform();
    const freshRun = makeWorkflowRun('resume-prev-fresh-run');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps1,
        platform: platform1,
        cwd: testDir,
        workflow: {
          name: 'interactive-loop-resume-prev-output',
          nodes: [
            {
              id: 'refine',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt:
                  'User: $LOOP_USER_INPUT. PREV=<<$LOOP_PREV_OUTPUT>>. Continue or emit COMPLETE.',
                until: 'COMPLETE',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review and provide feedback.',
              },
            },
          ],
        },
        workflowRun: freshRun,
      })
    );

    // First iteration of a fresh interactive loop: $LOOP_PREV_OUTPUT empty;
    // $LOOP_USER_INPUT empty (no user has spoken yet).
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const promptIter1 = mockSendQueryDag.mock.calls[0][0] as string;
    expect(promptIter1).toContain('PREV=<<>>.');
    expect(promptIter1).toContain('User: .');
    // Fresh interactive loop must pause at the gate, not return early.
    const pauseCalls1 = (
      mockDeps1.store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>
    ).mock.calls;
    expect(pauseCalls1.length).toBe(1);
    expect(pauseCalls1[0][1]).toMatchObject({
      type: 'interactive_loop',
      nodeId: 'refine',
      iteration: 1,
    });

    // ---- Call 2: resumed run — metadata carries iter 1 + user input.
    // iter 2 emits the completion signal so the loop exits cleanly.
    mockSendQueryDag.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: 'All clear. <promise>COMPLETE</promise>' };
      yield { type: 'result', sessionId: 'loop-session-2' };
    });
    const mockDeps2 = createMockDeps();
    const platform2 = createMockPlatform();
    const resumedRun = makeWorkflowRun('resume-prev-resume-run', {
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'refine',
          iteration: 1,
          sessionId: 'loop-session-1',
          message: 'Review and provide feedback.',
        },
        loop_user_input: 'looks good, ship it',
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps2,
        platform: platform2,
        cwd: testDir,
        workflow: {
          name: 'interactive-loop-resume-prev-output',
          nodes: [
            {
              id: 'refine',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt:
                  'User: $LOOP_USER_INPUT. PREV=<<$LOOP_PREV_OUTPUT>>. Continue or emit COMPLETE.',
                until: 'COMPLETE',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review and provide feedback.',
              },
            },
          ],
        },
        workflowRun: resumedRun,
      })
    );

    // Second executeDagWorkflow call started a fresh sendQuery generator (mock
    // call index 1 across the two runs). The resumed iteration must NOT carry
    // the prior process's iter-1 output through $LOOP_PREV_OUTPUT — it must
    // substitute to ''.
    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    const promptResumeIter = mockSendQueryDag.mock.calls[1][0] as string;
    expect(promptResumeIter).toContain('PREV=<<>>.');
    expect(promptResumeIter).not.toContain('Iter1 output: 2 type errors');
    // The resume's user input flows through on the first resumed iteration.
    expect(promptResumeIter).toContain('User: looks good, ship it.');
    // Resume call exits via completion, not via a second pause at the gate.
    const pauseCalls2 = (
      mockDeps2.store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>
    ).mock.calls;
    expect(pauseCalls2.length).toBe(0);
  });

  it('fails when max_iterations exceeded', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Still working...' };
      yield { type: 'result', sessionId: 'loop-session' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-max',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do task.',
                until: 'COMPLETE',
                max_iterations: 2,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // Should have called sendQuery exactly 2 times (max_iterations)
    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    // Workflow should be marked failed (no completion signal)
    expect(
      (mockDeps.store.failWorkflowRun as Mock<IWorkflowStore['failWorkflowRun']>).mock.calls.length
    ).toBe(1);
  });

  it('completes on final iteration with XML-wrapped signal (<COMPLETE>SIGNAL</COMPLETE>)', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      if (callCount < 3) {
        yield { type: 'agent_message_chunk', text: `Iteration ${String(callCount)} progress` };
        yield { type: 'result', sessionId: `loop-session-${String(callCount)}` };
      } else {
        // Final iteration uses <COMPLETE> tag instead of <promise>
        yield { type: 'agent_message_chunk', text: 'All clean! <COMPLETE>ALL_CLEAN</COMPLETE>' };
        yield { type: 'result', sessionId: `loop-session-${String(callCount)}` };
      }
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-xml-tag',
          nodes: [
            {
              id: 'fix-and-review',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Fix and review. When done, output <COMPLETE>ALL_CLEAN</COMPLETE>.',
                until: 'ALL_CLEAN',
                max_iterations: 3,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // 3 iterations run, signal found on iteration 3 → completed, NOT failed
    expect(mockSendQueryDag.mock.calls.length).toBe(3);
    expect(
      (mockDeps.store.completeWorkflowRun as Mock<IWorkflowStore['completeWorkflowRun']>).mock.calls
        .length
    ).toBe(1);
    expect(
      (mockDeps.store.failWorkflowRun as Mock<IWorkflowStore['failWorkflowRun']>).mock.calls.length
    ).toBe(0);
    // Verify stripping: raw XML completion tags must not appear in user-visible output
    const allSentMessages = (
      platform.sendMessage as Mock<(...args: unknown[]) => Promise<void>>
    ).mock.calls
      .map((call: unknown[]) => call[1] as string)
      .join('');
    expect(allSentMessages).not.toContain('<COMPLETE>');
    expect(allSentMessages).not.toContain('</COMPLETE>');
  });

  it('loop node output available to downstream nodes via $nodeId.output', async () => {
    let loopCallCount = 0;
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      if (prompt.includes('Do task')) {
        loopCallCount++;
        if (loopCallCount >= 2) {
          yield {
            type: 'agent_message_chunk',
            text: 'Loop result: all tasks done <promise>COMPLETE</promise>',
          };
        } else {
          yield { type: 'agent_message_chunk', text: 'Working on task 1' };
        }
        yield { type: 'result', sessionId: 'loop-sid' };
      } else {
        // downstream node
        yield { type: 'agent_message_chunk', text: 'Got upstream: ' + prompt.slice(0, 50) };
        yield { type: 'result', sessionId: 'downstream-sid' };
      }
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-output',
          nodes: [
            {
              id: 'impl',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do task. Output <promise>COMPLETE</promise> when done.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
            {
              id: 'report',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'Summarize: $impl.output' },
              depends_on: ['impl'],
            },
          ],
        },
        workflowRun,
      })
    );

    // Loop ran 2 iterations + downstream ran once = 3 calls
    expect(mockSendQueryDag.mock.calls.length).toBe(3);
  });

  it('fresh_context: true gives each iteration fresh session', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      if (callCount >= 2) {
        yield { type: 'agent_message_chunk', text: '<promise>DONE</promise>' };
      } else {
        yield { type: 'agent_message_chunk', text: 'Progress' };
      }
      yield { type: 'result', sessionId: `session-${String(callCount)}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-fresh',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                prompt: 'Do stuff.',
                until: 'DONE',
                max_iterations: 5,
                fresh_context: true,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // Both calls should have undefined resumeSessionId (fresh context)
    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    // First call: fresh (iteration 1 always fresh)
    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    // Second call: also fresh (fresh_context: true)
    expect(mockSendQueryDag.mock.calls[1][2]).toBeUndefined();
  });

  it('fresh_context: false threads session between iterations', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      if (callCount >= 2) {
        yield { type: 'agent_message_chunk', text: '<promise>DONE</promise>' };
      } else {
        yield { type: 'agent_message_chunk', text: 'Progress' };
      }
      yield { type: 'result', sessionId: `session-${String(callCount)}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-stateful',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                prompt: 'Do stuff.',
                until: 'DONE',
                max_iterations: 5,
                fresh_context: false,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    // First call: fresh (iteration 1 always fresh)
    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    // Second call: should have session-1 from first iteration
    expect(mockSendQueryDag.mock.calls[1][2]).toBe('session-1');
  });

  it('strips <promise> tags from platform output', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Done! <promise>COMPLETE</promise>' };
      yield { type: 'result', sessionId: 'loop-sid' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-strip',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Task.',
                until: 'COMPLETE',
                max_iterations: 3,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // In batch mode, accumulated clean output is sent
    const sendCalls = (platform.sendMessage as Mock<IWorkflowPlatform['sendMessage']>).mock.calls;
    const contentMessages = sendCalls
      .map((call: unknown[]) => call[1] as string)
      .filter((msg: string) => msg.includes('Done'));
    // Should have stripped <promise> tags
    for (const msg of contentMessages) {
      expect(msg).not.toContain('<promise>');
    }
  });

  it('cancellation between iterations stops the loop', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      yield { type: 'agent_message_chunk', text: `Iteration ${String(callCount)}` };
      yield { type: 'result', sessionId: `sid-${String(callCount)}` };
    });

    const store = createMockStore();
    let statusCallCount = 0;
    (store.getWorkflowRunStatus as Mock<() => Promise<string | null>>).mockImplementation(() => {
      statusCallCount++;
      // Return 'cancelled' on second status check (before iteration 2)
      if (statusCallCount >= 2) return Promise.resolve('cancelled');
      return Promise.resolve('running');
    });
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-cancel',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do tasks.',
                until: 'COMPLETE',
                max_iterations: 10,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // Should have only done 1 iteration (cancelled before iteration 2)
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
  });

  it('AI error mid-iteration returns failed NodeOutput', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      throw new Error('Claude Code auth error: unauthorized');
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-ai-error',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do task.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // Should have run exactly 1 iteration (failed on first)
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    // Workflow should be marked failed
    expect(
      (mockDeps.store.failWorkflowRun as Mock<IWorkflowStore['failWorkflowRun']>).mock.calls.length
    ).toBe(1);
  });

  it('loop iteration fails loudly when SDK returns error_during_execution', async () => {
    // Regression test for #1208: previously the loop silently broke on isError
    // results and kept iterating with empty output, producing "5-second crashes"
    // that masqueraded as successful iterations.
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'error_during_execution',
        errors: ['Subprocess crashed mid-turn'],
        sessionId: 'bad-session',
        cost: 0.04,
        tokens: { input: 70, output: 7, cacheRead: 30, cacheWrite: 0 },
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'loop-iteration-err',
          nodes: [
            {
              id: 'work',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do the work. Say DONE.',
                until: 'DONE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // Should fail after one iteration rather than burning through max_iterations
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    // The loop_iteration_failed event should carry the subtype and SDK errors detail
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const iterFailedEvents = eventCalls.filter(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>).event_type === 'loop_iteration_failed'
    );
    expect(iterFailedEvents.length).toBeGreaterThan(0);
    const failedData = (iterFailedEvents[0][0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(failedData.error).toContain('error_during_execution');
    expect(failedData.error).toContain('Subprocess crashed mid-turn');
    const nodeFailed = eventCalls.find(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    const nodeFailedData = (nodeFailed?.[0] as { data?: Record<string, unknown> } | undefined)
      ?.data;
    expect(nodeFailedData?.cost_usd).toBe(0.04);
    expect(nodeFailedData?.tokens).toEqual({
      input: 70,
      output: 7,
      cacheRead: 30,
      cacheWrite: 0,
    });
  });

  it('loop iteration does NOT fail on isError: true + errorSubtype: success', async () => {
    // Regression test for #1425 (loop-branch counterpart of the main-path
    // test). Stop_sequence terminations carry is_error: true + subtype:
    // 'success' under the Claude SDK contract; previously, the loop branch
    // threw "SDK returned success" and aborted the iteration even though
    // the AI had completed its work correctly.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Done.\nDONE' };
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'success',
        stopReason: 'end_turn',
        sessionId: 'sid-loop-stop',
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'loop-success-stop-seq-test',
          nodes: [
            {
              id: 'work',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do the work. Say DONE.',
                until: 'DONE',
                max_iterations: 3,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failedEvents = eventCalls.filter((call: unknown[]) => {
      const evt = (call[0] as Record<string, unknown>).event_type as string;
      return evt === 'node_failed' || evt === 'loop_iteration_failed';
    });
    expect(failedEvents).toHaveLength(0);
  });

  it('closes the loop lifecycle with exactly one node_failed on max-iterations exhaustion', async () => {
    // Failure finalizer contract: every failed exit after node_started goes
    // through one finalizer — exactly one node_failed row per started loop
    // node, paired with its node_started.
    await writeFile(
      join(testDir, '.archon', 'commands', 'exhaust-loop.md'),
      'Body that never signals completion'
    );

    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'still going, no signal' };
      yield { type: 'result', sessionId: 'sid-exhaust' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'loop-cmd-exhaust',
          nodes: [
            {
              id: 'exhaust-loop',
              kind: 'loop',
              loop: {
                command: 'exhaust-loop',
                until: 'COMPLETE',
                max_iterations: 2,
                fresh_context: true,
              },
            } as unknown as DagNode,
          ],
        },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const started = eventCalls.filter(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>).event_type === 'node_started' &&
        (call[0] as Record<string, unknown>).step_name === 'exhaust-loop'
    );
    const failed = eventCalls.filter(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>).event_type === 'node_failed' &&
        (call[0] as Record<string, unknown>).step_name === 'exhaust-loop'
    );
    expect(started).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const data = (failed[0][0] as Record<string, unknown>).data as Record<string, unknown>;
    expect(String(data.error)).toContain('exceeded max iterations');
  });
});
