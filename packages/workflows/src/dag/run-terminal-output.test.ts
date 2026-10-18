// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import { getProviderCapabilities } from '@archon/providers';
import { type MessageChunk } from '@archon/provider-contract';
import {
  mockLogFn,
  createMockStore,
  runUsageWrites,
  withProviderCapabilities,
  mockClaudeCapabilities,
  mockProviderRegistry,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  persistedEvents,
  minimalConfig,
  dagOptions,
  makeWorkflowRun,
  readTranscript,
} from './test-utils';
import { executeDagWorkflow } from '../dag-executor';
import type { IWorkflowStore } from '../store';

describe('executeDagWorkflow -- terminal node output selection', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-terminal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'Command prompt $ARGUMENTS');

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
    await removeTempTree(testDir);
  });

  it('returns output of the single terminal node in a linear DAG', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Final summary text' };
      yield { type: 'result', sessionId: 'sess-linear' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const result = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'linear-dag',
          nodes: [
            { id: 'step1', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } },
            {
              id: 'step2',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              depends_on: ['step1'],
            },
          ],
        },
        workflowRun,
      })
    );

    expect(result).toBe('Final summary text');
  });

  it('fails node when the AI stream closes with no assistant output', async () => {
    // Empty assistant output on AI nodes (`command:`/`prompt:`) typically
    // indicates a silent provider rejection or stream interruption that
    // didn't yield a result.isError chunk. Treat it as a node failure
    // rather than a successful empty completion.
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'result',
        sessionId: 'sess-empty',
        cost: 0.02,
        tokens: { input: 30, output: 3, cacheRead: 20, cacheWrite: 0 },
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
          name: 'empty-dag',
          nodes: [
            {
              id: 'only',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              retry: { max_attempts: 1, delay_ms: 1 },
            },
          ],
        },
        workflowRun,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const nodeFailedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(nodeFailedEvents.length).toBeGreaterThan(0);
    const failedData = (nodeFailedEvents[0][0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(failedData.error).toContain('produced no assistant output');
    // The node's failure row carries only the FINAL attempt's spend; the run total
    // accumulates every attempt — the empty-stream error is transient-retried (#2706),
    // and this node spent its retry budget (max_attempts: 1 → two paid attempts).
    expect(failedData.cost_usd).toBe(0.02);
    expect(failedData.tokens).toEqual({
      input: 30,
      output: 3,
      cacheRead: 20,
      cacheWrite: 0,
    });
    expect(runUsageWrites(store)).toEqual([
      {
        total_cost_usd: 0.04,
        total_tokens_in: 60,
        total_tokens_out: 6,
        total_cache_read_tokens: 40,
        total_cache_write_tokens: 0,
      },
    ]);
    // Workflow-level failure must propagate, not just the node event.
    expect(store.failWorkflowRun).toHaveBeenCalled();

    // Each attempt reports on its own `node_error` row, so the transcript is where a
    // reader sees both paid attempts — the durable failure row above carries only the
    // final one. Their sum is the run total (#3508).
    const rows = await readTranscript(join(testDir, 'logs'), workflowRun.id);
    const attemptRows = rows.filter(row => row.type === 'node_error' && row.step === 'only');
    expect(attemptRows.map(row => row.cost_usd)).toEqual([0.02, 0.02]);
    expect(
      rows
        .filter(row => row.type === 'node_complete' || row.type === 'node_error')
        .reduce((total, row) => total + (typeof row.cost_usd === 'number' ? row.cost_usd : 0), 0)
    ).toBeCloseTo(0.04, 10);
  });

  it('does NOT fail node when stream yields no assistant text but a structuredOutput is present', async () => {
    // Output-format nodes legitimately produce zero free-form text — the
    // useful payload is the structuredOutput field. The empty-output guard
    // must spare them.
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'result',
        sessionId: 'sess-structured',
        structuredOutput: { category: 'math' },
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
          name: 'structured-only-dag',
          nodes: [
            {
              id: 'classify',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'Classify this' },
              output_format: { type: 'object', properties: {} },
            },
          ],
        },
        workflowRun,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const nodeFailedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(nodeFailedEvents.length).toBe(0);
    const nodeCompletedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_completed'
    );
    expect(nodeCompletedEvents.length).toBeGreaterThan(0);
  });

  it('idle-timeout with zero output produces node_failed, not node_completed', async () => {
    // Regression test for #1807: idle-timeout before first token must fail, not silently complete.
    // The generator yields nothing; idle_timeout fires before any output is produced.
    mockSendQueryDag.mockImplementation(async function* (
      _prompt: string,
      _cwd: string,
      _resumeSessionId?: string,
      options?: { abortSignal?: AbortSignal }
    ) {
      // Wait for abort (idle timeout fires abort).
      await new Promise<void>(resolve => {
        if (options?.abortSignal?.aborted) {
          resolve();
        } else {
          options?.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
        }
      });
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
          name: 'idle-timeout-no-output',
          nodes: [
            {
              id: 'classify',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              idle_timeout: 50,
              // Disable retries so the test doesn't wait for retry delays (a timeout
              // is transient, which would trigger the default 2-retry / 3s-delay
              // policy otherwise).
              retry: { max_attempts: 0 },
            },
          ],
        },
        workflowRun,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const nodeFailedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(nodeFailedEvents.length).toBeGreaterThan(0);
    const failedData = (nodeFailedEvents[0][0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(failedData.error).toContain('timed out with no output');
    const nodeCompletedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_completed'
    );
    expect(nodeCompletedEvents.length).toBe(0);
    expect(store.failWorkflowRun).toHaveBeenCalled();
    const transcript = await readTranscript(join(testDir, 'logs'), workflowRun.id);
    expect(transcript.filter(event => event.type === 'watchdog_reset')).toHaveLength(0);
    expect(failedData.error).toContain('No provider chunk reset the watchdog');
  });

  it('a thinking-only stream renews the watchdog and persists a type-only timeout diagnostic', async () => {
    const privateThinking = 'reasoning the diagnostic must not copy';
    let yielded = 0;
    mockSendQueryDag.mockImplementation(async function* (
      _prompt: string,
      _cwd: string,
      _resumeSessionId?: string,
      options?: { abortSignal?: AbortSignal }
    ) {
      for (let i = 0; i < 3; i++) {
        await new Promise(resolve => setTimeout(resolve, 30));
        if (options?.abortSignal?.aborted) return;
        yielded++;
        yield { type: 'agent_thought_chunk', text: `${privateThinking} ${String(i)}` };
      }
      await new Promise<void>(resolve => {
        if (options?.abortSignal?.aborted) resolve();
        else options?.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    const store = createMockStore();
    const workflowRun = makeWorkflowRun('thinking-only-timeout');
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'thinking-only-timeout',
          nodes: [
            {
              id: 'review',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              idle_timeout: 70,
              retry: { max_attempts: 0 },
            },
          ],
        },
        workflowRun,
      })
    );

    expect(yielded).toBe(3);
    const transcript = await readTranscript(join(testDir, 'logs'), workflowRun.id);
    const resetEvents = transcript.filter(event => event.type === 'watchdog_reset');
    // Three renewals 30ms apart are one burst: its first and last renewal.
    expect(resetEvents.map(event => [event.chunk_type, event.chunk_count])).toEqual([
      ['agent_thought_chunk', 1],
      ['agent_thought_chunk', 2],
    ]);
    expect(resetEvents.every(event => !('content' in event))).toBe(true);
    expect(resetEvents.every(event => !Number.isNaN(Date.parse(String(event.ts))))).toBe(true);
    // The thinking is recorded once, as the provider's events; the diagnostic only names its type.
    expect(JSON.stringify(resetEvents)).not.toContain(privateThinking);
    expect(
      transcript.filter(event => event.type === 'provider_event').map(event => event.event)
    ).toEqual(
      [0, 1, 2].map(i => ({ type: 'agent_thought_chunk', text: `${privateThinking} ${String(i)}` }))
    );

    const failed = transcript.find(event => event.type === 'node_error' && event.step === 'review');
    // The transcript's last record is the renewal the stall diagnostic names.
    expect(failed?.error).toContain(
      `Last watchdog reset: ${String(resetEvents.at(-1)?.ts)} from chunk type 'agent_thought_chunk'.`
    );
  });

  it.each(
    (['agent', 'loop'] as const).flatMap(kind => [
      { kind, provider: 'claude', taskType: undefined, thresholdMs: 20 },
      { kind, provider: 'claude', taskType: undefined, thresholdMs: 0 },
      { kind, provider: 'codex', taskType: 'command_execution', thresholdMs: 20 },
      { kind, provider: 'codex', taskType: 'local_agent', thresholdMs: 20 },
      { kind, provider: 'claude', taskType: 'background', thresholdMs: 20 },
    ])
  )('silent reported work stays live: %j', async ({ kind, provider, taskType, thresholdMs }) => {
    const store = createMockStore();
    const workflowRun = makeWorkflowRun(`live-tool-${kind}`);
    let signal: AbortSignal | undefined;
    let complete: (() => void) | undefined;
    const completion = new Promise<void>(resolve => {
      complete = resolve;
    });
    let raised: (() => void) | undefined;
    const publication = new Promise<void>(resolve => {
      raised = resolve;
    });
    store.setToolCallAttention.mockImplementation(async (_runId, _streamId, calls) => {
      workflowRun.metadata.tool_call_attention = calls;
      if (calls.length) raised?.();
      return true;
    });
    let reachedWork: (() => void) | undefined;
    const workOpen = new Promise<void>(resolve => {
      reachedWork = resolve;
    });
    mockSendQueryDag.mockImplementationOnce(async function* (_prompt, _cwd, _session, options) {
      signal = options?.abortSignal;
      yield taskType
        ? { type: 'subtask', taskId: 'live', status: 'started', taskType, description: 'bun test' }
        : { type: 'tool_call', toolCallId: 'live', name: 'Bash', title: 'bun test' };
      // Resumed only once the executor has consumed the open-work event.
      reachedWork?.();
      await completion;
      yield taskType
        ? { type: 'subtask', taskId: 'live', status: 'completed' }
        : { type: 'tool_call_update', toolCallId: 'live', status: 'completed' };
      yield { type: 'agent_message_chunk', text: '{"done":true}' };
      yield { type: 'result', sessionId: 'session', structuredOutput: { done: true } };
      yield { type: 'settled', reason: 'turn_complete' };
    });
    const deps = createMockDeps(
      store,
      withProviderCapabilities(mockProviderRegistry, provider, {
        ...getProviderCapabilities(provider),
        backgroundWork: 'reported',
      })
    );
    const config = {
      ...minimalConfig,
      workflows: {
        autoResumeOnQuotaReset: false,
        toolCallAttentionMs: thresholdMs,
      },
    };
    const node =
      kind === 'agent'
        ? {
            id: 'implement',
            kind: 'agent' as const,
            source: { kind: 'command' as const, name: 'my-cmd' },
            idle_timeout: 10,
            retry: { max_attempts: 0 },
          }
        : {
            id: 'implement',
            kind: 'loop' as const,
            idle_timeout: 10,
            output_format: {
              type: 'object',
              properties: { done: { type: 'boolean' } },
              required: ['done'],
            },
            loop: {
              fresh_context: false,
              prompt: 'Implement',
              max_iterations: 1,
              until_field: 'done',
            },
          };
    const execution = executeDagWorkflow(
      dagOptions({
        deps,
        workflowProvider: provider,
        config,
        cwd: testDir,
        workflow: { name: 'live-tool', nodes: [node] },
        workflowRun,
      })
    );
    try {
      // Reaching the open work is bounded by the test's own budget, not a fixed timer:
      // startup took 110-190 ms here and over a second on a loaded Windows runner. With
      // attention disabled, the 80 ms after the work opens is the window in which it must
      // stay quiet.
      if (thresholdMs === 0) {
        await workOpen;
        await Bun.sleep(80);
      } else {
        await publication;
      }
      expect(signal?.aborted).toBe(false);
      expect(workflowRun.status).toBe('running');
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.cancelWorkflowRun).not.toHaveBeenCalled();
      expect(store.pauseWorkflowRun).not.toHaveBeenCalled();
      expect(
        store.createWorkflowEvent.mock.calls.some(
          ([event]) => event.event_type === 'node_started' && event.step_name === 'implement'
        )
      ).toBe(true);
      expect(
        store.createWorkflowEvent.mock.calls.some(
          ([event]) => event.event_type === 'node_completed' && event.step_name === 'implement'
        )
      ).toBe(false);
      if (thresholdMs === 0) expect(store.setToolCallAttention).not.toHaveBeenCalled();
      else
        expect(workflowRun.metadata.tool_call_attention).toMatchObject([
          { nodeId: 'implement', provider, name: taskType ?? 'Bash', title: 'bun test' },
        ]);
    } finally {
      // Settle the run even when an assertion failed, so it cannot consume a later test's mock.
      complete?.();
      await execution;
    }
    if (thresholdMs === 0) expect(store.setToolCallAttention).not.toHaveBeenCalled();
    else expect(store.setToolCallAttention.mock.calls.at(-1)?.[2]).toEqual([]);
    expect(signal?.aborted).toBe(false);
  });

  it.each(['agent', 'loop'] as const)(
    'failed %s stream cleanup clears while its successor remains running',
    async kind => {
      const store = createMockStore();
      const workflowRun = makeWorkflowRun(`cleanup-${kind}`);
      const snapshots = new Map<string, Parameters<IWorkflowStore['setToolCallAttention']>[2]>();
      let firstStream: string | undefined;
      let failures = 0;
      let recovered = false;
      let finishFirst!: () => void;
      const firstPublished = new Promise<void>(resolve => {
        finishFirst = resolve;
      });
      let finishSecond!: () => void;
      const secondCompletion = new Promise<void>(resolve => {
        finishSecond = resolve;
      });
      let enteredSecond!: () => void;
      const secondStarted = new Promise<void>(resolve => {
        enteredSecond = resolve;
      });
      store.setToolCallAttention.mockImplementation(async (_runId, streamId, calls) => {
        if (firstStream === undefined && calls.length) firstStream = streamId;
        if (streamId === firstStream && calls.length === 0 && !recovered) {
          failures++;
          throw new Error('Transient cleanup outage');
        }
        snapshots.set(streamId, calls);
        workflowRun.metadata.tool_call_attention = [...snapshots.values()].flat();
        if (streamId === firstStream && calls.length) finishFirst();
        return true;
      });
      mockSendQueryDag.mockImplementationOnce(async function* () {
        yield { type: 'tool_call', toolCallId: 'first', name: 'Bash' };
        await firstPublished;
        yield { type: 'result', sessionId: 's', structuredOutput: { done: true } };
        yield { type: 'tool_call_update', toolCallId: 'first', status: 'completed' };
        yield { type: 'settled', reason: 'turn_complete' };
      });
      mockSendQueryDag.mockImplementationOnce(async function* () {
        recovered = true;
        yield { type: 'tool_call', toolCallId: 'successor', name: 'Bash' };
        enteredSecond();
        await secondCompletion;
        yield { type: 'tool_call_update', toolCallId: 'successor', status: 'completed' };
        yield { type: 'result', sessionId: 's' };
        yield { type: 'settled', reason: 'turn_complete' };
      });
      const firstNode =
        kind === 'agent'
          ? {
              id: 'first',
              kind,
              source: { kind: 'command' as const, name: 'my-cmd' },
              idle_timeout: 10,
            }
          : {
              id: 'first',
              kind,
              idle_timeout: 10,
              output_format: {
                type: 'object',
                properties: { done: { type: 'boolean' } },
                required: ['done'],
              },
              loop: {
                fresh_context: false,
                prompt: 'Implement',
                max_iterations: 1,
                until_field: 'done',
              },
            };
      const execution = executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflowRun,
          config: {
            ...minimalConfig,
            workflows: {
              autoResumeOnQuotaReset: false,
              toolCallAttentionMs: 20,
            },
          },
          workflow: {
            name: 'cleanup-retry',
            nodes: [
              firstNode,
              {
                id: 'next',
                kind: 'agent',
                source: { kind: 'command', name: 'my-cmd' },
                depends_on: ['first'],
                idle_timeout: 10,
              },
            ],
          },
        })
      );
      try {
        await secondStarted;
        expect(failures).toBe(4);
        expect(snapshots.get(firstStream!)).toEqual([]);
        expect(workflowRun.status).toBe('running');
        expect(store.failWorkflowRun).not.toHaveBeenCalled();
        expect(store.cancelWorkflowRun).not.toHaveBeenCalled();
      } finally {
        finishFirst();
        finishSecond();
        await execution;
      }
    }
  );

  it('a stream of many chunks writes a bounded number of reset records with every renewal counted', async () => {
    const chunkCount = 300;
    mockSendQueryDag.mockImplementation(async function* (
      _prompt: string,
      _cwd: string,
      _resumeSessionId?: string,
      options?: { abortSignal?: AbortSignal }
    ) {
      for (let i = 0; i < chunkCount; i++) {
        if (i % 50 === 0) await new Promise(resolve => setTimeout(resolve, 1));
        yield { type: 'agent_thought_chunk', text: 'private reasoning' };
      }
      yield {
        type: 'tool_call',
        toolCallId: 'call-1',
        name: 'Bash',
        rawInput: { command: 'private tool input' },
      };
      yield { type: 'tool_call_update', toolCallId: 'call-1', status: 'completed' };
      await new Promise<void>(resolve => {
        if (options?.abortSignal?.aborted) resolve();
        else options?.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    const store = createMockStore();
    const workflowRun = makeWorkflowRun('many-chunks-timeout');
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'many-chunks-timeout',
          nodes: [
            {
              id: 'review',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              idle_timeout: 50,
              retry: { max_attempts: 0 },
            },
          ],
        },
        workflowRun,
      })
    );

    const transcript = await readTranscript(join(testDir, 'logs'), workflowRun.id);
    const resetEvents = transcript.filter(event => event.type === 'watchdog_reset');
    expect(resetEvents.map(event => [event.step, event.chunk_type, event.chunk_count])).toEqual([
      ['review', 'agent_thought_chunk', 1],
      ['review', 'tool_call_update', chunkCount + 1],
    ]);
    const failed = transcript.find(event => event.type === 'node_error' && event.step === 'review');
    expect(failed?.error).toContain(
      `Last watchdog reset: ${String(resetEvents.at(-1)?.ts)} from chunk type 'tool_call_update'.`
    );
  });

  it('loop timeout diagnostics retain the latest reset and distinguish tool progress from assistant output', async () => {
    const runCase = async (
      runId: string,
      chunks: MessageChunk[]
    ): Promise<{ transcript: Array<Record<string, unknown>>; error: string }> => {
      mockSendQueryDag.mockImplementationOnce(async function* (
        _prompt: string,
        _cwd: string,
        _resumeSessionId?: string,
        options?: { abortSignal?: AbortSignal }
      ) {
        for (const chunk of chunks) yield chunk;
        await new Promise<void>(resolve => {
          if (options?.abortSignal?.aborted) resolve();
          else options?.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
        });
      });

      const store = createMockStore();
      const workflowRun = makeWorkflowRun(runId);
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflow: {
            name: runId,
            nodes: [
              {
                id: 'implement',
                kind: 'loop',
                output_format: {
                  type: 'object',
                  properties: { done: { type: 'boolean' } },
                  required: ['done'],
                },
                loop: {
                  fresh_context: false,
                  prompt: 'Implement the change.',
                  max_iterations: 1,
                  until_field: 'done',
                },
                idle_timeout: 50,
              },
            ],
          },
          workflowRun,
        })
      );

      const transcript = await readTranscript(join(testDir, 'logs'), workflowRun.id);
      const failed = transcript.find(event => event.type === 'node_error');
      return { transcript, error: String(failed?.error) };
    };

    const tool = await runCase('loop-tool-timeout', [
      { type: 'agent_thought_chunk', text: 'private reasoning' },
      {
        type: 'tool_call',
        toolCallId: 'call-1',
        name: 'Bash',
        rawInput: { command: 'private tool input' },
      },
      { type: 'tool_call_update', toolCallId: 'call-1', status: 'completed' },
    ]);
    const assistant = await runCase('loop-assistant-timeout', [
      {
        type: 'agent_message_chunk',
        text: 'user-visible output',
      },
    ]);

    const toolReset = tool.transcript.filter(event => event.type === 'watchdog_reset');
    const assistantReset = assistant.transcript.filter(event => event.type === 'watchdog_reset');
    // One burst: its start, then its end written by the iteration's flush.
    expect(toolReset.map(event => [event.step, event.chunk_type, event.chunk_count])).toEqual([
      ['implement-iteration-1', 'agent_thought_chunk', 1],
      ['implement-iteration-1', 'tool_call_update', 2],
    ]);
    expect(assistantReset.map(event => event.chunk_type)).toEqual(['agent_message_chunk']);
    expect(toolReset.every(event => !('content' in event) && !('tool_input' in event))).toBe(true);
    expect(assistantReset.every(event => !('content' in event))).toBe(true);
    expect(tool.error).toContain("chunk type 'tool_call_update'");
    expect(assistant.error).toContain("chunk type 'agent_message_chunk'");
    const recordedTypes = (transcript: Array<Record<string, unknown>>): unknown[] =>
      transcript
        .filter(event => event.type === 'provider_event')
        .map(event => (event.event as { type: string }).type);
    expect(recordedTypes(tool.transcript)).toEqual([
      'agent_thought_chunk',
      'tool_call',
      'tool_call_update',
    ]);
    expect(recordedTypes(assistant.transcript)).toEqual(['agent_message_chunk']);
  });

  it('idle-timeout with zero output fails a loop iteration instead of consuming its iteration budget', async () => {
    mockSendQueryDag.mockImplementationOnce(async function* (
      _prompt: string,
      _cwd: string,
      _resumeSessionId?: string,
      options?: { abortSignal?: AbortSignal }
    ) {
      await new Promise<void>(resolve => {
        if (options?.abortSignal?.aborted) resolve();
        else options?.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'COMPLETE' };
      yield { type: 'result', sessionId: 'implement-recovered' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 1)) as typeof setTimeout;
    try {
      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          cwd: testDir,
          workflow: {
            name: 'loop-idle-timeout-no-output',
            nodes: [
              {
                id: 'implement',
                kind: 'loop',
                loop: {
                  fresh_context: false,
                  prompt: 'Implement the change.',
                  until: 'COMPLETE',
                  max_iterations: 1,
                },
                idle_timeout: 50,
              },
            ],
          },
          workflowRun,
        })
      );

      expect(mockSendQueryDag).toHaveBeenCalledTimes(2);
      const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
      const loopFailed = eventCalls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).event_type === 'node_failed' &&
          (call[0] as Record<string, unknown>).step_name === 'implement'
      );
      expect(loopFailed).toBeUndefined();
      const iterationFailed = eventCalls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).event_type === 'loop_iteration_failed' &&
          (call[0] as Record<string, unknown>).step_name === 'implement'
      );
      expect(iterationFailed).toBeDefined();
      const timeoutError = (
        (iterationFailed![0] as Record<string, unknown>).data as Record<string, unknown>
      ).error as string;
      expect(timeoutError).toContain('timed out with no output');
      // The retried attempt must NOT have been announced as a completion first —
      // that contradiction is what moving the notification below the guard fixed.
      const notices = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(
        (call: unknown[]) => String(call[1])
      );
      expect(notices.some(text => text.includes('completed via idle timeout'))).toBe(false);
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it('idle-timeout with zero output fails a structured loop immediately, without transient retries', async () => {
    // A loop declaring output_format owns its own timeout failure: retrying it would
    // spend another full idle_timeout window per attempt for no new information, and
    // the single-shot AI node fails such a node on its first attempt.
    mockSendQueryDag.mockImplementation(async function* (
      _prompt: string,
      _cwd: string,
      _resumeSessionId?: string,
      options?: { abortSignal?: AbortSignal }
    ) {
      await new Promise<void>(resolve => {
        if (options?.abortSignal?.aborted) resolve();
        else options?.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 1)) as typeof setTimeout;
    try {
      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          cwd: testDir,
          workflow: {
            name: 'structured-loop-idle-timeout',
            nodes: [
              {
                id: 'implement',
                kind: 'loop',
                output_format: {
                  type: 'object',
                  properties: { done: { type: 'boolean' } },
                  required: ['done'],
                },
                loop: {
                  fresh_context: false,
                  prompt: 'Implement the change.',
                  max_iterations: 3,
                  until_field: 'done',
                },
                idle_timeout: 50,
              },
            ],
          },
          workflowRun,
        })
      );

      expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
      const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
      const failed = eventCalls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).event_type === 'node_failed' &&
          (call[0] as Record<string, unknown>).step_name === 'implement'
      );
      expect(failed).toBeDefined();
      expect(
        String(((failed![0] as Record<string, unknown>).data as Record<string, unknown>).error)
      ).toContain('timed out before producing the required structured output');
      const notices = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(
        (call: unknown[]) => String(call[1])
      );
      expect(notices.some(text => text.includes('completed via idle timeout'))).toBe(false);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it('loop output_format that ajv cannot compile fails the iteration (#2453)', async () => {
    // Same contract as the ordinary AI gate: an unenforceable schema is a failure,
    // not a warning that lets the iteration payload through unchecked.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: '{"done":true}' };
      yield { type: 'result', sessionId: 's', structuredOutput: { done: true } };
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
        workflowRun,
        workflow: {
          name: 'loop-uncompilable-schema',
          nodes: [
            {
              id: 'implement',
              kind: 'loop',
              output_format: {
                type: 'object',
                properties: { done: { type: 'boolean' }, detail: { $ref: '#/$defs/missing' } },
                required: ['done'],
              },
              loop: {
                fresh_context: false,
                prompt: 'Implement the change.',
                max_iterations: 2,
                until_field: 'done',
              },
            },
          ],
        },
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failed = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>).event_type === 'node_failed' &&
        (call[0] as Record<string, unknown>).step_name === 'implement'
    );
    expect(failed).toBeDefined();
    expect(
      String(((failed![0] as Record<string, unknown>).data as Record<string, unknown>).error)
    ).toContain('output_format schema cannot be compiled');
    // One iteration only: an unenforceable contract does not get retried.
    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
  });

  it('output_format set but provider returns no structured output → node_failed (Task 8 fail-fast)', async () => {
    // Provider replied with prose only; no structuredOutput on the result chunk.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Sure, the verdict is review.' };
      yield { type: 'result', sessionId: 's' };
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
          name: 'outfmt-missing',
          nodes: [
            {
              id: 'classify',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'classify it' },
              output_format: {
                type: 'object',
                properties: { verdict: { type: 'string' } },
                required: ['verdict'],
              },
              retry: { max_attempts: 0 },
            },
          ],
        },
        workflowRun,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failed = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(failed.length).toBeGreaterThan(0);
    const errMsg = ((failed[0][0] as Record<string, unknown>).data as Record<string, unknown>)
      .error as string;
    expect(errMsg).toContain('no schema-valid structured output');
  });

  it('output_format structured output failing schema validation → node_failed (Task 7)', async () => {
    // Provider returned a structured object missing the required `verdict` field.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: '{"confidence":0.9}' };
      yield { type: 'result', sessionId: 's', structuredOutput: { confidence: 0.9 } };
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
          name: 'outfmt-invalid',
          nodes: [
            {
              id: 'classify',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'classify it' },
              output_format: {
                type: 'object',
                properties: { verdict: { type: 'string' }, confidence: { type: 'number' } },
                required: ['verdict'],
              },
              retry: { max_attempts: 0 },
            },
          ],
        },
        workflowRun,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failed = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(failed.length).toBeGreaterThan(0);
    const errMsg = ((failed[0][0] as Record<string, unknown>).data as Record<string, unknown>)
      .error as string;
    expect(errMsg).toContain('failed schema validation');
  });

  it.each([
    ['claude', 1],
    ['pi', 4],
  ] as const)(
    '%s rejects a schema-echo and fails instead of completing the producer',
    async (provider, attempts) => {
      const echo = {
        type: 'object',
        properties: { verdict: { type: 'string', enum: ['review', 'skip'] } },
        verdict: '...',
      };
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: JSON.stringify(echo) };
        yield { type: 'result', sessionId: 's', structuredOutput: echo };
      });
      const store = createMockStore();

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflowRun: makeWorkflowRun(),
          workflowProvider: provider,
          config: { ...minimalConfig, assistant: provider },
          workflow: {
            name: 'schema-echo',
            nodes: [
              {
                id: 'classify',
                kind: 'agent',
                source: { kind: 'inline', prompt: 'classify it' },
                provider,
                output_format: {
                  type: 'object',
                  properties: { verdict: { type: 'string', enum: ['review', 'skip'] } },
                  required: ['verdict'],
                },
                retry: { max_attempts: 0 },
              },
              {
                id: 'review',
                kind: 'agent',
                source: { kind: 'inline', prompt: 'review it' },
                depends_on: ['classify'],
                when: "$classify.output.verdict == 'review'",
              },
            ],
          },
        })
      );

      expect(mockSendQueryDag).toHaveBeenCalledTimes(attempts);
      const events = persistedEvents(store);
      expect(events.filter(event => event.event_type === 'node_completed')).toHaveLength(0);
      expect(
        events.find(event => event.event_type === 'node_failed' && event.step_name === 'classify')
          ?.data?.error
      ).toContain('failed schema validation');
      expect(store.failWorkflowRun).toHaveBeenCalled();
      expect(store.completeWorkflowRun).not.toHaveBeenCalled();
    }
  );

  it('output_format that ajv cannot compile → node_failed, never an unenforced pass (#2453)', async () => {
    // The provider returned a perfectly shaped object. It still fails: the schema
    // is uncompilable, so "valid" here would only mean nothing was checked. The
    // loader rejects this file up front — this gate covers a definition that
    // reached the executor without it.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: '{"verdict":"ship"}' };
      yield { type: 'result', sessionId: 's', structuredOutput: { verdict: 'ship' } };
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
        workflowRun,
        workflow: {
          name: 'outfmt-uncompilable',
          nodes: [
            {
              id: 'classify',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'classify it' },
              output_format: {
                type: 'object',
                properties: { verdict: { $ref: '#/$defs/missing' } },
              },
              retry: { max_attempts: 0 },
            },
          ],
        },
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const eventTypes = eventCalls.map(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type
    );
    expect(eventTypes).not.toContain('node_completed');
    const failed = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(failed.length).toBeGreaterThan(0);
    const errMsg = ((failed[0][0] as Record<string, unknown>).data as Record<string, unknown>)
      .error as string;
    expect(errMsg).toContain("Node 'classify'");
    expect(errMsg).toContain('output_format schema cannot be compiled');
  });

  it('when: referencing a field not in the producer schema FAILS the node (not a silent skip)', async () => {
    // Regression guard: an unresolvable `.field` ref in a `when:` must fail the
    // dependent node (OutputRefError → node_failed), NOT fail-closed-skip it —
    // the exact regression that would silently revert the no-silent-drop fix.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: '{"verdict":"review"}' };
      yield { type: 'result', sessionId: 's', structuredOutput: { verdict: 'review' } };
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
          name: 'when-badref',
          nodes: [
            {
              id: 'gate',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'decide' },
              output_format: {
                type: 'object',
                properties: { verdict: { type: 'string' } },
                required: ['verdict'],
              },
              retry: { max_attempts: 0 },
            },
            {
              id: 'runme',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'go' },
              depends_on: ['gate'],
              when: "$gate.output.nonexistent == 'x'",
              retry: { max_attempts: 0 },
            },
          ],
        },
        workflowRun,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const runmeFailed = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>).event_type === 'node_failed' &&
        (call[0] as Record<string, unknown>).step_name === 'runme'
    );
    expect(runmeFailed).toBeDefined();
    const errMsg = ((runmeFailed![0] as Record<string, unknown>).data as Record<string, unknown>)
      .error as string;
    expect(errMsg).toContain('not declared in node');
  });

  it('when: object-valued field FAILS the consuming node instead of skipping it', async () => {
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
          name: 'when-object-field',
          nodes: [
            {
              id: 'producer',
              kind: 'exec',
              runtime: 'sh',
              script: `printf '%s' '{"route":{"ready":true}}'`,
            },
            {
              id: 'runme',
              kind: 'exec',
              runtime: 'sh',
              script: 'exit 99',
              depends_on: ['producer'],
              when: "$producer.output.route == 'true'",
            },
          ],
        },
        workflowRun,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const runmeEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).step_name === 'runme'
    );
    expect(runmeEvents.map(call => (call[0] as Record<string, unknown>).event_type)).toEqual([
      'node_failed',
    ]);
    const error = ((runmeEvents[0]![0] as Record<string, unknown>).data as Record<string, unknown>)
      .error as string;
    expect(error).toContain("Condition reference '$producer.output.route' resolved to an object");
  });

  it('best-effort provider: malformed-then-fixed structured output recovers within reasks', async () => {
    // Attempt 1 returns structured output missing the required `verdict`; the reask
    // loop re-runs and attempt 2 returns valid output → node COMPLETES (not failed).
    // Cost and token usage accumulate across both attempts.
    mockSendQueryDag.mockImplementationOnce(async function* () {
      yield {
        type: 'result',
        sessionId: 's1',
        structuredOutput: { other: 'x' },
        cost: 0.01,
        tokens: { input: 10, output: 1, cacheRead: 5, cacheWrite: 0 },
      };
    });
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'result',
        sessionId: 's2',
        structuredOutput: { verdict: 'review' },
        cost: 0.02,
        tokens: { input: 20, output: 2, cacheRead: 10, cacheWrite: 0 },
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
          name: 'reask-recover',
          nodes: [
            {
              id: 'classify',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'decide' },
              provider: 'pi',
              output_format: {
                type: 'object',
                properties: { verdict: { type: 'string' } },
                required: ['verdict'],
              },
              retry: { max_attempts: 0 },
            },
          ],
        },
        workflowRun,
        workflowProvider: 'pi',
        config: { ...minimalConfig, assistant: 'pi' },
      })
    );

    // sendQuery ran twice (original + 1 reask); node completed, not failed.
    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completed = eventCalls.filter(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>).event_type === 'node_completed' &&
        (call[0] as Record<string, unknown>).step_name === 'classify'
    );
    const failed = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(completed.length).toBe(1);
    expect(failed.length).toBe(0);
    // Cost accumulates across both attempts (0.01 + 0.02), not just the last pass.
    const cost = ((completed[0][0] as Record<string, unknown>).data as Record<string, unknown>)
      .cost_usd as number;
    expect(cost).toBeCloseTo(0.03, 5);
    const tokens = ((completed[0][0] as Record<string, unknown>).data as Record<string, unknown>)
      .tokens;
    expect(tokens).toEqual({
      input: 30,
      output: 3,
      cacheRead: 15,
      cacheWrite: 0,
    });
  });

  it('best-effort provider: the node after a re-ask continues the real session, not the re-ask (#3584)', async () => {
    // A reask runs in a throwaway session so the invalid turn is not carried forward.
    // That session holds one repaired turn and none of the node's work, so the node's
    // session (and what the next node resumes) stays attempt 0's.
    const sessions: Array<string | undefined> = [];
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* (
      _p: unknown,
      _cwd: unknown,
      resumeId: string | undefined
    ) {
      calls++;
      sessions.push(resumeId);
      if (calls === 1) {
        yield { type: 'result', sessionId: 'real', structuredOutput: { other: 'x' } };
      } else if (calls === 2) {
        yield { type: 'result', sessionId: 'throwaway', structuredOutput: { verdict: 'ok' } };
      } else {
        yield { type: 'agent_message_chunk', text: 'downstream ran' };
        yield { type: 'result', sessionId: 'after-session' };
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
          name: 'reask-session-threading',
          nodes: [
            {
              id: 'classify',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'decide' },
              provider: 'pi',
              output_format: {
                type: 'object',
                properties: { verdict: { type: 'string' } },
                required: ['verdict'],
              },
              retry: { max_attempts: 0 },
            },
            {
              id: 'after',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'continue' },
              provider: 'pi',
              depends_on: ['classify'],
            },
          ],
        },
        workflowRun,
        workflowProvider: 'pi',
        config: { ...minimalConfig, assistant: 'pi' },
      })
    );

    // 1: classify attempt 0. 2: the reask, deliberately fresh. 3: the next node.
    expect(sessions).toEqual([undefined, undefined, 'real']);
    // The node record names attempt 0's session, never the reask's.
    expect(
      persistedEvents(mockDeps.store)
        .filter(row => row.event_type === 'node_completed' && row.step_name === 'classify')
        .map(row => row.data?.session_id)
    ).toEqual(['real']);
  });

  it('flags the run total when only a middle node is silent about cache', async () => {
    // The run total is accumulated pairwise, so the middle contribution's silence has to
    // survive two more folds. A 2-round test cannot see this: rounds 1 and 3 both agree on
    // both axes, so a wrapper that drops the flag still produces a complete-looking total.
    mockSendQueryDag
      .mockImplementationOnce(async function* () {
        yield { type: 'agent_message_chunk', text: 'a' };
        yield { type: 'result', tokens: { input: 10, output: 1, cacheRead: 5, cacheWrite: 0 } };
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'agent_message_chunk', text: 'b' };
        // Silent middle: reports no cache telemetry at all.
        yield { type: 'result', tokens: { input: 20, output: 2 } };
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'agent_message_chunk', text: 'c' };
        yield { type: 'result', tokens: { input: 30, output: 3, cacheRead: 9, cacheWrite: 1 } };
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
          name: 'three-node-fold',
          nodes: [
            { id: 'a', kind: 'agent', source: { kind: 'inline', prompt: 'a' } },
            { id: 'b', kind: 'agent', source: { kind: 'inline', prompt: 'b' }, depends_on: ['a'] },
            { id: 'c', kind: 'agent', source: { kind: 'inline', prompt: 'c' }, depends_on: ['b'] },
          ],
        },
        workflowRun,
      })
    );

    expect(runUsageWrites(mockDeps.store)).toEqual([
      {
        total_tokens_in: 60,
        total_tokens_out: 6,
        total_cache_read_tokens: 14,
        total_cache_write_tokens: 1,
        total_cache_partial: true,
      },
    ]);
  });

  it('best-effort provider: an attempt without cache telemetry narrows the total to a floor', async () => {
    // Attempt 1 reports cache; attempt 2 reports none. The node's accumulated usage must
    // keep attempt 1's cache as a floor rather than discarding it — dropping the axes here
    // left gross `input` standing beside no cache context and read as "nothing cached" (#2662).
    mockSendQueryDag.mockImplementationOnce(async function* () {
      yield {
        type: 'result',
        sessionId: 's1',
        structuredOutput: { other: 'x' },
        cost: 0.01,
        tokens: { input: 10, output: 1, cacheRead: 5, cacheWrite: 0 },
      };
    });
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'result',
        sessionId: 's2',
        structuredOutput: { verdict: 'review' },
        cost: 0.02,
        tokens: { input: 20, output: 2 },
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
          name: 'reask-partial-cache',
          nodes: [
            {
              id: 'classify',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'decide' },
              provider: 'pi',
              output_format: {
                type: 'object',
                properties: { verdict: { type: 'string' } },
                required: ['verdict'],
              },
              retry: { max_attempts: 0 },
            },
          ],
        },
        workflowRun,
        workflowProvider: 'pi',
        config: { ...minimalConfig, assistant: 'pi' },
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completed = eventCalls.filter(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>).event_type === 'node_completed' &&
        (call[0] as Record<string, unknown>).step_name === 'classify'
    );
    expect(completed.length).toBe(1);
    const tokens = ((completed[0][0] as Record<string, unknown>).data as Record<string, unknown>)
      .tokens;
    // Gross input still sums across both attempts; the cache axes are attempt 1's alone.
    expect(tokens).toEqual({
      input: 30,
      output: 3,
      cacheRead: 5,
      cacheWrite: 0,
      cachePartial: true,
    });
    // And the flag survives the node -> run fold. Rebuilding the usage field-by-field
    // here dropped it, so a partial node total silently became a complete run total.
    expect(runUsageWrites(mockDeps.store)).toEqual([
      {
        total_cost_usd: 0.03,
        total_tokens_in: 30,
        total_tokens_out: 3,
        total_cache_read_tokens: 5,
        total_cache_write_tokens: 0,
        total_cache_partial: true,
      },
    ]);
  });

  it('best-effort provider: a non-finite reask cost does not erase prior valid cost', async () => {
    mockSendQueryDag.mockImplementationOnce(async function* () {
      yield { type: 'result', sessionId: 's1', structuredOutput: { other: 'x' }, cost: 0.01 };
    });
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'result',
        sessionId: 's2',
        structuredOutput: { verdict: 'review' },
        cost: Number.NaN,
      };
    });

    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'reask-nan-cost',
          nodes: [
            {
              id: 'classify',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'decide' },
              provider: 'pi',
              output_format: {
                type: 'object',
                properties: { verdict: { type: 'string' } },
                required: ['verdict'],
              },
              retry: { max_attempts: 0 },
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
        workflowProvider: 'pi',
        config: { ...minimalConfig, assistant: 'pi' },
      })
    );

    expect(runUsageWrites(store)).toEqual([{ total_cost_usd: 0.01 }]);
    expect(
      (mockLogFn as unknown as Mock<(obj: unknown, msg?: string) => void>).mock.calls.some(
        call => call[1] === 'dag_node.usage_cost_non_finite_ignored'
      )
    ).toBe(true);
  });

  it('best-effort provider: reask exhaustion fails loudly', async () => {
    // Every attempt returns invalid structured output → fail after 1 + maxReasks (3) tries.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'result', sessionId: 's', structuredOutput: { other: 'x' } };
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
          name: 'reask-exhaust',
          nodes: [
            {
              id: 'classify',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'decide' },
              provider: 'pi',
              output_format: {
                type: 'object',
                properties: { verdict: { type: 'string' } },
                required: ['verdict'],
              },
              retry: { max_attempts: 0 },
            },
          ],
        },
        workflowRun,
        workflowProvider: 'pi',
        config: { ...minimalConfig, assistant: 'pi' },
      })
    );

    // 1 initial + 3 reasks = 4 sendQuery calls, then fail-fast.
    expect(mockSendQueryDag.mock.calls.length).toBe(4);
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failed = eventCalls.find(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(failed).toBeDefined();
    const errMsg = ((failed![0] as Record<string, unknown>).data as Record<string, unknown>)
      .error as string;
    expect(errMsg).toContain('failed schema validation');
  });

  it('enforced provider does NOT reask on a validation miss (exactly one sendQuery)', async () => {
    // Claude is 'enforced' → maxReasks = 0. A validation miss must fail on the
    // FIRST pass — a regressed gate would silently make 4 API calls per miss.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'result', sessionId: 's', structuredOutput: { other: 'x' } };
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
          name: 'enforced-no-reask',
          nodes: [
            {
              id: 'classify',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'decide' },
              provider: 'claude',
              output_format: {
                type: 'object',
                properties: { verdict: { type: 'string' } },
                required: ['verdict'],
              },
              retry: { max_attempts: 0 },
            },
          ],
        },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failed = eventCalls.find(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(failed).toBeDefined();
  });

  it('best-effort provider: MISSING structured output triggers reask and recovers', async () => {
    // Attempt 1 returns prose with no structuredOutput; attempt 2 returns valid JSON.
    mockSendQueryDag.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: 'Sure, here you go.' };
      yield { type: 'result', sessionId: 's1' };
    });
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'result', sessionId: 's2', structuredOutput: { verdict: 'review' } };
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
          name: 'reask-missing',
          nodes: [
            {
              id: 'classify',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'decide' },
              provider: 'pi',
              output_format: {
                type: 'object',
                properties: { verdict: { type: 'string' } },
                required: ['verdict'],
              },
              retry: { max_attempts: 0 },
            },
          ],
        },
        workflowRun,
        workflowProvider: 'pi',
        config: { ...minimalConfig, assistant: 'pi' },
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completed = eventCalls.filter(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>).event_type === 'node_completed' &&
        (call[0] as Record<string, unknown>).step_name === 'classify'
    );
    expect(completed.length).toBe(1);
  });

  it('best-effort provider: idle-timeout on an output_format node does NOT reask', async () => {
    // Generator hangs → idle_timeout fires → abort. canReask is false (timed out),
    // so exactly one sendQuery and the failure names the timeout, not "prose".
    mockSendQueryDag.mockImplementation(async function* (
      _prompt: string,
      _cwd: string,
      _resumeSessionId?: string,
      options?: { abortSignal?: AbortSignal }
    ) {
      await new Promise<void>(resolve => {
        if (options?.abortSignal?.aborted) resolve();
        else options?.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
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
          name: 'reask-idle',
          nodes: [
            {
              id: 'classify',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'decide' },
              provider: 'pi',
              idle_timeout: 50,
              output_format: {
                type: 'object',
                properties: { verdict: { type: 'string' } },
                required: ['verdict'],
              },
              retry: { max_attempts: 0 },
            },
          ],
        },
        workflowRun,
        workflowProvider: 'pi',
        config: { ...minimalConfig, assistant: 'pi' },
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failed = eventCalls.find(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(failed).toBeDefined();
    const errMsg = ((failed![0] as Record<string, unknown>).data as Record<string, unknown>)
      .error as string;
    expect(errMsg).toContain('timed out');
  });

  it('fails a node whose provider idles out after output without settling — #3524', async () => {
    // The subprocess hung after the AI wrote output, so the provider never said its
    // turn was over. That is not a finished node.
    mockSendQueryDag.mockImplementation(async function* (
      _prompt: string,
      _cwd: string,
      _resumeSessionId?: string,
      options?: { abortSignal?: AbortSignal }
    ) {
      yield { type: 'agent_message_chunk', text: 'Here is the analysis result.' };
      // Hang until abort signal fires (idle timeout aborts the controller)
      await new Promise<void>(resolve => {
        options?.abortSignal?.addEventListener('abort', () => resolve());
      });
    });

    const store = createMockStore();
    const platform = createMockPlatform();

    await executeDagWorkflow(
      dagOptions({
        // The raw mock: a provider that breaks the settle contract.
        deps: { ...createMockDeps(store), getAgentProvider: mockGetAgentProviderDag },
        platform,
        cwd: testDir,
        workflow: {
          name: 'idle-timeout-with-output',
          nodes: [
            {
              id: 'step1',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              idle_timeout: 50,
              retry: { max_attempts: 0 },
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    const failed = persistedEvents(store).find(event => event.event_type === 'node_failed');
    expect(failed?.data?.failure_kind).toBe('timeout');
    expect(failed?.data?.error).toContain('before the provider signalled that its turn settled');
    expect(persistedEvents(store).some(event => event.event_type === 'node_completed')).toBe(false);
  });

  it('fails a node whose provider stream ends after its result without settling — #3524', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Here is the analysis result.' };
      yield { type: 'result', sessionId: 'sid' };
    });

    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: { ...createMockDeps(store), getAgentProvider: mockGetAgentProviderDag },
        platform: createMockPlatform(),
        cwd: testDir,
        workflow: {
          name: 'unsettled-stream',
          nodes: [{ id: 'step1', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } }],
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    const failed = persistedEvents(store).find(event => event.event_type === 'node_failed');
    expect(failed?.data?.failure_kind).toBe('unknown');
    expect(failed?.data?.error).toBe(
      "Node 'step1' failed: the provider stream ended without signalling that its turn settled. Its work may be incomplete."
    );
  });

  it('fails the run when a node specifies an unknown provider (defense-in-depth at execution time)', async () => {
    // Loader-time validation also catches this (loader.ts iterates dagNodes
    // after parsing), but the executor's resolveNodeProviderAndModel
    // throws as defense-in-depth in case a code path bypasses the loader.
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
          name: 'unknown-provider-dag',
          nodes: [
            {
              id: 'bad',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              provider: 'claud', // typo
            },
          ],
        },
        workflowRun,
      })
    );

    expect(store.failWorkflowRun).toHaveBeenCalled();
    // The "unknown provider" detail surfaces on the node_failed event; the
    // workflow-level fail message names the failing node(s).
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const nodeFailedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(nodeFailedEvents.length).toBeGreaterThan(0);
    const nodeFailedData = (nodeFailedEvents[0][0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(nodeFailedData.error).toContain("Unknown provider: 'claud'");
  });

  it('failure message names the failing node instead of generic summary', async () => {
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
          name: 'fail-msg-test',
          nodes: [
            {
              id: 'fail-node',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              provider: 'nonexistent',
            },
          ],
        },
        workflowRun,
      })
    );

    expect(store.failWorkflowRun).toHaveBeenCalled();
    const failCall = (store.failWorkflowRun as ReturnType<typeof mock>).mock.calls[0];
    const failMsg = failCall[1] as string;
    expect(failMsg).toContain('fail-node failed');
    expect(failMsg).not.toContain('no successful nodes');
  });

  it('excludes intermediate nodes with dependents from terminal set (fan-in DAG)', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      if (callCount === 3) {
        // Third call is for node 'c' (terminal)
        yield { type: 'agent_message_chunk', text: 'C final output' };
      } else {
        yield { type: 'agent_message_chunk', text: `Intermediate output ${callCount}` };
      }
      yield { type: 'result', sessionId: `sess-fanin-${callCount}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const result = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'fanin-dag',
          nodes: [
            { id: 'a', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } },
            { id: 'b', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } },
            {
              id: 'c',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              depends_on: ['a', 'b'],
            },
          ],
        },
        workflowRun,
      })
    );

    // Only 'c' is terminal (no node depends on it); 'a' and 'b' are not terminal
    expect(result).toBe('C final output');
  });
});
