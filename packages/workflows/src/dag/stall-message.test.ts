// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { removeTempTree } from '@archon/paths/test-utils';
import { getProviderCapabilities } from '@archon/providers';
import type { ProviderEvent } from '@archon/provider-contract';
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

type Work = 'stalls' | 'progresses';

/** An agent node or a one-iteration loop node, both done on `DONE`. */
function nodeOf(kind: 'agent' | 'loop') {
  return kind === 'agent'
    ? {
        id: 'ci',
        kind: 'agent' as const,
        source: { kind: 'command' as const, name: 'my-cmd' },
        idle_timeout: 5_000,
      }
    : {
        id: 'ci',
        kind: 'loop' as const,
        idle_timeout: 5_000,
        loop: { prompt: 'Check CI', max_iterations: 1, until: 'DONE', fresh_context: false },
      };
}

describe('the engine asks a stalled session', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `stall-message-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
    await writeFile(join(testDir, '.archon', 'commands', 'my-cmd.md'), 'Check CI');
    mockSendQueryDag.mockClear();
  });

  afterEach(async () => {
    setSystemTime();
    await removeTempTree(testDir);
  });

  async function runNode(kind: 'agent' | 'loop', provider: 'claude' | 'pi', work: Work) {
    const store = createMockStore();
    const workflowRun = makeWorkflowRun(`stall-message-${kind}-${provider}-${work}`);
    store.getWorkflowRunStatus.mockImplementation(async () => workflowRun.status);
    store.getWorkflowRun.mockImplementation(async () => workflowRun);
    store.setToolCallAttention.mockImplementation(async (_run, _stream, calls) => {
      workflowRun.metadata.tool_call_attention = calls;
      return true;
    });
    const received: (string | undefined)[] = [];
    let offered = false;
    let signal: AbortSignal | undefined;
    mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, options) {
      signal = options?.abortSignal;
      offered = options?.turnMessages !== undefined;
      if (work === 'progresses') {
        const task = { type: 'subtask', taskId: 'watch', taskType: 'local_bash' } as const;
        yield { ...task, status: 'started' };
        // Each running update comes before the threshold passes, so nothing stalls.
        for (let tick = 0; tick < 5; tick++) {
          setSystemTime(new Date(Date.now() + 10));
          yield { ...task, status: 'running' } satisfies ProviderEvent;
        }
        yield { ...task, status: 'completed' };
      } else {
        yield { type: 'tool_call', toolCallId: 'call', name: 'Bash', title: 'sleep 900' };
        // The call outlives the threshold with no progress.
        setSystemTime(new Date(Date.now() + 100));
        yield { type: 'agent_thought_chunk', text: 'waiting' };
        if (options?.turnMessages) {
          const next = await options.turnMessages[Symbol.asyncIterator]().next();
          received.push(next.done === true ? undefined : next.value);
        }
        yield { type: 'tool_call_update', toolCallId: 'call', status: 'completed' };
      }
      yield { type: 'agent_message_chunk', text: 'DONE' };
      yield { type: 'result', sessionId: 'session' };
      yield { type: 'settled' };
    });
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(
          store,
          withProviderCapabilities(mockProviderRegistry, provider, {
            ...getProviderCapabilities(provider),
            backgroundWork: 'reported',
          })
        ),
        workflowProvider: provider,
        config: {
          ...minimalConfig,
          workflows: { autoResumeOnQuotaReset: false, toolCallAttentionMs: 20 },
        },
        cwd: testDir,
        workflow: { name: 'stall-message', nodes: [nodeOf(kind)] },
        workflowRun,
      })
    );
    const events = persistedEvents(store);
    return {
      received,
      offered,
      aborted: signal?.aborted === true,
      completed: events.some(event => event.event_type === 'node_completed'),
      messages: events.filter(event => event.event_type === 'stall_message'),
    };
  }

  it.each(['agent', 'loop'] as const)(
    'a stalled %s receives one message in its session and completes without an operator',
    async kind => {
      const outcome = await runNode(kind, 'claude', 'stalls');
      expect(outcome.completed).toBe(true);
      expect(outcome.aborted).toBe(false);
      expect(outcome.received).toHaveLength(1);
      expect(outcome.received[0]).toContain('Bash ("sleep 900")');
      expect(outcome.messages).toEqual([
        expect.objectContaining({
          step_name: 'ci',
          data: expect.objectContaining({
            sent: true,
            sender: 'engine',
            provider: 'claude',
            count: 1,
            limit: 2,
            text: outcome.received[0],
            ...(kind === 'loop' ? { iteration: 1 } : {}),
          }),
        }),
      ]);
    }
  );

  it('a session that keeps reporting progress gets no message', async () => {
    const outcome = await runNode('agent', 'claude', 'progresses');
    expect(outcome.offered).toBe(true);
    expect(outcome.completed).toBe(true);
    expect(outcome.messages).toEqual([]);
  });

  it('a provider that cannot take a message gets none, and the stall is recorded once', async () => {
    const outcome = await runNode('agent', 'pi', 'stalls');
    expect(outcome.offered).toBe(false);
    expect(outcome.completed).toBe(true);
    expect(outcome.messages.map(event => event.data)).toEqual([
      { sent: false, reason: 'provider_unsupported', provider: 'pi' },
    ]);
  });
});
