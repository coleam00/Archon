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

/** An order whose members are `part_of` it. */
const ORDER: RunEndedLinked = { kind: 'part_of', holder: 'to' };
/** A `depends_on` link reads from the waiting item to its dependency. */
export const WAIT: RunEndedLinked = { kind: 'depends_on', holder: 'from' };

type Ended = { runId: string; written: SourceReceiptAcceptance[] };

export interface Reviews {
  /** Start a run of `review` on `item`. */
  start: (item: string) => Promise<string>;
  /**
   * Complete a started run with `outcome`, passing the linked start the engine builds for
   * a binding on `approved`, and only for that outcome.
   */
  finish: (runId: string, item: string, outcome: string, link?: RunEndedLinked) => Promise<Ended>;
  /** Start and complete a run of `review` on `item`. */
  complete: (item: string, outcome: string, link?: RunEndedLinked) => Promise<Ended>;
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
  const finish: Reviews['finish'] = async (runId, item, outcome, link = ORDER) => {
    const written = await store.completeWorkflowRun(runId, { duration_ms: 1 }, undefined, {
      outcome: { kind: 'enum', value: outcome },
      ...(outcome === 'approved'
        ? { linkedStarts: [linkedStart(link, runId, await itemId(store, item), item)] }
        : {}),
    });
    return { runId, written: written.startReceipts };
  };
  return {
    start,
    finish,
    complete: async (item, outcome, link) => finish(await start(item), item, outcome, link),
  };
}

/** Record an active link from `from` to `to`; returns its id. */
export async function link(
  { store }: Harness,
  from: string,
  to: string,
  kind: RunEndedLinked['kind']
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

/** The linked start the engine builds for the end of `runId` on `member`. */
function linkedStart(
  link: RunEndedLinked,
  runId: string,
  itemId: string,
  member: string
): LinkedRunEndedStart {
  return {
    link,
    endedRunId: runId,
    endedItemId: itemId,
    acceptance: {
      receipt: {
        id: crypto.randomUUID(),
        sourceInstanceId: link.kind,
        deliveryId: runId,
        contentDigest: `digest-${member}`,
        receivedAt: new Date().toISOString(),
        occurredAt: null,
        sourceActor: { source: RUN_ENDED_SOURCE_ACTOR, id: runId, display: 'approved' },
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
          eventInputs: { member },
        },
      ],
    },
  };
}

export function describeLinkedStartConformance(makeHarness: () => Promise<Harness>): void {
  test('a linked start writes one start on the holder per end, over active links only', async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      const members = ['m1', 'm2', 'm3'];
      for (const member of [...members, 'gone']) await link(harness, member, 'order', 'part_of');
      // A link ended before its member completes counts for nothing.
      const [gone] = await store.listItemLinks(await itemId(store, 'gone'));
      if (!gone || 'type' in gone) throw new Error('no link for gone');
      await store.endItemLink({ linkId: gone.id, ...byCli });
      const { complete } = reviews(harness);

      expect((await complete('gone', 'approved')).written).toEqual([]);
      const ends = [];
      for (const member of members) ends.push(await complete(member, 'approved'));
      expect(await store.listStartReceipts()).toHaveLength(3);
      for (const [index, end] of ends.entries()) {
        expect(end.written).toHaveLength(1);
        const receipt = await store.getStartReceipt(end.written[0]?.receipt.id ?? '');
        if (!receipt) throw new Error('no receipt');
        expect(receipt).toMatchObject({
          itemKey: 'order',
          bindings: [{ bindingId: 'ship', status: 'pending' }],
        });
        expect(receipt.bindings[0]?.intent?.eventInputs).toEqual({ member: members[index] });
        // What `workflow runs --item order` shows as the cause of the run it starts.
        expect(startCause(receipt)).toEqual({
          kind: 'run_ended',
          runId: end.runId,
          sourceInstanceId: 'part_of',
        });
      }
    } finally {
      await harness.close();
    }
  });

  test('every item that depends on one starts when it ends; an unlinked item starts none', async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      await link(harness, 'waiter-1', 'dependency', 'depends_on');
      await link(harness, 'waiter-2', 'dependency', 'depends_on');
      const { complete } = reviews(harness);
      // The dependency is the one that ends; nothing starts on it.
      expect((await complete('dependency', 'approved', WAIT)).written).toHaveLength(2);
      expect(await startedOn(store)).toEqual(['waiter-1', 'waiter-2']);
      // An item with links of another kind only is no holder.
      expect((await complete('waiter-1', 'approved', ORDER)).written).toEqual([]);
      expect(await store.listStartReceipts()).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  test('a linked start commits with the completion: one that cannot be written fails it', async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      await link(harness, 'waiter', 'dependency', 'depends_on');
      const { start, finish } = reviews(harness);
      const runId = await start('dependency');
      // Take the delivery the waiter's start will use, with other content, so writing that
      // start conflicts. Written after the run's commit, the run would stay completed.
      const taken = linkedStart(WAIT, runId, await itemId(store, 'dependency'), 'x');
      taken.acceptance.receipt.deliveryId = `${runId}:${await itemId(store, 'waiter')}`;
      taken.acceptance.receipt.contentDigest = 'other';
      await store.acceptStartReceipt(taken.acceptance);

      await expect(finish(runId, 'dependency', 'approved', WAIT)).rejects.toThrow(
        'Delivery identity was reused with different verified content'
      );
      expect((await store.getWorkflowRun(runId))?.status).toBe('running');
      expect((await store.listStartReceipts()).map(({ id }) => id)).toEqual([
        taken.acceptance.receipt.id,
      ]);
    } finally {
      await harness.close();
    }
  });
}
