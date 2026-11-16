/**
 * Linked run-ended starts, on both SQL stores: the completing write finds the items that
 * hold an active link to the ended run's item and writes their starts. Called from each
 * backend's conformance test with its harness factory, after `makeSqlConformanceHarness`
 * has routed the store to that backend's database.
 */
import { expect, test } from 'bun:test';
import { projectKeyForCodebase } from '@archon/paths/archon-paths';
import {
  RUN_ENDED_SOURCE_ACTOR,
  startCause,
  type LinkedRunEndedStart,
  type RunEndedLinked,
  type SourceReceiptAcceptance,
} from '@archon/workflows/schemas/resource-start';
import type { IWorkflowStore } from '@archon/workflows/store';
import { CONFORMANCE_CONVERSATION_ID } from '@archon/workflows/store-conformance';
import type { WorkflowStoreHarness } from '@archon/workflows/store-conformance';
import type { IDatabase } from './adapters/types';

const projectKey = projectKeyForCodebase({ name: 'conformance', default_cwd: '/conformance' }, '');
const byCli = { via: 'cli', by: null, fromRun: null } as const;

type Harness = WorkflowStoreHarness & { db: IDatabase };

/** What a binding follows and the outcome it starts on; an order of members by default. */
interface Binding {
  kind: LinkedRunEndedStart['link']['kind'];
  holder: LinkedRunEndedStart['link']['holder'];
  outcome: string;
}
const ORDER: Binding = { kind: 'part_of', holder: 'to', outcome: 'approved' };

type Ended = { runId: string; written: SourceReceiptAcceptance[] };

export interface Reviews {
  /** Start a run of `review` on `item`. */
  start: (item: string) => Promise<string>;
  /** Complete a started run with `outcome`, as the engine would for `binding`. */
  finish: (
    runId: string,
    item: string,
    outcome: string,
    form: RunEndedLinked['form'],
    binding?: Binding
  ) => Promise<Ended>;
  /** Start and complete a run of `review` on `item`. */
  complete: (
    item: string,
    outcome: string,
    form: RunEndedLinked['form'],
    binding?: Binding
  ) => Promise<Ended>;
}

/** Runs of `review` on items of the conformance project, completed as the engine would. */
export function reviews({ db, store }: Harness): Reviews {
  const start = async (item: string): Promise<string> => {
    const runId = crypto.randomUUID();
    await db.query(
      `INSERT INTO remote_agent_workflow_runs (id, conversation_id, workflow_name, user_message, status, item_id)
       VALUES ($1, $2, 'review', '', 'running', $3)`,
      [runId, CONFORMANCE_CONVERSATION_ID, await itemId(store, item)]
    );
    return runId;
  };
  const finish: Reviews['finish'] = async (runId, item, outcome, form, binding = ORDER) => {
    const written = await store.completeWorkflowRun(runId, { duration_ms: 1 }, undefined, {
      outcome: { kind: 'enum', value: outcome },
      // The engine passes a linked start only for the outcome the binding names.
      ...(outcome === binding.outcome
        ? {
            linkedStarts: [
              linkedStart(form, binding, runId, await itemId(store, item), item, outcome),
            ],
          }
        : {}),
    });
    return { runId, written: written.startReceipts };
  };
  return {
    start,
    finish,
    complete: async (item, outcome, form, binding) =>
      finish(await start(item), item, outcome, form, binding),
  };
}

export interface LinkedOrder {
  order: string;
  members: string[];
  /** Complete a run of `review` on `member` with `outcome`, as the engine would. */
  complete: (member: string, outcome: string, form: RunEndedLinked['form']) => Promise<Ended>;
}

/** An order whose members are `part_of` it, and a way to end a member's review. */
export async function linkedOrder(
  harness: Harness,
  order: string,
  members: string[]
): Promise<LinkedOrder> {
  for (const member of members) await link(harness, member, order, 'part_of');
  const { complete } = reviews(harness);
  return { order, members, complete: (member, outcome, form) => complete(member, outcome, form) };
}

/** Record an active link from `from` to `to`; returns its id. */
export async function link(
  { store }: Harness,
  from: string,
  to: string,
  kind: Binding['kind']
): Promise<string> {
  const recorded = await store.recordItemLink({
    projectKey,
    fromKey: from,
    toKey: to,
    kind,
    ...byCli,
  });
  return recorded.link.id;
}

async function itemId(store: IWorkflowStore, key: string): Promise<string> {
  const found = await store.getItemRuns(projectKey, key);
  if (!found) throw new Error(`no item ${key}`);
  return found.item.id;
}

/** The item keys of every receipt written so far. */
async function startedOn(store: IWorkflowStore): Promise<(string | null | undefined)[]> {
  const keys = [];
  for (const { id } of await store.listStartReceipts())
    keys.push((await store.getStartReceipt(id))?.itemKey);
  return keys.sort();
}

function linkedStart(
  form: RunEndedLinked['form'],
  binding: Binding,
  runId: string,
  itemId: string,
  member: string,
  outcome: string
): LinkedRunEndedStart {
  return {
    form,
    link: { kind: binding.kind, holder: binding.holder },
    workflowName: 'review',
    outcome: binding.outcome,
    endedRunId: runId,
    endedItemId: itemId,
    acceptance: {
      receipt: {
        id: crypto.randomUUID(),
        sourceInstanceId: `${binding.kind}-${form}`,
        deliveryId: runId,
        contentDigest: `digest-${member}`,
        receivedAt: new Date().toISOString(),
        occurredAt: null,
        sourceActor: { source: RUN_ENDED_SOURCE_ACTOR, id: runId, display: outcome },
        itemKey: member,
      },
      outcome: 'matched',
      bindings: [
        {
          bindingId: 'ship',
          bindingRevision: 'r1',
          hostId: 'host',
          runAsUserId: 'operator',
          resource: 'ship',
          overlap: 'queue',
          launch: {
            cwd: '/conformance',
            workflowName: 'ship',
            inputs: {},
            isolation: { kind: 'in-place' },
          },
          ...(form === 'each' ? { eventInputs: { member, verdict: outcome } } : {}),
        },
      ],
    },
  };
}

export function describeLinkedStartConformance(makeHarness: () => Promise<Harness>): void {
  test('an all start writes once, when the last active member ends with the outcome', async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      const order = await linkedOrder(harness, 'order-1', ['m1', 'm2', 'm3', 'gone']);
      // A link ended before any member completes counts for nothing.
      const links = await store.listItemLinks(await itemId(store, 'gone'));
      const gone = links[0];
      if (!gone || 'type' in gone) throw new Error('no link for gone');
      await store.endItemLink({ linkId: gone.id, ...byCli });

      expect((await order.complete('m1', 'approved', 'all')).written).toEqual([]);
      // A member whose latest review declined is not done.
      await order.complete('m2', 'approved', 'all');
      expect((await order.complete('m2', 'declined', 'all')).written).toEqual([]);
      expect((await order.complete('m3', 'approved', 'all')).written).toEqual([]);
      expect(await store.listStartReceipts()).toEqual([]);

      const last = await order.complete('m2', 'approved', 'all');
      expect(last.written).toHaveLength(1);
      const [listed] = await store.listStartReceipts();
      const started = await store.getStartReceipt(listed?.id ?? '');
      expect(started).toMatchObject({
        itemKey: 'order-1',
        sourceActor: { source: RUN_ENDED_SOURCE_ACTOR, id: last.runId },
      });
      if (!started) throw new Error('no receipt');
      // What `workflow runs --item order-1` shows as the cause of the run it starts.
      expect(startCause(started)).toEqual({ kind: 'run_ended', runId: last.runId });
      expect(last.written[0]?.receipt.id).toBe(started.id);

      // A member that reviews again later starts nothing again.
      expect((await order.complete('m1', 'approved', 'all')).written).toEqual([]);
      expect(await store.listStartReceipts()).toHaveLength(1);

      // An item with no link of the kind starts nothing.
      const loose = await linkedOrder(harness, 'unused', []);
      await store.recordItemLink({
        projectKey,
        fromKey: 'loose',
        toKey: 'm1',
        kind: 'depends_on',
        ...byCli,
      });
      expect((await loose.complete('loose', 'approved', 'all')).written).toEqual([]);
      expect(await store.listStartReceipts()).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  test('an each start writes one start on the holder per member end', async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      const order = await linkedOrder(harness, 'order-2', ['m1', 'm2', 'm3']);
      const ends = [];
      for (const member of order.members)
        ends.push(await order.complete(member, 'approved', 'each'));
      expect((await order.complete('m1', 'declined', 'each')).written).toEqual([]);

      const receipts = await store.listStartReceipts();
      expect(receipts).toHaveLength(3);
      for (const [index, end] of ends.entries()) {
        expect(end.written).toHaveLength(1);
        const receipt = await store.getStartReceipt(end.written[0]?.receipt.id ?? '');
        expect(receipt).toMatchObject({
          itemKey: 'order-2',
          sourceActor: { id: end.runId },
          bindings: [{ bindingId: 'ship', status: 'pending' }],
        });
        expect(receipt?.bindings[0]?.intent?.eventInputs).toEqual({
          member: order.members[index],
          verdict: 'approved',
        });
      }
    } finally {
      await harness.close();
    }
  });

  // A depends_on link reads from the waiting item to its dependency, so the waiting item
  // holds it from the 'from' end; no part_of link is involved.
  const WAIT: Binding = { kind: 'depends_on', holder: 'from', outcome: 'approved' };

  test('items that depend on another start when it ends, each of them, in either form', async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      await link(harness, 'waiter-1', 'dependency', 'depends_on');
      await link(harness, 'waiter-2', 'dependency', 'depends_on');
      const { complete } = reviews(harness);
      // The dependency is the one that ends; nothing starts on it.
      expect((await complete('dependency', 'approved', 'each', WAIT)).written).toHaveLength(2);
      expect(await startedOn(store)).toEqual(['waiter-1', 'waiter-2']);
      expect((await complete('dependency', 'approved', 'all', WAIT)).written).toHaveLength(2);
      expect(await startedOn(store)).toEqual(['waiter-1', 'waiter-1', 'waiter-2', 'waiter-2']);
    } finally {
      await harness.close();
    }
  });

  test('a link ended before its dependency ends starts nothing, in either form', async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      const id = await link(harness, 'waiter', 'dependency', 'depends_on');
      await store.endItemLink({ linkId: id, ...byCli });
      const { complete } = reviews(harness);
      expect((await complete('dependency', 'approved', 'each', WAIT)).written).toEqual([]);
      expect((await complete('dependency', 'approved', 'all', WAIT)).written).toEqual([]);
      expect(await store.listStartReceipts()).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  test("a member's latest review is the one that completed last, not the one started last", async () => {
    const harness = await makeHarness();
    try {
      const { start, finish, complete } = reviews(harness);
      await linkedOrder(harness, 'order-3', ['m1', 'm2']);
      const first = await start('m1');
      const second = await start('m1');
      // Completed in the other order, within one second on SQLite.
      await finish(second, 'm1', 'declined', 'all');
      await finish(first, 'm1', 'approved', 'all');
      // completed_at says the other way, so only completion order can say first finished last.
      await harness.db.query(
        "UPDATE remote_agent_workflow_runs SET completed_at = '2000-01-01 00:00:00' WHERE id = $1",
        [first]
      );
      expect((await complete('m2', 'approved', 'all')).written).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  test('a member completed before outcomes were recorded counts by its boolean outcome', async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      await linkedOrder(harness, 'order-4', ['old', 'new']);
      // The shape an older binary wrote: `outcome` set, `completed_outcome` null.
      const old = await reviews(harness).start('old');
      await db.query(
        "UPDATE remote_agent_workflow_runs SET status = 'completed', outcome = 'succeeded', completed_at = started_at WHERE id = $1",
        [old]
      );
      expect((await store.getWorkflowRun(old))?.completed_outcome).toBeNull();
      const binding = { ...ORDER, outcome: 'succeeded' };
      const ended = await reviews(harness).complete('new', 'succeeded', 'all', binding);
      expect(ended.written).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
}
