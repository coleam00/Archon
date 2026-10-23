// @archon-test-isolated
import { type WorktreeDisposition } from '../schemas/terminal-record';
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  mockLogFn,
  type MockWorkflowStore,
  createMockStore,
  authoredOutcomeWrites,
  mockClaudeCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  type MockWorkflowDeps,
  createMockDeps,
  type MockWorkflowPlatform,
  createMockPlatform,
  deliveredMessages,
  persistedEvents,
  dagOptions,
  makeWorkflowRun,
  readTranscript,
} from './test-utils';
import { executeDagWorkflow, type ExecuteDagWorkflowOptions } from '../dag-executor';
import { getWorkflowEventEmitter, type WorkflowEmitterEvent } from '../event-emitter';
import type { DagNode, ExecNode, WorkflowRun } from '../schemas';
import type { IWorkflowPlatform } from '../deps';
import type { IWorkflowStore, PersistedNodeOutput } from '../store';

describe('executeDagWorkflow -- final status derivation', () => {
  // Invariant: if ANY non-skipped node has failed status, the run must be
  // marked 'failed' — never 'completed' — regardless of how many other nodes
  // succeeded. This covers the anyFailed branch in executeDagWorkflow
  // (dag-executor.ts ~line 2956), which had no direct test coverage.
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
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

  it('a failed-only DAG delegates its terminal event to failWorkflowRun', async () => {
    const mockStore = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(mockStore),
        conversationId: 'conv-status',
        cwd: testDir,
        workflow: {
          name: 'status-test',
          nodes: [{ id: 'fail', kind: 'exec', runtime: 'sh', script: 'exit 1' } as ExecNode],
        },
        workflowRun: makeWorkflowRun('dag-status-failed-only'),
      })
    );

    expect(mockStore.failWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockStore.createWorkflowEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'workflow_failed' })
    );
  });

  it('one success + one independent failure -> failWorkflowRun, not completeWorkflowRun', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-status-run-1');

    const nodes: DagNode[] = [
      { id: 'pass', kind: 'exec', runtime: 'sh', script: 'echo ok' } as ExecNode,
      { id: 'fail', kind: 'exec', runtime: 'sh', script: 'exit 1' } as ExecNode,
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-status',
        cwd: testDir,
        workflow: { name: 'status-test', nodes },
        workflowRun,
      })
    );

    expect((mockStore.failWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect((mockStore.completeWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    expect(mockStore.failWorkflowRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('fail'),
      { scheduledResume: undefined, exitReason: 'node_error' }
    );
    expect(mockStore.createWorkflowEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'workflow_failed' })
    );

    // The run tail tells the operator the run failed and which node did it. The
    // node's own error text is the subprocess's, so the assertion pins the
    // sentence the executor owns and the node it names.
    expect(deliveredMessages(platform)).toEqual([
      "❌ DAG workflow 'status-test' completed with failures: 'fail': Bash node 'fail' failed " +
        '[exit 1]: no diagnostic output',
    ]);
  });

  it('multiple successes + one failure -> failWorkflowRun, not completeWorkflowRun', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-status-run-2');

    const nodes: DagNode[] = [
      { id: 'a', kind: 'exec', runtime: 'sh', script: 'echo a' } as ExecNode,
      { id: 'b', kind: 'exec', runtime: 'sh', script: 'echo b' } as ExecNode,
      { id: 'c', kind: 'exec', runtime: 'sh', script: 'echo c' } as ExecNode,
      { id: 'fail', kind: 'exec', runtime: 'sh', script: 'exit 1' } as ExecNode,
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-status',
        cwd: testDir,
        workflow: { name: 'status-test-multi', nodes },
        workflowRun,
      })
    );

    expect((mockStore.failWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect((mockStore.completeWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    expect(mockStore.failWorkflowRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('fail'),
      { scheduledResume: undefined, exitReason: 'node_error' }
    );

    // Only the failing node is named; the three successes are not.
    expect(deliveredMessages(platform)).toEqual([
      "❌ DAG workflow 'status-test-multi' completed with failures: 'fail': Bash node 'fail' " +
        'failed [exit 1]: no diagnostic output',
    ]);
  });

  it('trigger_rule: none_failed_min_one_success skips dependent node + anyFailed still marks run failed', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-status-run-3');

    // Layer 1: A and B run in parallel. B fails.
    // Layer 2: C depends on B with trigger_rule: none_failed_min_one_success — so C is skipped.
    // Expected: anyFailed=true (from B), so run must be marked failed even though C is only skipped.
    const nodes: DagNode[] = [
      { id: 'a', kind: 'exec', runtime: 'sh', script: 'echo a' } as ExecNode,
      { id: 'b', kind: 'exec', runtime: 'sh', script: 'exit 1' } as ExecNode,
      {
        id: 'c',
        kind: 'exec',
        runtime: 'sh',
        script: 'echo c',
        depends_on: ['b'],
        trigger_rule: 'none_failed_min_one_success',
      } as ExecNode,
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-status',
        cwd: testDir,
        workflow: { name: 'status-test-skip', nodes },
        workflowRun,
      })
    );

    expect((mockStore.failWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect((mockStore.completeWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    expect(mockStore.failWorkflowRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('b'),
      { scheduledResume: undefined, exitReason: 'node_error' }
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Terminal reasons and node failure kinds
//
// Terminal run telemetry is projected by the run store from the durable log, so the
// engine's job is to record WHY: the exit reason on the terminal write and the failure
// kind on each node_failed row. Each test varies the failing node and reads what the
// engine actually handed the store.
// ───────────────────────────────────────────────────────────────────────────
describe('executeDagWorkflow -- terminal reasons and failure kinds', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-reason-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
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
    // The bash-timeout case can leave its killed shell's `sleep` holding the directory on
    // Windows; a raw rm fails that passing test with EBUSY.
    await removeTempTree(testDir);
  });

  async function runDag(
    nodes: DagNode[],
    prepareStore?: (store: MockWorkflowStore) => void
  ): Promise<{ store: MockWorkflowStore; failureKinds: Record<string, unknown> }> {
    const store = createMockStore();
    prepareStore?.(store);
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: { name: 'dag-reasons', nodes },
        workflowRun: makeWorkflowRun(),
      })
    );
    const failureKinds: Record<string, unknown> = {};
    for (const [event] of store.createWorkflowEvent.mock.calls) {
      if (event.event_type !== 'node_failed' || !event.step_name) continue;
      failureKinds[event.step_name] = (event.data as Record<string, unknown>).failure_kind;
    }
    return { store, failureKinds };
  }

  function failOptions(store: MockWorkflowStore): unknown {
    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
    return store.failWorkflowRun.mock.calls[0][2];
  }

  it('a first-node failure is a node_error, and a non-zero bash exit is exec_failed', async () => {
    const { store, failureKinds } = await runDag([
      { id: 'lint', kind: 'exec', runtime: 'sh', script: 'echo "3 problems" >&2; exit 1' },
    ]);
    expect(failureKinds).toEqual({ lint: 'exec_failed' });
    expect(failOptions(store)).toMatchObject({ exitReason: 'node_error' });
  });

  it('a bash timeout is recorded as timeout, not re-read from its message', async () => {
    const { failureKinds } = await runDag([
      { id: 'slow', kind: 'exec', runtime: 'sh', script: 'sleep 5', timeout: 100 },
    ]);
    expect(failureKinds).toEqual({ slow: 'timeout' });
  });

  it('a prompt that returns prose for a declared output_format is output_contract', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Sure, here is my answer in prose.' };
      yield { type: 'result', sessionId: 'sid-prose' };
    });
    const { failureKinds } = await runDag([
      {
        id: 'classify',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'Classify.' },
        output_format: { type: 'object', properties: { kind: { type: 'string' } } },
      },
    ]);
    expect(failureKinds).toEqual({ classify: 'output_contract' });
  });

  it('an untyped provider error is unknown, whatever its message says', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'partial' };
      throw new Error('401 unauthorized: invalid api key');
    });
    const { failureKinds } = await runDag([
      {
        id: 'step',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'Do thing.' },
        retry: { max_attempts: 1, delay_ms: 1 },
      },
    ]);
    expect(failureKinds).toEqual({ step: 'unknown' });
    // unknown is retried only under on_error: all.
    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
  });

  it('an AI node that idles out after output is retried as a transient timeout', async () => {
    mockSendQueryDag.mockImplementation(async function* (
      _prompt: string,
      _cwd: string,
      _resumeSessionId?: string,
      options?: { abortSignal?: AbortSignal }
    ) {
      yield { type: 'agent_message_chunk', text: 'Here is the analysis result.' };
      await new Promise<void>(resolve => {
        options?.abortSignal?.addEventListener('abort', () => resolve());
      });
    });
    const { failureKinds } = await runDag([
      {
        id: 'step',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'Do thing.' },
        idle_timeout: 50,
        retry: { max_attempts: 1, delay_ms: 1 },
      },
    ]);
    expect(failureKinds).toEqual({ step: 'timeout' });
    expect(mockSendQueryDag).toHaveBeenCalledTimes(2);
  });

  it('a config failure is never retried, even under on_error: all', async () => {
    const { store, failureKinds } = await runDag([
      {
        id: 'step',
        kind: 'agent',
        source: { kind: 'command', name: 'does-not-exist' },
        retry: { max_attempts: 2, delay_ms: 1, on_error: 'all' },
      },
    ]);
    expect(failureKinds).toEqual({ step: 'config' });
    const failedRows = store.createWorkflowEvent.mock.calls.filter(
      ([event]) => event.event_type === 'node_failed' && event.step_name === 'step'
    );
    expect(failedRows).toHaveLength(1);
  });

  it('a cancelled node is never retried, even under on_error: all', async () => {
    let streamStarted = false;
    mockSendQueryDag.mockImplementation(async function* () {
      streamStarted = true;
      yield { type: 'agent_message_chunk', text: 'partial' };
      yield { type: 'agent_message_chunk', text: 'MUST NOT BE REACHED' };
    });
    const { failureKinds } = await runDag(
      [
        {
          id: 'step',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'Do thing.' },
          retry: { max_attempts: 2, delay_ms: 1, on_error: 'all' },
        },
      ],
      store => {
        store.getWorkflowRunStatus.mockImplementation(() =>
          Promise.resolve(streamStarted ? 'cancelled' : 'running')
        );
      }
    );
    expect(failureKinds).toEqual({ step: 'cancelled' });
    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
  });

  it('a loop that exhausts max_iterations is max_iterations', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Still working...' };
      yield { type: 'result', sessionId: 'loop-session' };
    });
    const { failureKinds } = await runDag([
      {
        id: 'my-loop',
        kind: 'loop',
        loop: { fresh_context: false, prompt: 'Do task.', until: 'COMPLETE', max_iterations: 2 },
      },
    ]);
    expect(failureKinds).toEqual({ 'my-loop': 'max_iterations' });
  });

  it('a node whose provider cannot be prepared is config', async () => {
    mockGetAgentProviderDag.mockImplementation(() => {
      throw new Error('provider not registered');
    });
    const { failureKinds } = await runDag([
      { id: 'step', kind: 'agent', source: { kind: 'inline', prompt: 'Do thing.' } },
    ]);
    expect(failureKinds).toEqual({ step: 'config' });
  });

  it('one completed node and one failed node is a node_error', async () => {
    const { store } = await runDag([
      { id: 'ok', kind: 'exec', runtime: 'sh', script: 'echo fine' },
      { id: 'bad', kind: 'exec', runtime: 'sh', script: 'exit 2', depends_on: ['ok'] },
    ]);
    expect(failOptions(store)).toMatchObject({ exitReason: 'node_error' });
  });
});

describe('executeDagWorkflow -- evidence gate (#2230)', () => {
  // Thin terminal-success gate: when the workflow declares
  // `evidence_policy.required: true`, the executor refuses terminal `completed`
  // unless `$ARTIFACTS_DIR/evidence.json` exists. Presence check ONLY — the
  // workflow's own bash/script nodes compute what counts as evidence.
  let testDir: string;
  let artifactsDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-evidence-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    artifactsDir = join(testDir, 'artifacts');
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  async function runEvidenceWorkflow(opts: {
    store: IWorkflowStore;
    platform: IWorkflowPlatform;
    evidencePolicy?: { required: boolean };
    authoredGreen?: boolean;
    priorCompletedNodes?: Map<string, PersistedNodeOutput>;
    priorUsage?: ExecuteDagWorkflowOptions['priorUsage'];
  }): Promise<void> {
    const mockDeps = createMockDeps(opts.store);
    const workflowRun = makeWorkflowRun('dag-evidence-run');
    const nodes: DagNode[] = [
      opts.authoredGreen === undefined
        ? ({ id: 'work', kind: 'exec', runtime: 'sh', script: 'echo done' } as ExecNode)
        : ({
            id: 'work',
            kind: 'exec',
            runtime: 'sh',
            script: `printf '{"green":${String(opts.authoredGreen)}}'`,
            output_format: {
              type: 'object',
              properties: { green: { type: 'boolean' } },
              required: ['green'],
            },
          } as ExecNode),
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform: opts.platform,
        conversationId: 'conv-evidence',
        cwd: testDir,
        workflow: {
          name: 'evidence-test',
          nodes,
          ...(opts.evidencePolicy ? { evidence_policy: opts.evidencePolicy } : {}),
          ...(opts.authoredGreen !== undefined ? { returns: 'work', outcome_field: 'green' } : {}),
        },
        workflowRun,
        artifactsDir,
        priorCompletedNodes: opts.priorCompletedNodes,
        priorUsage: opts.priorUsage,
      })
    );
  }

  it('required: true + missing evidence.json -> failWorkflowRun with explicit reason, never completed', async () => {
    const mockStore = createMockStore();
    const platform = createMockPlatform();

    await runEvidenceWorkflow({
      store: mockStore,
      platform,
      evidencePolicy: { required: true },
    });

    expect((mockStore.completeWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    expect((mockStore.failWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    const failCall = (mockStore.failWorkflowRun as ReturnType<typeof mock>).mock
      .calls[0] as unknown[];
    expect(failCall[1] as string).toContain('evidence_policy.required');
    expect(failCall[1] as string).toContain(join(artifactsDir, 'evidence.json'));

    // The user-facing message says exactly why
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    expect(messages.some(m => m.includes('evidence_policy.required'))).toBe(true);
  });

  it('missing evidence writes a structured metadata.evidence_validation note', async () => {
    const mockStore = createMockStore();
    const platform = createMockPlatform();

    await runEvidenceWorkflow({
      store: mockStore,
      platform,
      evidencePolicy: { required: true },
    });

    const updateCalls = (mockStore.updateWorkflowRun as ReturnType<typeof mock>).mock
      .calls as unknown[][];
    const metadataCall = updateCalls.find(call => {
      const updates = call[1] as { metadata?: Record<string, unknown> };
      return updates?.metadata?.evidence_validation !== undefined;
    });
    expect(metadataCall).toBeDefined();
    const note = (metadataCall?.[1] as { metadata: Record<string, unknown> }).metadata
      .evidence_validation as Record<string, unknown>;
    expect(note.status).toBe('missing');
    expect(note.policy).toBe('evidence_policy.required');
    expect(note.expected_path).toBe(join(artifactsDir, 'evidence.json'));
    expect(typeof note.checked_at).toBe('string');
  });

  it('missing evidence persists an evidence_validation_failed workflow event and its exit reason', async () => {
    const mockStore = createMockStore();
    const platform = createMockPlatform();

    await runEvidenceWorkflow({
      store: mockStore,
      platform,
      evidencePolicy: { required: true },
    });

    const eventCalls = (mockStore.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls as unknown[][];
    const evidenceEvent = eventCalls.find(
      call => (call[0] as { event_type: string }).event_type === 'evidence_validation_failed'
    );
    expect(evidenceEvent).toBeDefined();
    const eventData = (evidenceEvent?.[0] as { data: Record<string, unknown> }).data;
    expect(eventData.expected_path).toBe(join(artifactsDir, 'evidence.json'));

    expect(mockStore.failWorkflowRun).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      exitReason: 'evidence_missing',
    });
  });

  it('carries prior run usage onto the evidence-gate workflow_error row', async () => {
    await runEvidenceWorkflow({
      store: createMockStore(),
      platform: createMockPlatform(),
      evidencePolicy: { required: true },
      priorUsage: {
        costUsd: 0.03,
        tokens: { input: 300, output: 30, cacheRead: 200, cacheWrite: 0 },
      },
    });

    const errorRow = (await readTranscript(join(testDir, 'logs'), 'dag-evidence-run')).find(
      row => row.type === 'workflow_error'
    );
    expect(errorRow?.cost_usd).toBe(0.03);
    expect(errorRow?.tokens).toEqual({
      input: 300,
      output: 30,
      cacheRead: 200,
      cacheWrite: 0,
    });
  });

  it('any evidence.json contents satisfy the file-presence convention', async () => {
    const mockStore = createMockStore();
    const platform = createMockPlatform();
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, 'evidence.json'),
      '{"verified":true,"checks":["nothing was run"]}'
    );

    await runEvidenceWorkflow({
      store: mockStore,
      platform,
      evidencePolicy: { required: true },
    });

    expect((mockStore.completeWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect((mockStore.failWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  it('authored succeeded coexists with lifecycle failure when the marker is absent', async () => {
    const mockStore = createMockStore();

    await runEvidenceWorkflow({
      store: mockStore,
      platform: createMockPlatform(),
      evidencePolicy: { required: true },
      authoredGreen: true,
    });

    expect(authoredOutcomeWrites(mockStore)).toEqual(['succeeded']);
    expect(mockStore.failWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockStore.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it('authored failed coexists with lifecycle completion when the marker exists', async () => {
    const mockStore = createMockStore();
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, 'evidence.json'), 'self-asserted');

    await runEvidenceWorkflow({
      store: mockStore,
      platform: createMockPlatform(),
      evidencePolicy: { required: true },
      authoredGreen: false,
    });

    expect(authoredOutcomeWrites(mockStore)).toEqual(['failed']);
    expect(mockStore.completeWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockStore.failWorkflowRun).not.toHaveBeenCalled();
  });

  it('surfaces a failed completion write', async () => {
    const mockStore = createMockStore();
    (mockStore.completeWorkflowRun as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('terminal completion write failed')
    );
    const platform = createMockPlatform();
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, 'evidence.json'), '{"proof": "landed"}');

    await expect(runEvidenceWorkflow({ store: mockStore, platform })).rejects.toThrow(
      'terminal completion write failed'
    );
  });

  it('surfaces a failed failure write', async () => {
    const mockStore = createMockStore();
    (mockStore.failWorkflowRun as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('terminal failure write failed')
    );

    await expect(
      runEvidenceWorkflow({
        store: mockStore,
        platform: createMockPlatform(),
        evidencePolicy: { required: true },
      })
    ).rejects.toThrow('terminal failure write failed');
  });

  it('no evidence_policy declared -> completes without checking for evidence.json', async () => {
    const mockStore = createMockStore();
    const platform = createMockPlatform();

    await runEvidenceWorkflow({ store: mockStore, platform });

    expect((mockStore.completeWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect((mockStore.failWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  it('required: false -> completes without checking for evidence.json', async () => {
    const mockStore = createMockStore();
    const platform = createMockPlatform();

    await runEvidenceWorkflow({
      store: mockStore,
      platform,
      evidencePolicy: { required: false },
    });

    expect((mockStore.completeWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect((mockStore.failWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  it('resumed run (all nodes prior-completed) with evidence.json now present -> completes', async () => {
    // A run that failed the gate is resumed after evidence.json was produced:
    // every node is skipped as prior-completed, the executor re-enters the
    // completion path, and the gate now passes.
    const mockStore = createMockStore();
    const platform = createMockPlatform();
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, 'evidence.json'), '{"proof": "landed"}');

    await runEvidenceWorkflow({
      store: mockStore,
      platform,
      evidencePolicy: { required: true },
      priorCompletedNodes: new Map([['work', { output: 'done' }]]),
    });

    expect((mockStore.completeWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect((mockStore.failWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  it('resumed run without evidence.json -> fails the gate again', async () => {
    const mockStore = createMockStore();
    const platform = createMockPlatform();

    await runEvidenceWorkflow({
      store: mockStore,
      platform,
      evidencePolicy: { required: true },
      priorCompletedNodes: new Map([['work', { output: 'done' }]]),
    });

    expect((mockStore.completeWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    expect((mockStore.failWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Terminal status write ordering (#2910 R3)
// ───────────────────────────────────────────────────────────────────────────
describe('executeDagWorkflow -- side effects survive a failed terminal write', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-terminal-order-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  /** One always-succeeding bash node, so the run reaches the completion site. */
  const okNode: ExecNode = { id: 'ok', kind: 'exec', runtime: 'sh', script: 'echo done' };
  /** One always-failing bash node, so the run reaches the node-failure site. */
  const badNode: ExecNode = { id: 'bad', kind: 'exec', runtime: 'sh', script: 'exit 3' };

  async function run(
    store: MockWorkflowStore,
    platform: MockWorkflowPlatform,
    nodes: DagNode[],
    emitted: string[]
  ): Promise<unknown> {
    const workflowRun = makeWorkflowRun('terminal-order-run');
    const unsubscribe = getWorkflowEventEmitter().subscribe((event: WorkflowEmitterEvent) => {
      if ('runId' in event && event.runId === workflowRun.id) emitted.push(event.type);
    });
    try {
      return await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          platform,
          conversationId: 'conv-terminal-order',
          cwd: testDir,
          workflow: { name: 'terminal-order', nodes },
          workflowRun,
        })
      );
    } finally {
      unsubscribe();
    }
  }

  it('mixed layer rejections preserve terminal rollback after successful siblings settle', async () => {
    const store = createMockStore();
    const cause = new Error('cancel record failed');
    const nodeFailure = new Error('node storage offline');
    let siblingSettled = false;
    store.cancelWorkflowRun = mock(async () => {
      throw cause;
    });
    store.persistWorkflowEvent = mock(async event => {
      if (event.event_type === 'node_started' && event.step_name === 'ok') throw nodeFailure;
      if (event.event_type === 'node_completed' && event.step_name === 'sibling') {
        await new Promise(resolve => setTimeout(resolve, 5));
        siblingSettled = true;
      }
      await store.createWorkflowEvent(event);
    });
    mockLogFn.mockClear();
    await expect(
      run(
        store,
        createMockPlatform(),
        [okNode, { id: 'stop', kind: 'halt', reason: 'stop' }, { ...okNode, id: 'sibling' }],
        []
      )
    ).rejects.toMatchObject({ name: 'TerminalStatusWriteError', cause });
    expect(siblingSettled).toBe(true);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
    expect(mockLogFn).toHaveBeenCalledWith(
      { err: expect.objectContaining({ cause: nodeFailure }), workflowRunId: 'terminal-order-run' },
      'dag.join_secondary_failure'
    );
  });

  it('propagates halt cancellation rollback without a compensating failure', async () => {
    const store = createMockStore();
    store.cancelWorkflowRun = mock(async () => {
      throw new Error('cancel record failed');
    });
    await expect(
      run(store, createMockPlatform(), [{ id: 'stop', kind: 'halt', reason: 'stop' }], [])
    ).rejects.toThrow('Failed to persist terminal workflow status: cancel record failed');
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it('propagates a loop_group body halt write failure after paid work', async () => {
    const store = createMockStore();
    const cause = new Error('cancel record failed');
    store.cancelWorkflowRun = mock(async () => {
      throw cause;
    });
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Paid work.' };
      yield {
        type: 'result',
        sessionId: 'halt-body-session',
        cost: 0.05,
        tokens: { input: 100, output: 10 },
      };
    });
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    await expect(
      run(
        store,
        createMockPlatform(),
        [
          {
            id: 'grp',
            kind: 'loop_group',
            loop_group: {
              until: 'DONE',
              max_iterations: 2,
              fresh_context: false,
              nodes: [
                { id: 'work', kind: 'agent', source: { kind: 'inline', prompt: 'Work.' } },
                { id: 'stop', kind: 'halt', reason: 'stop', depends_on: ['work'] },
              ],
            },
          },
        ],
        []
      )
    ).rejects.toMatchObject({ name: 'TerminalStatusWriteError', cause });
    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    expect(
      persistedEvents(store).find(
        event => event.event_type === 'node_completed' && event.step_name === 'grp.work'
      )?.data?.cost_usd
    ).toBe(0.05);
    expect(store.cancelWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it('awaits committed node lifecycle before the run terminal write', async () => {
    const store = createMockStore();
    const committed: string[] = [];
    store.persistWorkflowEvent = mock(async event => {
      await new Promise(resolve => setTimeout(resolve, 5));
      committed.push(event.event_type);
    });
    store.completeWorkflowRun = mock(async () => {
      expect(committed).toEqual(['node_started', 'node_completed']);
    });
    await run(store, createMockPlatform(), [okNode], []);
    expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('does not retry or report success when node completion cannot be stored', async () => {
    const store = createMockStore();
    store.persistWorkflowEvent = mock(async event => {
      if (event.event_type === 'node_completed') throw new Error('storage offline');
    });
    const emitted: string[] = [];
    await expect(
      run(
        store,
        createMockPlatform(),
        [{ ...okNode, retry: { max_attempts: 2, on_error: 'all', delay_ms: 1 } }],
        emitted
      )
    ).rejects.toThrow('Could not persist node_completed for ok: storage offline');
    expect(
      store.persistWorkflowEvent.mock.calls.filter(([event]) => event.event_type === 'node_started')
    ).toHaveLength(1);
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
    expect(emitted).not.toContain('node_completed');
  });

  it.each(['agent', 'script', 'loop'] as const)(
    'does not retry successful %s work when its completion write rejects',
    async kind => {
      const store = createMockStore();
      const cause = new Error('completion storage rejected');
      store.persistWorkflowEvent = mock(async event => {
        if (event.event_type === 'node_completed') throw cause;
        await store.createWorkflowEvent(event);
      });
      mockSendQueryDag.mockClear();
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: '<promise>DONE</promise>' };
        yield {
          type: 'result',
          sessionId: 'completion-test',
          cost: 0.25,
          tokens: { input: 100, output: 20 },
        };
      });
      mockGetAgentProviderDag.mockImplementation(() => ({
        sendQuery: mockSendQueryDag,
        checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
        getType: () => 'claude',
        getCapabilities: mockClaudeCapabilities,
      }));
      const retry = { max_attempts: 2, on_error: 'all' as const, delay_ms: 1 };
      const node: DagNode =
        kind === 'agent'
          ? { id: 'work', kind: 'agent', source: { kind: 'inline', prompt: 'finish once' }, retry }
          : kind === 'loop'
            ? {
                id: 'work',
                kind: 'loop',
                loop: {
                  prompt: 'finish once',
                  until: 'DONE',
                  max_iterations: 3,
                  fresh_context: false,
                },
                retry: { max_attempts: 2, delay_ms: 1 },
              }
            : {
                id: 'work',
                kind: 'exec',
                runtime: 'bun',
                script:
                  'import { appendFileSync } from "node:fs"; appendFileSync("workload-count", "x"); console.log("done");',
                retry,
              };
      const emitted: string[] = [];
      await expect(run(store, createMockPlatform(), [node], emitted)).rejects.toMatchObject({
        name: 'NodeEventWriteError',
        cause,
      });
      if (kind !== 'script') expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
      else expect(await readFile(join(testDir, 'workload-count'), 'utf8')).toBe('x');
      expect(
        store.persistWorkflowEvent.mock.calls.filter(
          ([event]) => event.event_type === 'node_failed'
        )
      ).toHaveLength(0);
      expect(emitted).not.toContain('node_completed');
      expect(store.completeWorkflowRun).not.toHaveBeenCalled();
    }
  );

  it('still emits workflow_completed and telemetry when the completion write rejects', async () => {
    const store = createMockStore();
    store.completeWorkflowRun = mock(async () => {
      throw new Error('completion write failed');
    });
    const emitted: string[] = [];

    await expect(run(store, createMockPlatform(), [okNode], emitted)).rejects.toThrow(
      'Failed to persist terminal workflow status'
    );

    expect(emitted).toContain('workflow_completed');
  });

  it.each([false, true])(
    'withholds live failure but unregisters the run when the failure write rejects (successful sibling: %s)',
    async successfulSibling => {
      const store = createMockStore();
      store.failWorkflowRun = mock(async () => {
        throw new Error('failure write failed');
      });
      const platform = createMockPlatform();
      const emitted: string[] = [];
      const emitter = getWorkflowEventEmitter();
      emitter.registerRun('terminal-order-run', 'conv-terminal-order');

      await expect(
        run(store, platform, [...(successfulSibling ? [okNode] : []), badNode], emitted)
      ).rejects.toThrow('Failed to persist terminal workflow status');

      expect(emitted).not.toContain('workflow_failed');
      expect(emitter.getConversationId('terminal-order-run')).toBeUndefined();
      const sent = platform.sendMessage.mock.calls.map(c => c[1]);
      expect(
        sent.some(m => m.includes(successfulSibling ? 'completed with failures' : 'failed: node'))
      ).toBe(true);
    }
  );

  it.each([false, true])(
    'announces no failure another writer already committed (successful sibling: %s)',
    async successfulSibling => {
      const store = createMockStore();
      store.failWorkflowRun = mock(async () => ({ failed: false }));
      // A status read after the write fails, so only the write result can decide the announcement.
      store.getWorkflowRunStatus = mock(async () => {
        if (store.failWorkflowRun.mock.calls.length > 0) throw new Error('status read failed');
        return 'running' as const;
      });
      const emitted: string[] = [];

      await run(
        store,
        createMockPlatform(),
        [...(successfulSibling ? [okNode] : []), badNode],
        emitted
      );

      expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
      expect(emitted).not.toContain('workflow_failed');
    }
  );
});

describe('executeDagWorkflow -- completed run worktree release', () => {
  const proof = { envId: 'env-release', creationId: 'creation-release' };
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-release-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  async function complete(
    disposition: WorktreeDisposition | null,
    release: () => Promise<void> = async () => {},
    readRun: (id: string) => Promise<WorkflowRun | null> = async id =>
      makeWorkflowRun(id, { working_path: '/wt', metadata: { owned_worktree: proof } })
  ): Promise<{
    order: string[];
    store: MockWorkflowStore;
    released: boolean;
    seen: WorkflowRun[];
    warnings: string[];
  }> {
    const order: string[] = [];
    const seen: WorkflowRun[] = [];
    let released = false;
    const mockDeps = createMockDeps();
    mockDeps.store.completeWorkflowRun.mockImplementation(async () => {
      order.push('complete');
    });
    // The in-memory run predates the proof a pre-created run's row receives later.
    mockDeps.store.getWorkflowRun.mockImplementation(readRun);
    const deps: MockWorkflowDeps<MockWorkflowStore> = {
      ...mockDeps,
      completedRunWorktree: {
        assess: async run => {
          order.push('assess');
          seen.push(run);
          return disposition;
        },
        release: async run => {
          order.push('release');
          seen.push(run);
          released = true;
          await release();
        },
      },
    };
    const platform = createMockPlatform();
    await executeDagWorkflow(
      dagOptions({
        deps,
        platform,
        conversationId: 'conv-release',
        cwd: testDir,
        workflow: {
          name: 'release-test',
          nodes: [{ id: 'only', kind: 'exec', runtime: 'sh', script: 'echo done' }],
        },
        workflowRun: makeWorkflowRun('release-run-id'),
      })
    );
    const warnings = platform.sendMessage.mock.calls
      .map(call => call[1])
      .filter(message => message.includes('Kept worktree'));
    return { order, store: mockDeps.store, released, seen, warnings };
  }

  it('records the assessment in the completion and releases only after the write', async () => {
    const { order, store, seen, warnings } = await complete({ disposition: 'release' });

    expect(order).toEqual(['assess', 'complete', 'release']);
    expect(warnings).toEqual([]);
    expect(seen.map(run => run.metadata.owned_worktree)).toEqual([proof, proof]);
    expect(store.completeWorkflowRun.mock.calls[0]?.[2]).toMatchObject({
      worktree_disposition: { disposition: 'release' },
    });
  });

  it('keeps a retained worktree and records why', async () => {
    const retained: WorktreeDisposition = {
      disposition: 'retained',
      reason: 'unpushed_commits',
      detail: '2 commit(s) on no remote',
    };
    const { order, store, released, warnings } = await complete(retained);

    expect(released).toBe(false);
    expect(order).toEqual(['assess', 'complete']);
    expect(store.completeWorkflowRun.mock.calls[0]?.[2]).toMatchObject({
      worktree_disposition: retained,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('/wt');
    expect(warnings[0]).toContain('2 commit(s) on no remote');
  });

  it('keeps a workspace the platform retains without a warning', async () => {
    const { warnings } = await complete({
      disposition: 'retained',
      reason: 'workspace_retained',
    });

    expect(warnings).toEqual([]);
  });

  it('leaves the run completed when the release fails', async () => {
    const { order, store, warnings } = await complete({ disposition: 'release' }, async () => {
      throw new Error('worktree is no longer releasable: uncommitted_changes');
    });

    expect(order).toEqual(['assess', 'complete', 'release']);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('no longer releasable: uncommitted_changes');
  });

  it('completes the run without a disposition when the run cannot be re-read', async () => {
    const { order, store } = await complete({ disposition: 'release' }, undefined, async () => {
      throw new Error('store unavailable');
    });

    expect(order).toEqual(['complete']);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun.mock.calls[0]?.[2]).not.toHaveProperty('worktree_disposition');
  });
});
