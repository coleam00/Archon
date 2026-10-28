// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import { getProviderCapabilities } from '@archon/providers';
import {
  createMockStore,
  withProviderCapabilities,
  mockProviderRegistry,
  mockSendQueryDag,
  createMockDeps,
  persistedEvents,
  runUsageWrites,
  minimalConfig,
  dagOptions,
  makeWorkflowRun,
} from './test-utils';
import { executeDagWorkflow } from '../dag-executor';
import { CANCEL_CHECK_INTERVAL_MS } from './run-control';
import type { ProviderEvent } from '@archon/provider-contract';
import { runAttention } from '../schemas/workflow-run';
import { planEndTurn } from '../end-turn-request';

const DONE_SCHEMA = {
  type: 'object',
  properties: { done: { type: 'boolean' } },
  required: ['done'],
};

// A structured loop iteration carries its payload before it settles, so a cut-off
// iteration must still fail rather than be accepted on that payload.
const structuredLoop = (structured: boolean) =>
  structured
    ? {
        output_format: DONE_SCHEMA,
        loop: {
          prompt: 'Check CI',
          max_iterations: 1,
          until_field: 'done',
          fresh_context: false,
        },
      }
    : { loop: { prompt: 'Check CI', max_iterations: 1, until: 'DONE', fresh_context: false } };

function assertRecoveryOutcome(
  store: ReturnType<typeof createMockStore>,
  retry: boolean,
  attempts: number
): void {
  const events = persistedEvents(store);
  if (retry) {
    expect(attempts).toBe(2);
    expect(events.some(event => event.event_type === 'node_retry_scheduled')).toBe(true);
    expect(events.some(event => event.event_type === 'node_completed')).toBe(true);
    expect(
      events
        .filter(event => event.event_type === 'node_failed')
        .every(event => event.data?.failure_kind === 'timeout')
    ).toBe(true);
  } else {
    const failed = events.find(event => event.event_type === 'node_failed');
    expect(failed?.data?.failure_kind).toBe('timeout');
    expect(String(failed?.data?.error)).toContain('was ended by the operator');
    expect(events.some(event => event.event_type === 'node_completed')).toBe(false);
  }
}

describe('ending a stalled turn', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `end-turn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
    await writeFile(join(testDir, '.archon', 'commands', 'my-cmd.md'), 'Check CI');
    mockSendQueryDag.mockClear();
  });

  afterEach(async () => {
    setSystemTime();
    await removeTempTree(testDir);
  });

  it.each([
    { kind: 'agent', retry: false, payload: true, provider: 'codex', work: true },
    { kind: 'loop', retry: false, payload: true, provider: 'codex', work: true },
    { kind: 'structured loop', retry: true, payload: true, provider: 'codex', work: true },
    { kind: 'structured loop', retry: true, payload: false, provider: 'codex', work: true },
    { kind: 'structured agent', retry: true, payload: true, provider: 'codex', work: true },
    { kind: 'agent', retry: true, payload: false, provider: 'claude', work: false },
    { kind: 'loop', retry: true, payload: false, provider: 'pi', work: false },
  ] as const)(
    'ends $provider $kind with work=$work, payload=$payload, retry=$retry',
    async ({ kind, retry, payload, provider, work }) => {
      const store = createMockStore();
      const workflowRun = makeWorkflowRun(`end-turn-${kind}`);
      store.getWorkflowRunStatus.mockImplementation(async () => workflowRun.status);
      store.getWorkflowRun.mockImplementation(async () => workflowRun);
      let raised!: () => void;
      const stalled = new Promise<void>(resolve => {
        raised = resolve;
      });
      store.setToolCallAttention.mockImplementation(async (_runId, _streamId, calls) => {
        workflowRun.metadata.tool_call_attention = calls;
        if (calls.length) raised();
        return true;
      });
      let signal: AbortSignal | undefined;
      let attempts = 0;
      mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, options) {
        attempts++;
        if (attempts > 1) {
          yield { type: 'agent_message_chunk', text: 'DONE' };
          yield { type: 'result', sessionId: 'retry', structuredOutput: { done: true } };
          yield { type: 'settled' };
          return;
        }
        signal = options?.abortSignal;
        if (!work) yield { type: 'tool_call', toolCallId: 'call', name: 'bash' };
        if (work)
          yield {
            type: 'subtask',
            taskId: 'command:thread:exec-1',
            status: 'started',
            taskType: 'command_execution',
            description: 'while true; do gh run view; sleep 30; done',
          };
        if (payload) {
          yield { type: 'agent_message_chunk', text: '{"done":true}' };
          yield {
            type: 'result',
            sessionId: 'session',
            structuredOutput: kind === 'structured agent' ? { done: 'invalid' } : { done: true },
          };
        }
        // The provider leaves this turn open until the operator requests recovery.
        await new Promise<void>(resolve => {
          signal?.addEventListener('abort', () => resolve());
        });
      });
      const node =
        kind === 'agent' || kind === 'structured agent'
          ? {
              id: 'ci',
              kind: 'agent' as const,
              source: { kind: 'command' as const, name: 'my-cmd' },
              ...(kind === 'structured agent' ? { output_format: DONE_SCHEMA } : {}),
              idle_timeout: 5_000,
              retry: { max_attempts: retry ? 1 : 0, delay_ms: 1 },
            }
          : {
              id: 'ci',
              kind: 'loop' as const,
              idle_timeout: 5_000,
              retry: { max_attempts: retry ? 1 : 0, delay_ms: 1 },
              ...structuredLoop(kind === 'structured loop'),
            };
      const execution = executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(
            store,
            withProviderCapabilities(mockProviderRegistry, provider, {
              ...getProviderCapabilities(provider),
              backgroundWork: work ? 'reported' : 'unobserved',
            })
          ),
          workflowProvider: provider,
          config: {
            ...minimalConfig,
            workflows: { autoResumeOnQuotaReset: false, toolCallAttentionMs: 20 },
          },
          cwd: testDir,
          workflow: { name: 'end-turn', nodes: [node] },
          workflowRun,
        })
      );

      await stalled;
      // The operator can end stalled work before the post-result idle timeout.
      expect(signal?.aborted).toBe(false);
      expect(persistedEvents(store).some(e => e.event_type === 'node_failed')).toBe(false);
      expect(runAttention(workflowRun)).toMatchObject({
        kind: 'stalled_tool_calls',
        calls: [{ nodeId: 'ci', stalledForMs: expect.any(Number) }],
      });
      const plan = planEndTurn(workflowRun);
      if (plan.kind !== 'request') throw new Error(`expected a request, got ${plan.reason}`);
      Object.assign(workflowRun.metadata, plan.metadata);
      // The owner reads the request at its next throttled status check.
      setSystemTime(new Date(Date.now() + CANCEL_CHECK_INTERVAL_MS + 1_000));
      await execution;

      expect(signal?.aborted).toBe(true);
      assertRecoveryOutcome(store, retry, attempts);
      expect(workflowRun.metadata.tool_call_attention).toEqual([]);
      expect(store.cancelWorkflowRun).not.toHaveBeenCalled();
    }
  );
  it.each([
    { kind: 'agent', work: 'tool' },
    { kind: 'agent', work: 'subtask' },
    { kind: 'loop', work: 'tool' },
    { kind: 'loop', work: 'subtask' },
    { kind: 'agent', work: 'result' },
    { kind: 'loop', work: 'result' },
    { kind: 'agent', work: 'failure' },
    { kind: 'loop', work: 'failure' },
    { kind: 'agent', work: 'cancelled failure' },
    { kind: 'loop', work: 'cancelled failure' },
  ] as const)(
    '$kind processes delivered $work before matching a request',
    async ({ kind, work }) => {
      const store = createMockStore();
      const workflowRun = makeWorkflowRun(`recovery-${kind}-${work}`);
      const result = work !== 'tool' && work !== 'subtask';
      const failure = { class: 'misconfigured', evidence: 'Missing MCP config' } as const;
      store.getWorkflowRunStatus.mockImplementation(async () => workflowRun.status);
      store.getWorkflowRun.mockImplementation(async () => workflowRun);
      store.setToolCallAttention.mockImplementation(async (_run, _stream, calls) => {
        workflowRun.metadata.tool_call_attention = calls;
        return true;
      });
      let signal: AbortSignal | undefined;
      mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, options) {
        signal = options?.abortSignal;
        const start: ProviderEvent =
          work === 'tool'
            ? { type: 'tool_call', toolCallId: 'call', name: 'bash' }
            : { type: 'subtask', taskId: 'task', status: 'started' };
        yield start;
        setSystemTime(new Date(Date.now() + 100));
        yield { type: 'agent_thought_chunk', text: 'waiting' };
        const plan = planEndTurn(workflowRun);
        expect(plan.kind).toBe('request');
        if (plan.kind !== 'request') throw new Error(plan.reason);
        Object.assign(workflowRun.metadata, plan.metadata);
        setSystemTime(new Date(Date.now() + CANCEL_CHECK_INTERVAL_MS + 1000));
        if (work === 'cancelled failure') workflowRun.status = 'cancelled';
        if (result) {
          yield {
            type: 'result',
            ...(work !== 'result' ? { failure } : {}),
            sessionId: 'delivered',
            cost: 7,
            tokens: { input: 100, output: 10 },
            structuredOutput: { done: true },
          };
          yield { type: 'settled' };
          return;
        }
        yield work === 'tool'
          ? { type: 'tool_call_update', toolCallId: 'call', status: 'completed' }
          : { type: 'subtask', taskId: 'task', status: 'running' };
        if (work === 'subtask') yield { type: 'subtask', taskId: 'task', status: 'completed' };
        yield { type: 'agent_message_chunk', text: 'DONE' };
        yield { type: 'result', sessionId: 'session' };
        yield { type: 'settled' };
      });
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(
            store,
            withProviderCapabilities(mockProviderRegistry, 'codex', {
              ...getProviderCapabilities('codex'),
              backgroundWork: 'reported',
            })
          ),
          workflowProvider: 'codex',
          config: {
            ...minimalConfig,
            workflows: { autoResumeOnQuotaReset: false, toolCallAttentionMs: 20 },
          },
          cwd: testDir,
          workflowRun,
          workflow: {
            name: 'recovery',
            nodes: [
              kind === 'agent'
                ? {
                    id: 'ci',
                    kind: 'agent',
                    retry: { max_attempts: work === 'failure' ? 1 : 0, delay_ms: 1 },
                    idle_timeout: 10,
                    source: { kind: 'command', name: 'my-cmd' },
                  }
                : {
                    id: 'ci',
                    kind: 'loop',
                    retry: { max_attempts: work === 'failure' ? 1 : 0, delay_ms: 1 },
                    idle_timeout: 10,
                    ...structuredLoop(false),
                  },
            ],
          },
        })
      );
      if (result) {
        expect(signal?.aborted).toBe(true);
        const failed = persistedEvents(store).find(event => event.event_type === 'node_failed');
        expect(failed?.data).toMatchObject({
          failure_kind:
            work === 'cancelled failure' ? 'cancelled' : work === 'failure' ? 'fatal' : 'timeout',
          ...(work === 'failure' ? { provider_failure: failure } : {}),
          cost_usd: 7,
          session_id: 'delivered',
          tokens: { input: 100, output: 10 },
        });
        expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
        expect(persistedEvents(store).some(e => e.event_type === 'node_retry_scheduled')).toBe(
          false
        );
        expect(runUsageWrites(store).at(-1)).toMatchObject({
          total_cost_usd: 7,
          total_tokens_in: 100,
          total_tokens_out: 10,
        });
        expect(persistedEvents(store).some(event => event.event_type === 'node_completed')).toBe(
          false
        );
        return;
      }
      expect(signal?.aborted).toBe(false);
      expect(persistedEvents(store).filter(event => event.event_type === 'node_failed')).toEqual(
        []
      );
      expect(persistedEvents(store).some(event => event.event_type === 'node_completed')).toBe(
        true
      );
    }
  );
});
