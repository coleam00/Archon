import {
  emitWorkflowNotice,
  listWorkflowNotices,
  countWorkflowNotices,
  workflowNoticeSchema,
  WORKFLOW_NOTICE_LIMITS,
} from '../workflow-notice';
import { admissionNoticeCursor } from '../admission-notice';
import { WorkflowEventCursorError } from '../store';
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
    test('admission notice reads retain skipped delivery facts and page by admission order', async () => {
      const head = await store.getAdmissionNoticeHead();
      const holder = launch();
      await store.admitResourceStart({ ...binding, launch: holder });
      const before = await store.getWorkflowRun(holder.run.id);
      const source = await store.createWorkflowRun(launch().run);
      await store.cancelWorkflowRun(source.id);
      const expected: string[] = [];
      let queuedId = '';
      for (const [index, overlap, deliveryId] of [
        [0, 'skip', 'delivery'],
        [1, 'skip', null],
        [2, 'queue', 'queued-delivery'],
        [3, 'skip', 'another-delivery'],
      ] as const) {
        const input = acceptance();
        input.receipt.deliveryId = deliveryId;
        input.receipt.sourceActor = { source: 'archon-run', id: source.id, display: 'handoff' };
        input.bindings = [{ ...binding, overlap }];
        await store.acceptStartReceipt(input);
        const identity = {
          receiptId: input.receipt.id,
          bindingId: binding.bindingId,
          ownerId: 'owner',
        };
        await store.claimStartBindingPreparation(identity);
        const prepared = launch();
        const result = await store.completeStartBindingPreparation({
          ...identity,
          launch: prepared,
        });
        expect(result?.status).toBe(overlap === 'skip' ? 'skipped' : 'queued');
        if (index === 2) queuedId = prepared.run.id;
        if (index === 0 || index === 3) expected.push(prepared.run.id);
        expect(await store.getWorkflowRun(prepared.run.id)).toBeNull();
        if (deliveryId !== null) {
          expect(
            await store.acceptStartReceipt({
              ...input,
              receipt: { ...input.receipt, id: crypto.randomUUID() },
            })
          ).toEqual({ receiptId: input.receipt.id, replay: true });
        }
      }
      const first = await store.readAdmissionNoticesAfter(head, { limit: 1 });
      expect(first.notices).toHaveLength(1);
      expect(first.caughtUp).toBe(false);
      expect(first.notices[0]?.facts).toMatchObject({
        requestId: expected[0],
        bindingId: binding.bindingId,
        resource: binding.resource,
        overlap: 'skip',
        blocker: { kind: 'run', id: holder.run.id },
        deliveryId: 'delivery',
        sourceActor: { source: 'archon-run', id: source.id, display: 'handoff' },
        codebaseId: CONFORMANCE_CODEBASE_ID,
      });
      const second = await store.readAdmissionNoticesAfter(first.next, { limit: 1 });
      expect(second.notices.map(row => row.facts.requestId)).toEqual([expected[1]]);
      expect(second.caughtUp).toBe(true);
      expect(second.notices[0]?.facts.blocker).toEqual({ kind: 'request', id: queuedId });
      expect((await store.readAdmissionNoticesAfter(second.next, { limit: 1 })).notices).toEqual(
        []
      );
      expect(
        (await store.readAdmissionNoticesAfter(null, { limit: 10 })).notices.map(
          row => row.facts.requestId
        )
      ).toEqual(expected);
      expect(await store.getWorkflowRun(holder.run.id)).toEqual(before);
    });
    test('history selects receipt time while retaining admission order and inclusive boundaries', async () => {
      await store.admitResourceStart({ ...binding, launch: launch() });
      const ids: string[] = [];
      for (const [index, receivedAt] of [
        '2026-01-03T00:00:00.000Z',
        '2025-12-31T23:59:59.999Z',
        '2026-01-02T00:00:00Z',
        '2026-01-02T00:00:00.000123Z',
        '2026-01-02T00:00Z',
      ].entries()) {
        const input = acceptance();
        input.receipt.deliveryId = `delivery-${String(index)}`;
        input.receipt.receivedAt = receivedAt;
        input.bindings = [{ ...binding, overlap: 'skip' }];
        await store.acceptStartReceipt(input);
        const identity = {
          receiptId: input.receipt.id,
          bindingId: binding.bindingId,
          ownerId: 'owner',
        };
        await store.claimStartBindingPreparation(identity);
        const prepared = launch();
        await store.completeStartBindingPreparation({ ...identity, launch: prepared });
        ids.push(prepared.run.id);
      }
      const since = new Date('2026-01-02T00:00:00.000Z');
      const first = await store.readAdmissionNoticesAfter(null, { limit: 1, since });
      expect(first.notices.map(row => row.facts.requestId)).toEqual([ids[0]]);
      expect(first.caughtUp).toBe(false);
      const second = await store.readAdmissionNoticesAfter(first.next, { limit: 10, since });
      expect(second.notices.map(row => row.facts.requestId)).toEqual(ids.slice(2));
      expect(second.caughtUp).toBe(true);
      expect(
        (await store.readAdmissionNoticesAfter(second.next, { limit: 1, since })).notices
      ).toEqual([]);
      const notices = await listWorkflowNotices(
        { store },
        { scope: { kind: 'all' }, labels: {}, since }
      );
      expect(notices.map(notice => notice.labels.request)).toEqual([...ids.slice(2), ids[0]]);
      expect(
        (await store.readAdmissionNoticesAfter(null, { limit: 10 })).notices.map(
          row => row.facts.requestId
        )
      ).toEqual(ids);
    });
    test('admission history preserves every signal without consuming the author notice budget', async () => {
      const holder = launch();
      await store.admitResourceStart({ ...binding, launch: holder });
      const source = await store.createWorkflowRun(launch().run);
      await store.claimPendingWorkflowRun(source.id);
      const receivedAt = new Date(Date.now() - 60_000).toISOString();
      const drops: string[] = [];
      const fire = async (fromRun: boolean) => {
        const input = acceptance();
        input.receipt.deliveryId = crypto.randomUUID();
        input.receipt.receivedAt = receivedAt;
        input.receipt.sourceActor = fromRun
          ? { source: 'archon-run', id: source.id, display: 'handoff' }
          : null;
        input.bindings = [{ ...binding, overlap: 'skip' }];
        await store.acceptStartReceipt(input);
        const identity = {
          receiptId: input.receipt.id,
          bindingId: binding.bindingId,
          ownerId: 'owner',
        };
        await store.claimStartBindingPreparation(identity);
        const prepared = launch();
        expect(
          await store.completeStartBindingPreparation({ ...identity, launch: prepared })
        ).toMatchObject({ status: 'skipped' });
        drops.push(prepared.run.id);
      };
      for (let index = 0; index < 51; index++) await fire(true);
      for (let index = 0; index < WORKFLOW_NOTICE_LIMITS.perRun; index++)
        await emitWorkflowNotice(store, {
          runId: source.id,
          node: 'work',
          text: `Authored ${String(index)}`,
          labels: { kind: 'authored' },
        });
      expect(
        await rejection(
          emitWorkflowNotice(store, { runId: source.id, node: null, text: 'Too many', labels: {} })
        )
      ).toMatchObject({ reason: 'run_limit' });
      await store.completeWorkflowRun(source.id, { duration_ms: 1 });
      await fire(true);
      await fire(false);
      const query = { scope: { kind: 'all' as const }, labels: {} };
      const notices = await listWorkflowNotices({ store }, query);
      expect(notices).toHaveLength(103);
      for (const notice of notices)
        expect(workflowNoticeSchema.safeParse(notice).success).toBe(true);
      const admission = notices.filter(notice => notice.labels.kind === 'admission-skipped');
      expect(admission.map(notice => notice.labels.request)).toEqual(drops);
      expect(admission[0]).toMatchObject({
        runId: source.id,
        workflow: source.workflow_name,
        node: 'handoff',
        at: receivedAt,
        labels: {
          binding: binding.bindingId,
          resource: binding.resource,
          blocker: holder.run.id,
          blocker_kind: 'run',
          overlap: 'skip',
        },
      });
      expect(admission[0]?.text).toContain('Dropped start');
      expect(admission[0]?.text).toContain(holder.run.id);
      expect(admission[0]?.text).toContain('Not queued');
      expect(admission[51]?.runId).toBe(source.id);
      expect(admission[52]).toMatchObject({
        runId: null,
        workflow: null,
        parentRunId: null,
        node: null,
        project: { codebaseId: CONFORMANCE_CODEBASE_ID },
      });
      const project = admission[52]?.project;
      if (project === null || project === undefined) throw new Error('Missing binding project');
      expect(
        await listWorkflowNotices(
          { store },
          { ...query, scope: { kind: 'project', project }, labels: { request: drops[52] } }
        )
      ).toHaveLength(1);
      expect(
        await listWorkflowNotices(
          { store },
          {
            ...query,
            labels: { kind: 'admission-skipped' },
            since: new Date(Date.parse(receivedAt) + 1),
          }
        )
      ).toEqual([]);
      expect(
        await countWorkflowNotices({ store }, { ...query, countBy: { by: 'label', key: 'kind' } })
      ).toEqual({
        by: 'label',
        key: 'kind',
        counts: [
          { value: 'admission-skipped', count: 53 },
          { value: 'authored', count: 50 },
        ],
      });
      expect(await store.listWorkflowNoticeRows()).toHaveLength(50);
      expect((await store.getWorkflowRun(source.id))?.status).toBe('completed');
      expect((await store.getResourceStartRequest(holder.run.id))?.status).toBe('admitted');
    });
    test('admission reader rejects foreign cursors and invalid page sizes', async () => {
      await expect(
        store.readAdmissionNoticesAfter(admissionNoticeCursor('other-store:1'), { limit: 1 })
      ).rejects.toBeInstanceOf(WorkflowEventCursorError);
      for (const limit of [0, -1, 1.5])
        await expect(store.readAdmissionNoticesAfter(null, { limit })).rejects.toBeInstanceOf(
          RangeError
        );
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
