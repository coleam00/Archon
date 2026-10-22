import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ZodError } from 'zod';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from './store';
import { receiptFieldsSchema, pathFor } from './admission-documents';
import {
  evaluatedStartBindingStatusSchema,
  sourceReceiptOutcomeSchema,
  startBindingPreparationStatusSchema,
} from '../schemas/resource-start';
import * as commitModule from './commit';

const roots = trackTempRoots();

async function damageReceipt(path: string, damage: string): Promise<void> {
  if (damage === 'unreadable') return;
  if (damage === 'json') return writeFile(path, '{');
  const row = JSON.parse(await readFile(path, 'utf8'));
  switch (damage) {
    case 'matched-empty':
      row.bindings = [];
      break;
    case 'matched-evaluated-only':
      row.bindings[0].intent = null;
      row.bindings[0].hostId = null;
      row.bindings[0].status = 'unmatched';
      break;
    case 'unmatched-intent':
      row.outcome = 'unmatched';
      break;
    case 'unsupported-intent':
      row.outcome = 'unsupported';
      break;
    case 'malformed-intent':
      row.outcome = 'malformed';
      break;
    case 'created-at':
      row.createdAt = 42;
      break;
    case 'schema':
      row.bindings = [{}];
      break;
    case 'outer-id':
      row.id = 'wrong';
      break;
    case 'binding-id':
      row.bindings[0].receiptId = 'wrong';
      break;
    case 'duplicate-binding':
      row.bindings.push({ ...row.bindings[0] });
      break;
    case 'evaluated-collision':
    case 'duplicate-evaluated': {
      const evaluated = {
        ...row.bindings[0],
        bindingId: damage === 'duplicate-evaluated' ? 'evaluated' : row.bindings[0].bindingId,
        hostId: null,
        status: 'unmatched',
        intent: null,
      };
      row.bindings.push(evaluated);
      if (damage === 'duplicate-evaluated') row.bindings.push({ ...evaluated });
      break;
    }
    case 'intent-binding-id':
      row.bindings[0].intent.bindingId = 'wrong';
      break;
    case 'intent-revision':
      row.bindings[0].intent.bindingRevision = 'wrong';
      break;
    case 'host':
      row.bindings[0].hostId = 'host';
      break;
    case 'unmatched-status-intent':
      row.bindings[0].status = 'unmatched';
      break;
    case 'complete-null-intent':
      row.bindings.push({
        ...row.bindings[0],
        bindingId: 'evaluated',
        hostId: null,
        intent: null,
        status: 'complete',
      });
      break;
    case 'null-intent':
      row.bindings[0].intent = null;
      break;
    case 'failed-null-intent':
      row.bindings[0].intent = null;
      row.bindings[0].status = 'failed';
      break;
    case 'preparing-null-intent':
      row.bindings[0].intent = null;
      row.bindings[0].status = 'preparing';
      break;
    default:
      throw new Error('unknown receipt damage');
  }
  await writeFile(path, JSON.stringify(row));
}

test.each([
  'json',
  'matched-empty',
  'matched-evaluated-only',
  'unmatched-intent',
  'unsupported-intent',
  'malformed-intent',
  'schema',
  'created-at',
  'unreadable',
  'outer-id',
  'binding-id',
  'duplicate-binding',
  'evaluated-collision',
  'duplicate-evaluated',
  'intent-binding-id',
  'intent-revision',
  'host',
  'unmatched-status-intent',
  'complete-null-intent',
  'null-intent',
  'failed-null-intent',
  'preparing-null-intent',
] as const)('receipt lists remain strict and preserve %s evidence without writes', async damage => {
  const root = roots(await mkdtemp(join(tmpdir(), 'receipt-read-')));
  const store = await createFileWorkflowStore({ root });
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  for (const [index, id] of ids.entries()) {
    await store.acceptStartReceipt({
      receipt: {
        id,
        sourceInstanceId: 'source',
        deliveryId: null,
        contentDigest: 'digest',
        receivedAt: new Date().toISOString(),
        occurredAt: null,
        sourceActor: null,
      },
      outcome: 'matched',
      bindings: [
        {
          bindingId: 'binding',
          bindingRevision: null,
          hostId: index === 0 ? 'host' : 'other',
          runAsUserId: 'operator',
          resource: 'resource',
          capacity: 1,
          overlap: 'queue',
          launch: {
            cwd: '/test',
            workflowName: 'test',
            inputs: {},
            isolation: { kind: 'in-place' },
          },
        },
      ],
    });
  }
  expect(await store.listPendingStartBindings({ hostId: 'host' })).toMatchObject([
    { receiptId: ids[0] },
  ]);
  expect(await store.listStartReceipts()).toHaveLength(2);
  const relative = pathFor('receipts', ids[1]!);
  const path = join(root, relative);
  const originalReceipt = receiptFieldsSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  await damageReceipt(path, damage);
  const tracked = ['head.json', ...ids.map(id => pathFor('receipts', id))];
  const before = await Promise.all(tracked.map(name => readFile(join(root, name), 'utf8')));
  const failure = Object.assign(new Error('read refused'), { code: 'EACCES' });
  const read = commitModule.readJson;
  let original: unknown;
  const fault = spyOn(commitModule, 'readJson').mockImplementation(async file => {
    try {
      if (damage === 'unreadable' && file === path) throw failure;
      return await read(file);
    } catch (error) {
      original = error;
      throw error;
    }
  });
  try {
    for (const list of [
      () => store.listPendingStartBindings({ hostId: 'host' }),
      () => store.listStartReceipts(),
      () => store.getStartReceipt(ids[1]!),
      () =>
        store.acceptStartReceipt({ receipt: originalReceipt, outcome: 'unmatched', bindings: [] }),
      () =>
        store.admitResourceStart({
          resource: 'independent',
          capacity: 1,
          hostId: 'host',
          overlap: 'queue',
          receipt: { receiptId: ids[1]!, bindingId: 'binding' },
          launch: {
            version: 2,
            run: {
              id: crypto.randomUUID(),
              workflow_name: 'test',
              codebase_id: 'project',
              user_message: '',
              metadata: {},
            },
            execution: { cwd: '/test', conversationId: 'test', isolation: { kind: 'in-place' } },
          },
        }),
      () =>
        store.claimStartBindingPreparation({
          receiptId: ids[1]!,
          bindingId: 'binding',
          ownerId: 'owner',
        }),
      () =>
        store.completeStartBindingPreparation({
          receiptId: ids[1]!,
          bindingId: 'binding',
          ownerId: 'owner',
          launch: {
            version: 2,
            run: {
              id: crypto.randomUUID(),
              workflow_name: 'test',
              codebase_id: 'project',
              user_message: '',
              metadata: {},
            },
            execution: { cwd: '/test', conversationId: 'test', isolation: { kind: 'in-place' } },
          },
        }),
      () =>
        store.failStartBindingPreparation({
          receiptId: ids[1]!,
          bindingId: 'binding',
          ownerId: 'owner',
          retryable: false,
          error: 'test',
        }),
      () =>
        store.resetStartBindingPreparation({
          receiptId: ids[1]!,
          bindingId: 'binding',
          ownerId: 'owner',
        }),
    ]) {
      const error = await list().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error('expected receipt failure');
      expect(error.message).toContain(relative);
      if (!['json', 'unreadable'].includes(damage)) expect(error.cause).toBeInstanceOf(ZodError);
      else {
        expect(error.cause).toBe(original);
        expect(error.cause).toBeInstanceOf(damage === 'json' ? SyntaxError : Error);
      }
    }
  } finally {
    fault.mockRestore();
  }
  expect(await Promise.all(tracked.map(name => readFile(join(root, name), 'utf8')))).toEqual(
    before
  );
});

for (const outcome of sourceReceiptOutcomeSchema.options) {
  test.each([null, ...evaluatedStartBindingStatusSchema.options])(
    `${outcome} receipt preserves evaluated bindings: %s`,
    async evaluatedStatus => {
      const root = roots(await mkdtemp(join(tmpdir(), 'receipt-outcome-')));
      const store = await createFileWorkflowStore({ root });
      const id = crypto.randomUUID();
      const receipt = {
        id,
        sourceInstanceId: 'source',
        deliveryId: null,
        contentDigest: 'digest',
        receivedAt: new Date().toISOString(),
        occurredAt: null,
        sourceActor: null,
      };
      const evaluatedBindings = evaluatedStatus
        ? [
            {
              bindingId: 'evaluated',
              bindingRevision: null,
              status: evaluatedStatus,
              reason: 'no match',
            },
          ]
        : [];
      await store.acceptStartReceipt(
        outcome === 'matched'
          ? {
              receipt,
              outcome,
              evaluatedBindings,
              bindings: [
                {
                  bindingId: 'accepted',
                  bindingRevision: null,
                  hostId: 'host',
                  runAsUserId: 'operator',
                  resource: 'resource',
                  capacity: 1,
                  overlap: 'queue',
                  launch: {
                    cwd: '/test',
                    workflowName: 'test',
                    inputs: {},
                    isolation: { kind: 'in-place' },
                  },
                },
              ],
            }
          : { receipt, outcome, evaluatedBindings, bindings: [] }
      );
      expect(await store.listStartReceipts()).toMatchObject([{ id, outcome }]);
      const pending = await store.listPendingStartBindings({ hostId: 'host' });
      expect(pending.map(binding => binding.bindingId)).toEqual(
        outcome === 'matched' ? ['accepted'] : []
      );
      const stored = await store.getStartReceipt(id);
      expect(stored?.outcome).toBe(outcome);
      expect(stored?.bindings.map(binding => binding.bindingId)).toEqual([
        ...(outcome === 'matched' ? ['accepted'] : []),
        ...(evaluatedStatus ? ['evaluated'] : []),
      ]);
      if (outcome === 'matched') {
        const path = join(root, pathFor('receipts', id));
        const row = JSON.parse(await readFile(path, 'utf8'));
        for (const status of startBindingPreparationStatusSchema.exclude(['unmatched']).options) {
          row.bindings[0].status = status;
          await writeFile(path, JSON.stringify(row));
          const updated = await store.getStartReceipt(id);
          expect(updated?.bindings.find(binding => binding.bindingId === 'accepted')?.status).toBe(
            status
          );
          expect(await store.listStartReceipts()).toHaveLength(1);
          expect(await store.listPendingStartBindings({ hostId: 'host' })).toHaveLength(
            status === 'pending' || status === 'failed' ? 1 : 0
          );
        }
      }
    }
  );
}
