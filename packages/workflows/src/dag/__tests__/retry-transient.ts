import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import type { ProviderFailure } from '@archon/provider-contract';
import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeDagWorkflow } from '../../dag-executor';
import { RATE_LIMIT_MAX_RETRIES } from '../../executor-shared';
import { nodeInvocationKey, readNodeRecordEvent } from '../../node-record-reader';
import type { DagNode, WorkflowRun } from '../../schemas';
import type { IWorkflowStore } from '../../store';
import {
  createMockDeps,
  createMockPlatform,
  createMockStore,
  dagOptions,
  makeWorkflowRun,
  mockClaudeCapabilities,
  mockGetAgentProviderDag,
  mockSendQueryDag,
  runUsageWrites,
} from '../test-utils';

export function registerTransientTests() {
  describe('executeDagWorkflow -- node-level retry for transient errors', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(
        tmpdir(),
        `dag-retry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      const commandsDir = join(testDir, '.archon', 'commands');
      await mkdir(commandsDir, { recursive: true });
      await writeFile(join(commandsDir, 'my-cmd.md'), 'Do something for $USER_MESSAGE');

      mockSendQueryDag.mockClear();
      mockGetAgentProviderDag.mockClear();
      mockGetAgentProviderDag.mockImplementation(() => ({
        sendQuery: mockSendQueryDag,
        checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
        getType: () => 'claude',
        getCapabilities: mockClaudeCapabilities,
      }));
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'DAG AI response' };
        yield { type: 'result', sessionId: 'dag-session-id' };
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

    it('node succeeds on retry after a transient error', async () => {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(async function* () {
        callCount++;
        if (callCount === 1) {
          yield {
            type: 'result',
            isError: true,
            errorSubtype: 'error_during_execution',
            errors: ['Claude Code crash: process exited with code 1'],
            failure: {
              class: 'transient',
              evidence: 'Claude Code crash: process exited with code 1',
            },
            sessionId: 'failed-retry-sess',
            cost: 0.01,
            tokens: { input: 10, output: 1, cacheRead: 5, cacheWrite: 0 },
          };
          return;
        }
        yield { type: 'agent_message_chunk', text: 'Recovered' };
        yield {
          type: 'result',
          sessionId: 'retry-sess',
          cost: 0.02,
          tokens: { input: 20, output: 2, cacheRead: 10, cacheWrite: 0 },
        };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('dag-retry-succeed-run');

      const nodes: DagNode[] = [
        {
          id: 'my-node',
          kind: 'agent',
          source: { kind: 'command', name: 'my-cmd' },
          retry: { max_attempts: 2, delay_ms: 1 },
        },
      ];

      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId: 'conv-dag-retry-succeed',
          cwd: testDir,
          workflow: { name: 'dag-retry-succeed', nodes },
          workflowRun,
        })
      );

      // Node was called at least twice (first fails transiently, second succeeds)
      expect(callCount).toBeGreaterThanOrEqual(2);
      expect(mockDeps.store.failWorkflowRun as ReturnType<typeof mock>).not.toHaveBeenCalled();
      expect(runUsageWrites(mockDeps.store)).toEqual([
        {
          total_cost_usd: 0.03,
          total_tokens_in: 30,
          total_tokens_out: 3,
          total_cache_read_tokens: 15,
          total_cache_write_tokens: 0,
        },
      ]);
      const terminals = (
        mockDeps.store.persistWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>
      ).mock.calls
        .map(([event]) => event)
        .filter(
          event => event.event_type === 'node_failed' || event.event_type === 'node_completed'
        );
      expect(terminals).toHaveLength(2);
      expect(terminals[0].data?.invocation).toEqual(terminals[1].data?.invocation);
      expect(terminals[0].data?.attempt).not.toEqual(terminals[1].data?.attempt);
    });

    it('retains the failed invocation when a durable resume starts another attempt', async () => {
      const store = createMockStore();
      const deps = createMockDeps(store);
      const workflowRun = makeWorkflowRun('invocation-resume');
      const workflow = {
        name: 'invocation-resume',
        nodes: [
          {
            id: 'work',
            kind: 'agent' as const,
            source: { kind: 'inline' as const, prompt: 'Do work' },
            retry: { max_attempts: 0 },
          },
        ],
      };
      mockSendQueryDag.mockImplementation(async function* () {
        yield {
          type: 'result',
          isError: true,
          errors: ['Invalid API key'],
          errorSubtype: 'error_during_execution',
        };
      });
      await executeDagWorkflow(dagOptions({ deps, cwd: testDir, workflow, workflowRun }));
      const failedRow = store.persistWorkflowEvent.mock.calls
        .map(([event]) => event)
        .find(event => event.event_type === 'node_failed');
      expect(failedRow).toBeDefined();
      const original =
        failedRow && readNodeRecordEvent({ ...failedRow, data: failedRow.data })?.metadata;
      if (original === undefined) throw new Error('Expected typed failed execution');
      store.getDagResumeSnapshot.mockResolvedValue({
        completedNodeOutputs: new Map(),
        fanOutSnapshots: new Map(),
        failedNodes: new Map(),
        unresolvedNodeStarts: new Set(),
        budget: { workUnits: 0, spendUsd: 0 },
        costUsd: 0,
        unfinishedInvocations: new Map([[nodeInvocationKey('work', []), original]]),
      });
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'done' };
        yield { type: 'result' };
      });
      await executeDagWorkflow(
        dagOptions({ deps, cwd: testDir, workflow, workflowRun, priorCompletedNodes: new Map() })
      );
      const completed = store.persistWorkflowEvent.mock.calls
        .map(([event]) => event)
        .find(event => event.event_type === 'node_completed');
      expect(completed?.data?.invocation).toEqual(original.invocation);
      expect(completed?.data?.attempt).not.toEqual(original.attempt);
    });

    it('workflow fails after exhausting all node retries', async () => {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(async function* () {
        callCount++;
        yield {
          type: 'result',
          isError: true,
          errorSubtype: 'error_during_execution',
          errors: ['Claude Code crash: process exited with code 1'],
          failure: {
            class: 'transient',
            evidence: 'Claude Code crash: process exited with code 1',
          },
        };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('dag-retry-exhaust-run');

      const nodes: DagNode[] = [
        {
          id: 'my-node',
          kind: 'agent',
          source: { kind: 'command', name: 'my-cmd' },
          retry: { max_attempts: 2, delay_ms: 1 },
        },
      ];

      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId: 'conv-dag-retry-exhaust',
          cwd: testDir,
          workflow: { name: 'dag-retry-exhaust', nodes },
          workflowRun,
        })
      );

      // max_attempts: 2 = 2 retries → 3 total attempts (delay_ms: 1 keeps test fast)
      expect(callCount).toBe(3);
      expect(mockDeps.store.failWorkflowRun as ReturnType<typeof mock>).toHaveBeenCalled();
    });

    it('retries an AI node whose stream closed without yielding content — #2706', async () => {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(async function* () {
        callCount++;
        if (callCount === 1) {
          // Silent stream death: clean result chunk, zero assistant content.
          yield { type: 'result', sessionId: 'silent-death-sess' };
          return;
        }
        yield { type: 'agent_message_chunk', text: 'Second attempt produced output' };
        yield { type: 'result', sessionId: 'silent-recovery-sess' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('dag-silent-stream-run');

      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId: 'conv-dag-silent-stream',
          cwd: testDir,
          workflow: {
            name: 'dag-silent-stream',
            nodes: [
              {
                id: 'my-node',
                kind: 'agent',
                source: { kind: 'command', name: 'my-cmd' },
                retry: { max_attempts: 1, delay_ms: 1 },
              },
            ],
          },
          workflowRun,
        })
      );

      expect(callCount).toBe(2);
      expect(mockDeps.store.failWorkflowRun as ReturnType<typeof mock>).not.toHaveBeenCalled();
    });

    it('sends retry notification to platform before each delay', async () => {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(async function* () {
        callCount++;
        if (callCount === 1) {
          yield {
            type: 'result',
            isError: true,
            errorSubtype: 'error_during_execution',
            errors: ['Claude Code crash: process exited with code 1'],
            failure: {
              class: 'transient',
              evidence: 'Claude Code crash: process exited with code 1',
            },
          };
          return;
        }
        yield { type: 'agent_message_chunk', text: 'OK' };
        yield { type: 'result', sessionId: 'ok-sess' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('dag-retry-notify-run');

      const nodes: DagNode[] = [
        {
          id: 'my-node',
          kind: 'agent',
          source: { kind: 'command', name: 'my-cmd' },
          retry: { max_attempts: 2, delay_ms: 1 },
        },
      ];

      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId: 'conv-dag-retry-notify',
          cwd: testDir,
          workflow: { name: 'dag-retry-notify', nodes },
          workflowRun,
        })
      );

      const sendCalls = (platform.sendMessage as ReturnType<typeof mock>).mock.calls;
      const retryMessages = sendCalls.filter(
        (call: unknown[]) =>
          typeof call[1] === 'string' && (call[1] as string).includes('transient error')
      );
      expect(retryMessages.length).toBeGreaterThan(0);
    });

    // A provider that classified its own failure reports it as `failure` on the result. Its
    // class alone decides retry; the `errors` text is never read for it (#3520).
    async function attemptsForTypedFailure(
      failure: ProviderFailure,
      errors: string[] = [failure.evidence],
      onError?: 'transient' | 'all'
    ): Promise<{
      calls: number;
      failedKinds: unknown[];
      failedErrors: unknown[];
      runFailed: boolean;
    }> {
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 1)) as typeof setTimeout;
      try {
        let calls = 0;
        mockSendQueryDag.mockImplementation(async function* () {
          calls++;
          if (calls === 1) {
            yield {
              type: 'result',
              isError: true,
              errorSubtype: 'error_during_execution',
              errors,
              failure,
            };
            return;
          }
          yield { type: 'agent_message_chunk', text: 'Recovered' };
          yield { type: 'result', sessionId: 'typed-recovered' };
        });
        const store = createMockStore();
        const mockDeps = createMockDeps(store);
        await executeDagWorkflow(
          dagOptions({
            deps: mockDeps,
            platform: createMockPlatform(),
            cwd: testDir,
            workflow: {
              name: 'dag-typed-failure',
              nodes: [
                {
                  id: 'my-node',
                  kind: 'agent',
                  source: { kind: 'command', name: 'my-cmd' },
                  retry: {
                    max_attempts: 1,
                    delay_ms: 1,
                    ...(onError ? { on_error: onError } : {}),
                  },
                },
              ],
            },
            workflowRun: makeWorkflowRun('dag-typed-failure-run'),
          })
        );
        const failedEvents = store.persistWorkflowEvent.mock.calls
          .map(([event]) => event)
          .filter(event => event.event_type === 'node_failed');
        return {
          calls,
          failedKinds: failedEvents.map(event => event.data?.failure_kind),
          failedErrors: failedEvents.map(event => event.data?.error),
          runFailed: store.failWorkflowRun.mock.calls.length > 0,
        };
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }
    }

    function assertRetryWaits(
      store: ReturnType<typeof createMockStore>,
      mode: string,
      isLoop: boolean,
      expectedCalls: number
    ): void {
      const events = store.createWorkflowEvent.mock.calls.map(([event]) => event);
      const waits = events.filter(event => event.event_type === 'node_retry_scheduled');
      expect(waits).toHaveLength(expectedCalls - 1);
      for (const [index, wait] of waits.entries()) {
        const capacity = mode === 'overloaded' || (mode === 'mixed' && index === 0);
        expect(wait.step_name).toBe('my-node');
        expect(wait.data).toMatchObject({
          nodeId: 'my-node',
          retry_class: capacity ? 'overloaded' : 'transient',
          retry_attempt: index + 1,
          max_retries: capacity ? 5 : 2,
          delay_ms: capacity ? [45000, 90000, 180000, 300000, 300000][index] : 3000 * 2 ** index,
        });
        expect(wait.data?.iteration).toBe(isLoop ? 1 : undefined);
      }
    }

    function assertFinalFailure(
      store: ReturnType<typeof createMockStore>,
      mode: string,
      calls: number
    ): void {
      const final = store.persistWorkflowEvent.mock.calls
        .map(([event]) => event)
        .filter(event => event.event_type === 'node_failed')
        .at(-1);
      const failureClass = mode === 'mixed' ? 'transient' : mode;
      expect(final?.data).toMatchObject({
        failure_kind: failureClass,
        provider_failure: {
          class: failureClass,
          evidence: `Selected model is at capacity: attempt ${String(calls)}`,
        },
        error: expect.stringContaining(`Selected model is at capacity: attempt ${String(calls)}`),
      });
    }

    it.each([
      ['capacity exhaustion', 'overloaded', 0, 6, true],
      ['capacity recovery', 'overloaded', 4, 5, false],
      ['transient exhaustion', 'transient', 0, 3, true],
      ['capacity then transient', 'mixed', 0, 3, true],
      ['unclassified capacity prose', 'unknown', 0, 1, true],
    ] as const)(
      '%s keeps its budget in nodes and loop iterations',
      async (_name, mode, recoverAt, expectedCalls, fails) => {
        const realSetTimeout = globalThis.setTimeout;
        const random = Math.random;
        globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 1)) as typeof setTimeout;
        Math.random = () => 0.5;
        try {
          for (const isLoop of [false, true]) {
            let calls = 0;
            mockSendQueryDag.mockImplementation(async function* () {
              calls++;
              if (recoverAt && calls > recoverAt) {
                yield { type: 'agent_message_chunk', text: '<promise>COMPLETE</promise>' };
                yield { type: 'result', sessionId: 'capacity-recovered' };
                return;
              }
              const failureClass =
                mode === 'mixed' ? (calls === 1 ? 'overloaded' : 'transient') : mode;
              const evidence = `Selected model is at capacity: attempt ${String(calls)}`;
              yield {
                type: 'result',
                isError: true,
                errors: [evidence],
                failure: { class: failureClass, evidence },
              };
            });
            const store = createMockStore();
            const node: DagNode = isLoop
              ? {
                  id: 'my-node',
                  kind: 'loop',
                  loop: {
                    prompt: 'Complete the task.',
                    until: 'COMPLETE',
                    max_iterations: 2,
                    fresh_context: false,
                  },
                }
              : {
                  id: 'my-node',
                  kind: 'agent',
                  source: { kind: 'command', name: 'my-cmd' },
                  ...(mode === 'overloaded' ? { retry: { max_attempts: 1, delay_ms: 1000 } } : {}),
                };
            await executeDagWorkflow(
              dagOptions({
                deps: createMockDeps(store),
                platform: createMockPlatform(),
                cwd: testDir,
                workflow: { name: 'capacity-retry', nodes: [node] },
                workflowRun: makeWorkflowRun(`capacity-${String(isLoop)}-${mode}`),
              })
            );
            expect(calls).toBe(expectedCalls);
            expect(store.failWorkflowRun.mock.calls.length > 0).toBe(fails);
            assertRetryWaits(store, mode, isLoop, expectedCalls);
            if (fails) assertFinalFailure(store, mode, calls);
          }
        } finally {
          globalThis.setTimeout = realSetTimeout;
          Math.random = random;
        }
      }
    );

    it.each(['cancelled', 'failed', 'completed', null, 'paused'] as const)(
      'capacity waits respect run status %s before another provider attempt',
      async stopStatus => {
        const realSetTimeout = globalThis.setTimeout;
        try {
          for (const isLoop of [false, true]) {
            let status: WorkflowRun['status'] | null = 'running';
            let waiting = false;
            const waitSlices: number[] = [];
            globalThis.setTimeout = ((fn: () => void, delay?: number) => {
              if (waiting) {
                waitSlices.push(delay ?? 0);
                return realSetTimeout(() => {
                  status = stopStatus;
                  fn();
                }, 1);
              }
              return realSetTimeout(fn, 1);
            }) as typeof setTimeout;
            let calls = 0;
            mockSendQueryDag.mockImplementation(async function* () {
              calls++;
              if (calls === 1) {
                yield {
                  type: 'result',
                  isError: true,
                  errors: ['opaque capacity evidence'],
                  failure: { class: 'overloaded', evidence: 'opaque capacity evidence' },
                };
              } else {
                yield { type: 'agent_message_chunk', text: '<promise>COMPLETE</promise>' };
                yield { type: 'result', sessionId: 'unexpected-retry' };
              }
            });
            const store = createMockStore();
            store.getWorkflowRunStatus.mockImplementation(async () => status);
            const createEvent = store.createWorkflowEvent;
            store.createWorkflowEvent = mock(async event => {
              await createEvent(event);
              if (event.event_type === 'node_retry_scheduled') waiting = true;
            });
            const node: DagNode = isLoop
              ? {
                  id: 'my-node',
                  kind: 'loop',
                  loop: {
                    prompt: 'Do work.',
                    until: 'COMPLETE',
                    max_iterations: 2,
                    fresh_context: false,
                  },
                }
              : { id: 'my-node', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } };
            await executeDagWorkflow(
              dagOptions({
                deps: createMockDeps(store),
                cwd: testDir,
                workflowRun: makeWorkflowRun('capacity-cancel-run'),
                workflow: { name: 'capacity-cancel', nodes: [node] },
              })
            );
            expect(calls).toBe(stopStatus === 'paused' ? 2 : 1);
            expect(waitSlices.length).toBeGreaterThan(0);
            if (stopStatus !== 'paused') expect(waitSlices).toHaveLength(1);
            expect(Math.max(...waitSlices)).toBeLessThanOrEqual(10_000);
            const completed = store.persistWorkflowEvent.mock.calls
              .map(([event]) => event)
              .filter(event => event.event_type === 'node_completed');
            expect(completed).toHaveLength(stopStatus === 'paused' ? 1 : 0);
            expect(store.completeWorkflowRun).not.toHaveBeenCalled();
            expect(store.failWorkflowRun).not.toHaveBeenCalled();
          }
        } finally {
          globalThis.setTimeout = realSetTimeout;
        }
      }
    );

    it('a failed status read during a capacity wait does not end the node', async () => {
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 1)) as typeof setTimeout;
      try {
        let calls = 0;
        mockSendQueryDag.mockImplementation(async function* () {
          calls++;
          if (calls === 1) {
            yield {
              type: 'result',
              isError: true,
              errors: ['opaque capacity evidence'],
              failure: { class: 'overloaded', evidence: 'opaque capacity evidence' },
            };
          } else {
            yield { type: 'agent_message_chunk', text: 'recovered' };
            yield { type: 'result', sessionId: 'after-capacity' };
          }
        });
        const store = createMockStore();
        let waiting = false;
        store.getWorkflowRunStatus.mockImplementation(async () => {
          if (waiting) {
            waiting = false;
            throw new Error('database is locked');
          }
          return 'running';
        });
        const createEvent = store.createWorkflowEvent;
        store.createWorkflowEvent = mock(async event => {
          await createEvent(event);
          if (event.event_type === 'node_retry_scheduled') waiting = true;
        });
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            platform: createMockPlatform(),
            cwd: testDir,
            workflowRun: makeWorkflowRun('capacity-status-error-run'),
            workflow: {
              name: 'capacity-status-error',
              nodes: [
                { id: 'my-node', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } },
              ],
            },
          })
        );
        expect(calls).toBe(2);
        expect(store.failWorkflowRun).not.toHaveBeenCalled();
        expect(store.completeWorkflowRun).toHaveBeenCalled();
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }
    });

    it('retries a typed transient failure whose text reads as fatal — #3520', async () => {
      const result = await attemptsForTypedFailure({
        class: 'transient',
        evidence: 'upstream proxy returned 401 unauthorized while the backend restarted',
      });
      expect(result.calls).toBe(2);
      expect(result.failedKinds).toEqual(['transient']);
      expect(result.runFailed).toBe(false);
    });

    it.each([
      'upstream proxy returned 401 unauthorized while the backend restarted',
      'connection reset by peer (econnreset)',
      'the provider reported a problem',
    ])('a typed class decides retry whatever the text says: %s — #3520', async evidence => {
      // Transient retries once and recovers; auth never retries; neither depends on the text.
      expect((await attemptsForTypedFailure({ class: 'transient', evidence })).calls).toBe(2);
      const auth = await attemptsForTypedFailure({ class: 'auth', evidence });
      expect(auth.calls).toBe(1);
      expect(auth.failedKinds).toEqual(['fatal']);
    });

    it.each([undefined, 'transient', 'all'] as const)(
      'a misconfigured failure is never retried, on_error: %s — #3566',
      async onError => {
        const evidence = 'proxy_invalid: HTTPS_PROXY is not a complete URL';
        const result = await attemptsForTypedFailure(
          { class: 'misconfigured', evidence },
          [evidence],
          onError
        );
        expect(result.calls).toBe(1);
        expect(result.failedKinds).toEqual(['fatal']);
        expect(result.failedErrors).toEqual([
          expect.stringContaining("the provider's configuration must be fixed"),
        ]);
        expect(result.runFailed).toBe(true);
        // The same harness does retry an unclassified failure when on_error allows it.
        const unknown = await attemptsForTypedFailure(
          { class: 'unknown', evidence },
          [evidence],
          onError
        );
        expect(unknown.calls).toBe(onError === 'all' ? 2 : 1);
        expect(unknown.failedErrors).not.toContainEqual(
          expect.stringContaining("the provider's configuration must be fixed")
        );
      }
    );

    it(
      'a typed rate limit earns the widened budget without rate-limit wording — #3520',
      async () => {
        const realSetTimeout = globalThis.setTimeout;
        globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 1)) as typeof setTimeout;
        try {
          let calls = 0;
          mockSendQueryDag.mockImplementation(async function* () {
            calls++;
            yield {
              type: 'result',
              isError: true,
              errorSubtype: 'error_during_execution',
              errors: ['request refused'],
              failure: { class: 'rate_limited', evidence: 'request refused' },
            };
          });
          const store = createMockStore();
          await executeDagWorkflow(
            dagOptions({
              deps: createMockDeps(store),
              platform: createMockPlatform(),
              cwd: testDir,
              workflow: {
                name: 'dag-typed-rate-limit',
                nodes: [
                  {
                    id: 'my-node',
                    kind: 'agent',
                    source: { kind: 'command', name: 'my-cmd' },
                    retry: { max_attempts: 1, delay_ms: 1 },
                  },
                ],
              },
              workflowRun: makeWorkflowRun('dag-typed-rate-limit-run'),
            })
          );
          expect(calls).toBe(1 + RATE_LIMIT_MAX_RETRIES);
        } finally {
          globalThis.setTimeout = realSetTimeout;
        }
      },
      testTimeout(10_000)
    );
  });
}
