import { describe, expect, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { WorkflowEventRow } from '@archon/workflows/schemas/workflow-event';
import { workflowRunSchema, type WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { registerRunRecordsRoute, type RunRecordsDeps } from './api.run-records';
import { runRecordsResponseSchema } from './schemas/workflow.schemas';

const run = (id: string, status: WorkflowRun['status']): WorkflowRun =>
  workflowRunSchema.parse({
    origin: null,
    id,
    workflow_name: 'build',
    conversation_id: null,
    parent_conversation_id: null,
    codebase_id: null,
    status,
    outcome: null,
    completed_outcome: null,
    user_message: '',
    metadata: {},
    started_at: new Date('2026-11-20T10:00:00Z'),
    completed_at: status === 'running' ? null : new Date('2026-11-20T11:00:00Z'),
    last_activity_at: null,
    active_phase_started_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    item_id: null,
  });

const event = (
  runId: string,
  order: number,
  type: string,
  step: string,
  data: Record<string, unknown> = {}
): WorkflowEventRow =>
  ({
    id: `${runId}-${String(order)}`,
    workflow_run_id: runId,
    event_type: type,
    step_index: null,
    step_name: step,
    data,
    created_at: '2026-11-20 10:00:00',
    event_order: order,
  }) as WorkflowEventRow;

function appWith(runs: WorkflowRun[], events: Record<string, WorkflowEventRow[]>) {
  const loaded: string[][] = [];
  const deps: RunRecordsDeps = {
    runsByIds: async ids => runs.filter(r => ids.includes(r.id)),
    eventsForRuns: async ids => {
      loaded.push([...ids]);
      return new Map(ids.map(id => [id, events[id] ?? []]));
    },
  };
  const app = new OpenAPIHono();
  registerRunRecordsRoute(app, deps);
  const read = async (ids: string[], outputKeys: string[] = []) => {
    const query = new URLSearchParams();
    for (const id of ids) query.append('runId', id);
    for (const key of outputKeys) query.append('outputKey', key);
    return app.request(`/api/workflows/runs/records?${query.toString()}`);
  };
  return { read, loaded };
}

describe('GET /api/workflows/runs/records', () => {
  const ended = run('ended', 'completed');
  const going = run('going', 'running');
  const events = {
    ended: [event('ended', 1, 'node_started', 'a'), event('ended', 2, 'node_completed', 'a')],
    going: [
      event('going', 1, 'node_started', 'loop'),
      event('going', 2, 'loop_iteration_started', 'loop', { iteration: 1, maxIterations: 3 }),
      event('going', 3, 'loop_iteration_completed', 'loop', { iteration: 1 }),
      event('going', 4, 'loop_iteration_started', 'loop', { iteration: 2, maxIterations: 3 }),
      event('going', 5, 'node_started', 'loop.check'),
    ],
  };

  test('reads each run as a record, with no events, and lists an unknown id as missing', async () => {
    const { read } = appWith([ended, going], events);
    const res = await read(['going', 'ended', 'nobody']);
    expect(res.status).toBe(200);
    const body = runRecordsResponseSchema.parse(await res.json());
    expect(body.records.map(r => r.id)).toEqual(['going', 'ended']);
    expect(body.missing).toEqual(['nobody']);
    const [live, done] = body.records;
    expect(live?.running).toEqual(['loop', 'loop.check']);
    expect(live?.loop_iterations).toEqual([
      { group: 'loop', iteration: 1, max: 3, completed: true },
      { group: 'loop', iteration: 2, max: 3, completed: false },
    ]);
    expect(done?.running).toEqual([]);
    expect(done?.node_outcomes.nodes.map(n => n.node_id)).toEqual(['a']);
    expect(JSON.stringify(body)).not.toContain('event_type');
  });

  test('folds an ended run once across reads, and a running one every time', async () => {
    const { read, loaded } = appWith([ended, going], events);
    await read(['ended', 'going']);
    await read(['ended', 'going']);
    expect(loaded).toEqual([['ended', 'going'], ['going']]);
  });

  test('keeps only the output and result fields asked for', async () => {
    const done = run('done', 'completed');
    const output = { outcome: 'approve', summary: 'ok', findings: ['long'] };
    const { read } = appWith([done], {
      done: [
        event('done', 1, 'node_started', 'a'),
        event('done', 2, 'node_completed', 'a', { structured_output: output }),
      ],
    });
    const res = await read(['done'], ['outcome']);
    const body = runRecordsResponseSchema.parse(await res.json());
    expect(body.records[0]?.node_outcomes.nodes[0]?.output).toEqual({ outcome: 'approve' });
  });

  test('refuses more than 100 ids', async () => {
    const { read } = appWith([], {});
    const ids = Array.from({ length: 101 }, (_, i) => `r${String(i)}`);
    expect((await read(ids)).status).toBe(400);
  });
});
