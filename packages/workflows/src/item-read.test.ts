import { describe, expect, test } from 'bun:test';
import { readItem, type ItemReadSource } from './item-read';
import type { WorkflowEventRow } from './schemas/workflow-event';
import type { WorkflowItem, WorkflowRun } from './schemas/workflow-run';

const item: WorkflowItem = { id: 'item-row', projectKey: 'acme/web', key: 'issue-7' };

function run(id: string, fields: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    origin: null,
    id,
    workflow_name: 'deliver',
    conversation_id: null,
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    outcome: null,
    user_message: '',
    metadata: {},
    active_phase_started_at: null,
    started_at: new Date('2026-11-01T10:00:00.000Z'),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    item_id: item.id,
    ...fields,
  };
}

function asking(id: string, since: string, fields: Partial<WorkflowRun>): WorkflowRun {
  return run(id, {
    status: 'paused',
    metadata: {
      wait: {
        owner: 'node',
        nodeId: 'ask',
        kind: 'attention',
        waitingSince: since,
        message: `Question from ${id}`,
        pauseId: `pause-${id}`,
      },
    },
    ...fields,
  });
}

function event(
  runId: string,
  event_type: string,
  created_at: string,
  data: Record<string, unknown>
): WorkflowEventRow {
  return {
    id: `${runId}-${created_at}`,
    workflow_run_id: runId,
    event_type,
    step_index: null,
    step_name: 'ask',
    data,
    created_at,
  };
}

// Two top-level runs on the item; the second was started first. The later one has a
// `workflow:` child paused on a question, and an unrelated run asks one too.
const first = run('first', {
  status: 'completed',
  outcome: 'succeeded',
  started_at: new Date('2026-11-01T09:00:00.000Z'),
  completed_at: new Date('2026-11-01T09:30:00.000Z'),
});
const second = run('second', { started_at: new Date('2026-11-01T11:00:00.000Z') });
const child = asking('child', '2026-11-01T11:10:00.000Z', {
  parent_run_id: 'second',
  item_id: null,
});
const unrelated = asking('unrelated', '2026-11-01T08:00:00.000Z', { item_id: null });
const runs = new Map([first, second, child, unrelated].map(row => [row.id, row]));

const events: WorkflowEventRow[] = [
  event('child', 'wait_answered', '2026-11-01T11:05:00.000Z', {
    via: 'cli',
    occurrence: 'pause-earlier',
    answer: { decision: 'accept', text: '' },
    by: { declared: 'triage-agent' },
  }),
  event('first', 'approval_received', '2026-11-01T09:20:00.000Z', {
    via: 'api',
    occurrence: 'gate-1',
    decision: 'rejected',
    reason: 'needs tests',
  }),
  // An older gate row recorded no occurrence or surface; it still reads as an answer.
  event('first', 'approval_received', '2026-11-01T09:25:00.000Z', { decision: 'approved' }),
  // The parent's gate is read before its child's rows but was answered after them.
  event('second', 'approval_received', '2026-11-01T11:20:00.000Z', {
    via: 'slack',
    occurrence: 'gate-2',
    decision: 'approved',
    comment: 'ship it',
  }),
  event('unrelated', 'wait_answered', '2026-11-01T08:30:00.000Z', { via: 'cli' }),
];

const source: ItemReadSource = {
  branchOf: async () => null,
  store: {
    getItemRuns: async (projectKey, key) =>
      projectKey === item.projectKey && key === item.key ? { item, runs: [first, second] } : null,
    findChildRuns: async id => [...runs.values()].filter(row => row.parent_run_id === id),
    listEventsForRuns: async ids =>
      new Map(ids.map(id => [id, events.filter(row => row.workflow_run_id === id)])),
    listAttentionQueueRows: async () => [unrelated, child],
    getWorkflowRun: async id => runs.get(id) ?? null,
    getWorkflowRunForAttention: async id => runs.get(id) ?? null,
    getCodebase: async () => null,
    getItem: async () => null,
  },
};

describe('reading an item', () => {
  test('lists its own runs, and the questions and answers of their whole tree, oldest first', async () => {
    const read = await readItem(source, item.projectKey, item.key);
    expect(read?.item).toEqual(item);
    expect(read?.runs).toEqual([
      {
        id: 'first',
        workflow: 'deliver',
        status: 'completed',
        outcome: 'succeeded',
        startedAt: '2026-11-01T09:00:00.000Z',
        completedAt: '2026-11-01T09:30:00.000Z',
      },
      {
        id: 'second',
        workflow: 'deliver',
        status: 'running',
        outcome: null,
        startedAt: '2026-11-01T11:00:00.000Z',
        completedAt: null,
      },
    ]);
    // The child's question is the item's, under the child's run id; the unrelated one is not.
    expect(read?.questions.map(question => [question.kind, question.run?.id])).toEqual([
      ['attention', 'child'],
    ]);
    expect(read?.answers).toEqual([
      {
        kind: 'gate',
        runId: 'first',
        node: 'ask',
        occurrence: 'gate-1',
        at: '2026-11-01T09:20:00.000Z',
        via: 'api',
        decision: 'rejected',
        text: 'needs tests',
      },
      {
        kind: 'gate',
        runId: 'first',
        node: 'ask',
        occurrence: null,
        at: '2026-11-01T09:25:00.000Z',
        via: null,
        decision: 'approved',
        text: null,
      },
      {
        kind: 'attention',
        runId: 'child',
        node: 'ask',
        occurrence: 'pause-earlier',
        at: '2026-11-01T11:05:00.000Z',
        via: 'cli',
        answer: { decision: 'accept', text: '' },
        by: { declared: 'triage-agent' },
        fromRun: null,
      },
      {
        kind: 'gate',
        runId: 'second',
        node: 'ask',
        occurrence: 'gate-2',
        at: '2026-11-01T11:20:00.000Z',
        via: 'slack',
        decision: 'approved',
        text: 'ship it',
      },
    ]);
    expect(read?.degraded).toEqual([]);
  });

  test('an unknown key reads as null, an item with no runs as empty', async () => {
    expect(await readItem(source, item.projectKey, 'issue-8')).toBeNull();
    const empty: ItemReadSource = {
      ...source,
      store: { ...source.store, getItemRuns: async () => ({ item, runs: [] }) },
    };
    expect(await readItem(empty, item.projectKey, item.key)).toEqual({
      item,
      runs: [],
      questions: [],
      answers: [],
      degraded: [],
    });
  });
});
