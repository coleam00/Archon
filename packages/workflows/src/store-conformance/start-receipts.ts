import { resourceStartFixtures } from '../resource-start-conformance';
import { SourceReceiptDigestConflictError } from '../resource-start-store';
import type {
  ResourceStartBindingIntent,
  SourceReceiptAcceptance,
} from '../schemas/resource-start';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { IWorkflowStore } from '../store';
import type { WorkflowStoreHarness } from '../store-conformance';
import { CONFORMANCE_CODEBASE_ID, CONFORMANCE_CONVERSATION_ID, eight, rejection } from './fixtures';

export function describeStartReceiptConformance(getHarness: () => WorkflowStoreHarness): void {
  describe('start receipts', () => {
    let harness: WorkflowStoreHarness;
    let store: IWorkflowStore;
    beforeEach(() => {
      harness = getHarness();
      store = harness.store;
    });

    const { launch } = resourceStartFixtures(CONFORMANCE_CODEBASE_ID, CONFORMANCE_CONVERSATION_ID);
    const binding: ResourceStartBindingIntent = {
      bindingId: 'binding',
      bindingRevision: 'v1',
      hostId: 'host',
      runAsUserId: 'operator',
      resource: 'resource',
      capacity: 1,
      overlap: 'queue',
      launch: {
        cwd: '/conformance',
        workflowName: 'conformance',
        inputs: {},
        isolation: { kind: 'in-place' },
      },
    };
    const acceptance = (): SourceReceiptAcceptance => ({
      receipt: {
        id: crypto.randomUUID(),
        sourceInstanceId: 'source',
        deliveryId: 'delivery',
        contentDigest: 'digest',
        receivedAt: new Date().toISOString(),
        occurredAt: null,
        sourceActor: null,
      },
      outcome: 'matched' as const,
      bindings: [binding] as [ResourceStartBindingIntent],
    });
    test('receipt deduplication compares verified content and preparation has one owner', async () => {
      const store = harness.store,
        input = acceptance();
      expect(await store.acceptStartReceipt(input)).toEqual({
        receiptId: input.receipt.id,
        replay: false,
      });
      expect(
        await store.acceptStartReceipt({
          ...input,
          receipt: { ...input.receipt, id: crypto.randomUUID() },
        })
      ).toEqual({ receiptId: input.receipt.id, replay: true });
      expect(
        await rejection(
          store.acceptStartReceipt({
            ...input,
            receipt: { ...input.receipt, id: crypto.randomUUID(), contentDigest: 'different' },
          })
        )
      ).toBeInstanceOf(SourceReceiptDigestConflictError);
      const owners = await eight(index =>
        store.claimStartBindingPreparation({
          receiptId: input.receipt.id,
          bindingId: binding.bindingId,
          ownerId: String(index),
        })
      );
      expect(owners.filter(Boolean)).toHaveLength(1);
      const ownerId = String(owners.indexOf(true));
      const identity = { receiptId: input.receipt.id, bindingId: binding.bindingId, ownerId };
      const prepared = launch();
      expect(
        await store.completeStartBindingPreparation({
          ...identity,
          ownerId: 'stale',
          launch: prepared,
        })
      ).toBeNull();
      prepared.run.metadata.admission_checkout_guard = 'false';
      await expect(
        store.completeStartBindingPreparation({ ...identity, launch: prepared })
      ).rejects.toThrow('expected a boolean');
      expect(await store.getResourceStartRequest(prepared.run.id)).toBeNull();
      expect(await store.getStartReceipt(input.receipt.id)).toMatchObject({
        bindings: [{ status: 'preparing' }],
      });
      prepared.run.metadata.admission_checkout_guard = true;
      const result = await store.completeStartBindingPreparation({ ...identity, launch: prepared });
      expect(result).toEqual({
        status: 'admitted',
        requestId: prepared.run.id,
        runId: prepared.run.id,
      });
      expect(
        await store.completeStartBindingPreparation({ ...identity, launch: launch() })
      ).toBeNull();
      expect(await store.getStartReceipt(input.receipt.id)).toMatchObject({
        bindings: [{ status: 'complete', requestStatus: 'admitted', disposition: result }],
      });
      expect(await store.listPendingStartBindings({ hostId: 'host' })).toEqual([]);
    });
    test('delivery lookup answers only for the recorded source and delivery', async () => {
      const input = acceptance();
      expect(await store.hasStartReceiptForDelivery('source', 'delivery')).toBe(false);
      await store.acceptStartReceipt(input);
      await store.acceptStartReceipt({
        ...input,
        receipt: { ...input.receipt, id: crypto.randomUUID(), deliveryId: null },
      });
      expect(await store.hasStartReceiptForDelivery('source', 'delivery')).toBe(true);
      expect(await store.hasStartReceiptForDelivery('source', 'other-delivery')).toBe(false);
      expect(await store.hasStartReceiptForDelivery('other-source', 'delivery')).toBe(false);
    });
    test('preparation failure and reset require the exact current owner', async () => {
      const store = harness.store,
        input = acceptance();
      await store.acceptStartReceipt(input);
      const identity = {
        receiptId: input.receipt.id,
        bindingId: binding.bindingId,
        ownerId: 'owner',
      };
      expect(await store.claimStartBindingPreparation(identity)).toBe(true);
      expect(await store.resetStartBindingPreparation({ ...identity, ownerId: 'stale' })).toBe(
        false
      );
      expect(
        await store.failStartBindingPreparation({ ...identity, retryable: true, error: 'retry' })
      ).toBe(true);
      expect(await store.listPendingStartBindings({ hostId: 'host' })).toMatchObject([
        { status: 'failed', error: 'retry' },
      ]);
      expect(await store.claimStartBindingPreparation({ ...identity, ownerId: 'next' })).toBe(true);
      expect(await store.resetStartBindingPreparation(identity)).toBe(false);
      expect(await store.resetStartBindingPreparation({ ...identity, ownerId: 'next' })).toBe(true);
      expect(await store.claimStartBindingPreparation(identity)).toBe(true);
      expect(
        await store.failStartBindingPreparation({
          ...identity,
          retryable: false,
          error: 'rejected',
        })
      ).toBe(true);
      expect(await store.listPendingStartBindings({ hostId: 'host' })).toEqual([]);
    });
    for (const { name, timestamps } of [
      {
        name: 'mixed fractional precision',
        timestamps: ['2026-01-02T00:00:00.500Z', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00.5Z'],
      },
      {
        name: 'submillisecond precision',
        timestamps: [
          '2026-01-02T00:00:00.0002Z',
          '2026-01-02T00:00:00.0001Z',
          '2026-01-02T00:00:00.000200Z',
        ],
      },
      {
        name: 'optional seconds',
        timestamps: [
          '2026-01-02T00:00:00.001Z',
          '2026-01-02T00:00Z',
          '2026-01-02T00:00:00.001000Z',
        ],
      },
      {
        name: 'equal zero fractions',
        timestamps: ['2026-01-02T00:00Z', '2026-01-01T23:59:59.9999Z', '2026-01-02T00:00:00.0000Z'],
      },
    ]) {
      test(`receipt listing orders ${name} by newest instant then ID before limiting`, async () => {
        const receipts = timestamps.map((receivedAt, index) => ({
          id: `00000000-0000-4000-8000-00000000000${String([2, 3, 1][index])}`,
          receivedAt,
        }));
        for (const receipt of receipts) {
          const input = acceptance();
          await store.acceptStartReceipt({
            ...input,
            receipt: { ...input.receipt, ...receipt, deliveryId: receipt.id },
          });
        }
        expect((await store.listStartReceipts()).map(row => row.id)).toEqual([
          receipts[0].id,
          receipts[2].id,
          receipts[1].id,
        ]);
        expect((await store.listStartReceipts(2)).map(row => row.id)).toEqual([
          receipts[0].id,
          receipts[2].id,
        ]);
      });
    }
  });
}
