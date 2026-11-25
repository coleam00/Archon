import { describe, expect, test } from 'bun:test';
import { readItem, readItemOfRun, type ItemReadSource } from './item-read';
import { heldRunOf } from './attention-queue';
import type { ResourceStartRequestInspection } from './resource-start-store';
import type { ItemMerge } from './schemas/item-merge';
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
    expect(read?.startLimits).toEqual([standing]);
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
      standing: { runId: null, state: 'done', pack: null },
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
    });
    const held: ItemReadSource = {
      ...source,
      ownerLost: { holders: async () => [second], observe: async () => 'unreachable' },
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
