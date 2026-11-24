/**
 * Conformance for a binding's start limit on the SQL stores, run by the SQLite and
 * PostgreSQL integration tests: admission counts a limited binding's starts per item,
 * refuses the one past the limit with a reason, lets a grant allow one more, and starts the
 * count again when the limit's reset workflow completes on the item.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  RUN_ENDED_SOURCE_ACTOR,
  type ResourceStartBindingIntent,
  type SourceReceiptInput,
} from '@archon/workflows/schemas/resource-start';
import { readItemStopped } from '@archon/workflows/schemas/run-metadata';
import {
  CONFORMANCE_CODEBASE_ID,
  CONFORMANCE_CONVERSATION_ID,
  resourceStartFixtures,
  type WorkflowStoreHarness,
} from '@archon/workflows/store-conformance';

const LIMIT = { name: 'check', starts: 3, resetOn: 'plan' };

type Harness = WorkflowStoreHarness;
type LimitFields = Pick<ResourceStartBindingIntent, 'limit' | 'grants'>;

/**
 * Starts on items through the real receipt, preparation and admission path. Nothing here
 * edits a timestamp: these run within one second, so on SQLite a start and the reset after
 * it share a timestamp, and the count must still order them.
 */
function starts(harness: Harness) {
  const { store } = harness;
  const { launch } = resourceStartFixtures(CONFORMANCE_CODEBASE_ID, CONFORMANCE_CONVERSATION_ID);
  const start = async (
    itemKey: string | undefined,
    fields: LimitFields,
    sourceActor: SourceReceiptInput['sourceActor'] = null
  ) => {
    const identity = { receiptId: randomUUID(), bindingId: 'binding', ownerId: 'owner' };
    await store.acceptStartReceipt({
      receipt: {
        id: identity.receiptId,
        sourceInstanceId: 'source',
        deliveryId: null,
        contentDigest: identity.receiptId,
        receivedAt: new Date().toISOString(),
        occurredAt: null,
        sourceActor,
        ...(itemKey === undefined ? {} : { itemKey }),
      },
      outcome: 'matched',
      bindings: [
        {
          bindingId: identity.bindingId,
          bindingRevision: null,
          hostId: 'host',
          runAsUserId: 'operator',
          resource: 'resource',
          overlap: 'queue',
          launch: { cwd: '/c', workflowName: 'w', inputs: {}, isolation: { kind: 'in-place' } },
          ...fields,
        },
      ],
    });
    await store.claimStartBindingPreparation(identity);
    const result = await store.completeStartBindingPreparation({ ...identity, launch: launch() });
    return { result, receiptId: identity.receiptId };
  };
  const finish = async (runId: string) => {
    await store.claimPendingWorkflowRun(runId);
    await store.completeWorkflowRun(runId, { duration_ms: 1 });
  };
  // Each started run ends before the next start, so none waits behind it.
  const admitted = async (itemKey: string, fields: LimitFields = { limit: LIMIT }) => {
    const { result } = await start(itemKey, fields);
    if (result?.status !== 'admitted') throw new Error(`Expected admitted, got ${result?.status}`);
    await finish(result.runId);
    return result.runId;
  };
  /** A run of `plan` completed on the item: the reset `LIMIT` names. */
  const plan = async (itemKey: string) => {
    const run = await store.createWorkflowRun({
      workflow_name: 'plan',
      user_message: '',
      codebase_id: CONFORMANCE_CODEBASE_ID,
      item_key: itemKey,
    });
    await finish(run.id);
    return { runId: run.id, itemId: run.item_id ?? '' };
  };
  const standing = async (itemId: string) => (await store.readItemStartLimits(itemId)).limits[0];
  return { start, finish, admitted, plan, standing };
}

export function describeSqlStartLimitConformance(makeHarness: () => Promise<Harness>): void {
  test('a limited binding starts its stage three times on an item, then only after a grant or a reset', async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      const { start, admitted, plan, standing } = starts(harness);
      const itemId = async (key: string) =>
        (
          await store.createWorkflowRun({
            workflow_name: 'other',
            user_message: '',
            codebase_id: CONFORMANCE_CODEBASE_ID,
            item_key: key,
          })
        ).item_id ?? '';

      const rounds = [await admitted('a'), await admitted('a'), await admitted('a')];
      const fourth = await start('a', { limit: LIMIT });
      expect(fourth.result).toEqual({
        status: 'refused',
        reason: expect.stringContaining(
          "Start limit 'check' reached on item 'a': 3 of 3 starts used"
        ),
      });
      const refused = (await store.getStartReceipt(fourth.receiptId))?.bindings[0];
      expect(refused).toMatchObject({ status: 'rejected', requestStatus: null });
      expect(refused?.error).toContain('grants');
      expect(refused?.intent?.limit).toEqual(LIMIT);

      // The count is per item: another item starts.
      await admitted('b');

      const a = await itemId('a');
      const read = await store.readItemStartLimits(a);
      expect(read.limits).toEqual([
        { name: 'check', starts: 3, resetOn: 'plan', since: null, granted: 0, used: 3, left: 0 },
      ]);
      expect(Object.keys(read.countedUnder).sort()).toEqual([...rounds].sort());

      // An operator's answer starts a granting binding: one more start, then the limit again.
      await admitted('a', { grants: 'check' });
      await admitted('a');
      expect((await start('a', { limit: LIMIT })).result?.status).toBe('refused');
      expect(await standing(a)).toMatchObject({ granted: 1, used: 4, left: 0 });
      expect(await standing(await itemId('b'))).toMatchObject({ granted: 0, used: 1, left: 2 });

      // The reset workflow completing on the item starts the count again, grants included,
      // and cleaning that run up before any later start does not bring the rounds back.
      const reset = await plan('a');
      const since = (await standing(a))?.since;
      expect(since).not.toBeNull();
      const { deleteWorkflowRun } = await import('./workflow-run-writes');
      await deleteWorkflowRun(reset.runId);
      expect(await standing(a)).toMatchObject({ since, granted: 0, used: 0, left: 3 });
      await admitted('a');
      expect(await standing(a)).toMatchObject({ used: 1, left: 2 });

      // The count is per item, so a limited start on no item is refused, not let through.
      expect((await start(undefined, { limit: LIMIT })).result).toEqual({
        status: 'refused',
        reason: expect.stringContaining('names no item'),
      });
    } finally {
      await harness.close();
    }
  });

  test('a start refused at its limit records the stop on the run whose end caused it', async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      const { start, admitted } = starts(harness);
      const limit = { name: 'check', starts: 1 };
      const ended = await admitted('s', { limit });
      const refused = await start('s', { limit }, { source: RUN_ENDED_SOURCE_ACTOR, id: ended });
      expect(refused.result?.status).toBe('refused');
      const run = await store.getWorkflowRun(ended);
      expect(readItemStopped(run?.metadata ?? {})).toEqual({
        summary: null,
        limit: { ...limit, granted: 0, used: 1, bindingId: 'binding', workflow: 'w' },
      });
    } finally {
      await harness.close();
    }
  });

  test('a start that waited in the queue across a reset counts in the new count', async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      const { start, finish, admitted, plan, standing } = starts(harness);
      // The first start holds the resource, so the second waits behind it.
      const first = (await start('r', { limit: LIMIT })).result;
      const waiting = (await start('r', { limit: LIMIT })).result;
      if (first?.status !== 'admitted' || waiting?.status !== 'queued')
        throw new Error('Expected one admitted start and one queued');
      const { itemId } = await plan('r');
      // Only the waiting start is in the new count: it is promised, and it runs after the reset.
      expect(await standing(itemId)).toMatchObject({ used: 1, left: 2 });
      await finish(first.runId);
      const drained = await store.drainResourceStarts({ resource: 'resource', hostId: 'host' });
      expect(drained).toEqual([expect.objectContaining({ status: 'admitted' })]);
      expect(await standing(itemId)).toMatchObject({ used: 1, left: 2 });
      await finish(waiting.requestId);
      await admitted('r');
      await admitted('r');
      expect((await start('r', { limit: LIMIT })).result?.status).toBe('refused');
    } finally {
      await harness.close();
    }
  });

  test('a reset right after a start leaves the full allowance, and a grant before it is spent', async () => {
    const harness = await makeHarness();
    try {
      const { start, admitted, plan, standing } = starts(harness);
      // A start, then a grant, then the reset, with no time passing between them.
      await admitted('s');
      await admitted('s', { grants: 'check' });
      const { itemId } = await plan('s');
      expect(await standing(itemId)).toMatchObject({ granted: 0, used: 0, left: 3 });
      await admitted('s');
      await admitted('s');
      await admitted('s');
      expect((await start('s', { limit: LIMIT })).result?.status).toBe('refused');
    } finally {
      await harness.close();
    }
  });

  test("a grant made before the limited binding's first start on the item counts", async () => {
    const harness = await makeHarness();
    try {
      const { admitted, plan, standing } = starts(harness);
      const { itemId } = await plan('g');
      await admitted('g', { grants: 'check' });
      await admitted('g');
      expect(await standing(itemId)).toMatchObject({ granted: 1, used: 1, left: 3 });
    } finally {
      await harness.close();
    }
  });

  test('a queued start holds its place in the count until it is withdrawn', async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      const { start } = starts(harness);
      const limit = { name: 'check', starts: 2 };
      expect((await start('q', { limit })).result?.status).toBe('admitted');
      const waiting = (await start('q', { limit })).result;
      if (waiting?.status !== 'queued') throw new Error('Expected the second start to queue');
      expect((await start('q', { limit })).result?.status).toBe('refused');
      await store.withdrawQueuedResourceStart(waiting.requestId);
      expect((await start('q', { limit })).result?.status).toBe('queued');
    } finally {
      await harness.close();
    }
  });
}
