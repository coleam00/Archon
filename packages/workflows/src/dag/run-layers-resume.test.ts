// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import {
  createMockStore,
  mockClaudeCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  dagOptions,
  ready,
  makeWorkflowRun,
} from './test-utils';
import { executeDagWorkflow } from '../dag-executor';
import type { WorkflowDefinition } from '../schemas';
import { dagNodeSchema } from '../schemas';
import type { PersistedNodeOutput } from '../store';

describe('executeDagWorkflow -- resume with priorCompletedNodes', () => {
  let testDir: string;

  type PersistedEvent = {
    event_type: string;
    step_name?: string;
    data?: Record<string, unknown>;
  };

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

  function rawLoopGroupWorkflow(field: 'note' | 'status'): WorkflowDefinition {
    return {
      name: `raw-loop-group-${field}`,
      description: 'Raw loop-group resume parity fixture',
      nodes: [
        dagNodeSchema.parse({
          id: 'group',
          output_format: {
            type: 'object',
            properties: { status: { type: 'string' } },
            required: ['status'],
          },
          loop_group: {
            until_bash: 'exit 0',
            max_iterations: 1,
            fresh_context: false,
            nodes: [{ id: 'emit', bash: `printf '%s' '{"note":"hi"}'` }],
          },
        }),
        dagNodeSchema.parse({
          id: 'consumer',
          prompt: `whole=[$group.output]\nfield=[$group.output.${field}]`,
          depends_on: ['group'],
        }),
      ],
    };
  }

  async function runRawLoopGroupWorkflow(
    field: 'note' | 'status',
    runId: string,
    priorCompletedNodes?: Map<string, PersistedNodeOutput>
  ): Promise<{
    prompt: string | undefined;
    result: string | undefined;
    events: PersistedEvent[];
  }> {
    let prompt: string | undefined;
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* (resolvedPrompt: string) {
      prompt = resolvedPrompt;
      yield { type: 'agent_message_chunk', text: 'consumer completed' };
      yield { type: 'result', sessionId: `${runId}-session` };
    });

    const store = createMockStore();
    const result = await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-resume',
        cwd: testDir,
        workflow: ready(rawLoopGroupWorkflow(field)),
        workflowRun: makeWorkflowRun(runId),
        priorCompletedNodes,
      })
    );

    const events = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      (call: unknown[]) => call[0] as PersistedEvent
    );
    if (typeof result === 'object') throw new Error('Unexpected source release');
    return { prompt, result, events };
  }

  it('skips nodes that appear in priorCompletedNodes', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const priorCompletedNodes = new Map([['step1', { output: 'prior step1 output' }]]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-resume',
        cwd: testDir,
        workflow: {
          name: 'two-step',
          nodes: [
            { id: 'step1', kind: 'agent', source: { kind: 'command', name: 'step1' } },
            {
              id: 'step2',
              kind: 'agent',
              source: { kind: 'command', name: 'step2' },
              depends_on: ['step1'],
            },
          ],
        },
        workflowRun,
        priorCompletedNodes,
      })
    );

    // Only step2 should have been executed (step1 was skipped)
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
  });

  it('pre-populates nodeOutputs so downstream nodes can use $nodeId.output', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    let capturedPrompt = '';
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      capturedPrompt = prompt;
      yield { type: 'agent_message_chunk', text: 'step2 result' };
      yield { type: 'result', sessionId: 'session-id' };
    });

    const priorCompletedNodes = new Map([['step1', { output: 'hello from prior run' }]]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-resume',
        cwd: testDir,
        workflow: {
          name: 'two-step',
          nodes: [
            { id: 'step1', kind: 'agent', source: { kind: 'command', name: 'step1' } },
            {
              id: 'step2',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'Use this: $step1.output' },
              depends_on: ['step1'],
            },
          ],
        },
        workflowRun,
        priorCompletedNodes,
      })
    );

    // The prompt sent to AI should contain the prior run's output
    expect(capturedPrompt).toContain('hello from prior run');
  });

  it('emits node_skipped_prior_success event for resumed nodes', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('resume-run-id');

    const priorCompletedNodes = new Map([['step1', { output: 'prior output' }]]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-resume',
        cwd: testDir,
        workflow: {
          name: 'two-step',
          nodes: [
            { id: 'step1', kind: 'agent', source: { kind: 'command', name: 'step1' } },
            {
              id: 'step2',
              kind: 'agent',
              source: { kind: 'command', name: 'step2' },
              depends_on: ['step1'],
            },
          ],
        },
        workflowRun,
        priorCompletedNodes,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const skippedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_skipped_prior_success' &&
        (call[0] as { step_name: string }).step_name === 'step1'
    );
    expect(skippedEvent).toBeDefined();
    if (!skippedEvent) throw new Error('Expected prior-success skip event');
    expect(skippedEvent[0].data.node_output).toBe('prior output');
  });

  it('bounds a large prior output when re-emitting node_skipped_prior_success (#2726)', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('resume-run-id-large-skip');
    const artifactsDir = join(testDir, 'artifacts');

    // Simulates what a fixed getDagResumeSnapshot now hands the executor: the FULL,
    // untruncated value (read back from a spill by a prior resume), not a preview.
    // Without the fix, re-emitting this verbatim would write an unbounded row again.
    const largeOutput = 'y'.repeat(40_000);
    const priorCompletedNodes = new Map([['step1', { output: largeOutput }]]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-resume-large-skip',
        cwd: testDir,
        workflow: {
          name: 'two-step',
          nodes: [
            { id: 'step1', kind: 'agent', source: { kind: 'command', name: 'step1' } },
            {
              id: 'step2',
              kind: 'agent',
              source: { kind: 'command', name: 'step2' },
              depends_on: ['step1'],
            },
          ],
        },
        workflowRun,
        artifactsDir,
        priorCompletedNodes,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const skippedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_skipped_prior_success' &&
        (call[0] as { step_name: string }).step_name === 'step1'
    );
    expect(skippedEvent).toBeDefined();
    if (!skippedEvent) throw new Error('Expected prior-success skip event');
    const data = skippedEvent[0].data as {
      node_output: string;
      node_output_truncated: boolean;
      node_output_original_bytes: number;
      node_output_spill_path: string;
    };
    expect(Buffer.byteLength(data.node_output, 'utf8')).toBeLessThanOrEqual(32_768);
    expect(data.node_output_truncated).toBe(true);
    expect(data.node_output_original_bytes).toBe(40_000);
    expect(dirname(data.node_output_spill_path)).toBe(
      join(artifactsDir, '.archon', 'node-output-spills', 'persisted')
    );
    expect(await readFile(data.node_output_spill_path, 'utf8')).toBe(largeOutput);
  });

  it('emits node_skipped_prior_success with empty output when node ID not in map', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('resume-empty-output');

    // priorCompletedNodes has step1 but with undefined value to test the ?? '' fallback
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['step1', { output: undefined as unknown as string }],
    ]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-resume',
        cwd: testDir,
        workflow: {
          name: 'two-step',
          nodes: [
            { id: 'step1', kind: 'agent', source: { kind: 'command', name: 'step1' } },
            {
              id: 'step2',
              kind: 'agent',
              source: { kind: 'command', name: 'step2' },
              depends_on: ['step1'],
            },
          ],
        },
        workflowRun,
        priorCompletedNodes,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const skippedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_skipped_prior_success' &&
        (call[0] as { step_name: string }).step_name === 'step1'
    );
    expect(skippedEvent).toBeDefined();
    if (!skippedEvent) throw new Error('Expected prior-success skip event');
    // The ?? '' fallback kicks in when the map value is undefined
    expect(skippedEvent[0].data.node_output).toBe('');
  });

  it('runs all nodes when priorCompletedNodes is empty', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-resume',
        cwd: testDir,
        workflow: {
          name: 'two-step',
          nodes: [
            { id: 'step1', kind: 'agent', source: { kind: 'command', name: 'step1' } },
            {
              id: 'step2',
              kind: 'agent',
              source: { kind: 'command', name: 'step2' },
              depends_on: ['step1'],
            },
          ],
        },
        workflowRun,
        priorCompletedNodes: new Map(),
      })
    );

    // Both nodes should execute
    expect(mockSendQueryDag.mock.calls.length).toBe(2);
  });

  it('keeps raw loop_group output schemaless on resume for a present undeclared field', async () => {
    const rawOutput = '{"note":"hi"}';
    const fresh = await runRawLoopGroupWorkflow('note', 'raw-group-present-fresh');
    const resumed = await runRawLoopGroupWorkflow(
      'note',
      'raw-group-present-resumed',
      new Map([['group', { output: rawOutput }]])
    );

    expect(fresh.prompt).toBe(`whole=[${rawOutput}]\nfield=[hi]`);
    expect(resumed.prompt).toBe(fresh.prompt);
    expect(fresh.result).toBe('consumer completed');
    expect(resumed.result).toBe(fresh.result);

    const freshGroup = fresh.events.find(
      event => event.event_type === 'node_completed' && event.step_name === 'group'
    );
    const resumedGroup = resumed.events.find(
      event => event.event_type === 'node_skipped_prior_success' && event.step_name === 'group'
    );
    expect(freshGroup?.data?.node_output).toBe(rawOutput);
    expect(resumedGroup?.data?.node_output).toBe(freshGroup?.data?.node_output);
  });

  it('keeps an absent loop_group JSON field missing on fresh execution and resume', async () => {
    const rawOutput = '{"note":"hi"}';
    const fresh = await runRawLoopGroupWorkflow('status', 'raw-group-absent-fresh');
    const resumed = await runRawLoopGroupWorkflow(
      'status',
      'raw-group-absent-resumed',
      new Map([['group', { output: rawOutput }]])
    );

    expect(fresh.prompt).toBeUndefined();
    expect(resumed.prompt).toBeUndefined();
    expect(fresh.result).toBeUndefined();
    expect(resumed.result).toBeUndefined();

    const freshFailure = fresh.events.find(
      event => event.event_type === 'node_failed' && event.step_name === 'consumer'
    );
    const resumedFailure = resumed.events.find(
      event => event.event_type === 'node_failed' && event.step_name === 'consumer'
    );
    expect(freshFailure?.data?.error).toContain('JSON output has no such key');
    expect(resumedFailure?.data?.error).toBe(freshFailure?.data?.error);

    const freshGroup = fresh.events.find(
      event => event.event_type === 'node_completed' && event.step_name === 'group'
    );
    const resumedGroup = resumed.events.find(
      event => event.event_type === 'node_skipped_prior_success' && event.step_name === 'group'
    );
    expect(freshGroup?.data?.node_output).toBe(rawOutput);
    expect(resumedGroup?.data?.node_output).toBe(freshGroup?.data?.node_output);
  });

  it('keeps a structured loop declared-field contract on resume', async () => {
    const store = createMockStore();
    let capturedPrompt = '';
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      capturedPrompt = prompt;
      yield { type: 'agent_message_chunk', text: 'consumer completed' };
      yield { type: 'result', sessionId: 'structured-loop-resume-session' };
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-resume',
        cwd: testDir,
        workflow: {
          name: 'structured-loop-resume',
          nodes: [
            {
              id: 'iterate',
              output_format: {
                type: 'object',
                properties: { done: { type: 'boolean' }, note: { type: 'string' } },
                required: ['done'],
              },
              kind: 'loop',
              loop: {
                prompt: 'iterate',
                until_field: 'done',
                max_iterations: 1,
                fresh_context: false,
              },
            },
            {
              id: 'consumer',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'note=[$iterate.output.note]' },
              depends_on: ['iterate'],
            },
          ],
        },
        workflowRun: makeWorkflowRun('structured-loop-resume'),
        priorCompletedNodes: new Map([['iterate', { output: '{"done":true}' }]]),
      })
    );

    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    expect(capturedPrompt).toBe('note=[]');
  });

  // #2091: on resume, prior completed nodes are rehydrated from text only, so the
  // producer's output_format field set must be re-derived from the loaded definition —
  // otherwise the strict `$node.output.field` contract downgrades to the schemaless
  // path and a resumed run gets different semantics than a fresh one.
  it("re-derives declaredFields on resume so a declared-optional-absent field resolves to ''", async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('resume-declared-optional');

    let capturedPrompt = '';
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      capturedPrompt = prompt;
      yield { type: 'agent_message_chunk', text: 'step2 result' };
      yield { type: 'result', sessionId: 'session-id' };
    });

    // Prior JSON output omits the declared-optional `note` field.
    const priorCompletedNodes = new Map([['step1', { output: '{"type":"BUG"}' }]]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-resume',
        cwd: testDir,
        workflow: {
          name: 'declared-optional',
          nodes: [
            {
              id: 'step1',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'produce json' },
              output_format: {
                type: 'object',
                properties: { type: { type: 'string' }, note: { type: 'string' } },
                required: ['type'],
              },
            },
            {
              id: 'step2',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'note=[$step1.output.note]' },
              depends_on: ['step1'],
            },
          ],
        },
        workflowRun,
        priorCompletedNodes,
      })
    );

    // The consumer must run (step1 was skipped, so exactly one AI call = step2),
    // and the declared-but-absent `note` resolves to '' — not a missing-key throw.
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    expect(capturedPrompt).toBe('note=[]');
  });

  it('re-derives declaredFields on resume so an undeclared key fails the consumer (not-in-schema)', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('resume-undeclared-key');

    // Prior JSON output carries an `extra` key that the schema does NOT declare.
    const priorCompletedNodes = new Map([['step1', { output: '{"type":"BUG","extra":"x"}' }]]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-resume',
        cwd: testDir,
        workflow: {
          name: 'undeclared-key',
          nodes: [
            {
              id: 'step1',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'produce json' },
              output_format: {
                type: 'object',
                properties: { type: { type: 'string' } },
                required: ['type'],
              },
            },
            {
              id: 'step2',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'extra=[$step1.output.extra]' },
              depends_on: ['step1'],
            },
          ],
        },
        workflowRun,
        priorCompletedNodes,
      })
    );

    // The undeclared `extra` must fail the consumer before the AI runs (0 calls),
    // matching fresh-run behavior instead of silently resolving via the schemaless path.
    expect(mockSendQueryDag.mock.calls.length).toBe(0);

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_failed' &&
        (call[0] as { step_name: string }).step_name === 'step2'
    );
    expect(failedEvent).toBeDefined();
    if (!failedEvent) throw new Error('Expected node-failed event');
    expect((failedEvent[0].data as { error: string }).error).toContain('is not declared in node');
  });
});

describe('executeDagWorkflow -- always_run resume opt-out', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-always-run-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'producer.md'), 'Producer prompt');
    await writeFile(join(commandsDir, 'consumer.md'), 'Consumer prompt $producer.output');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'fresh output' };
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

  it('re-runs node flagged always_run even when present in priorCompletedNodes', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const priorCompletedNodes = new Map([['producer', { output: 'cached stale output' }]]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-always-run',
        cwd: testDir,
        workflow: {
          name: 'always-run-producer',
          nodes: [
            {
              id: 'producer',
              kind: 'agent',
              source: { kind: 'command', name: 'producer' },
              always_run: true,
            },
            {
              id: 'consumer',
              kind: 'agent',
              source: { kind: 'command', name: 'consumer' },
              depends_on: ['producer'],
            },
          ],
        },
        workflowRun,
        priorCompletedNodes,
      })
    );

    // Producer re-runs (instead of being skipped) AND consumer runs => 2 sendQuery calls
    expect(mockSendQueryDag.mock.calls.length).toBe(2);

    // No skip event written for the always_run node — but a reset event IS written for audit
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const skippedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_skipped_prior_success' &&
        (call[0] as { step_name: string }).step_name === 'producer'
    );
    expect(skippedEvent).toBeUndefined();

    const resetEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_always_run_reset' &&
        (call[0] as { step_name: string }).step_name === 'producer'
    );
    expect(resetEvent).toBeDefined();
    expect((resetEvent![0] as { data: { prior_output: string } }).data.prior_output).toBe(
      'cached stale output'
    );
  });

  it('bounds a large prior output in the node_always_run_reset audit event (#2726)', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    const artifactsDir = join(testDir, 'artifacts');
    const largeOutput = 'w'.repeat(40_000);

    const priorCompletedNodes = new Map([['producer', { output: largeOutput }]]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-always-run-large',
        cwd: testDir,
        workflow: {
          name: 'always-run-producer-large',
          nodes: [
            {
              id: 'producer',
              kind: 'agent',
              source: { kind: 'command', name: 'producer' },
              always_run: true,
            },
            {
              id: 'consumer',
              kind: 'agent',
              source: { kind: 'command', name: 'consumer' },
              depends_on: ['producer'],
            },
          ],
        },
        workflowRun,
        artifactsDir,
        priorCompletedNodes,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const resetEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_always_run_reset' &&
        (call[0] as { step_name: string }).step_name === 'producer'
    );
    expect(resetEvent).toBeDefined();
    if (!resetEvent) throw new Error('Expected an always_run reset event');
    const data = resetEvent[0].data as {
      prior_output: string;
      prior_output_truncated: boolean;
      prior_output_original_bytes: number;
      prior_output_spill_path: string;
    };
    expect(Buffer.byteLength(data.prior_output, 'utf8')).toBeLessThanOrEqual(32_768);
    expect(data.prior_output_truncated).toBe(true);
    expect(data.prior_output_original_bytes).toBe(40_000);
    expect(dirname(data.prior_output_spill_path)).toBe(
      join(artifactsDir, '.archon', 'node-output-spills', 'persisted')
    );
    expect(await readFile(data.prior_output_spill_path, 'utf8')).toBe(largeOutput);
  });

  it('still skips non-always_run nodes in the same priorCompletedNodes set', async () => {
    await writeFile(join(testDir, '.archon', 'commands', 'cached.md'), 'Cached prompt');
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const priorCompletedNodes = new Map([
      ['producer', { output: 'cached stale output' }],
      ['cached', { output: 'cached output' }],
    ]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-mixed',
        cwd: testDir,
        workflow: {
          name: 'mixed',
          nodes: [
            {
              id: 'producer',
              kind: 'agent',
              source: { kind: 'command', name: 'producer' },
              always_run: true,
            },
            { id: 'cached', kind: 'agent', source: { kind: 'command', name: 'cached' } },
          ],
        },
        workflowRun,
        priorCompletedNodes,
      })
    );

    // Only producer re-runs; cached node stays skipped
    expect(mockSendQueryDag.mock.calls.length).toBe(1);

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const cachedSkipped = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_skipped_prior_success' &&
        (call[0] as { step_name: string }).step_name === 'cached'
    );
    expect(cachedSkipped).toBeDefined();
  });

  it('downstream consumer reads fresh producer output (not the pre-populated cached value)', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const seenPrompts: string[] = [];
    let queryCount = 0;
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      seenPrompts.push(prompt);
      queryCount++;
      // First call is the always_run producer; subsequent calls are consumers
      yield {
        type: 'agent_message_chunk',
        text: queryCount === 1 ? 'fresh producer output' : 'consumer result',
      };
      yield { type: 'result', sessionId: 'session-id' };
    });

    const priorCompletedNodes = new Map([['producer', { output: 'STALE_CACHED_VALUE' }]]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-fresh-output',
        cwd: testDir,
        workflow: {
          name: 'always-run-fresh',
          nodes: [
            {
              id: 'producer',
              kind: 'agent',
              source: { kind: 'command', name: 'producer' },
              always_run: true,
            },
            {
              id: 'consumer',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'See: $producer.output' },
              depends_on: ['producer'],
            },
          ],
        },
        workflowRun,
        priorCompletedNodes,
      })
    );

    // Consumer's prompt should contain the fresh producer output, not the stale cached value
    const consumerPrompt = seenPrompts[1];
    expect(consumerPrompt).toContain('fresh producer output');
    expect(consumerPrompt).not.toContain('STALE_CACHED_VALUE');
  });
});

describe('executeDagWorkflow -- prior-success cache invalidated by dep re-execution (#2402)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-2402-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(testDir, '.archon', 'commands', 'producer.md'), 'Producer prompt');
    await writeFile(
      join(testDir, '.archon', 'commands', 'consumer.md'),
      'Consumer prompt $producer.output'
    );

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
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    await removeTempTree(testDir);
  });

  it('invalidates a cached downstream when an always_run dep re-runs with fresh output', async () => {
    // Bug shape from #2402: producer is `always_run` so it re-executes on resume; consumer
    // is also cached from the prior run. The naive resume used to skip consumer and read
    // the stale cached value, reporting success over synthesis made against the OLD
    // producer. After the fix, consumer must re-execute against the fresh producer.
    const seenPrompts: string[] = [];
    let queryCount = 0;
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      seenPrompts.push(prompt);
      queryCount++;
      yield {
        type: 'agent_message_chunk',
        text: queryCount === 1 ? 'fresh producer output' : 'consumer result',
      };
      yield { type: 'result', sessionId: 'session-id' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    // Both producer and consumer were completed in the prior run — this is the
    // scenario the bug report describes.
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['producer', { output: 'STALE_CACHED_PRODUCER' }],
      ['consumer', { output: 'STALE_CACHED_CONSUMER' }],
    ]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-2402-always-run',
        cwd: testDir,
        workflow: {
          name: 'stale-cache-always-run',
          nodes: [
            {
              id: 'producer',
              kind: 'agent',
              source: { kind: 'command', name: 'producer' },
              always_run: true,
            },
            {
              id: 'consumer',
              kind: 'agent',
              source: { kind: 'command', name: 'consumer' },
              depends_on: ['producer'],
            },
          ],
        },
        workflowRun,
        priorCompletedNodes,
      })
    );

    // Producer re-runs (always_run) AND consumer re-runs (cache invalidated by dep) —
    // before the fix, consumer was skipped and only 1 sendQuery call happened.
    expect(mockSendQueryDag.mock.calls.length).toBe(2);

    // Consumer's prompt must contain the FRESH producer output, not the stale cached
    // value the resume snapshot carried.
    const consumerPrompt = seenPrompts[1];
    expect(consumerPrompt).toContain('fresh producer output');
    expect(consumerPrompt).not.toContain('STALE_CACHED_PRODUCER');

    // Audit: producer emits node_always_run_reset; consumer emits
    // node_prior_cache_invalidated naming producer as the invalidating dep.
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const consumerSkippedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_skipped_prior_success' &&
        (call[0] as { step_name: string }).step_name === 'consumer'
    );
    expect(consumerSkippedEvent).toBeUndefined();

    const invalidatedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_prior_cache_invalidated' &&
        (call[0] as { step_name: string }).step_name === 'consumer'
    );
    expect(invalidatedEvent).toBeDefined();
    const data = (invalidatedEvent![0] as { data: Record<string, unknown> }).data;
    expect(data.reason).toBe('stale_dependency');
    expect(data.invalidating_deps).toEqual(['producer']);
    expect(data.prior_output).toBe('STALE_CACHED_CONSUMER');
  });

  it('does NOT invalidate when a cached dep actually re-runs and produces text-identical output (#2705 R3)', async () => {
    // The comparison is conservative: a dep that re-ran with byte-identical text
    // and structured output is NOT flagged as stale. The cached downstream's value
    // is semantically equivalent, so honouring the cache is correct (and avoids an
    // unnecessary re-execution). This pins that contract for #2402.
    //
    // Producer MUST actually re-execute this resume for the contract to mean
    // anything — `always_run: true` forces that. (A prior version of this test used
    // a non-always_run producer that was itself skipped via the ordinary prior-cache
    // path, so the "re-ran... identical output" comparison this test claims to pin
    // was never reached — flagged as #2705 R3.)
    let queryCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      queryCount++;
      yield { type: 'agent_message_chunk', text: 'identical output' };
      yield { type: 'result', sessionId: 'session-id' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    // Producer was completed in the prior run with output "identical output" AND is
    // `always_run`, so it actually re-executes this resume — and its fresh output
    // matches the prior snapshot byte-for-byte.
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['producer', { output: 'identical output' }],
      ['consumer', { output: 'cached consumer output' }],
    ]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-2402-identical',
        cwd: testDir,
        workflow: {
          name: 'stale-cache-identical',
          nodes: [
            {
              id: 'producer',
              kind: 'agent',
              source: { kind: 'command', name: 'producer' },
              always_run: true,
            },
            {
              id: 'consumer',
              kind: 'agent',
              source: { kind: 'command', name: 'consumer' },
              depends_on: ['producer'],
            },
          ],
        },
        workflowRun,
        priorCompletedNodes,
      })
    );

    // Producer re-runs (always_run) with output identical to its prior snapshot;
    // consumer stays cached because the comparison found no diff. A regression that
    // makes the check over-eager (flagging every re-run dep regardless of value)
    // would call consumer's sendQuery too, pushing this past 1.
    expect(queryCount).toBe(1);

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const invalidatedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_prior_cache_invalidated'
    );
    expect(invalidatedEvent).toBeUndefined();

    const consumerSkippedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_skipped_prior_success' &&
        (call[0] as { step_name: string }).step_name === 'consumer'
    );
    expect(consumerSkippedEvent).toBeDefined();
  });

  it('invalidates a cached downstream when a dep that was never cached completes fresh this resume', async () => {
    // A dep can be missing from priorCompletedNodes for two reasons: it never completed
    // in the prior run, or it completed but its row was lost. The pre-populate loop
    // never seeds nodeOutputs for such a dep, so case 1 of the staleness check fires:
    // "dep missing from prior + nodeOutputs now completed => ran fresh this resume".
    // Pin that contract — it can otherwise regress into the same staleness class.
    let queryCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      queryCount++;
      yield {
        type: 'agent_message_chunk',
        text: queryCount === 1 ? 'fresh producer' : 'fresh consumer',
      };
      yield { type: 'result', sessionId: 'session-id' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    // Consumer is cached; producer is NOT cached (e.g. it failed in the prior run and
    // is being re-attempted this resume).
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['consumer', { output: 'stale consumer output' }],
    ]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-2402-uncached-dep',
        cwd: testDir,
        workflow: {
          name: 'stale-cache-uncached-dep',
          nodes: [
            { id: 'producer', kind: 'agent', source: { kind: 'command', name: 'producer' } },
            {
              id: 'consumer',
              kind: 'agent',
              source: { kind: 'command', name: 'consumer' },
              depends_on: ['producer'],
            },
          ],
        },
        workflowRun,
        priorCompletedNodes,
      })
    );

    // Producer ran fresh + consumer was invalidated and re-ran = 2 sendQuery calls.
    expect(queryCount).toBe(2);

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const invalidatedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_prior_cache_invalidated' &&
        (call[0] as { step_name: string }).step_name === 'consumer'
    );
    expect(invalidatedEvent).toBeDefined();
    const data = (invalidatedEvent![0] as { data: Record<string, unknown> }).data;
    expect(data.invalidating_deps).toEqual(['producer']);
  });

  it('bounds a large prior output in the node_prior_cache_invalidated audit event (#2726)', async () => {
    let queryCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      queryCount++;
      yield {
        type: 'agent_message_chunk',
        text: queryCount === 1 ? 'fresh producer' : 'fresh consumer',
      };
      yield { type: 'result', sessionId: 'session-id' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    const artifactsDir = join(testDir, 'artifacts');
    const largeOutput = 'v'.repeat(40_000);

    // Consumer is cached with a large prior value; producer is NOT cached, so it runs
    // fresh and invalidates consumer's cache (same trigger as the test above).
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['consumer', { output: largeOutput }],
    ]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-2402-large-invalidated',
        cwd: testDir,
        workflow: {
          name: 'stale-cache-large-invalidated',
          nodes: [
            { id: 'producer', kind: 'agent', source: { kind: 'command', name: 'producer' } },
            {
              id: 'consumer',
              kind: 'agent',
              source: { kind: 'command', name: 'consumer' },
              depends_on: ['producer'],
            },
          ],
        },
        workflowRun,
        artifactsDir,
        priorCompletedNodes,
      })
    );

    expect(queryCount).toBe(2);

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const invalidatedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_prior_cache_invalidated' &&
        (call[0] as { step_name: string }).step_name === 'consumer'
    );
    expect(invalidatedEvent).toBeDefined();
    if (!invalidatedEvent) throw new Error('Expected a cache-invalidated event');
    const data = invalidatedEvent[0].data as {
      prior_output: string;
      prior_output_truncated: boolean;
      prior_output_original_bytes: number;
      prior_output_spill_path: string;
    };
    expect(Buffer.byteLength(data.prior_output, 'utf8')).toBeLessThanOrEqual(32_768);
    expect(data.prior_output_truncated).toBe(true);
    expect(data.prior_output_original_bytes).toBe(40_000);
    expect(dirname(data.prior_output_spill_path)).toBe(
      join(artifactsDir, '.archon', 'node-output-spills', 'persisted')
    );
    expect(await readFile(data.prior_output_spill_path, 'utf8')).toBe(largeOutput);
  });

  it('invalidates a cached downstream when a dep that re-ran fresh failed (case 1 \"failed\" arm)', async () => {
    // Pin case 1's `current?.state === 'failed'` arm of getStaleCachedDependencies
    // (the #2402 bug surface on the failure path). A dep that was not in the prior
    // snapshot and re-runs this resume is normally stale via case 1's
    // `'completed'` check. The exact same dep shape on the failure path — producer
    // re-attempted this resume and crashed — must also be flagged stale: honouring
    // the cached downstream would silently report success over synthesis built
    // against the prior run's view of a now-failed dep. Test 3 above pins the
    // `'completed'` half of case 1; this one pins the `'failed'` half so a future
    // refactor that drops `|| current?.state === 'failed'` is structurally caught
    // (the regression is observationally indistinguishable from test 3 without it).
    let queryCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      queryCount++;
      if (queryCount === 1) {
        // Producer's only attempt fails. The catch arm in executeNodeInternal
        // converts this to { state: 'failed', output: '', error: '...' } and the
        // layer aggregation writes that into nodeOutputs['producer']. After this,
        // any prior-cached consumer that depends on producer must be invalidated,
        // not silently skipped. An untyped thrown error is `unknown`, which the
        // default `on_error: transient` never retries — one attempt, keeping
        // queryCount deterministic against the assertion.
        throw new Error('producer crashed: provider auth error');
      }
      yield { type: 'agent_message_chunk', text: 'fresh consumer output' };
      yield { type: 'result', sessionId: 'session-id' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    // #2713: this test's shared consumer.md fixture inlines $producer.output, which
    // itself now throws when producer is 'failed' (the sibling gap this test
    // predates) — override it so this test measures ONLY the #2402
    // staleness-invalidation behavior, not the unrelated #2713 guard.
    await writeFile(join(testDir, '.archon', 'commands', 'consumer.md'), 'Consumer prompt');

    // Consumer is cached (it ran in the prior run). Producer is NOT cached —
    // it failed in the prior run and is being re-attempted this resume. Same
    // shape as test 3 (case 1 with `'completed'`); the producer's FINAL state
    // in nodeOutputs is `'failed'` instead.
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['consumer', { output: 'STALE_CACHED_CONSUMER' }],
    ]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-2402-fresh-failed-dep',
        cwd: testDir,
        workflow: {
          name: 'stale-cache-fresh-failed-dep',
          nodes: [
            { id: 'producer', kind: 'agent', source: { kind: 'command', name: 'producer' } },
            // `all_done` (not the default `all_success`) so the consumer's trigger
            // rule permits re-execution against a failed producer. Without this,
            // the default rule would silently skip consumer on the failure path —
            // exercising the staleness arm but never landing the consumer's query,
            // which would erase the queryCount === 2 discriminator between
            // AFTER and BEFORE the fix.
            {
              id: 'consumer',
              kind: 'agent',
              source: { kind: 'command', name: 'consumer' },
              depends_on: ['producer'],
              trigger_rule: 'all_done',
            },
          ],
        },
        workflowRun,
        priorCompletedNodes,
      })
    );

    // Producer failed (1 sendQuery attempt) + consumer was invalidated by the
    // failed-dep arm and re-ran = 2 sendQuery calls in total. A regression that
    // drops `|| current?.state === 'failed'` leaves case 1 unable to flag the
    // failed dep; the consumer is then prior-skipped, sendQuery is only called
    // for the producer's failed attempt, and queryCount lands at 1 — failing.
    expect(queryCount).toBe(2);

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;

    // The cached-skip arm MUST NOT fire for the consumer. A regression that
    // drops the `'failed'` arm (or narrows case 1 back to `=== 'completed'`)
    // lets the prior-completed skip take over and emits
    // node_skipped_prior_success — this assertion catches that exact fallback.
    const consumerSkippedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_skipped_prior_success' &&
        (call[0] as { step_name: string }).step_name === 'consumer'
    );
    expect(consumerSkippedEvent).toBeUndefined();

    // The invalidation audit MUST fire for the consumer, naming the failed dep.
    const invalidatedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_prior_cache_invalidated' &&
        (call[0] as { step_name: string }).step_name === 'consumer'
    );
    expect(invalidatedEvent).toBeDefined();
    const data = (invalidatedEvent![0] as { data: Record<string, unknown> }).data;
    expect(data.reason).toBe('stale_dependency');
    expect(data.invalidating_deps).toEqual(['producer']);
    expect(data.prior_output).toBe('STALE_CACHED_CONSUMER');
  });

  it('invalidates a cached downstream when a PREVIOUSLY-CACHED dep fails fresh with output matching its prior success (#2705 R1)', async () => {
    // Every failure arm in the executor returns `output: ''`. When a dependency WAS
    // cached from a prior success — the ordinary shape for an `always_run: true` gate
    // on a second-or-later resume — and that prior success also carried `output: ''`
    // (a bash gate with no stdout), a value-equality-only staleness check finds the
    // fresh failure's `''` indistinguishable from the prior success's `''` and reports
    // "not stale." The cached consumer is then skipped via node_skipped_prior_success
    // BEFORE checkTriggerRule ever runs, silently reporting success over a live
    // failure produced on THIS resume. Unlike the case-1 "failed arm" test above
    // (producer had NO prior entry), this producer WAS in priorCompletedNodes —
    // the shape cases 2/3 govern, and the one the fix must also cover.
    let queryCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      queryCount++;
      if (queryCount === 1) {
        // Producer's only attempt fails this resume. An untyped error is `unknown`,
        // not retried by default — one attempt, deterministic queryCount.
        throw new Error('producer crashed: provider auth error');
      }
      yield { type: 'agent_message_chunk', text: 'fresh consumer output' };
      yield { type: 'result', sessionId: 'session-id' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    // #2713: this test's shared consumer.md fixture inlines $producer.output, which
    // itself now throws when producer is 'failed' (the sibling gap this test
    // predates) — override it so this test measures ONLY the #2402
    // staleness-invalidation behavior, not the unrelated #2713 guard.
    await writeFile(join(testDir, '.archon', 'commands', 'consumer.md'), 'Consumer prompt');

    // Producer WAS cached from a prior success with EMPTY output — the exact value
    // its fresh failure also produces. Consumer was cached too.
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['producer', { output: '' }],
      ['consumer', { output: 'STALE_CACHED_CONSUMER' }],
    ]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-2705-r1-cached-dep-fresh-fail',
        cwd: testDir,
        workflow: {
          name: 'stale-cache-cached-dep-fresh-fail',
          nodes: [
            {
              id: 'producer',
              kind: 'agent',
              source: { kind: 'command', name: 'producer' },
              always_run: true,
            },
            {
              id: 'consumer',
              kind: 'agent',
              source: { kind: 'command', name: 'consumer' },
              depends_on: ['producer'],
              trigger_rule: 'all_done',
            },
          ],
        },
        workflowRun,
        priorCompletedNodes,
      })
    );

    // Producer's failed attempt (1) + consumer invalidated and re-ran (1) = 2. A
    // regression that judges a previously-cached dep by value alone leaves consumer
    // prior-skipped and queryCount stuck at 1 — failing.
    expect(queryCount).toBe(2);

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const consumerSkippedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_skipped_prior_success' &&
        (call[0] as { step_name: string }).step_name === 'consumer'
    );
    expect(consumerSkippedEvent).toBeUndefined();

    const invalidatedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_prior_cache_invalidated' &&
        (call[0] as { step_name: string }).step_name === 'consumer'
    );
    expect(invalidatedEvent).toBeDefined();
    const data = (invalidatedEvent![0] as { data: Record<string, unknown> }).data;
    expect(data.reason).toBe('stale_dependency');
    expect(data.invalidating_deps).toEqual(['producer']);
    expect(data.prior_output).toBe('STALE_CACHED_CONSUMER');
  });

  it('invalidates when a dep’s structured output changes even though text is stable', async () => {
    // Case 3 of the staleness check: a `$dep.output.field` consumer must be invalidated
    // when the structured value changes, even if the text form is identical. Otherwise
    // the #2637 logical-value surface would silently read stale data through the cache.
    // The dep must actually re-run for the comparison to fire — `always_run: true`
    // forces that without contaminating the case with text-staleness.
    let queryCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      queryCount++;
      yield {
        type: 'agent_message_chunk',
        text: queryCount === 1 ? 'producer text' : 'consumer result',
      };
      yield {
        type: 'result',
        sessionId: 'session-id',
        // Simulate a provider that attaches a logical value alongside the text.
        // Producer: same text as the cache, different structured payload. This is
        // the case-3 trigger — the dep's nodeOutputs entry will have the new
        // structuredOutput even though its text is identical.
        structuredOutput: queryCount === 1 ? { status: 'PASS_NEW', count: 7 } : { ok: true },
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      // Text matches the new producer run, but the structured payload is the OLD
      // shape — a `$producer.output.status` consumer would read the stale
      // string "PASS_OLD" through the cache.
      ['producer', { output: 'producer text', structuredOutput: { status: 'PASS_OLD', count: 3 } }],
      // The consumer's own cached value also carries a structured payload so the
      // audit log can record what was thrown away on the invalidated side too.
      ['consumer', { output: 'cached consumer', structuredOutput: { stale: true } }],
    ]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-2402-structured',
        cwd: testDir,
        workflow: {
          name: 'stale-cache-structured',
          nodes: [
            // always_run forces the producer re-execution that surfaces case 3.
            {
              id: 'producer',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'Run producer' },
              always_run: true,
            },
            {
              id: 'consumer',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'Use $producer.output.status' },
              depends_on: ['producer'],
            },
          ],
        },
        workflowRun,
        priorCompletedNodes,
      })
    );

    // Producer re-ran (always_run) + consumer was invalidated (text-stable but
    // structured-output differs) = 2 sendQuery calls.
    expect(queryCount).toBe(2);

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const invalidatedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_prior_cache_invalidated' &&
        (call[0] as { step_name: string }).step_name === 'consumer'
    );
    expect(invalidatedEvent).toBeDefined();
    const data = (invalidatedEvent![0] as { data: Record<string, unknown> }).data;
    expect(data.invalidating_deps).toEqual(['producer']);
    expect(data.prior_structured_output).toEqual({ stale: true });
  });

  it('invalidates a cached downstream when ONE of its multiple deps re-ran (any-stale triggers re-execution)', async () => {
    // Pin the "any stale dep invalidates" trigger for cached consumers with >= 2 deps
    // (#2402). The single-dep cases above can't catch a regression to "re-run only when
    // ALL deps are stale" (`if (staleDeps.length === deps.length)`), which would
    // re-introduce the original bug for any cached consumer that has at least one
    // fresh dep and one stable one. The shape: producer re-runs (always_run, fresh
    // output) + side stays cached (text-identical to prior) -> consumer is cached
    // but reads `$producer.output` in its prompt. The fresh producer MUST invalidate
    // the cached consumer even though side is stable.
    const seenPrompts: string[] = [];
    let queryCount = 0;
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      seenPrompts.push(prompt);
      queryCount++;
      // queryCount 1: producer re-runs (always_run).
      // queryCount 2: consumer re-runs after cache invalidation.
      // Side is in priorCompletedNodes with text-identical-to-prior output, so the
      // pre-populate loop seeds it and the resume-skip arm fires for it — side is
      // never sent to sendQuery.
      yield {
        type: 'agent_message_chunk',
        text: queryCount === 1 ? 'FRESH producer output' : 'consumer result',
      };
      yield { type: 'result', sessionId: 'session-id' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    // All three nodes cached in the prior run. Side's cached output matches what its
    // pre-populated nodeOutputs entry will carry, so case 2 (text diff) reports no
    // staleness for side. Producer's cached output is the stale value — the fresh
    // always_run execution will surface case 2 and invalidate consumer.
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['producer', { output: 'STALE producer output' }],
      ['side', { output: 'stable side output' }],
      ['consumer', { output: 'STALE consumer output' }],
    ]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-2402-multi-dep',
        cwd: testDir,
        workflow: {
          name: 'stale-cache-multi-dep',
          nodes: [
            // always_run forces producer to re-execute this resume (case 2 fires).
            {
              id: 'producer',
              kind: 'agent',
              source: { kind: 'command', name: 'producer' },
              always_run: true,
            },
            // Stable dep — text matches prior so case 2 doesn't flag it.
            { id: 'side', kind: 'agent', source: { kind: 'command', name: 'side' } },
            // Consumer reads producer; its dep list has BOTH producer and side.
            {
              id: 'consumer',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'Use $producer.output and $side.output' },
              depends_on: ['producer', 'side'],
            },
          ],
        },
        workflowRun,
        priorCompletedNodes,
      })
    );

    // Exactly two queries: producer re-runs (always_run), consumer re-runs
    // (cache invalidated). Side is skipped via the pre-populate prior-success arm,
    // so it never reaches sendQuery.
    expect(queryCount).toBe(2);

    // Consumer's prompt must contain the FRESH producer output (not the stale cached
    // value the resume snapshot carried). Side's stable output is also fine.
    const consumerPrompt = seenPrompts[1];
    expect(consumerPrompt).toContain('FRESH producer output');
    expect(consumerPrompt).not.toContain('STALE producer output');
    expect(consumerPrompt).toContain('stable side output');

    // Consumer emits node_prior_cache_invalidated naming ONLY the stale dep. If a
    // future refactor flagged every dep in the list (or stopped pushing after the
    // first dep), invalidating_deps would either be ['producer','side'] or []
    // respectively — both would fail this length-1 assertion.
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const consumerSkippedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_skipped_prior_success' &&
        (call[0] as { step_name: string }).step_name === 'consumer'
    );
    expect(consumerSkippedEvent).toBeUndefined();

    const invalidatedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_prior_cache_invalidated' &&
        (call[0] as { step_name: string }).step_name === 'consumer'
    );
    expect(invalidatedEvent).toBeDefined();
    const data = (invalidatedEvent![0] as { data: Record<string, unknown> }).data;
    expect(data.reason).toBe('stale_dependency');
    // Length 1 (not 2) — pinning the "any stale dep invalidates" trigger; pinning
    // that only the actually-stale dep is reported (not the stable side).
    expect(data.invalidating_deps).toEqual(['producer']);
    expect(data.prior_output).toBe('STALE consumer output');

    // Side stayed cached, so it should emit node_skipped_prior_success exactly once.
    const sideSkippedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_skipped_prior_success' &&
        (call[0] as { step_name: string }).step_name === 'side'
    );
    expect(sideSkippedEvent).toBeDefined();
  });
});
