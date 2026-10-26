import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import type { SendQueryOptions } from '@archon/provider-contract';
import { type ProviderEvent } from '@archon/provider-contract';
import {
  createMockDeps,
  createMockPlatform,
  createMockStore,
  dagOptions,
  makeWorkflowRun,
  minimalConfig,
  mockClaudeCapabilities,
  mockGetAgentProviderDag,
  mockLogFn,
  mockSendQueryDag,
  node,
  persistedEvents,
  readTranscript,
  ready,
  runUsageWrites,
} from '../../../test-utils';
import { executeDagWorkflow } from '../../../../dag-executor';
import { readNodeArtifacts } from '../../../../artifacts-index';
import {
  providerEventEnvelopeSchema,
  providerEventLineSchema,
} from '../../../../schemas/provider-event';
import { getWorkflowEventEmitter, type WorkflowEmitterEvent } from '../../../../event-emitter';
import type { DagNode, WorkflowDefinition } from '../../../../schemas';
import { dagNodeSchema } from '../../../../schemas';
import { expandWorkflowIncludes } from '../../../../include-expander';
import type { IWorkflowStore } from '../../../../store';

export function registerProviderEventsTests() {
  describe('executeDagWorkflow -- provider event recording', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(
        tmpdir(),
        `dag-toolcomplete-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      const commandsDir = join(testDir, '.archon', 'commands');
      await mkdir(commandsDir, { recursive: true });
      await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt for $USER_MESSAGE');

      mockSendQueryDag.mockClear();
      mockGetAgentProviderDag.mockClear();
      mockGetAgentProviderDag.mockImplementation(() => ({
        sendQuery: mockSendQueryDag,
        checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
        getType: () => 'claude',
        getCapabilities: mockClaudeCapabilities,
      }));
    });

    afterEach(async () => {
      await removeTempTree(testDir);
    });

    it('records every provider event unchanged in the store, the JSONL log and the emitter', async () => {
      const mockStore = createMockStore();
      const workflowRun = makeWorkflowRun();
      const yielded: ProviderEvent[] = [
        { type: 'agent_thought_chunk', text: 'thinking' },
        { type: 'tool_call', toolCallId: 'id-a', name: 'read_file', rawInput: { path: '/a' } },
        { type: 'tool_call', toolCallId: 'id-b', name: 'Bash', title: 'ls' },
        { type: 'tool_call_update', toolCallId: 'id-a', status: 'completed', output: 'contents' },
        {
          type: 'tool_call_update',
          toolCallId: 'id-b',
          status: 'failed',
          output: 'x'.repeat(16_384),
          outputTruncated: true,
          exitCode: 2,
        },
        { type: 'warning', code: 'claude.test', message: 'careful' },
        { type: 'mcp_server_status', server: 'github', status: 'connected' },
        {
          type: 'compaction',
          phase: 'completed',
          trigger: 'auto',
          tokensBefore: 9,
          tokensAfter: 3,
        },
        { type: 'subtask', taskId: 't-1', status: 'started', description: 'look' },
        { type: 'subtask', taskId: 't-1', status: 'completed', summary: 'found' },
        {
          type: 'hook',
          hookId: 'h-1',
          hookName: 'PreToolUse',
          hookEvent: 'PreToolUse',
          status: 'succeeded',
        },
        { type: 'state_update', state: 'running' },
        { type: 'agent_message_chunk', text: 'done' },
      ];
      mockSendQueryDag.mockImplementation(async function* () {
        yield* yielded;
        yield { type: 'result', sessionId: 'dag-sess-envelope' };
      });
      const emitted: WorkflowEmitterEvent[] = [];
      const unsubscribe = getWorkflowEventEmitter().subscribe(event => {
        if (event.type === 'provider_event') emitted.push(event);
      });

      try {
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(mockStore),
            cwd: testDir,
            workflow: { name: 'dag-envelope-test', nodes: [node('my-cmd')] },
            workflowRun,
          })
        );
      } finally {
        unsubscribe();
      }

      const transcript = await readTranscript(join(testDir, 'logs'), workflowRun.id);
      const nodeStart = transcript.find(line => line.type === 'node_start');
      const attemptId = (nodeStart?.execution as { attempt?: { id?: string } } | undefined)?.attempt
        ?.id;
      expect(typeof attemptId).toBe('string');
      const rows = persistedEvents(mockStore).filter(e => e.event_type === 'provider_event');
      const lines = transcript.filter(line => line.type === 'provider_event');
      expect(rows.map(row => row.data?.event)).toEqual(yielded);
      expect(lines.map(line => line.event)).toEqual(yielded);
      expect(emitted.map(event => (event.type === 'provider_event' ? event.event : null))).toEqual(
        yielded
      );
      // The envelope names the node and the attempt, and numbers the attempt's events from 0.
      for (const [index, row] of rows.entries()) {
        expect(row.step_name).toBe('my-cmd');
        expect(providerEventEnvelopeSchema.parse(row.data)).toMatchObject({
          attemptId,
          seq: index,
        });
        expect(providerEventLineSchema.parse(lines[index])).toEqual({
          type: 'provider_event',
          workflow_id: workflowRun.id,
          ts: expect.any(String),
          step: 'my-cmd',
          ...providerEventEnvelopeSchema.parse(row.data),
        });
      }
      // The old line types are gone: the log has one shape for provider activity.
      expect(transcript.filter(line => line.type === 'assistant' || line.type === 'tool')).toEqual(
        []
      );
    });

    it('numbers a reask pass on from the first pass of the same attempt', async () => {
      const mockStore = createMockStore();
      const workflowRun = makeWorkflowRun();
      let pass = 0;
      mockSendQueryDag.mockImplementation(async function* () {
        pass += 1;
        yield { type: 'agent_message_chunk', text: `pass ${String(pass)}` };
        yield {
          type: 'result',
          sessionId: `dag-sess-reask-${String(pass)}`,
          structuredOutput: pass === 1 ? { note: 'bad' } : { ok: true },
        };
      });

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(mockStore),
          cwd: testDir,
          workflowProvider: 'pi',
          config: { ...minimalConfig, assistant: 'pi' },
          workflow: {
            name: 'dag-reask-seq',
            nodes: [
              {
                ...node('my-cmd'),
                provider: 'pi',
                output_format: {
                  type: 'object',
                  properties: { ok: { type: 'boolean' } },
                  required: ['ok'],
                },
              },
            ],
          },
          workflowRun,
        })
      );

      expect(pass).toBe(2);
      const envelopes = persistedEvents(mockStore)
        .filter(e => e.event_type === 'provider_event')
        .map(e => providerEventEnvelopeSchema.parse(e.data));
      expect(envelopes.map(e => e.seq)).toEqual([0, 1]);
      expect(new Set(envelopes.map(e => e.attemptId)).size).toBe(1);
    });

    it('records no tool event when no tools were called in DAG node', async () => {
      const mockStore = createMockStore();
      const mockDeps = createMockDeps(mockStore);
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'DAG AI response' };
        yield { type: 'result', sessionId: 'dag-sess-3' };
      });

      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId: 'conv-dag-notools',
          cwd: testDir,
          workflow: { name: 'dag-notools-test', nodes: [node('my-cmd')] },
          workflowRun,
        })
      );

      const createEventCalls = (mockStore.createWorkflowEvent as ReturnType<typeof mock>).mock
        .calls as Array<[{ event_type: string; data?: Record<string, unknown> }]>;
      const toolEvents = createEventCalls.filter(
        ([arg]) =>
          arg.event_type === 'provider_event' &&
          (arg.data?.event as { type?: string } | undefined)?.type?.startsWith('tool_call')
      );

      expect(toolEvents.length).toBe(0);
    });
  });
}

export function registerCostTests() {
  describe('executeDagWorkflow -- cost tracking', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(
        tmpdir(),
        `dag-cost-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      const commandsDir = join(testDir, '.archon', 'commands');
      await mkdir(commandsDir, { recursive: true });
      await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt');

      mockSendQueryDag.mockClear();
      mockGetAgentProviderDag.mockClear();
      mockLogFn.mockClear();

      mockGetAgentProviderDag.mockImplementation(() => ({
        sendQuery: mockSendQueryDag,
        checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
        getType: () => 'claude',
        getCapabilities: mockClaudeCapabilities,
      }));
    });

    afterEach(async () => {
      await removeTempTree(testDir);
    });

    it('persists total_cost_usd on the run row when a node yields cost', async () => {
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'done' };
        yield { type: 'result', sessionId: 'sid-cost', cost: 0.0042 };
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
            name: 'dag-cost',
            nodes: [{ id: 'step', kind: 'agent', source: { kind: 'inline', prompt: 'Do thing.' } }],
          },
          workflowRun,
        })
      );

      expect(runUsageWrites(store)).toEqual([{ total_cost_usd: 0.0042 }]);
      // Exactly one writer: completeWorkflowRun keeps node_counts, not usage (#2469).
      const completeCalls = (
        store.completeWorkflowRun as Mock<IWorkflowStore['completeWorkflowRun']>
      ).mock.calls;
      expect(completeCalls.length).toBe(1);
      expect(completeCalls[0][2]).toEqual({
        node_counts: { completed: 1, failed: 0, skipped: 0, total: 1 },
      });
    });

    it('sums total_cost_usd across multiple sequential nodes', async () => {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(async function* () {
        callCount++;
        yield { type: 'agent_message_chunk', text: `Step ${String(callCount)} output` };
        yield { type: 'result', sessionId: `sid-${String(callCount)}`, cost: 0.001 };
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
            name: 'dag-cost-multi',
            nodes: [
              { id: 'step1', kind: 'agent', source: { kind: 'inline', prompt: 'Step 1.' } },
              {
                id: 'step2',
                kind: 'agent',
                source: { kind: 'inline', prompt: 'Step 2.' },
                depends_on: ['step1'],
              },
            ],
          },
          workflowRun,
        })
      );

      expect(runUsageWrites(store)).toEqual([{ total_cost_usd: 0.002 }]);
    });

    it('writes no usage metadata at all when no node yielded cost or tokens', async () => {
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'Some output' };
        yield { type: 'result', sessionId: 'sid-no-cost' };
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
            name: 'dag-no-cost',
            nodes: [{ id: 'step', kind: 'agent', source: { kind: 'inline', prompt: 'Do thing.' } }],
          },
          workflowRun,
        })
      );

      // A zero must stay ABSENT, not written as 0 — a bash-only workflow reading as a
      // free AI run is the misleading shape the `> 0` guards exist to prevent.
      expect(runUsageWrites(store)).toEqual([]);
      const completeCalls = (
        store.completeWorkflowRun as Mock<IWorkflowStore['completeWorkflowRun']>
      ).mock.calls;
      expect(completeCalls.length).toBe(1);
      expect(completeCalls[0][2]).not.toHaveProperty('total_cost_usd');
    });

    it('accumulates finite loop costs and ignores a later non-finite cost', async () => {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(async function* () {
        callCount++;
        if (callCount < 4) {
          yield { type: 'agent_message_chunk', text: 'Still working...' };
          yield {
            type: 'result',
            sessionId: `loop-sid-${String(callCount)}`,
            cost: callCount < 3 ? 0.001 : 0.002,
          };
        } else {
          yield { type: 'agent_message_chunk', text: 'All done! <promise>COMPLETE</promise>' };
          yield {
            type: 'result',
            sessionId: `loop-sid-${String(callCount)}`,
            cost: Number.NaN,
          };
        }
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
            name: 'dag-loop-cost',
            nodes: [
              {
                id: 'my-loop',
                kind: 'loop',
                loop: {
                  fresh_context: false,
                  prompt: 'Work.',
                  until: 'COMPLETE',
                  max_iterations: 5,
                },
              },
            ],
          },
          workflowRun,
        })
      );

      // The final NaN is omitted without erasing the first three iterations.
      expect(runUsageWrites(store)).toEqual([{ total_cost_usd: 0.004 }]);
      expect(
        (mockLogFn as unknown as Mock<(obj: unknown, msg?: string) => void>).mock.calls.some(
          call => call[1] === 'loop_node.usage_cost_non_finite_ignored'
        )
      ).toBe(true);

      // The loop's own terminal row carries the cumulative total once, and its
      // per-iteration rows carry duration only (#3508). Nothing on the path restates
      // the total, so a reader summing the transcript lands on the run total.
      const rows = await readTranscript(join(testDir, 'logs'), workflowRun.id);
      const terminal = rows.find(row => row.type === 'node_complete' && row.step === 'my-loop');
      expect(terminal?.cost_usd).toBeCloseTo(0.004, 10);
      const iterationRows = rows.filter(
        row =>
          row.type === 'node_complete' &&
          typeof row.step === 'string' &&
          row.step.startsWith('my-loop-iteration-')
      );
      expect(iterationRows.length).toBe(4);
      for (const row of iterationRows) expect(row).not.toHaveProperty('cost_usd');
    });
  });
}

export function registerSessionRecordTests() {
  describe('executeDagWorkflow -- provider session ids stay on the node record', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(
        tmpdir(),
        `dag-session-ids-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      await mkdir(testDir, { recursive: true });
      mockSendQueryDag.mockClear();
    });

    afterEach(async () => {
      await removeTempTree(testDir);
    });

    it('records each attempt and iteration id durably and nowhere in the stream', async () => {
      const failedAttempt = 'a1111111-0000-4000-8000-000000000001';
      const completedAttempt = 'b2222222-0000-4000-8000-000000000002';
      const iterations = [
        'c3333333-0000-4000-8000-000000000003',
        'd4444444-0000-4000-8000-000000000004',
        'e5555555-0000-4000-8000-000000000005',
      ];
      let calls = 0;
      mockSendQueryDag.mockImplementation(async function* () {
        calls++;
        if (calls === 1) {
          yield {
            type: 'result',
            sessionId: failedAttempt,
            isError: true,
            errors: ['upstream overloaded'],
            failure: { class: 'transient', evidence: 'upstream overloaded' },
          };
          return;
        }
        if (calls === 2) {
          yield { type: 'agent_message_chunk', text: 'planned' };
          yield { type: 'result', sessionId: completedAttempt };
          return;
        }
        const iteration = calls - 2;
        yield { type: 'agent_message_chunk', text: iteration === 3 ? 'DONE' : 'working' };
        yield { type: 'result', sessionId: iterations[iteration - 1] };
      });
      const emitted: WorkflowEmitterEvent[] = [];
      const unsubscribe = getWorkflowEventEmitter().subscribe(event => {
        emitted.push(event);
      });
      const store = createMockStore();
      const workflowRun = makeWorkflowRun('session-ids-run');
      try {
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            cwd: testDir,
            workflow: {
              name: 'session-ids',
              nodes: [
                {
                  id: 'plan',
                  kind: 'agent',
                  source: { kind: 'inline', prompt: 'plan it' },
                  output_type: 'plan',
                  retry: { max_attempts: 1, delay_ms: 1 },
                },
                {
                  id: 'work',
                  kind: 'loop',
                  depends_on: ['plan'],
                  output_type: 'work',
                  loop: { prompt: 'work', until: 'DONE', max_iterations: 5, fresh_context: true },
                },
              ],
            },
            workflowRun,
          })
        );
      } finally {
        unsubscribe();
      }
      expect(store.completeWorkflowRun).toHaveBeenCalled();

      const rows = persistedEvents(store);
      const sessionIdsOf = (eventType: string, step: string): unknown[] =>
        rows
          .filter(row => row.event_type === eventType && row.step_name === step)
          .map(row => row.data?.session_id);
      expect(sessionIdsOf('node_failed', 'plan')).toEqual([failedAttempt]);
      expect(sessionIdsOf('node_completed', 'plan')).toEqual([completedAttempt]);
      expect(sessionIdsOf('loop_iteration_completed', 'work')).toEqual(iterations);
      expect(sessionIdsOf('node_completed', 'work')).toEqual([iterations[2]]);

      const allIds = [failedAttempt, completedAttempt, ...iterations];
      const transcript = await readFile(join(testDir, 'logs', `${workflowRun.id}.jsonl`), 'utf8');
      const stream = JSON.stringify(emitted);
      const { artifactsByType } = await readNodeArtifacts(join(testDir, 'artifacts'), {
        scope: 'current-run',
        runId: workflowRun.id,
      });
      expect(Object.keys(artifactsByType).sort()).toEqual(['plan', 'work']);
      const artifactIndex = JSON.stringify(artifactsByType);
      for (const id of allIds) {
        expect(transcript).not.toContain(id);
        expect(stream).not.toContain(id);
        expect(artifactIndex).not.toContain(id);
      }
      // The preview still reaches the stream.
      expect(stream).toContain(completedAttempt.slice(0, 8));
    });

    it("an iteration retried after a failed attempt records only the successful attempt's session", async () => {
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 1)) as typeof setTimeout;
      let calls = 0;
      mockSendQueryDag.mockImplementation(async function* () {
        calls++;
        if (calls === 2) {
          // Iteration 2, attempt 1: names a session, then fails transiently.
          yield {
            type: 'result',
            sessionId: 'failed-attempt-session',
            isError: true,
            errors: ['upstream overloaded'],
            failure: { class: 'transient', evidence: 'upstream overloaded' },
          };
          return;
        }
        yield { type: 'agent_message_chunk', text: calls === 4 ? 'DONE' : 'working' };
        // Iteration 2's successful retry (call 3) reports no session.
        yield calls === 3
          ? { type: 'result' }
          : { type: 'result', sessionId: `iteration-session-${String(calls)}` };
      });
      const store = createMockStore();
      try {
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            cwd: testDir,
            workflow: {
              name: 'iteration-retry-session',
              nodes: [
                {
                  id: 'work',
                  kind: 'loop',
                  loop: { prompt: 'work', until: 'DONE', max_iterations: 5, fresh_context: true },
                },
              ],
            },
            workflowRun: makeWorkflowRun('iteration-retry-session-run'),
          })
        );
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }
      expect(store.completeWorkflowRun).toHaveBeenCalled();
      expect(
        persistedEvents(store)
          .filter(row => row.event_type === 'loop_iteration_completed')
          .map(row => row.data?.session_id)
      ).toEqual(['iteration-session-1', undefined, 'iteration-session-4']);
    });
  });
}

export function registerRuntimeSubstitutionTests() {
  describe('executeDagWorkflow -- systemPrompt and agents are runtime substitution surfaces', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(tmpdir(), `dag-aicfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(testDir, { recursive: true });
      mockSendQueryDag.mockClear();
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'response' };
        yield { type: 'result', sessionId: 'session-1' };
      });
    });

    afterEach(async () => {
      await removeTempTree(testDir);
    });

    async function runNodes(
      nodes: unknown[],
      run = makeWorkflowRun('aicfg-run')
    ): Promise<SendQueryOptions[]> {
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          cwd: testDir,
          workflow: { name: 'aicfg', nodes: nodes.map(n => dagNodeSchema.parse(n) as DagNode) },
          workflowRun: run,
        })
      );
      return mockSendQueryDag.mock.calls.map(call => {
        const options = call[3];
        if (!options) throw new Error('Expected provider query options');
        return options;
      });
    }

    it('AC15 — all three surfaces resolve workflow variables and $node.output refs', async () => {
      const options = await runNodes([
        { id: 'produce', bash: 'printf "%s" "UPSTREAM"' },
        {
          id: 'use',
          prompt: 'go',
          depends_on: ['produce'],
          systemPrompt: 'artifacts=$ARTIFACTS_DIR upstream=$produce.output',
          agents: {
            helper: {
              description: 'handles $produce.output',
              prompt: 'work on $produce.output in $ARTIFACTS_DIR',
            },
          },
        },
      ]);

      const artifacts = join(testDir, 'artifacts');
      const last = options.at(-1)!;
      expect(last.systemPrompt).toBe(`artifacts=${artifacts} upstream=UPSTREAM`);
      expect(last.nodeConfig?.agents?.helper?.description).toBe('handles UPSTREAM');
      expect(last.nodeConfig?.agents?.helper?.prompt).toBe(`work on UPSTREAM in ${artifacts}`);
    });

    it('AC15 — the node definition is not mutated, so a second pass is not double-substituted', async () => {
      const definition = dagNodeSchema.parse({
        id: 'use',
        prompt: 'go',
        systemPrompt: 'dir=$ARTIFACTS_DIR',
      }) as DagNode;
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          cwd: testDir,
          workflow: { name: 'aicfg2', nodes: [definition] },
          workflowRun: makeWorkflowRun('aicfg-run-2'),
        })
      );
      expect(definition.systemPrompt).toBe('dir=$ARTIFACTS_DIR');
    });

    it('AC15 — $INPUTS in a systemPrompt produces the same text standalone as composed', async () => {
      const block: WorkflowDefinition = {
        name: 'sp-blk',
        description: 'sp-blk',
        inputs: { mode: { default: 'strict' } },
        nodes: [
          dagNodeSchema.parse({ id: 'work', prompt: 'go', systemPrompt: 'mode=$INPUTS.mode' }),
        ],
      };
      const parent: WorkflowDefinition = {
        name: 'sp-parent',
        description: 'sp-parent',
        nodes: [dagNodeSchema.parse({ id: 'inc', include: 'sp-blk' })],
      };

      // Standalone: `$INPUTS.mode` resolves at RUN time from the run's own declared inputs.
      const standalone = await runNodes(
        [{ id: 'work', prompt: 'go', systemPrompt: 'mode=$INPUTS.mode' }],
        makeWorkflowRun('sp-standalone', { metadata: { inputs: { mode: 'strict' } } })
      );
      expect(standalone.at(-1)!.systemPrompt).toBe('mode=strict');

      // Composed: the same text, resolved at LOAD time by the include macro.
      mockSendQueryDag.mockClear();
      const { workflows, errors } = expandWorkflowIncludes(
        new Map([
          ['sp-blk', block],
          ['sp-parent', parent],
        ])
      );
      expect(errors).toEqual([]);
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          cwd: testDir,
          workflow: ready(workflows.get('sp-parent')!),
          workflowRun: makeWorkflowRun('sp-composed'),
        })
      );
      expect(mockSendQueryDag.mock.calls.at(-1)?.[3]?.systemPrompt).toBe('mode=strict');
    });
  });
}
