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
  minimalConfig,
  dagOptions,
  makeWorkflowRun,
} from './test-utils';
import { executeDagWorkflow } from '../dag-executor';
import { CANCEL_CHECK_INTERVAL_MS } from './run-control';
import { planEndTurn } from '../end-turn-request';

// #4533: a Codex agent left `while true; …; sleep 30; done` running as a background
// command. Its turn completed, but the reported work never ended, so the watchdog stayed
// suspended and only `stalled_tool_calls` attention showed the hang. Ending the turn is
// the operator's answer to that attention.
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

  it.each(['agent', 'loop'] as const)(
    'fails the %s attempt as a timeout once the operator ends it',
    async kind => {
      const store = createMockStore();
      const workflowRun = makeWorkflowRun(`end-turn-${kind}`);
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
      mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, options) {
        signal = options?.abortSignal;
        yield {
          type: 'subtask',
          taskId: 'command:thread:exec-1',
          status: 'started',
          taskType: 'command_execution',
          description: 'while true; do gh run view; sleep 30; done',
        };
        yield { type: 'agent_message_chunk', text: '{"done":true}' };
        yield { type: 'result', sessionId: 'session', structuredOutput: { done: true } };
        // The background command never ends, so the provider never settles.
        await new Promise<void>(resolve => {
          signal?.addEventListener('abort', () => resolve());
        });
      });
      const node =
        kind === 'agent'
          ? {
              id: 'ci',
              kind: 'agent' as const,
              source: { kind: 'command' as const, name: 'my-cmd' },
              idle_timeout: 10,
              retry: { max_attempts: 0 },
            }
          : {
              id: 'ci',
              kind: 'loop' as const,
              idle_timeout: 10,
              retry: { max_attempts: 0 },
              loop: { prompt: 'Check CI', max_iterations: 1, until: 'DONE', fresh_context: false },
            };
      const execution = executeDagWorkflow(
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
          workflow: { name: 'end-turn', nodes: [node] },
          workflowRun,
        })
      );

      await stalled;
      // Still waiting on the live command: the watchdog is suspended, nothing timed out.
      expect(signal?.aborted).toBe(false);
      const plan = planEndTurn(workflowRun);
      if (plan.kind !== 'request') throw new Error(`expected a request, got ${plan.reason}`);
      Object.assign(workflowRun.metadata, plan.metadata);
      // The owner reads the request at its next throttled status check.
      setSystemTime(new Date(Date.now() + CANCEL_CHECK_INTERVAL_MS + 1_000));
      await execution;

      expect(signal?.aborted).toBe(true);
      const failed = persistedEvents(store).find(event => event.event_type === 'node_failed');
      expect(failed?.data?.failure_kind).toBe('timeout');
      expect(String(failed?.data?.error)).toContain('was ended by the operator');
      expect(persistedEvents(store).some(event => event.event_type === 'node_completed')).toBe(
        false
      );
      expect(store.cancelWorkflowRun).not.toHaveBeenCalled();
    }
  );
});
