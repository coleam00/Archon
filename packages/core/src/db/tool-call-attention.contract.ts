import { FAN_OUT_CANCEL_REASONS } from '@archon/workflows/store';
import { expect, test } from 'bun:test';
import type { IDatabase } from './adapters/types';
import {
  runAttention,
  type WorkflowRun,
  type ToolCallAttention,
} from '@archon/workflows/schemas/workflow-run';

type Workflows = typeof import('./workflows');
export function toolCallAttentionContract(
  getDb: () => IDatabase,
  getWorkflows: () => Workflows
): void {
  test('parallel streams publish independently, repeats do not notify, and clearing preserves other metadata', async () => {
    const db = getDb(),
      workflows = getWorkflows();
    const runId = crypto.randomUUID(),
      conversationId = crypto.randomUUID();
    await db.query(
      "INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ($1, 'test', $2)",
      [conversationId, conversationId]
    );
    await db.query(
      "INSERT INTO remote_agent_workflow_runs (id, conversation_id, workflow_name, user_message, status, metadata) VALUES ($1, $2, 'test', '', 'running', $3)",
      [runId, conversationId, JSON.stringify({ keep: 'value' })]
    );
    const readRun = async (): Promise<WorkflowRun> => {
      const run = await workflows.getWorkflowRun(runId);
      if (!run) throw new Error('Expected persisted run');
      return run;
    };
    const call = (streamId: string): ToolCallAttention => ({
      streamId,
      nodeId: streamId,
      provider: 'codex',
      toolCallId: 'same-id',
      name: 'bash',
      title: 'bun test',
      startedAt: '2026-10-01T00:00:00.000Z',
      lastProgressAt: '2026-10-01T00:00:00.000Z',
      raisedAt: '2026-10-01T00:30:00.000Z',
      thresholdMs: 1800000,
    });
    expect(
      await Promise.all(['a', 'b'].map(id => workflows.setToolCallAttention(runId, id, [call(id)])))
    ).toEqual([true, true]);
    let run = await readRun();
    const attention = runAttention(run);
    expect(attention?.kind).toBe('stalled_tool_calls');
    if (attention?.kind !== 'stalled_tool_calls') throw new Error('Expected advisory');
    expect(attention.calls.map(c => c.streamId).sort()).toEqual(['a', 'b']);
    expect(run.status).toBe('running');
    expect(await workflows.setToolCallAttention(runId, 'a', [call('a')])).toBe(false);
    const events = await db.query<{ data: unknown }>(
      "SELECT data FROM remote_agent_workflow_events WHERE workflow_run_id = $1 AND event_type = 'run_attention_changed'",
      [runId]
    );
    expect(events.rows).toHaveLength(2);
    expect(JSON.stringify(events.rows)).not.toContain('bun test');
    await workflows.setToolCallAttention(runId, 'a', []);
    run = await readRun();
    expect(run.metadata.tool_call_attention).toEqual([call('b')]);
    await workflows.setToolCallAttention(runId, 'b', []);
    run = await readRun();
    expect(run.metadata).toEqual({ keep: 'value' });
    expect(runAttention(run)).toBeNull();
    await workflows.setToolCallAttention(runId, 'b', [call('b')]);
    await db.query("UPDATE remote_agent_workflow_runs SET status = 'paused' WHERE id = $1", [
      runId,
    ]);
    expect(await workflows.setToolCallAttention(runId, 'a', [call('a')])).toBe(false);
    await workflows.resumeWorkflowRun(runId);
    expect((await readRun()).metadata).toEqual({ keep: 'value' });
    await Promise.all([
      workflows.setToolCallAttention(runId, 'a', [call('a')]),
      db.query("UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id = $1", [runId]),
    ]);
    run = await readRun();
    expect(runAttention(run)?.kind).toBe('terminal');
    expect(await workflows.setToolCallAttention(runId, 'b', [call('b')])).toBe(false);
    await db.query(
      "UPDATE remote_agent_workflow_runs SET status = 'cancelled', metadata = $2 WHERE id = $1",
      [
        runId,
        JSON.stringify({
          keep: 'value',
          cancelled_reason: FAN_OUT_CANCEL_REASONS[0],
          tool_call_attention: [call('a')],
        }),
      ]
    );
    await workflows.recoverCancelledFanOutRun(runId);
    run = await readRun();
    expect(run.status).toBe('running');
    expect(run.metadata).toEqual({ keep: 'value' });
  });
}
