/**
 * The provider-event reader's behavior, run against a real database by both dialect
 * suites (`workflow-events.provider-events.integration.test.ts` on SQLite and
 * `workflow-events.provider-events.postgres.integration.test.ts` on Postgres), so the
 * two dialects are held to one set of expectations.
 */
import { expect, test } from 'bun:test';
import type { ProviderEvent } from '@archon/provider-contract';
import type { ProviderEventEnvelope } from '@archon/workflows/schemas/provider-event';
import type { IDatabase } from './adapters/types';

type WorkflowEventsModule = typeof import('./workflow-events');

/** Insert a run (and its conversation) the event rows can reference. */
async function seedRun(db: IDatabase): Promise<string> {
  const conversationId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  await db.query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
     VALUES ($1, 'test', $2)`,
    [conversationId, `provider-events-${conversationId}`]
  );
  await db.query(
    `INSERT INTO remote_agent_workflow_runs (id, workflow_name, conversation_id, user_message, status)
     VALUES ($1, 'wf', $2, 'msg', 'running')`,
    [runId, conversationId]
  );
  return runId;
}

/** A row as an older binary wrote it: the event type and data keys v0.11.0 shipped. */
async function insertLegacyRow(
  db: IDatabase,
  runId: string,
  eventType: string,
  stepName: string,
  data: Record<string, unknown>
): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_workflow_events (id, workflow_run_id, event_type, step_name, data)
     VALUES ($1, $2, $3, $4, $5)`,
    [crypto.randomUUID(), runId, eventType, stepName, JSON.stringify(data)]
  );
}

function envelope(attemptId: string, seq: number, event: ProviderEvent): ProviderEventEnvelope {
  return { attemptId, seq, observedAt: '2026-10-02T10:00:00.000Z', event };
}

export function providerEventReaderContract(
  getDb: () => IDatabase,
  getModule: () => WorkflowEventsModule
): void {
  test('translates every v0.11.0 legacy row into the vocabulary with a null attempt', async () => {
    const db = getDb();
    const runId = await seedRun(db);
    await insertLegacyRow(db, runId, 'tool_called', 'build', {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_call_id: 'call-1',
    });
    await insertLegacyRow(db, runId, 'tool_completed', 'build', {
      tool_name: 'Bash',
      duration_ms: 12,
      tool_call_id: 'call-1',
      tool_outcome: 'error',
      exit_code: 2,
    });
    // An engine-minted id and completion stay what they were: a call the engine closed.
    await insertLegacyRow(db, runId, 'tool_called', 'build', {
      tool_name: 'Read',
      tool_input: {},
      tool_call_id: 'anonymous-1',
    });
    await insertLegacyRow(db, runId, 'tool_completed', 'build', {
      tool_name: 'Read',
      duration_ms: 3,
      tool_call_id: 'anonymous-1',
      tool_outcome: 'unknown',
    });
    await insertLegacyRow(db, runId, 'task_activity', 'build', {
      task_id: 't-1',
      activity: 'progress',
      summary: 'reading',
      usage: { total_tokens: 10 },
      last_tool_name: 'Grep',
    });
    await insertLegacyRow(db, runId, 'task_activity', 'build', {
      task_id: 't-1',
      activity: 'completed',
      output_file: '/tmp/out.md',
    });
    await insertLegacyRow(db, runId, 'hook_activity', 'build', {
      hook_id: 'h-1',
      hook_name: 'PreToolUse',
      hook_event: 'PreToolUse',
      activity: 'started',
    });
    await insertLegacyRow(db, runId, 'hook_activity', 'build', {
      hook_id: 'h-1',
      hook_name: 'PreToolUse',
      hook_event: 'PreToolUse',
      activity: 'response',
      outcome: 'success',
      exit_code: 0,
    });

    const records = await getModule().listProviderEvents(runId);

    expect(records.map(r => [r.stepName, r.attemptId, r.seq])).toEqual(
      [0, 1, 2, 3, 4, 5, 6, 7].map(seq => ['build', null, seq])
    );
    expect(records.every(r => !Number.isNaN(Date.parse(r.observedAt)))).toBe(true);
    expect(records.map(r => r.event)).toEqual([
      { type: 'tool_call', toolCallId: 'call-1', name: 'Bash', rawInput: { command: 'ls' } },
      { type: 'tool_call_update', toolCallId: 'call-1', status: 'failed', exitCode: 2 },
      { type: 'tool_call', toolCallId: 'anonymous-1', name: 'Read', rawInput: {} },
      { type: 'tool_call_update', toolCallId: 'anonymous-1', status: 'cancelled' },
      {
        type: 'subtask',
        taskId: 't-1',
        status: 'running',
        summary: 'reading',
        lastToolName: 'Grep',
        usage: { total_tokens: 10 },
      },
      { type: 'subtask', taskId: 't-1', status: 'completed', outputFile: '/tmp/out.md' },
      {
        type: 'hook',
        hookId: 'h-1',
        hookName: 'PreToolUse',
        hookEvent: 'PreToolUse',
        status: 'started',
      },
      {
        type: 'hook',
        hookId: 'h-1',
        hookName: 'PreToolUse',
        hookEvent: 'PreToolUse',
        status: 'succeeded',
        exitCode: 0,
      },
    ]);
  });

  test('reads legacy and envelope rows of one node in emission order, whatever the store order', async () => {
    const db = getDb();
    const { createWorkflowEvent, listProviderEvents } = getModule();
    const runId = await seedRun(db);
    const write = (stepName: string, data: Record<string, unknown>): Promise<void> =>
      createWorkflowEvent({
        workflow_run_id: runId,
        event_type: 'provider_event',
        step_name: stepName,
        data,
      });
    await insertLegacyRow(db, runId, 'tool_called', 'build', {
      tool_name: 'Bash',
      tool_input: {},
      tool_call_id: 'old',
    });
    // Unawaited store writes can commit out of order: attempt a's seq 1 lands first.
    await write('build', envelope('a', 1, { type: 'agent_message_chunk', text: 'second' }));
    await write('build', envelope('a', 0, { type: 'agent_message_chunk', text: 'first' }));
    await write('review', envelope('r', 0, { type: 'agent_message_chunk', text: 'other node' }));
    await write('build', envelope('b', 0, { type: 'state_update', state: 'running' }));
    await write('build', envelope('b', 1, { type: 'agent_message_chunk', text: 'retry' }));
    // A row that is not an envelope is skipped, not thrown.
    await write('build', { attemptId: 'a', seq: 'not a number' });

    const build = await listProviderEvents(runId, { stepName: 'build' });
    expect(build.map(r => [r.attemptId, r.seq])).toEqual([
      [null, 0],
      ['a', 0],
      ['a', 1],
      ['b', 0],
      ['b', 1],
    ]);
    expect(build[1]).toEqual({
      runId,
      stepName: 'build',
      ...envelope('a', 0, { type: 'agent_message_chunk', text: 'first' }),
    });

    const all = await listProviderEvents(runId);
    expect(all.map(r => r.stepName)).toEqual([
      'build',
      'build',
      'build',
      'build',
      'build',
      'review',
    ]);

    // The cursor returns the attempt's later events and every later attempt's.
    const afterA0 = await listProviderEvents(runId, {
      stepName: 'build',
      after: { attemptId: 'a', seq: 0 },
    });
    expect(afterA0.map(r => [r.attemptId, r.seq])).toEqual([
      ['a', 1],
      ['b', 0],
      ['b', 1],
    ]);
    // An attempt the store does not hold yet says nothing about what came after it.
    expect(
      await listProviderEvents(runId, { stepName: 'build', after: { attemptId: 'c', seq: 0 } })
    ).toEqual([]);
  });

  test('envelope rows leave the resume snapshot unchanged', async () => {
    const db = getDb();
    const { createWorkflowEvent, getDagResumeSnapshot } = getModule();
    const runId = await seedRun(db);
    const before = await getDagResumeSnapshot(runId);
    await createWorkflowEvent({
      workflow_run_id: runId,
      event_type: 'provider_event',
      step_name: 'build',
      data: envelope('a', 0, { type: 'agent_message_chunk', text: 'hi' }),
    });
    expect(await getDagResumeSnapshot(runId)).toEqual(before);
  });
}
