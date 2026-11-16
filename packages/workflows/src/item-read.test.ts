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
    completed_outcome: null,
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

// Two top-level runs on the item; the second was started first. The later one has two
// `workflow:` children paused on questions, the older of which the queue returns last, and
// an unrelated run asks one too.
const first = run('first', {
  status: 'completed',
  completed_outcome: 'built',
  started_at: new Date('2026-11-01T09:00:00.000Z'),
  completed_at: new Date('2026-11-01T09:30:00.000Z'),
});
// The second run was started by the end of the first; its receipt holds that cause.
const SECOND_RECEIPT = '5a4f7f9e-2b0e-4a4c-9d36-1c1f1f6f3a10';
const second = run('second', {
  started_at: new Date('2026-11-01T11:00:00.000Z'),
  metadata: { resource_start: { receiptId: SECOND_RECEIPT, bindingId: 'review' } },
});
const child = asking('child', '2026-11-01T11:10:00.000Z', {
  parent_run_id: 'second',
  item_id: null,
});
const sibling = asking('sibling', '2026-11-01T11:02:00.000Z', {
  parent_run_id: 'second',
  item_id: null,
});
const unrelated = asking('unrelated', '2026-11-01T08:00:00.000Z', { item_id: null });
const runs = new Map([first, second, child, sibling, unrelated].map(row => [row.id, row]));

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
      projectKey === item.projectKey && key === item.key
        ? { item, runs: [first, second], descendantIds: ['child', 'sibling'] }
        : null,
    listEventsForRuns: async ids =>
      new Map(ids.map(id => [id, events.filter(row => row.workflow_run_id === id)])),
    listAttentionQueueRows: async () => [unrelated, child, sibling],
    getWorkflowRun: async id => runs.get(id) ?? null,
    getWorkflowRunForAttention: async id => runs.get(id) ?? null,
    getCodebase: async () => null,
    getItem: async () => null,
    getResourceStartRequest: async () => null,
    getStartReceipt: async id =>
      id === SECOND_RECEIPT
        ? {
            id,
            sourceInstanceId: 'review-after-deliver',
            deliveryId: 'first',
            contentDigest: 'digest',
            receivedAt: '2026-11-01T09:30:00.000Z',
            occurredAt: null,
            sourceActor: { source: 'archon-run-ended', id: 'first', display: 'built' },
            itemKey: item.key,
            outcome: 'matched',
            reason: null,
            bindings: [],
          }
        : null,
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
        outcome: 'built',
        startedAt: '2026-11-01T09:00:00.000Z',
        completedAt: '2026-11-01T09:30:00.000Z',
        cause: null,
        awaitingExecution: null,
      },
      {
        id: 'second',
        workflow: 'deliver',
        status: 'running',
        outcome: null,
        startedAt: '2026-11-01T11:00:00.000Z',
        completedAt: null,
        cause: { kind: 'run_ended', runId: 'first' },
        awaitingExecution: null,
      },
    ]);
    // The children's questions are the item's, under their own run ids, oldest first; the
    // unrelated one is not.
    expect(read?.questions.map(question => [question.kind, question.run?.id])).toEqual([
      ['attention', 'sibling'],
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
      store: { ...source.store, getItemRuns: async () => ({ item, runs: [], descendantIds: [] }) },
    };
    expect(await readItem(empty, item.projectKey, item.key)).toEqual({
      item,
      runs: [],
      questions: [],
      answers: [],
      degraded: [],
    });
  });

  test('a run the store could not read is reported, and the rest of the item still reads', async () => {
    // One of the item's own runs and one paused child do not normalize. The store still
    // finds both by id, and the queue reports the paused one as unreadable.
    const unreadable = { type: 'degraded', reason: 'run_unreadable' } as const;
    const broken: ItemReadSource = {
      ...source,
      store: {
        ...source.store,
        getItemRuns: async () => ({
          item,
          runs: [first, { ...unreadable, runId: 'lost-root' }, second],
          descendantIds: ['child', 'lost-child'],
        }),
        listAttentionQueueRows: async () => [child, { ...unreadable, runId: 'lost-child' }],
      },
    };
    const read = await readItem(broken, item.projectKey, item.key);
    expect(read?.runs.map(row => row.id)).toEqual(['first', 'second']);
    expect(read?.questions.map(question => question.run?.id)).toEqual(['child']);
    expect(read?.answers.map(answer => answer.runId)).toEqual([
      'first',
      'first',
      'child',
      'second',
    ]);
    expect(read?.degraded).toEqual([
      { ...unreadable, runId: 'lost-root' },
      { ...unreadable, runId: 'lost-child' },
    ]);
  });
});
