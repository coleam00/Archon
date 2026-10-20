// @archon-test-isolated
import { describe, expect, mock, test } from 'bun:test';
const warn = mock(() => undefined);
mock.module('@archon/paths', () => ({ createLogger: () => ({ warn }) }));
import { planEndTurn, isEndTurnRequested } from './end-turn-request';
const { createRunToolCallAttention } = await import('./tool-call-attention');
import { runAttention, type ToolCallAttention, type WorkflowRun } from './schemas/workflow-run';
import {
  workflowRunContinuationConfigSchema,
  DEFAULT_TOOL_CALL_ATTENTION_MS,
} from './schemas/run-config';

function harness(thresholdMs = 100, reportedBackgroundWork = false) {
  let time = Date.parse('2026-10-01T00:00:00Z');
  const snapshots: ToolCallAttention[][] = [];
  const write = mock(async (_run: string, _stream: string, calls: ToolCallAttention[]) => {
    snapshots.push(calls);
    return true;
  });
  const run: WorkflowRun = {
    id: 'run',
    workflow_name: 'attention',
    origin: null,
    conversation_id: null,
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    outcome: null,
    user_message: '',
    metadata: {},
    started_at: new Date(time),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    output_root: null,
    checkout_baseline: null,
    adopted_from_run_id: null,
  };
  const read = mock(
    async (): Promise<WorkflowRun | null> => ({
      ...run,
      metadata: { ...run.metadata, tool_call_attention: snapshots.at(-1) },
    })
  );
  const owner = createRunToolCallAttention({
    store: { setToolCallAttention: write, getWorkflowRun: read },
    runId: 'run',
  });
  const tracker = owner.createStream({
    reportedBackgroundWork,
    nodeId: 'group.node',
    provider: 'codex',
    thresholdMs,
    env: { API_TOKEN: 'secret-value', SPECIAL: 'file-key' },
    protectedEnvKeys: ['SPECIAL'],
    protectedCredentialValues: ['file-credential'],
    now: () => time,
  });
  return {
    tracker,
    read,
    run,
    owner,
    write,
    snapshots,
    advance: (ms: number) => {
      time += ms;
    },
    now: () => time,
  };
}
const start = {
  type: 'tool_call',
  toolCallId: 'call',
  name: 'bash',
  title: 'echo secret-value file-key file-credential',
  rawInput: { hidden: 'INPUT_SENTINEL' },
} as const;

describe('tool call attention', () => {
  test('raises only at the threshold, redacts before retaining, clears on completion', async () => {
    const h = harness();
    await h.tracker.observe(start);
    h.advance(99);
    await h.tracker.refresh();
    expect(h.write).not.toHaveBeenCalled();
    h.advance(1);
    await h.tracker.refresh();
    const [call] = h.snapshots[0];
    expect(call).toMatchObject({
      nodeId: 'group.node',
      provider: 'codex',
      toolCallId: 'call',
      title: 'echo [REDACTED] [REDACTED] [REDACTED]',
    });
    expect(JSON.stringify(h.snapshots)).not.toContain('INPUT_SENTINEL');
    h.advance(100);
    await h.tracker.refresh();
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.read).not.toHaveBeenCalled();
    expect(
      runAttention(
        { id: 'run', status: 'running', metadata: { tool_call_attention: [call] } },
        h.now()
      )
    ).toMatchObject({ kind: 'stalled_tool_calls', calls: [{ elapsedMs: 200, stalledForMs: 200 }] });
    await h.tracker.observe({
      type: 'tool_call_update',
      toolCallId: 'call',
      status: 'failed',
      output: 'OUTPUT_SENTINEL',
    });
    expect(h.snapshots.at(-1)).toEqual([]);
    expect(JSON.stringify(h.snapshots)).not.toContain('OUTPUT_SENTINEL');
  });

  test('duplicate starts and unrelated text never postpone a call; correlated subtasks clear and re-raise it', async () => {
    const h = harness();
    await h.tracker.observe(start);
    h.advance(60);
    await h.tracker.observe(start);
    await h.tracker.observe({ ...start, toolCallId: 'second' });
    await h.tracker.observe({ type: 'agent_message_chunk', text: 'MESSAGE_SENTINEL' });
    await h.tracker.observe({
      type: 'subtask',
      taskId: 'unrelated',
      status: 'running',
      summary: 'SUMMARY_SENTINEL',
    });
    h.advance(40);
    await h.tracker.refresh();
    expect(h.snapshots.at(-1)?.map(c => c.toolCallId)).toEqual(['call']);
    await h.tracker.observe({
      type: 'subtask',
      taskId: 'task',
      parentToolCallId: 'call',
      status: 'started',
    });
    expect(h.snapshots.at(-1)).toEqual([]);
    h.advance(60);
    await h.tracker.refresh();
    expect(h.snapshots.at(-1)?.map(c => c.toolCallId)).toEqual(['second']);
    await h.tracker.observe({ type: 'subtask', taskId: 'task', status: 'completed' });
    h.advance(100);
    await h.tracker.refresh();
    const calls = h.snapshots.at(-1)!;
    expect(calls).toHaveLength(2);
    expect(calls[0].raisedAt).not.toEqual(h.snapshots[0][0].raisedAt);
    await h.tracker.observe({
      type: 'tool_call_update',
      toolCallId: 'unknown',
      status: 'completed',
    });
    expect(h.snapshots.at(-1)).toEqual(calls);
    await h.tracker.clear();
    expect(h.snapshots.at(-1)).toEqual([]);
  });

  test.each(['tool', 'subtask'] as const)(
    'an old request cannot end a renewed %s stall after progress with a backward clock jump',
    async kind => {
      const h = harness(100, true);
      if (kind === 'tool') await h.tracker.observe(start);
      if (kind === 'subtask')
        await h.tracker.observe({ type: 'subtask', taskId: 'task', status: 'started' });
      h.advance(100);
      await h.tracker.refresh();
      const requested = async () => {
        const stall = h.tracker.stall();
        if (!stall) throw new Error('expected published stall');
        return isEndTurnRequested({ getWorkflowRun: h.read }, 'run', stall);
      };
      const plan = planEndTurn({
        ...h.run,
        metadata: { tool_call_attention: h.snapshots.at(-1) },
      });
      if (plan.kind !== 'request') throw new Error(plan.reason);
      Object.assign(h.run.metadata, plan.metadata);
      expect(await requested()).toBe(true);
      h.advance(-1000);
      if (kind === 'tool') {
        await h.tracker.observe({
          type: 'subtask',
          taskId: 'child',
          parentToolCallId: 'call',
          status: 'running',
        });
      } else {
        await h.tracker.observe({ type: 'subtask', taskId: 'task', status: 'running' });
      }
      expect(h.tracker.stall()).toBeUndefined();
      h.advance(100);
      await h.tracker.refresh();
      expect(await requested()).toBe(false);
    }
  );

  test('an observed call remains endable while siblings progress, but successor calls do not', async () => {
    const h = harness();
    await h.tracker.observe(start);
    h.advance(50);
    await h.tracker.observe({ ...start, toolCallId: 'second' });
    h.advance(100);
    await h.tracker.refresh();
    const plan = planEndTurn({ ...h.run, metadata: { tool_call_attention: h.snapshots.at(-1) } });
    if (plan.kind !== 'request') throw new Error(plan.reason);
    Object.assign(h.run.metadata, plan.metadata);
    await h.tracker.observe({ type: 'tool_call_update', toolCallId: 'call', status: 'completed' });
    const remaining = h.tracker.stall();
    if (!remaining) throw new Error('expected remaining stall');
    expect(await isEndTurnRequested({ getWorkflowRun: h.read }, 'run', remaining)).toBe(true);
    await h.tracker.observe({
      type: 'tool_call_update',
      toolCallId: 'second',
      status: 'completed',
    });
    await h.tracker.observe(start);
    h.advance(100);
    await h.tracker.refresh();
    const successor = h.tracker.stall();
    if (!successor) throw new Error('expected successor stall');
    expect(await isEndTurnRequested({ getWorkflowRun: h.read }, 'run', successor)).toBe(false);
  });

  test('clear finishes after an in-flight write and leaves no attention', async () => {
    const h = harness();
    await h.tracker.observe(start);
    h.advance(100);
    await h.tracker.refresh();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    h.advance(100);
    await h.tracker.observe({ ...start, toolCallId: 'second' });
    h.advance(100);
    h.write.mockImplementationOnce(async (_run, _stream, calls) => {
      entered.resolve();
      await release.promise;
      h.snapshots.push(calls);
      return true;
    });
    const refresh = h.tracker.refresh();
    await entered.promise;
    const clear = h.tracker.clear();
    release.resolve();
    await Promise.all([refresh, clear]);
    expect(h.snapshots.at(-1)).toEqual([]);
    expect(h.tracker.stall()).toBeUndefined();
    h.advance(100);
    await h.tracker.refresh();
    expect(h.snapshots.at(-1)).toEqual([]);
  });

  test('a backward clock jump cannot clear an already raised advisory', async () => {
    const h = harness();
    await h.tracker.observe(start);
    h.advance(100);
    await h.tracker.refresh();
    h.advance(-200);
    await h.tracker.refresh();
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.snapshots[0]).toHaveLength(1);
  });

  test('publication and cleanup failures retry without escaping into execution', async () => {
    const h = harness();
    await h.tracker.observe(start);
    h.advance(100);
    h.write.mockRejectedValueOnce(new Error('secret-value INPUT_SENTINEL'));
    await h.tracker.refresh();
    expect(h.snapshots).toEqual([]);
    await h.tracker.refresh();
    expect(h.snapshots).toHaveLength(1);
    h.write.mockRejectedValueOnce(new Error('cleanup failed'));
    await h.tracker.clear();
    expect(h.snapshots).toHaveLength(1);
    await h.owner.refresh();
    expect(h.snapshots.at(-1)).toEqual([]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-value');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('INPUT_SENTINEL');
  });

  test('a paused-state publication race retains the snapshot for the next tick', async () => {
    const h = harness();
    await h.tracker.observe(start);
    h.advance(100);
    h.write.mockResolvedValueOnce(false);
    await h.tracker.refresh();
    await h.tracker.refresh();
    expect(h.write).toHaveBeenCalledTimes(2);
    expect(h.snapshots).toHaveLength(1);
  });

  test('disable affects publication only; a fresh stream owns reused provider ids', async () => {
    const h = harness(0);
    expect(h.tracker.hasOpenTools()).toBe(false);
    await h.tracker.observe(start);
    h.advance(10000000);
    await h.tracker.refresh();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.tracker.hasOpenTools()).toBe(true);
    await h.tracker.clear();
    expect(h.tracker.hasOpenTools()).toBe(false);
    const a = harness(),
      b = harness();
    await a.tracker.observe(start);
    await b.tracker.observe(start);
    a.advance(100);
    await a.tracker.refresh();
    await a.tracker.clear();
    b.advance(100);
    await b.tracker.refresh();
    expect(b.snapshots.at(-1)).toHaveLength(1);
    expect(b.snapshots[0][0].streamId).not.toBe(a.snapshots[0][0].streamId);
  });

  test('redacts entire known values before truncation at 512 code points', async () => {
    const h = harness();
    await h.tracker.observe({ ...start, title: '😀'.repeat(505) + 'secret-value' });
    h.advance(100);
    await h.tracker.refresh();
    const title = h.snapshots[0][0].title!;
    expect([...title]).toHaveLength(512);
    expect(title).not.toContain('secret');
  });

  test('running projection rejects malformed descriptors, clamps time, and terminal state wins', async () => {
    const h = harness();
    await h.tracker.observe(start);
    h.advance(100);
    await h.tracker.refresh();
    const metadata = { tool_call_attention: h.snapshots[0] };
    expect(runAttention({ id: 'run', status: 'running', metadata }, 0)).toMatchObject({
      calls: [{ elapsedMs: 0, stalledForMs: 0 }],
    });
    expect(runAttention({ id: 'run', status: 'completed', metadata })).toMatchObject({
      kind: 'terminal',
    });
    expect(
      runAttention({
        id: 'run',
        status: 'running',
        metadata: { tool_call_attention: [{ ...h.snapshots[0][0], rawInput: 'private' }] },
      })
    ).toMatchObject({ kind: 'unreadable', reason: 'malformed_tool_call_attention' });
    for (const malformed of [null, 'invalid', {}])
      expect(
        runAttention({ id: 'run', status: 'running', metadata: { tool_call_attention: malformed } })
      ).toMatchObject({ kind: 'unreadable', reason: 'malformed_tool_call_attention' });
    expect(runAttention({ id: 'run', status: 'running', metadata: {} })).toBeNull();
  });

  test.each([
    ['codex', 'command_execution'],
    ['codex', 'local_agent'],
    ['claude', 'background'],
  ])('reported %s %s work raises, renews and clears independently', async (_provider, taskType) => {
    const h = harness(100, true);
    const event = {
      type: 'subtask',
      taskId: 'task',
      taskType,
      status: 'started',
      description: 'bun test secret-value',
      summary: 'SUMMARY_SENTINEL',
    } as const;
    await h.tracker.observe(event);
    h.advance(60);
    await h.tracker.observe(event);
    h.advance(40);
    await h.tracker.refresh();
    expect(h.snapshots.at(-1)).toMatchObject([
      { toolCallId: 'subtask:task', name: taskType, title: 'bun test [REDACTED]' },
    ]);
    await h.tracker.observe({ type: 'subtask', taskId: 'other', status: 'started' });
    await h.tracker.observe({ ...event, status: 'running' });
    expect(h.snapshots.at(-1)).toEqual([]);
    h.advance(100);
    await h.tracker.refresh();
    expect(h.snapshots.at(-1)).toHaveLength(2);
    for (const status of ['completed', 'failed', 'stopped'] as const) {
      await h.tracker.observe(event);
      h.advance(100);
      await h.tracker.refresh();
      expect(h.snapshots.at(-1)).toHaveLength(2);
      await h.tracker.observe({ ...event, status });
      expect(h.snapshots.at(-1)?.map(c => c.toolCallId)).toEqual(['subtask:other']);
    }
    expect(JSON.stringify(h.snapshots)).not.toContain('SUMMARY_SENTINEL');
    const unreported = harness(100, false);
    await unreported.tracker.observe(event);
    unreported.advance(100);
    await unreported.tracker.refresh();
    expect(unreported.write).not.toHaveBeenCalled();
  });

  test('reported subtasks remain observable after their parent tool closes and clear with late correlation', async () => {
    const h = harness(100, true);
    await h.tracker.observe(start);
    await h.tracker.observe({
      type: 'subtask',
      taskId: 'child',
      parentToolCallId: 'call',
      status: 'started',
      taskType: 'local_agent',
      description: 'Review',
    });
    h.advance(100);
    await h.tracker.refresh();
    expect(h.snapshots.at(-1)?.map(c => c.toolCallId)).toEqual(['call']);
    await h.tracker.observe({ type: 'tool_call_update', toolCallId: 'call', status: 'completed' });
    expect(h.snapshots.at(-1)?.map(c => c.toolCallId)).toEqual(['subtask:child']);
    await h.tracker.observe({ type: 'subtask', taskId: 'child', status: 'completed' });
    expect(h.snapshots.at(-1)).toEqual([]);
    await h.tracker.observe({ type: 'subtask', taskId: 'late', status: 'started' });
    h.advance(100);
    await h.tracker.refresh();
    await h.tracker.observe({
      type: 'subtask',
      taskId: 'late',
      parentToolCallId: 'closed',
      status: 'completed',
    });
    expect(h.snapshots.at(-1)).toEqual([]);
  });

  test('run owner retains failed final deletions across successor streams', async () => {
    const h = harness();
    await h.tracker.observe(start);
    h.advance(100);
    await h.tracker.refresh();
    h.write.mockRejectedValueOnce(new Error('completion failed'));
    await h.tracker.observe({ type: 'tool_call_update', toolCallId: 'call', status: 'completed' });
    h.write.mockRejectedValueOnce(new Error('final cleanup failed'));
    await h.tracker.clear();
    expect(h.snapshots.at(-1)).toHaveLength(1);
    const successor = h.owner.createStream({
      nodeId: 'next',
      provider: 'codex',
      reportedBackgroundWork: true,
      thresholdMs: 100,
      env: {},
      now: h.now,
    });
    await successor.observe({ ...start, toolCallId: 'successor' });
    await h.owner.refresh();
    expect(h.snapshots.at(-1)).toEqual([]);
    expect(successor.hasOpenTools()).toBe(true);
    const writes = h.write.mock.calls.length;
    await h.owner.refresh();
    expect(h.write.mock.calls).toHaveLength(writes);
  });

  test('reconciles a committed write whose response was lost before honoring recovery', async () => {
    const h = harness();
    await h.tracker.observe(start);
    h.advance(100);
    h.write.mockImplementationOnce(async (_run, _stream, calls) => {
      h.snapshots.push(calls);
      throw new Error('COMMIT response lost');
    });
    await h.tracker.refresh();
    expect(h.tracker.stall()).toBeUndefined();
    h.write.mockResolvedValueOnce(false);
    await h.tracker.refresh();
    expect(h.read).toHaveBeenCalledTimes(1);
    const published = h.snapshots[0][0];
    expect(h.tracker.stall()).toEqual([
      {
        streamId: published.streamId,
        toolCallId: published.toolCallId,
        raisedAt: published.raisedAt,
      },
    ]);
    const plan = planEndTurn({ ...h.run, metadata: { tool_call_attention: h.snapshots[0] } });
    if (plan.kind !== 'request') throw new Error(plan.reason);
    Object.assign(h.run.metadata, plan.metadata);
    const stall = h.tracker.stall();
    if (!stall) throw new Error('expected reconciled stall');
    expect(await isEndTurnRequested({ getWorkflowRun: h.read }, 'run', stall)).toBe(true);
  });

  test('progress clears a committed advisory even when its publication response was lost', async () => {
    const h = harness();
    await h.tracker.observe(start);
    h.advance(100);
    h.write.mockImplementationOnce(async (_run, _stream, calls) => {
      h.snapshots.push(calls);
      throw new Error('COMMIT response lost');
    });
    await h.tracker.refresh();
    await h.tracker.observe({ type: 'tool_call_update', toolCallId: 'call', status: 'completed' });
    expect(h.snapshots.at(-1)).toEqual([]);
    expect(h.tracker.stall()).toBeUndefined();
  });

  test.each(['absent', 'different stall', 'other stream', 'terminal', 'unreadable'] as const)(
    'does not adopt a refused write when the persisted snapshot is %s',
    async mismatch => {
      const h = harness();
      await h.tracker.observe(start);
      h.advance(100);
      h.write.mockImplementationOnce(async (_run, _stream, calls) => {
        h.snapshots.push(calls);
        throw new Error('uncertain write');
      });
      await h.tracker.refresh();
      h.read.mockImplementation(async () => {
        const [call] = h.snapshots[0];
        if (mismatch === 'absent') return null;
        return {
          ...h.run,
          status: mismatch === 'terminal' ? 'completed' : 'running',
          metadata: {
            tool_call_attention:
              mismatch === 'unreadable'
                ? {}
                : [
                    {
                      ...call,
                      ...(mismatch === 'different stall'
                        ? { raisedAt: new Date(h.now() + 1).toISOString() }
                        : {}),
                      ...(mismatch === 'other stream' ? { streamId: 'other' } : {}),
                    },
                  ],
          },
        };
      });
      h.write.mockResolvedValueOnce(false);
      await h.tracker.refresh();
      expect(h.tracker.stall()).toBeUndefined();
    }
  );

  test('policy has a 30-minute default and accepts only safe nonnegative integer overrides', () => {
    expect(DEFAULT_TOOL_CALL_ATTENTION_MS).toBe(1800000);
    for (const value of [0, 1, 60000])
      expect(
        workflowRunContinuationConfigSchema.parse({ toolCallAttentionMs: value })
          .toolCallAttentionMs
      ).toBe(value);
    for (const value of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(
        workflowRunContinuationConfigSchema.safeParse({ toolCallAttentionMs: value }).success
      ).toBe(false);
  });
});
