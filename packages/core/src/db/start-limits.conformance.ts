/**
 * Conformance for a binding's start limit on the SQL stores, run by the SQLite and
 * PostgreSQL integration tests: admission counts a limited binding's starts per item,
 * refuses the one past the limit with a reason, lets a grant allow one more, and starts the
 * count again when the limit's reset workflow completes on the item.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { ResourceStartBindingIntent } from '@archon/workflows/schemas/resource-start';
import {
  CONFORMANCE_CODEBASE_ID,
  CONFORMANCE_CONVERSATION_ID,
  resourceStartFixtures,
  type WorkflowStoreHarness,
} from '@archon/workflows/store-conformance';

const LIMIT = { name: 'check', starts: 3, resetOn: 'plan' };

export function describeSqlStartLimitConformance(
  makeHarness: () => Promise<WorkflowStoreHarness>
): void {
  test('a limited binding starts its stage three times on an item, then only after a grant or a reset', async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      const { launch } = resourceStartFixtures(
        CONFORMANCE_CODEBASE_ID,
        CONFORMANCE_CONVERSATION_ID
      );
      const start = async (
        itemKey: string | undefined,
        fields: Pick<ResourceStartBindingIntent, 'limit' | 'grants'>
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
            sourceActor: null,
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
        const result = await store.completeStartBindingPreparation({
          ...identity,
          launch: launch(),
        });
        return { result, receiptId: identity.receiptId };
      };
      // Each started run ends before the next start, so none waits behind it.
      const finish = async (runId: string) => {
        await store.claimPendingWorkflowRun(runId);
        await store.completeWorkflowRun(runId, { duration_ms: 1 });
      };
      const admitted = async (
        itemKey: string,
        fields: Pick<ResourceStartBindingIntent, 'limit' | 'grants'> = { limit: LIMIT }
      ) => {
        const { result } = await start(itemKey, fields);
        if (result?.status !== 'admitted')
          throw new Error(`Expected admitted, got ${result?.status}`);
        await finish(result.runId);
        return result.runId;
      };
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
      const standing = await store.readItemStartLimits(a);
      expect(standing.limits).toEqual([
        { name: 'check', starts: 3, resetOn: 'plan', since: null, granted: 0, used: 3, left: 0 },
      ]);
      expect(Object.keys(standing.countedUnder).sort()).toEqual([...rounds].sort());

      // An operator's answer starts a granting binding: one more start, then the limit again.
      await admitted('a', { grants: 'check' });
      await admitted('a');
      expect((await start('a', { limit: LIMIT })).result?.status).toBe('refused');
      expect((await store.readItemStartLimits(a)).limits[0]).toMatchObject({
        granted: 1,
        used: 4,
        left: 0,
      });
      expect((await store.readItemStartLimits(await itemId('b'))).limits[0]).toMatchObject({
        granted: 0,
        used: 1,
        left: 2,
      });

      // The reset workflow completing on the item starts the count again, grants included.
      const plan = await store.createWorkflowRun({
        workflow_name: 'plan',
        user_message: '',
        codebase_id: CONFORMANCE_CODEBASE_ID,
        item_key: 'a',
      });
      await finish(plan.id);
      await admitted('a');
      const reset = (await store.readItemStartLimits(a)).limits[0];
      expect(reset).toMatchObject({ granted: 0, used: 1, left: 2 });
      expect(reset?.since).not.toBeNull();
      // Cleaning up the reset run does not bring the earlier rounds back.
      const { deleteWorkflowRun } = await import('./workflow-run-writes');
      await deleteWorkflowRun(plan.id);
      expect((await store.readItemStartLimits(a)).limits[0]).toMatchObject({
        since: reset?.since,
        used: 1,
      });

      // The count is per item, so a limited start on no item is refused, not let through.
      expect((await start(undefined, { limit: LIMIT })).result).toEqual({
        status: 'refused',
        reason: expect.stringContaining('names no item'),
      });
    } finally {
      await harness.close();
    }
  });

  test('a queued start holds its place in the count until it is withdrawn', async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      const { launch } = resourceStartFixtures(
        CONFORMANCE_CODEBASE_ID,
        CONFORMANCE_CONVERSATION_ID
      );
      const limit = { name: 'check', starts: 2 };
      const start = async () => {
        const identity = { receiptId: randomUUID(), bindingId: 'binding', ownerId: 'owner' };
        await store.acceptStartReceipt({
          receipt: {
            id: identity.receiptId,
            sourceInstanceId: 'source',
            deliveryId: null,
            contentDigest: identity.receiptId,
            receivedAt: new Date().toISOString(),
            occurredAt: null,
            sourceActor: null,
            itemKey: 'q',
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
              limit,
            },
          ],
        });
        await store.claimStartBindingPreparation(identity);
        return store.completeStartBindingPreparation({ ...identity, launch: launch() });
      };
      expect((await start())?.status).toBe('admitted');
      const waiting = await start();
      if (waiting?.status !== 'queued') throw new Error('Expected the second start to queue');
      expect((await start())?.status).toBe('refused');
      await store.withdrawQueuedResourceStart(waiting.requestId);
      expect((await start())?.status).toBe('queued');
    } finally {
      await harness.close();
    }
  });
}
