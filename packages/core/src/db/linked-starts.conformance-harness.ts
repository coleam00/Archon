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

export interface LinkedOrder {
  order: string;
  members: string[];
  /** Complete a run of `review` on `member` with `outcome`, as the engine would. */
  complete: (
    member: string,
    outcome: string,
    form: RunEndedLinked['form']
  ) => Promise<{ runId: string; written: SourceReceiptAcceptance[] }>;
}

/** An order whose members are `part_of` it, and a way to end a member's review. */
export async function linkedOrder(
  { db, store }: Harness,
  order: string,
  members: string[]
): Promise<LinkedOrder> {
  for (const member of members)
    await store.recordItemLink({
      projectKey,
      fromKey: member,
      toKey: order,
      kind: 'part_of',
      ...byCli,
    });
  return {
    order,
    members,
    complete: async (member, outcome, form) => {
      const runId = crypto.randomUUID();
      const item = await itemId(store, member);
      await db.query(
        `INSERT INTO remote_agent_workflow_runs (id, conversation_id, workflow_name, user_message, status, item_id)
         VALUES ($1, $2, 'review', '', 'running', $3)`,
        [runId, CONFORMANCE_CONVERSATION_ID, item]
      );
      const written = await store.completeWorkflowRun(runId, { duration_ms: 1 }, undefined, {
        outcome: { kind: 'enum', value: outcome },
        // The engine passes a linked start only for the outcome the binding names.
        ...(outcome === 'approved'
          ? { linkedStarts: [linkedStart(form, runId, item, member, outcome)] }
          : {}),
      });
      return { runId, written: written.startReceipts };
    },
  };
}

async function itemId(store: IWorkflowStore, key: string): Promise<string> {
  const found = await store.getItemRuns(projectKey, key);
  if (!found) throw new Error(`no item ${key}`);
  return found.item.id;
}

function linkedStart(
  form: RunEndedLinked['form'],
  runId: string,
  itemId: string,
  member: string,
  outcome: string
): LinkedRunEndedStart {
  return {
    form,
    link: { kind: 'part_of', holder: 'to' },
    workflowName: 'review',
    outcome: 'approved',
    endedRunId: runId,
    endedItemId: itemId,
    acceptance: {
      receipt: {
        id: crypto.randomUUID(),
        sourceInstanceId: `order-${form}`,
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
}
