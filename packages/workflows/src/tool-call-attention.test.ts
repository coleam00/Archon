import { describe, expect, mock, test } from 'bun:test';
const warn = mock(() => undefined);
mock.module('@archon/paths', () => ({ createLogger: () => ({ warn }) }));
const { createToolCallAttention } = await import('./tool-call-attention');
import { runAttention, type ToolCallAttention } from './schemas/workflow-run';
import {
  workflowRunContinuationConfigSchema,
  DEFAULT_TOOL_CALL_ATTENTION_MS,
} from './schemas/run-config';

function harness(thresholdMs = 100) {
  let time = Date.parse('2026-10-01T00:00:00Z');
  const snapshots: ToolCallAttention[][] = [];
  const write = mock(async (_run: string, _stream: string, calls: ToolCallAttention[]) => {
    snapshots.push(calls);
    return true;
  });
  const tracker = createToolCallAttention({
    store: { setToolCallAttention: write },
    runId: 'run',
    nodeId: 'group.node',
    attemptId: 'attempt',
    provider: 'codex',
    thresholdMs,
    env: { API_TOKEN: 'secret-value', SPECIAL: 'file-key' },
    protectedEnvKeys: ['SPECIAL'],
    protectedCredentialValues: ['file-credential'],
    now: () => time,
  });
  return {
    tracker,
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
    await h.tracker.clear();
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
