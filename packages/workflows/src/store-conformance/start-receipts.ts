import {
  workflowNoticeDataSchema,
  WORKFLOW_NOTICE_LIMITS,
  WorkflowNoticeRefusedError,
} from '../workflow-notice';
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
    const { start } = resourceStartFixtures(CONFORMANCE_CODEBASE_ID, CONFORMANCE_CONVERSATION_ID);
    async function skipFire(input: SourceReceiptAcceptance, fireBinding = binding) {
      input.bindings[0] = { ...fireBinding, overlap: 'skip' };
      await store.acceptStartReceipt(input);
      const identity = {
        receiptId: input.receipt.id,
        bindingId: fireBinding.bindingId,
        ownerId: 'owner',
      };
      expect(await store.claimStartBindingPreparation(identity)).toBe(true);
      const prepared = launch();
      const result = await store.completeStartBindingPreparation({ ...identity, launch: prepared });
      if (result?.status !== 'skipped') throw new Error('Expected skipped admission');
      expect(await store.getWorkflowRun(prepared.run.id)).toBeNull();
      return { identity, prepared, result };
    }
    test("a binding start holds its workflow's declared resource, so a direct start waits on it", async () => {
      const input = acceptance();
      await store.acceptStartReceipt(input);
      const identity = { receiptId: input.receipt.id, bindingId: binding.bindingId, ownerId: 'o' };
      expect(await store.claimStartBindingPreparation(identity)).toBe(true);
      const prepared = launch();
      expect(
        await store.completeStartBindingPreparation({
          ...identity,
          launch: prepared,
          resource: 'build',
        })
      ).toMatchObject({ status: 'admitted' });
      expect(await store.getResourceStartRequest(prepared.run.id)).toMatchObject({
        resource: 'build',
      });
      const direct = launch();
      await store.createWorkflowRun(direct.run);
      expect(
        await store.admitPendingRun({ resource: 'build', capacity: 1, launch: direct })
      ).toEqual({
        kind: 'run',
        id: prepared.run.id,
      });
    });
    test('skipped explicit fires notify their source run, including after it ends', async () => {
      const longSuffix = 'x'.repeat(WORKFLOW_NOTICE_LIMITS.labelValueLength);
      const fireBinding = {
        ...binding,
        bindingId: `binding\n${longSuffix}`,
        resource: `resource\u007f${longSuffix}`,
      };
      const holder = { ...start(), resource: fireBinding.resource };
      await store.admitResourceStart(holder);
      for (const [bindingId, expectedBinding] of [
        [
          fireBinding.bindingId,
          `binding\\u000a${'x'.repeat(WORKFLOW_NOTICE_LIMITS.labelValueLength - 14)}…`,
        ],
        [`${'x'.repeat(198)}\n`, `${'x'.repeat(198)}…`],
        [`${'x'.repeat(193)}\nxx`, `${'x'.repeat(193)}\\u000a…`],
        [`${'x'.repeat(194)}\n`, `${'x'.repeat(194)}\\u000a`],
      ]) {
        for (const ended of [false, true]) {
          const source = await store.createWorkflowRun(launch().run);
          await store.claimPendingWorkflowRun(source.id);
          if (ended) await store.completeWorkflowRun(source.id, { duration_ms: 1 });
          const before = await store.getWorkflowRun(source.id);
          const input = acceptance();
          input.receipt.deliveryId = `delivery\t${longSuffix}${crypto.randomUUID()}`;
          input.receipt.sourceActor = { source: 'archon-run', id: source.id };
          const { prepared } = await skipFire(input, { ...fireBinding, bindingId });
          expect(await store.getStartReceipt(input.receipt.id)).toMatchObject({
            deliveryId: input.receipt.deliveryId,
            bindings: [{ bindingId, intent: { resource: fireBinding.resource } }],
          });
          expect(await store.getResourceStartRequest(prepared.run.id)).toMatchObject({
            status: 'skipped',
            resource: fireBinding.resource,
          });
          const events =
            (await store.listEventsForRuns([source.id], ['workflow_notice'])).get(source.id) ?? [];
          expect(events).toHaveLength(1);
          const notice = workflowNoticeDataSchema.parse(events[0]?.data);
          expect(notice).toMatchObject({
            text: 'Trigger fire dropped, not queued (overlap=skip).',
            node: null,
            labels: {
              binding: expectedBinding,
              resource: `resource\\u007f${'x'.repeat(WORKFLOW_NOTICE_LIMITS.labelValueLength - 15)}…`,
              blocker_kind: 'run',
              blocker: holder.launch.run.id,
              delivery: `delivery\\u0009${'x'.repeat(WORKFLOW_NOTICE_LIMITS.labelValueLength - 15)}…`,
              overlap: 'skip',
            },
          });
          expect(await store.getWorkflowRun(source.id)).toEqual(before);
        }
      }
      const queued = { ...start(), resource: fireBinding.resource };
      await store.admitResourceStart(queued);
      await store.claimPendingWorkflowRun(holder.launch.run.id);
      await store.completeWorkflowRun(holder.launch.run.id, { duration_ms: 1 });
      const source = await store.createWorkflowRun(launch().run);
      const input = acceptance();
      input.receipt.deliveryId = crypto.randomUUID();
      input.receipt.sourceActor = { source: 'archon-run', id: source.id };
      await skipFire(input, fireBinding);
      expect(
        (await store.listEventsForRuns([source.id], ['workflow_notice'])).get(source.id)?.[0]?.data
      ).toMatchObject({ labels: { blocker_kind: 'request', blocker: queued.launch.run.id } });
      for (let i = 1; i < WORKFLOW_NOTICE_LIMITS.perRun; i++)
        await store.persistWorkflowEvent({
          workflow_run_id: source.id,
          event_type: 'workflow_notice',
          data: { text: 'Existing notice', node: null, labels: {} },
        });
      const limited = acceptance();
      limited.receipt.deliveryId = crypto.randomUUID();
      limited.receipt.sourceActor = input.receipt.sourceActor;
      limited.bindings[0] = { ...fireBinding, overlap: 'skip' };
      await store.acceptStartReceipt(limited);
      const identity = {
        receiptId: limited.receipt.id,
        bindingId: fireBinding.bindingId,
        ownerId: 'owner',
      };
      await store.claimStartBindingPreparation(identity);
      const prepared = launch();
      await expect(
        store.completeStartBindingPreparation({ ...identity, launch: prepared })
      ).rejects.toBeInstanceOf(WorkflowNoticeRefusedError);
      await expect(
        store.admitResourceStart({
          ...start('skip'),
          resource: fireBinding.resource,
          launch: prepared,
          receipt: identity,
        })
      ).rejects.toBeInstanceOf(WorkflowNoticeRefusedError);
      expect(await store.getResourceStartRequest(prepared.run.id)).toBeNull();
      expect(
        (await store.listWorkflowNoticeRows()).filter(row => row.runId === source.id)
      ).toHaveLength(WORKFLOW_NOTICE_LIMITS.perRun);
      expect((await store.getStartReceipt(limited.receipt.id))?.bindings[0]?.status).toBe(
        'preparing'
      );
    });
    test('scheduled skips and runless explicit fires produce no notice', async () => {
      await store.admitResourceStart(start());
      const source = await store.createWorkflowRun(launch().run);
      for (const scheduled of [true, false]) {
        const input = acceptance();
        input.receipt.deliveryId = scheduled ? null : 'manual';
        input.receipt.sourceActor = scheduled ? { source: 'archon-run', id: source.id } : null;
        await skipFire(input);
      }
      expect(await store.listWorkflowNoticeRows()).toEqual([]);
    });
    test('delivery replay and repeated request admission add no second skipped-fire notice', async () => {
      await store.admitResourceStart(start());
      const source = await store.createWorkflowRun(launch().run);
      const input = acceptance();
      input.receipt.sourceActor = { source: 'archon-run', id: source.id };
      const { identity, prepared, result } = await skipFire(input);
      expect(
        await store.acceptStartReceipt({
          ...input,
          receipt: { ...input.receipt, id: crypto.randomUUID() },
        })
      ).toEqual({ receiptId: input.receipt.id, replay: true });
      expect(
        await store.completeStartBindingPreparation({ ...identity, launch: prepared })
      ).toBeNull();
      expect(
        await store.admitResourceStart({ ...start('skip'), launch: prepared, receipt: identity })
      ).toEqual(result);
      expect(
        (await store.listEventsForRuns([source.id], ['workflow_notice'])).get(source.id)
      ).toHaveLength(1);
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
