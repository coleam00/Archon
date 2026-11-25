import { describe, expect, test } from 'bun:test';
import { readItem, readItemOfRun, type ItemReadSource } from './item-read';
import { heldRunOf } from './attention-queue';
import type { ResourceStartRequestInspection } from './resource-start-store';
import type { ItemMerge } from './schemas/item-merge';
import type { ItemEnd } from './schemas/item-end';
import type { ItemLanding } from './schemas/item-landing';
import type { StoredItemAsk } from './schemas/item-ask';
import type { ItemLink } from './schemas/item-link';
import type { ItemRuling } from './schemas/item-ruling';
import type { WorkflowEventRow } from './schemas/workflow-event';
import { RUN_DISPATCH_METADATA_KEY } from './schemas/run-metadata';
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
  metadata: { total_cost_usd: 0.42, total_tokens_in: 1200, total_tokens_out: 300 },
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

// Rulings come from the store oldest first; one falls between the item's answers, and
// a withdrawn one still reads.
const rulings: ItemRuling[] = [
  {
    kind: 'ruling',
    id: 'ruling-1',
    text: 'do not accept an empty outcome',
    at: '2026-11-01T09:22:00.000Z',
    via: 'api',
    by: null,
    fromRun: null,
    withdrawn: { at: '2026-11-01T12:00:00.000Z', via: 'cli', by: null, fromRun: null },
  },
  {
    kind: 'ruling',
    id: 'ruling-2',
    text: 'leave the chat readers for a follow-up',
    at: '2026-11-01T11:15:00.000Z',
    via: 'cli',
    by: { declared: 'operator-agent' },
    fromRun: { runId: 'elsewhere', nodePath: 'triage' },
    withdrawn: null,
  },
];

const merge: ItemMerge = {
  change: 'https://github.com/acme/web/pull/12',
  commit: null,
  at: '2026-11-01T12:30:00.000Z',
  recordedAt: '2026-11-01T12:31:00.000Z',
  via: 'cli',
  fromRun: null,
};
const landing: ItemLanding = {
  branch: 'feat/order-1',
  recordedAt: '2026-11-01T08:00:00.000Z',
  fromRun: null,
};
const other: WorkflowItem = { id: 'other-row', projectKey: 'acme/web', key: 'issue-3' };
const whole: WorkflowItem = { id: 'whole-row', projectKey: 'acme/web', key: 'order-1' };
const linkAct = { at: '2026-11-01T09:00:00.000Z', via: 'cli', by: null, fromRun: null } as const;
const links: ItemLink[] = [
  { id: 'link-out', kind: 'depends_on', from: item, to: other, ...linkAct, ended: null },
  { id: 'link-in', kind: 'duplicate_of', from: other, to: item, ...linkAct, ended: null },
  {
    id: 'link-ended',
    kind: 'part_of',
    from: item,
    to: whole,
    ...linkAct,
    ended: { ...linkAct, at: '2026-11-01T09:30:00.000Z', by: { declared: 'alice' } },
  },
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
    getItem: async id => (id === item.id ? item : null),
    listItemAsks: async () => [],
    listOpenItemWaits: async () => [],
    listItemRulings: async id => (id === item.id ? rulings : []),
    getItemMerge: async id => (id === item.id ? merge : null),
    getItemLanding: async id => (id === item.id ? landing : null),
    getHoldingItemEnd: async () => null,
    listItemLinks: async id => (id === item.id ? links : []),
    getResourceStartRequest: async () => null,
    listSkippedItemStarts: async () => [],
    readItemStartLimits: async () => ({ limits: [], countedUnder: {} }),
    listQueuedItemStarts: async () => [],
    getInstallHold: async () => null,
    getRunLimit: async () => null,
    listHeldItemStarts: async () => [],
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
  test('a set with an unreadable ask row does not read as settled; a readable set does, with its run gone', async () => {
    const act = { via: 'cli', by: null, fromRun: null } as const;
    const stored = (
      id: string,
      runId: string,
      at: string,
      closed: 'answered' | 'withdrawn'
    ): StoredItemAsk => ({
      id,
      itemId: item.id,
      runId,
      workflowName: 'deliver',
      position: 0,
      ask: {
        question: `Ask ${id}?`,
        context: 'Context.',
        options: [
          { id: 'keep', does: 'Keep it.', cost: 'None.' },
          { id: 'drop', does: 'Drop it.', cost: 'None.' },
        ],
        recommendation: { option: 'keep', why: 'Cheaper.' },
        artifacts: [],
      },
      openedAt: '2026-11-01T12:00:00.000Z',
      closed:
        closed === 'answered'
          ? { as: 'answered', answer: { decision: 'keep', text: '' }, act: { ...act, at } }
          : { as: 'withdrawn', act: { ...act, at } },
    });
    const unreadable = { type: 'degraded', reason: 'run_unreadable', runId: 'open-set' } as const;
    const withAsks: ItemReadSource = {
      ...source,
      store: {
        ...source.store,
        // 'settled-set' has no run row: its run was deleted, and its asks stay on the item.
        listItemAsks: async () => [
          stored('a1', 'open-set', '2026-11-01T12:10:00.000Z', 'answered'),
          unreadable,
          stored('b1', 'settled-set', '2026-11-01T12:20:00.000Z', 'answered'),
          stored('b2', 'settled-set', '2026-11-01T12:30:00.000Z', 'withdrawn'),
        ],
      },
    };
    const read = await readItem(withAsks, item.projectKey, item.key);
    const asks = read?.answers.filter(
      answer => answer.kind === 'ask' || answer.kind === 'asks_settled'
    );
    expect(asks?.map(answer => [answer.kind, answer.runId])).toEqual([
      ['ask', 'open-set'],
      ['ask', 'settled-set'],
      ['ask', 'settled-set'],
      ['asks_settled', 'settled-set'],
    ]);
    expect(asks?.at(-1)).toMatchObject({
      at: '2026-11-01T12:30:00.000Z',
      answered: 1,
      withdrawn: 1,
    });
    expect(read?.degraded).toEqual([unreadable]);
  });

  test('a run started under a start limit names it, and the item lists where that limit stands', async () => {
    const standing = {
      name: 'check',
      starts: 3,
      resetOn: 'plan',
      since: null,
      granted: 0,
      used: 3,
      left: 0,
    };
    const read = await readItem(
      {
        ...source,
        store: {
          ...source.store,
          readItemStartLimits: async () => ({
            limits: [standing],
            countedUnder: { second: 'check' },
          }),
        },
      },
      item.projectKey,
      item.key
    );
    // A host that reads no trigger files cannot say which bindings count under it.
    expect(read?.startLimits).toEqual([{ ...standing, bindings: null }]);
    expect(read?.runs.map(run => [run.id, run.startLimit])).toEqual([
      ['first', null],
      ['second', 'check'],
    ]);
  });

  test('lists its own runs, and the questions and answers of their whole tree, oldest first', async () => {
    const read = await readItem(source, item.projectKey, item.key);
    expect(read?.item).toEqual(item);
    expect(read?.runs).toEqual([
      {
        id: 'first',
        workflow: 'deliver',
        pack: null,
        status: 'completed',
        outcome: 'built',
        startedAt: '2026-11-01T09:00:00.000Z',
        completedAt: '2026-11-01T09:30:00.000Z',
        cause: null,
        awaitingExecution: null,
        startLimit: null,
        spend: { usd: 0.42, inputTokens: 1200, outputTokens: 300 },
        heldBehind: null,
        operatorPause: null,
        hasResult: false,
        resultCommit: null,
        changeSize: null,
      },
      {
        id: 'second',
        workflow: 'deliver',
        pack: null,
        status: 'running',
        outcome: null,
        startedAt: '2026-11-01T11:00:00.000Z',
        completedAt: null,
        cause: { kind: 'run_ended', runId: 'first', sourceInstanceId: 'review-after-deliver' },
        awaitingExecution: null,
        startLimit: null,
        spend: { usd: null, inputTokens: null, outputTokens: null },
        heldBehind: null,
        operatorPause: null,
        hasResult: false,
        resultCommit: null,
        changeSize: null,
      },
    ]);
    // The children's questions are the item's, under their own run ids, oldest first; the
    // unrelated one is not.
    expect(read?.questions.map(question => [question.kind, heldRunOf(question)?.id])).toEqual([
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
      rulings[0],
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
      rulings[1],
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
    expect(read?.merged).toEqual(merge);
    expect(read?.landing).toEqual({ branch: 'feat/order-1', from: { kind: 'own' } });
    expect(read?.degraded).toEqual([]);
  });

  test('reads the run limit the store reports, and marks the queued starts only it holds', async () => {
    const queued = (requestId: string) => ({
      requestId,
      workflow: 'review',
      resource: 'build',
      hostId: 'host',
      queuedAt: '2026-11-01T09:35:00.000Z',
      ahead: 0,
      blockedBy: null,
    });
    const limited: ItemReadSource = {
      ...source,
      store: {
        ...source.store,
        listQueuedItemStarts: async () => [queued('held'), queued('free')],
        getRunLimit: async () => ({ limit: 2, live: 2, waiting: ['held'] }),
      },
    };
    const read = await readItem(limited, item.projectKey, item.key);
    expect(read?.runLimit).toEqual({ limit: 2, live: 2 });
    expect(read?.queued.map(start => [start.requestId, start.waitsForRunLimit])).toEqual([
      ['held', true],
      ['free', false],
    ]);
  });

  test('an end the store holds reads as ended until a held trigger start waits on the item', async () => {
    const end: ItemEnd = {
      kind: 'ended',
      id: 'end-1',
      reason: 'Done by hand elsewhere.',
      at: '2026-11-01T10:00:00.000Z',
      via: 'cli',
      by: { declared: 'alice' },
      fromRun: null,
    };
    const ended: ItemReadSource = {
      ...source,
      store: { ...source.store, getHoldingItemEnd: async id => (id === item.id ? end : null) },
    };
    expect((await readItem(ended, item.projectKey, item.key))?.ended).toEqual(end);
    const held: ItemReadSource = {
      ...ended,
      store: {
        ...ended.store,
        listHeldItemStarts: async () => [
          {
            receiptId: 'receipt-1',
            bindingId: 'binding',
            hostId: 'host',
            workflow: 'review',
            receivedAt: '2026-11-01T11:00:00.000Z',
          },
        ],
      },
    };
    expect((await readItem(held, item.projectKey, item.key))?.ended).toBeNull();
  });

  test('a landing that cannot be resolved is reported, and the rest of the item still reads', async () => {
    const unreadable: ItemReadSource = {
      ...source,
      store: {
        ...source.store,
        getItemLanding: async id => ({
          type: 'degraded',
          reason: 'landing_unreadable',
          itemId: id,
        }),
      },
    };
    const read = await readItem(unreadable, item.projectKey, item.key);
    expect(read?.landing).toBeNull();
    expect(read?.merged).toEqual(merge);
    expect(read?.degraded).toEqual([
      expect.objectContaining({ reason: 'landing_unresolved', message: expect.any(String) }),
    ]);
  });

  test('an unknown key reads as null, an item with no runs as empty but for its rulings', async () => {
    expect(await readItem(source, item.projectKey, 'issue-8')).toBeNull();
    const empty: ItemReadSource = {
      ...source,
      store: {
        ...source.store,
        getItemRuns: async () => ({ item, runs: [], descendantIds: [] }),
        listItemLinks: async () => [],
      },
    };
    expect(await readItem(empty, item.projectKey, item.key)).toEqual({
      item,
      runs: [],
      queued: [],
      skipped: [],
      hold: null,
      runLimit: null,
      startLimits: [],
      held: [],
      waits: [],
      questions: [],
      answers: rulings,
      merged: merge,
      landing: { branch: 'feat/order-1', from: { kind: 'own' } },
      links: [],
      ended: null,
      workOrder: null,
      degraded: [],
    });
  });

  test('a run reads the pack and in-pack name its dispatch recorded, not its public name', async () => {
    const dispatched = (pack: string, source: string) => ({
      [RUN_DISPATCH_METADATA_KEY]: {
        base_branch: 'dev',
        pack,
        pack_workflow: 'stage-check',
        source,
      },
    });
    const project = run('project', {
      workflow_name: 'stage-check',
      metadata: dispatched('archon-software-factory', 'project'),
    });
    // An entrypoint may publish the workflow under another name than its `name:`.
    const installed = run('installed', {
      workflow_name: 'acme/archon-software-factory:check',
      metadata: dispatched('acme.archon-software-factory', 'installed'),
    });
    // Recorded by an older build: a pack but no in-pack name, which is not guessed.
    const older = run('older', {
      workflow_name: 'stage-check',
      metadata: {
        [RUN_DISPATCH_METADATA_KEY]: { base_branch: 'dev', pack: 'archon-software-factory' },
      },
    });
    const packed: ItemReadSource = {
      ...source,
      store: {
        ...source.store,
        getItemRuns: async () => ({ item, runs: [project, installed, older], descendantIds: [] }),
      },
    };
    const read = await readItem(packed, item.projectKey, item.key);
    expect(read?.runs.map(({ workflow, pack }) => ({ workflow, pack }))).toEqual([
      {
        workflow: 'stage-check',
        pack: { key: 'archon-software-factory', workflow: 'stage-check' },
      },
      {
        workflow: 'acme/archon-software-factory:check',
        pack: { key: 'acme.archon-software-factory', workflow: 'stage-check' },
      },
      { workflow: 'stage-check', pack: null },
    ]);
  });

  test('a start admitted while the item is read is listed once, as a run', async () => {
    const admitted: WorkflowRun = { ...first, id: 'admitted', status: 'pending', metadata: {} };
    // One start, either queued or admitted, never both. Admission lands right after the
    // second store read (the first resolves the item), whichever read that is, so a read
    // that takes the runs before the queue sees the start in neither.
    let reads = 0;
    let isAdmitted = false;
    const read = async <T>(value: () => T): Promise<T> => {
      const result = value();
      if (++reads === 2) isAdmitted = true;
      return result;
    };
    const racing: ItemReadSource = {
      ...source,
      store: {
        ...source.store,
        getItemRuns: () =>
          read(() => ({ item, runs: isAdmitted ? [admitted] : [], descendantIds: [] })),
        listQueuedItemStarts: () =>
          read(() =>
            isAdmitted
              ? []
              : [
                  {
                    requestId: 'admitted',
                    workflow: 'deliver',
                    resource: 'build',
                    hostId: 'host',
                    queuedAt: '2026-11-01T11:05:00.000Z',
                    ahead: 0,
                    blockedBy: null,
                  },
                ]
          ),
      },
    };
    const result = await readItem(racing, item.projectKey, item.key);
    expect(isAdmitted).toBe(true);
    expect(result?.runs.map(run => run.id)).toEqual(['admitted']);
    expect(result?.queued).toEqual([]);
  });

  test('an admitted start reads what the observer sees of its executor, and unknown without one', async () => {
    const admitted = run('admitted', { status: 'pending' });
    const request: ResourceStartRequestInspection = {
      id: 'admitted',
      resource: 'build',
      hostId: 'host',
      overlap: 'queue',
      status: 'admitted',
      runStatus: 'pending',
      blocker: null,
      blockerRunStatus: null,
      launch: {
        version: 2,
        run: {
          id: 'admitted',
          workflow_name: 'deliver',
          codebase_id: 'codebase',
          user_message: '',
          metadata: {},
        },
        execution: {
          cwd: '/repo',
          conversationId: 'conversation',
          isolation: { kind: 'in-place' },
        },
      },
    };
    const pending: ItemReadSource = {
      ...source,
      store: {
        ...source.store,
        getItemRuns: async () => ({ item, runs: [admitted], descendantIds: [] }),
        getResourceStartRequest: async id => (id === 'admitted' ? request : null),
      },
    };
    const awaiting = async (from: ItemReadSource) =>
      (await readItem(from, item.projectKey, item.key))?.runs[0]?.awaitingExecution;
    const executor = { host: 'here', pid: 4242 };

    // A reader that cannot look never reports the executor absent.
    expect(await awaiting(pending)).toEqual({
      requestId: 'admitted',
      hostId: 'host',
      state: 'unknown',
      executor: null,
    });
    expect(
      await awaiting({
        ...pending,
        startExecutor: { observe: async () => ({ state: 'starting', executor }) },
      })
    ).toEqual({ requestId: 'admitted', hostId: 'host', state: 'starting', executor });
    // The run moved on while it was observed: it no longer awaits execution.
    expect(await awaiting({ ...pending, startExecutor: { observe: async () => null } })).toBeNull();
  });

  test('links read from this item: outgoing to what it points at, incoming from what points at it', async () => {
    const read = await readItem(source, item.projectKey, item.key);
    expect(read?.links).toEqual([
      { id: 'link-out', kind: 'depends_on', direction: 'outgoing', other, ...linkAct, ended: null },
      {
        id: 'link-in',
        kind: 'duplicate_of',
        direction: 'incoming',
        other,
        ...linkAct,
        ended: null,
      },
      // An ended link stays in the read with who ended it and when.
      {
        id: 'link-ended',
        kind: 'part_of',
        direction: 'outgoing',
        other: whole,
        ...linkAct,
        ended: { ...linkAct, at: '2026-11-01T09:30:00.000Z', by: { declared: 'alice' } },
      },
    ]);
  });

  test('a run reads the item of its root, and a run with no item reads null', async () => {
    expect((await readItemOfRun(source, 'child'))?.item).toEqual(item);
    // Two levels down: the walk must reach the root, not stop at the first parent.
    const grandchild = run('grandchild', { parent_run_id: 'child', item_id: null });
    const deeper: ItemReadSource = {
      ...source,
      store: {
        ...source.store,
        getWorkflowRun: async id => (id === 'grandchild' ? grandchild : (runs.get(id) ?? null)),
      },
    };
    expect((await readItemOfRun(deeper, 'grandchild'))?.item).toEqual(item);
    expect(await readItemOfRun(source, 'unrelated')).toBeNull();
    expect(await readItemOfRun(source, 'missing')).toBeNull();
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
        listItemRulings: async () => [
          { type: 'degraded', reason: 'ruling_unreadable', rulingId: 'lost-ruling' },
        ],
        getItemMerge: async () => ({
          type: 'degraded',
          reason: 'merge_unreadable',
          itemId: item.id,
        }),
        listItemLinks: async () => [
          { type: 'degraded', reason: 'link_unreadable', linkId: 'lost-link' },
        ],
      },
    };
    const read = await readItem(broken, item.projectKey, item.key);
    expect(read?.runs.map(row => row.id)).toEqual(['first', 'second']);
    expect(read?.questions.map(question => heldRunOf(question)?.id)).toEqual(['child']);
    expect(read?.answers.map(answer => answer.kind !== 'ruling' && answer.runId)).toEqual([
      'first',
      'first',
      'child',
      'second',
    ]);
    expect(read?.degraded).toEqual([
      { ...unreadable, runId: 'lost-root' },
      { ...unreadable, runId: 'lost-child' },
      { type: 'degraded', reason: 'ruling_unreadable', rulingId: 'lost-ruling' },
      { type: 'degraded', reason: 'merge_unreadable', itemId: item.id },
      { type: 'degraded', reason: 'link_unreadable', linkId: 'lost-link' },
    ]);
    expect(read?.merged).toBeNull();
  });

  test('a start held behind the run of its workflow on the item names that run and its owner', async () => {
    // `second` runs `deliver` on the item and its owner is gone. A hand start of `deliver`
    // waits behind it; a `review` run on the same item is held by nothing.
    const waiting = run('waiting', {
      status: 'pending',
      started_at: new Date('2026-11-01T12:00:00Z'),
    });
    const review = run('review', {
      workflow_name: 'review',
      status: 'pending',
      started_at: new Date('2026-11-01T12:01:00Z'),
    });
    const queued = (requestId: string, workflow: string) => ({
      requestId,
      workflow,
      resource: 'build',
      hostId: 'host',
      queuedAt: '2026-11-01T12:02:00.000Z',
      ahead: 0,
      blockedBy: null,
    });
    const held: ItemReadSource = {
      ...source,
      ownerLost: { runs: async () => [second], observe: async () => 'unreachable' },
      store: {
        ...source.store,
        getItemRuns: async () => ({
          item,
          runs: [first, second, waiting, review],
          descendantIds: [],
        }),
        listQueuedItemStarts: async () => [
          queued('queued-deliver', 'deliver'),
          queued('queued-review', 'review'),
        ],
        listSkippedItemStarts: async () => [
          {
            requestId: 'skipped-deliver',
            workflow: 'deliver',
            resource: 'build',
            blockerRunId: 'second',
          },
        ],
      },
    };
    const read = await readItem(held, item.projectKey, item.key);
    const behindSecond = {
      runId: 'second',
      workflow: 'deliver',
      status: 'running',
      owner: 'unreachable',
    } as const;
    expect(read?.runs.map(row => [row.id, row.heldBehind])).toEqual([
      ['first', null],
      ['second', null],
      ['waiting', behindSecond],
      ['review', null],
    ]);
    expect(read?.queued.map(start => [start.requestId, start.heldBehind])).toEqual([
      ['queued-deliver', behindSecond],
      ['queued-review', null],
    ]);
    expect(read?.skipped.map(start => [start.requestId, start.heldBehind])).toEqual([
      ['skipped-deliver', behindSecond],
    ]);
    // The lost owner is reported on the starts held behind it, not as an open question.
    expect(read?.questions).toEqual([]);
  });
});

describe('reading a work order', () => {
  const order: WorkflowItem = { id: 'order-row', projectKey: 'acme/web', key: 'order-9' };
  const a: WorkflowItem = { id: 'a-row', projectKey: 'acme/web', key: 'issue-a' };
  const b: WorkflowItem = { id: 'b-row', projectKey: 'acme/web', key: 'issue-b' };
  const c: WorkflowItem = { id: 'c-row', projectKey: 'acme/web', key: 'issue-c' };
  const partOf = (from: WorkflowItem, to: WorkflowItem): ItemLink => ({
    id: `${from.key}-in-${to.key}`,
    kind: 'part_of',
    from,
    to,
    ...linkAct,
    ended: null,
  });
  const end: ItemEnd = {
    kind: 'ended',
    id: 'end-a',
    reason: 'Not needed.',
    at: '2026-11-01T10:00:00.000Z',
    via: 'cli',
    by: { declared: 'alice' },
    fromRun: null,
  };

  /** The order's read, with no run on it, where `merged` and `ended` name which items carry those facts. */
  async function readOrder(facts: {
    links: ItemLink[];
    merged?: string[];
    ended?: string[];
    store?: Partial<ItemReadSource['store']>;
  }) {
    const linksOf = (id: string) =>
      facts.links.filter(link => link.from.id === id || link.to.id === id);
    const read = await readItem(
      {
        ...source,
        store: {
          ...source.store,
          getItemRuns: async () => ({ item: order, runs: [], descendantIds: [] }),
          listItemRulings: async () => [],
          getItemMerge: async id => (facts.merged?.includes(id) ? merge : null),
          getItemLanding: async () => null,
          getHoldingItemEnd: async id => (facts.ended?.includes(id) ? end : null),
          listItemLinks: async id => linksOf(id),
          ...facts.store,
        },
      },
      order.projectKey,
      order.key
    );
    return { workOrder: read?.workOrder, degraded: read?.degraded };
  }

  test('one open member and one merged member: open, naming the open member', async () => {
    const links = [partOf(a, order), partOf(b, order)];
    expect((await readOrder({ links, merged: [b.id] })).workOrder).toEqual({
      state: 'open',
      members: [
        { item: a, state: 'open' },
        { item: b, state: 'merged' },
      ],
    });
  });

  test('once the open member merges or is ended, the order is done with no run on it', async () => {
    const links = [partOf(a, order), partOf(b, order)];
    expect((await readOrder({ links, merged: [a.id, b.id] })).workOrder?.state).toBe('done');
    expect((await readOrder({ links, merged: [b.id], ended: [a.id] })).workOrder).toEqual({
      state: 'done',
      members: [
        { item: a, state: 'ended' },
        { item: b, state: 'merged' },
      ],
    });
  });

  test('an ended member whose end no longer holds makes the order open again', async () => {
    // A start waiting on the member reopens it; the store's newer-run rule is `getHoldingItemEnd`'s.
    const held = {
      receiptId: 'receipt-a',
      bindingId: 'binding',
      hostId: 'host',
      workflow: 'build',
      receivedAt: '2026-11-01T11:00:00.000Z',
    };
    const read = await readOrder({
      links: [partOf(a, order)],
      ended: [a.id],
      store: { listHeldItemStarts: async id => (id === a.id ? [held] : []) },
    });
    expect(read.workOrder?.state).toBe('open');
  });

  test('an unreadable member merge reads unknown, never done, and is reported with its member', async () => {
    const lost = { type: 'degraded', reason: 'merge_unreadable', itemId: a.id } as const;
    const read = await readOrder({
      links: [partOf(a, order), partOf(b, order)],
      merged: [b.id],
      store: { getItemMerge: async id => (id === a.id ? lost : id === b.id ? merge : null) },
    });
    expect(read.workOrder?.state).toBe('unknown');
    expect(read.workOrder?.members[0]).toEqual({ item: a, state: 'unknown' });
    expect(read.degraded).toEqual([
      { type: 'degraded', reason: 'member_unreadable', member: a, report: lost },
    ]);
  });

  test('an unreadable link of the order itself keeps it from done', async () => {
    const read = await readOrder({
      links: [partOf(a, order)],
      merged: [a.id],
      store: {
        listItemLinks: async id =>
          id === order.id
            ? [partOf(a, order), { type: 'degraded', reason: 'link_unreadable', linkId: 'lost' }]
            : [],
      },
    });
    expect(read.workOrder?.state).toBe('unknown');
  });

  test('a member that is a work order follows its own members, not its own merge', async () => {
    // b is part of a, and a is part of the order; a merge recorded on a does not close it.
    const links = [partOf(a, order), partOf(b, a)];
    expect((await readOrder({ links, merged: [a.id] })).workOrder).toEqual({
      state: 'open',
      members: [{ item: a, state: 'open' }],
    });
    expect((await readOrder({ links, merged: [b.id] })).workOrder).toEqual({
      state: 'done',
      members: [{ item: a, state: 'done' }],
    });
  });

  test("a nested order's unreadable merge and end reach the top order's degraded list", async () => {
    // b is open under a, and a is under the order; a's merge and end rows do not read.
    const lostMerge = { type: 'degraded', reason: 'merge_unreadable', itemId: a.id } as const;
    const lostEnd = { type: 'degraded', reason: 'end_unreadable', endId: 'end-a' } as const;
    const read = await readOrder({
      links: [partOf(a, order), partOf(b, a)],
      store: {
        getItemMerge: async id => (id === a.id ? lostMerge : null),
        getHoldingItemEnd: async id => (id === a.id ? lostEnd : null),
      },
    });
    expect(read.workOrder?.state).toBe('open');
    expect(read.degraded).toEqual([
      { type: 'degraded', reason: 'member_unreadable', member: a, report: lostMerge },
      { type: 'degraded', reason: 'member_unreadable', member: a, report: lostEnd },
    ]);
  });

  test('a part_of cycle reads unknown, whatever order its links were recorded in', async () => {
    // a and b are part of each other and of the order; c, part of b, merged.
    const cycle = [partOf(a, b), partOf(b, a), partOf(c, b)];
    const one = await readOrder({
      links: [partOf(a, order), partOf(b, order), ...cycle],
      merged: [c.id],
    });
    const other = await readOrder({
      links: [partOf(b, order), partOf(a, order), ...cycle],
      merged: [c.id],
    });
    expect(one.workOrder?.state).toBe('unknown');
    expect(other.workOrder?.state).toBe('unknown');
    const states = (read: typeof one) =>
      Object.fromEntries(read.workOrder?.members.map(m => [m.item.key, m.state]) ?? []);
    expect(states(one)).toEqual(states(other));
  });

  test('only an active part_of makes a member', async () => {
    const ended = { ...partOf(a, order), ended: { ...linkAct, by: { declared: 'alice' } } };
    const dependsOn: ItemLink = { ...partOf(c, order), id: 'c-needs-order', kind: 'depends_on' };
    expect(
      (await readOrder({ links: [partOf(b, order), ended, dependsOn], merged: [b.id] })).workOrder
    ).toEqual({ state: 'done', members: [{ item: b, state: 'merged' }] });
  });

  test('an unreadable member end or member link reads unknown, never done', async () => {
    const lostEnd = { type: 'degraded', reason: 'end_unreadable', endId: 'end-a' } as const;
    const endUnread = await readOrder({
      links: [partOf(a, order), partOf(b, order)],
      merged: [b.id],
      store: { getHoldingItemEnd: async id => (id === a.id ? lostEnd : null) },
    });
    expect(endUnread.workOrder?.state).toBe('unknown');
    expect(endUnread.degraded).toEqual([
      { type: 'degraded', reason: 'member_unreadable', member: a, report: lostEnd },
    ]);
    const lostLink = { type: 'degraded', reason: 'link_unreadable', linkId: 'lost' } as const;
    const links = [partOf(a, order)];
    const linkUnread = await readOrder({
      links,
      merged: [a.id],
      store: {
        listItemLinks: async id =>
          id === a.id ? [...links, lostLink] : id === order.id ? links : [],
      },
    });
    expect(linkUnread.workOrder?.state).toBe('unknown');
    expect(linkUnread.degraded).toEqual([
      { type: 'degraded', reason: 'member_unreadable', member: a, report: lostLink },
    ]);
  });

  test('an item nothing is part of is no work order', async () => {
    expect((await readOrder({ links: [partOf(order, a)] })).workOrder).toBeNull();
  });
});
