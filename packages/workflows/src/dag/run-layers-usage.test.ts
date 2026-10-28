// @archon-test-isolated
import { foldDagResumeSnapshot } from '../dag-resume-snapshot';
import { inspectResumableRun } from '../run-resume';
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createMockStore,
  runUsageWrites,
  mockClaudeCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  persistedEvents,
  dagOptions,
  makeWorkflowRun,
  readTranscript,
} from './test-utils';
import { executeDagWorkflow } from '../dag-executor';
import type { DagNode } from '../schemas';
import type { PersistedNodeOutput } from '../store';

describe('executeDagWorkflow -- resumed and fresh node usage', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-resume-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
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

  it('seeds a resumed run with prior usage and accumulates the resumed pass', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('resume-token-reconciliation');
    const workflow = {
      name: 'resume-token-reconciliation',
      nodes: [
        { id: 'step1', kind: 'agent', source: { kind: 'command', name: 'step1' } },
        {
          id: 'step2',
          kind: 'agent',
          source: { kind: 'command', name: 'step2' },
          depends_on: ['step1'],
          // Empty-output failures are transient-retried (#2706); keep this test on
          // its failure-semantics assertions rather than the default retry wait.
          retry: { max_attempts: 1, delay_ms: 1 },
        },
      ] as DagNode[],
    };

    let firstInvocationCall = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      firstInvocationCall++;
      if (firstInvocationCall === 1) {
        yield { type: 'agent_message_chunk', text: 'first execution output' };
        yield {
          type: 'result',
          sessionId: 'first-execution-session',
          cost: 0.02,
          tokens: { input: 40, output: 4 },
        };
        return;
      }
      // A result without assistant output fails step2 after step1 has persisted
      // its node_completed event.
      yield { type: 'result', sessionId: 'failed-step-session' };
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-resume-tokens',
        cwd: testDir,
        workflow,
        workflowRun,
      })
    );

    expect(store.failWorkflowRun).toHaveBeenCalled();
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();

    // #2469 (AC1): the run FAILED, and it still recorded what step1 burned before
    // step2 died. Before the fix this run's row carried nothing but { error }.
    expect(runUsageWrites(store)).toEqual([
      { total_cost_usd: 0.02, total_tokens_in: 40, total_tokens_out: 4 },
    ]);
    (store.updateWorkflowRun as ReturnType<typeof mock>).mockClear();

    // The resume snapshot is the store's to build (covered in core's workflow-events
    // tests); here it is fixed data matching what pass 1 persisted.
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['step1', { output: 'first execution output' }],
    ]);
    const priorUsage = { tokens: { input: 40, output: 4 }, costUsd: 0.02 };

    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'resumed execution output' };
      yield {
        type: 'result',
        sessionId: 'resumed-execution-session',
        cost: 0.03,
        tokens: { input: 60, output: 6 },
      };
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-resume-tokens',
        cwd: testDir,
        workflow,
        workflowRun,
        priorCompletedNodes,
        priorUsage,
      })
    );

    // #2469 (AC4): the resumed run reports pass 1 + pass 2 on BOTH axes. Cost used to
    // reset to 0 on every pass, so a run that failed at 0.02 and then completed would
    // have reported 0.03 — a figure that goes DOWN.
    expect(runUsageWrites(store)).toEqual([
      { total_cost_usd: 0.05, total_tokens_in: 100, total_tokens_out: 10 },
    ]);

    // Usage has exactly one writer now; completeWorkflowRun carries only node_counts.
    const completionCalls = (store.completeWorkflowRun as ReturnType<typeof mock>).mock.calls;
    expect(completionCalls).toHaveLength(1);
    expect(completionCalls[0]?.[1]).not.toHaveProperty('total_tokens_in');
    expect(completionCalls[0]?.[1]).not.toHaveProperty('total_cost_usd');

    const completedEvents = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls
      .map(
        (call: unknown[]) =>
          call[0] as {
            event_type: string;
            data?: { tokens?: { input: number; output: number } };
          }
      )
      .filter(event => event.event_type === 'node_completed' && event.data?.tokens !== undefined);
    const eventTokenTotal = completedEvents.reduce(
      (total, event) => ({
        input: total.input + (event.data?.tokens?.input ?? 0),
        output: total.output + (event.data?.tokens?.output ?? 0),
      }),
      { input: 0, output: 0 }
    );
    expect(eventTokenTotal).toEqual({ input: 100, output: 10 });
  });

  it('keeps a cold-resumed run token total unknown when a prior node could not count', async () => {
    const store = createMockStore();
    const deps = createMockDeps(store);
    const workflowRun = makeWorkflowRun('resume-unknown-tokens');
    const workflow = {
      name: 'resume-unknown-tokens',
      nodes: [
        { id: 'step1', kind: 'agent', source: { kind: 'inline', prompt: 'One.' } },
        {
          id: 'step2',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'Two.' },
          depends_on: ['step1'],
          retry: { max_attempts: 1, delay_ms: 1 },
        },
      ] as DagNode[],
    };
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      if (calls === 1) {
        yield { type: 'agent_message_chunk', text: 'first output' };
        yield { type: 'result', sessionId: 's1', cost: 0.1, tokensUnknown: true };
      } else {
        // No assistant output fails step2 after step1's row is durable.
        yield { type: 'result', sessionId: 's2' };
      }
    });
    await executeDagWorkflow(dagOptions({ deps, cwd: testDir, workflow, workflowRun }));
    expect(store.failWorkflowRun).toHaveBeenCalled();

    // Cold resume reads the persisted rows through the same handoff the executor uses.
    const rows = persistedEvents(store);
    store.getDagResumeSnapshot.mockImplementation(async id => foldDagResumeSnapshot(rows, id));
    const inspection = await inspectResumableRun(deps, workflowRun);
    if (!inspection) throw new Error('Expected the failed run to be resumable');
    (store.updateWorkflowRun as ReturnType<typeof mock>).mockClear();

    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'second output' };
      yield {
        type: 'result',
        sessionId: 's3',
        cost: 0.2,
        tokens: { input: 170, output: 20, cacheRead: 30, cacheWrite: 40 },
      };
    });
    await executeDagWorkflow(
      dagOptions({
        deps,
        cwd: testDir,
        workflow,
        workflowRun,
        priorCompletedNodes: inspection.priorCompletedNodes,
        priorUsage: inspection.priorUsage,
      })
    );

    expect(store.completeWorkflowRun).toHaveBeenCalled();
    const usage = runUsageWrites(store).at(-1);
    expect(usage?.total_cost_usd).toBeCloseTo(0.3);
    expect(usage?.total_tokens_unknown).toBe(true);
    expect(usage?.total_tokens_in).toBeNull();
    expect(usage?.total_tokens_out).toBeNull();
    expect(usage?.total_cache_read_tokens).toBeNull();
    expect(usage?.total_cache_write_tokens).toBeNull();
  });

  it.each(['node_completed', 'node_failed', 'node_deferred_usage'])(
    'persists unknown tokens after resuming malformed historical %s usage',
    async eventType => {
      const store = createMockStore();
      const deps = createMockDeps(store);
      const workflowRun = makeWorkflowRun('resume-malformed-tokens');
      const snapshot = await foldDagResumeSnapshot(
        [
          {
            step_name: 'historical',
            event_type: eventType,
            data: { tokens: { input: 100, output: 'unreadable' }, cost_usd: 0.1 },
          },
          {
            step_name: 'valid',
            event_type: 'node_completed',
            data: { tokens: { input: 7, output: 3 }, cost_usd: 0.2 },
          },
        ],
        workflowRun.id
      );
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'resumed output' };
        yield { type: 'result', sessionId: 'resumed', tokens: { input: 5, output: 2 }, cost: 0.3 };
      });
      await executeDagWorkflow(
        dagOptions({
          deps,
          cwd: testDir,
          workflowRun,
          workflow: {
            name: 'resume-malformed',
            nodes: [
              { id: 'fresh', kind: 'agent', source: { kind: 'inline', prompt: 'Continue.' } },
            ],
          },
          priorUsage: snapshot,
        })
      );
      expect(store.completeWorkflowRun).toHaveBeenCalled();
      const usage = runUsageWrites(store).at(-1);
      expect(usage?.total_cost_usd).toBeCloseTo(0.6);
      expect(usage?.total_tokens_unknown).toBe(true);
      expect(usage?.total_tokens_in).toBeNull();
      expect(usage?.total_tokens_out).toBeNull();
    }
  );

  it('stores node_output in node_completed event data for AI nodes', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('output-persist-run');

    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'the node output text' };
      yield {
        type: 'result',
        sessionId: 'sid',
        resolvedModel: { id: 'claude-opus-5' },
        tokens: { input: 100, output: 10, cacheRead: 80, cacheWrite: 0 },
      };
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-output',
        cwd: testDir,
        workflow: {
          name: 'single-node',
          nodes: [
            {
              id: 'step1',
              kind: 'agent',
              source: { kind: 'command', name: 'step1' },
              model: 'requested-model',
            },
          ],
        },
        workflowRun,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_completed' &&
        (call[0] as { step_name: string }).step_name === 'step1'
    );
    expect(completedEvent).toBeDefined();
    expect((completedEvent![0] as { data: { node_output: string } }).data.node_output).toBe(
      'the node output text'
    );
    expect(
      (completedEvent![0] as { data: { model_usage: { requested: string; resolved: string } } })
        .data.model_usage
    ).toEqual({ requested: 'requested-model', resolved: 'claude-opus-5' });
    expect(
      (
        completedEvent![0] as {
          data: {
            tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
          };
        }
      ).data.tokens
    ).toEqual({ input: 100, output: 10, cacheRead: 80, cacheWrite: 0 });
  });

  it('omits tokens from a direct AI node_completed event when the provider reports no usage', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'the node output text' };
      yield { type: 'result', sessionId: 'no-usage-sid' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        conversationId: 'conv-no-usage',
        cwd: testDir,
        workflow: {
          name: 'no-usage',
          nodes: [{ id: 'step1', kind: 'agent', source: { kind: 'command', name: 'step1' } }],
        },
        workflowRun: makeWorkflowRun('no-usage-run'),
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls as Array<
      [{ event_type: string; step_name: string; data?: Record<string, unknown> }]
    >;
    const completedEvent = eventCalls.find(
      ([event]) => event.event_type === 'node_completed' && event.step_name === 'step1'
    );
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.[0].data).not.toHaveProperty('tokens');
  });

  it('persists only {input, output} — provider-defined total/cost are not part of the shape', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'out' };
      // Pi/OpenCode shape: `total` folds in cache/reasoning tokens, so it is NOT
      // input + output. Persisting it would hand consumers a field they cannot
      // interpret without knowing the provider; `cost` duplicates cost_usd.
      yield {
        type: 'result',
        sessionId: 'shape-sid',
        tokens: { input: 100, output: 10, total: 900, cost: 0.5 },
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        conversationId: 'conv-shape',
        cwd: testDir,
        workflow: {
          name: 'token-shape',
          nodes: [{ id: 'step1', kind: 'agent', source: { kind: 'command', name: 'step1' } }],
        },
        workflowRun: makeWorkflowRun('token-shape-run'),
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls as Array<
      [{ event_type: string; step_name: string; data?: Record<string, unknown> }]
    >;
    const completedEvent = eventCalls.find(
      ([event]) => event.event_type === 'node_completed' && event.step_name === 'step1'
    );
    expect(completedEvent?.[0].data?.tokens).toEqual({ input: 100, output: 10 });
  });

  it('drops non-finite provider token counts instead of persisting them', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'out' };
      yield { type: 'result', sessionId: 'nan-sid', tokens: { input: NaN, output: 10 } };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        conversationId: 'conv-nan',
        cwd: testDir,
        workflow: {
          name: 'nan-tokens',
          nodes: [{ id: 'step1', kind: 'agent', source: { kind: 'command', name: 'step1' } }],
        },
        workflowRun: makeWorkflowRun('nan-tokens-run'),
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls as Array<
      [{ event_type: string; step_name: string; data?: Record<string, unknown> }]
    >;
    const completedEvent = eventCalls.find(
      ([event]) => event.event_type === 'node_completed' && event.step_name === 'step1'
    );
    expect(completedEvent).toBeDefined();
    // A NaN would serialize to `{input: null, output: 10}` — a wrong number that
    // gets believed. Absence is the honest answer.
    expect(completedEvent?.[0].data).not.toHaveProperty('tokens');
  });

  it('writes node and run cost to the transcript, matching the persisted events', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'out' };
      yield {
        type: 'result',
        sessionId: 'cost-sid',
        cost: 0.3,
        tokens: { input: 100, output: 10 },
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const logDir = join(testDir, 'logs');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        conversationId: 'conv-transcript-cost',
        cwd: testDir,
        workflow: {
          name: 'transcript-cost',
          nodes: [{ id: 'step1', kind: 'agent', source: { kind: 'command', name: 'step1' } }],
        },
        workflowRun: makeWorkflowRun('transcript-cost-run'),
        logDir,
      })
    );

    const transcript = await readTranscript(logDir, 'transcript-cost-run');
    const nodeRow = transcript.find(e => e.type === 'node_complete' && e.step === 'step1');
    const runRow = transcript.find(e => e.type === 'workflow_complete');

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls as Array<
      [{ event_type: string; step_name: string; data?: Record<string, unknown> }]
    >;
    const completedEvent = eventCalls.find(
      ([event]) => event.event_type === 'node_completed' && event.step_name === 'step1'
    );

    expect(nodeRow?.cost_usd).toBe(0.3);
    expect(nodeRow?.tokens).toEqual({ input: 100, output: 10 });
    // Both sinks read the one carrier, so the transcript can never disagree with the
    // event the console and `workflow get` render.
    expect(nodeRow?.cost_usd).toBe(completedEvent?.[0].data?.cost_usd);
    expect(runRow?.cost_usd).toBe(0.3);
    expect(runRow?.tokens).toEqual({ input: 100, output: 10 });
  });

  it('leaves cost off the transcript when the provider reports none', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'out' };
      // Codex reports no cost at all (#2334). Writing 0 here would claim the node was
      // free, and a reader summing the transcript would believe it.
      yield { type: 'result', sessionId: 'no-cost-sid', tokens: { input: 100, output: 10 } };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const logDir = join(testDir, 'logs');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        conversationId: 'conv-transcript-no-cost',
        cwd: testDir,
        workflow: {
          name: 'transcript-no-cost',
          nodes: [{ id: 'step1', kind: 'agent', source: { kind: 'command', name: 'step1' } }],
        },
        workflowRun: makeWorkflowRun('transcript-no-cost-run'),
        logDir,
      })
    );

    const transcript = await readTranscript(logDir, 'transcript-no-cost-run');
    const nodeRow = transcript.find(e => e.type === 'node_complete' && e.step === 'step1');
    const runRow = transcript.find(e => e.type === 'workflow_complete');

    expect(nodeRow).toBeDefined();
    expect(nodeRow).not.toHaveProperty('cost_usd');
    expect(nodeRow?.tokens).toEqual({ input: 100, output: 10 });
    expect(runRow).not.toHaveProperty('cost_usd');
    // The two run-level axes are decided independently, so a missing cost must not
    // suppress the tokens that were reported.
    expect(runRow?.tokens).toEqual({ input: 100, output: 10 });
  });
});
