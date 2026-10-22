import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as fileStore from '@archon/workflows/file-store';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { PreparedWorkflowLaunch } from '@archon/workflows/schemas/resource-start';
import { createFileWorkflowHost } from './file-host';
import { drainResourceStartHost, ResourceStartDrainError } from './resource-start-host';

const roots = trackTempRoots();

async function fixture(receiptHost: string) {
  const root = roots(await fs.mkdtemp(join(tmpdir(), 'receipt-drain-')));
  const host = await createFileWorkflowHost(root);
  const store = host.deps.store;
  const launch = (resource: string): PreparedWorkflowLaunch => ({
    version: 2,
    run: {
      id: crypto.randomUUID(),
      workflow_name: 'test',
      codebase_id: 'project',
      user_message: '',
      metadata: {},
    },
    execution: {
      cwd: join(root, resource),
      conversationId: 'test',
      isolation: { kind: 'in-place' },
    },
  });
  const accept = async (hostId: string, resource: string) => {
    const receiptId = crypto.randomUUID();
    await store.acceptStartReceipt({
      receipt: {
        id: receiptId,
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
          hostId,
          runAsUserId: 'operator',
          resource,
          capacity: 1,
          overlap: 'queue',
          launch: {
            cwd: join(root, resource),
            workflowName: 'test',
            inputs: {},
            isolation: { kind: 'in-place' },
          },
        },
      ],
    });
    return receiptId;
  };
  const holder = launch('healthy');
  await store.admitResourceStart({
    resource: 'healthy',
    capacity: 1,
    hostId: 'host',
    overlap: 'queue',
    launch: holder,
  });
  const healthy = launch('healthy');
  const preparedId = await accept('host', 'healthy');
  const owner = { receiptId: preparedId, bindingId: 'binding', ownerId: 'owner' };
  expect(await store.claimStartBindingPreparation(owner)).toBe(true);
  expect(await store.completeStartBindingPreparation({ ...owner, launch: healthy })).toMatchObject({
    status: 'queued',
  });
  const foreignHolder = launch('foreign');
  await store.admitResourceStart({
    resource: 'foreign',
    capacity: 1,
    hostId: 'other',
    overlap: 'queue',
    launch: foreignHolder,
  });
  const foreign = launch('foreign');
  expect(
    await store.admitResourceStart({
      resource: 'foreign',
      capacity: 1,
      hostId: 'other',
      overlap: 'queue',
      launch: foreign,
    })
  ).toMatchObject({ status: 'queued' });
  await store.cancelWorkflowRun(holder.run.id);
  await store.cancelWorkflowRun(foreignHolder.run.id);
  const receiptId = await accept(receiptHost, 'damaged');
  const path = join(
    root,
    'resource/receipts',
    `${createHash('sha256').update(receiptId).digest('hex')}.json`
  );
  const sentinel = join(root, 'sentinel.json');
  await fs.writeFile(sentinel, 'operator evidence');
  return { host, store, healthy, foreign, receiptId, path, sentinel, accept };
}

for (const receiptHost of ['host', 'other']) {
  test.each(['json', 'schema', 'unreadable'] as const)(
    `receipt %s failure from ${receiptHost} preserves independent queued progress`,
    async damage => {
      const context = await fixture(receiptHost);
      const deferredId = await context.accept('host', 'deferred');
      const { host, store, path, receiptId, healthy, foreign, sentinel } = context;
      if (damage === 'json') await fs.writeFile(path, '{');
      if (damage === 'schema') {
        const row = JSON.parse(await fs.readFile(path, 'utf8'));
        row.bindings = [{}];
        await fs.writeFile(path, JSON.stringify(row));
      }
      const bytes = await fs.readFile(path, 'utf8');
      const ioError = Object.assign(new Error('receipt read refused'), { code: 'EACCES' });
      const read = fileStore.readJson;
      const fault = spyOn(fileStore, 'readJson').mockImplementation(file =>
        damage === 'unreadable' && file === path ? Promise.reject(ioError) : read(file)
      );
      const claim = spyOn(store, 'claimStartBindingPreparation');
      const fail = spyOn(store, 'failStartBindingPreparation');
      const started: string[] = [];
      try {
        for (let pass = 0; pass < 2; pass++) {
          const error = await drainResourceStartHost({
            ...host,
            hostId: 'host',
            startAdmitted: async id => {
              started.push(id);
            },
          }).catch((caught: unknown) => caught);
          expect(started).toEqual([healthy.run.id]);
          expect(error).toBeInstanceOf(ResourceStartDrainError);
          if (!(error instanceof ResourceStartDrainError))
            throw new Error('expected drain failure');
          expect(error.failures).toHaveLength(1);
          expect(error.failures[0]?.receiptId).toBeUndefined();
          const failure = error.failures[0]?.error;
          expect(failure).toBeInstanceOf(Error);
          if (!(failure instanceof Error)) throw new Error('expected receipt error');
          expect(failure.message).toContain(`resource/receipts/${basename(path)}`);
          if (damage === 'unreadable') expect(failure.cause).toBe(ioError);
          else expect(failure.cause).toBeInstanceOf(Error);
          expect(await store.getResourceStartRequest(healthy.run.id)).toMatchObject({
            status: 'admitted',
          });
          expect(await store.getWorkflowRun(healthy.run.id)).toMatchObject({ status: 'pending' });
          expect(await store.getResourceStartRequest(foreign.run.id)).toMatchObject({
            status: 'queued',
          });
          expect(claim).not.toHaveBeenCalled();
          expect(fail).not.toHaveBeenCalled();
          expect(await fs.readFile(sentinel, 'utf8')).toBe('operator evidence');
        }
      } finally {
        fault.mockRestore();
        claim.mockRestore();
        fail.mockRestore();
      }
      expect(await fs.readFile(path, 'utf8')).toBe(bytes);
      expect(await store.getStartReceipt(deferredId)).toMatchObject({
        bindings: [{ status: 'pending', disposition: null }],
      });
      if (damage === 'unreadable') {
        expect(await store.getStartReceipt(receiptId)).toMatchObject({
          bindings: [{ status: 'pending', disposition: null }],
        });
      }
    }
  );
}

test('healthy foreign receipt filters out and queued drain succeeds once', async () => {
  const { host, store, healthy, foreign, receiptId } = await fixture('other');
  const started: string[] = [];
  for (let pass = 0; pass < 2; pass++)
    await drainResourceStartHost({
      ...host,
      hostId: 'host',
      startAdmitted: async id => {
        started.push(id);
      },
    });
  expect(started).toEqual([healthy.run.id]);
  expect(await store.getStartReceipt(receiptId)).toMatchObject({
    bindings: [{ status: 'pending' }],
  });
  expect(await store.getResourceStartRequest(foreign.run.id)).toMatchObject({ status: 'queued' });
});

test('receipt read failure after listing contains the claim without failing unowned preparation', async () => {
  const { host, store, healthy, path, receiptId } = await fixture('host');
  const bytes = await fs.readFile(path, 'utf8');
  const ioError = Object.assign(new Error('receipt claim read refused'), { code: 'EACCES' });
  let listed = false;
  const list = store.listPendingStartBindings.bind(store);
  const listing = spyOn(store, 'listPendingStartBindings').mockImplementation(async options => {
    const bindings = await list(options);
    listed = true;
    return bindings;
  });
  const read = fileStore.readJson;
  const fault = spyOn(fileStore, 'readJson').mockImplementation(file =>
    listed && file === path ? Promise.reject(ioError) : read(file)
  );
  const fail = spyOn(store, 'failStartBindingPreparation');
  const started: string[] = [];
  try {
    for (let pass = 0; pass < 2; pass++) {
      listed = false;
      const error = await drainResourceStartHost({
        ...host,
        hostId: 'host',
        startAdmitted: async id => {
          started.push(id);
        },
      }).catch((caught: unknown) => caught);
      expect(started).toEqual([healthy.run.id]);
      expect(error).toBeInstanceOf(ResourceStartDrainError);
      if (!(error instanceof ResourceStartDrainError)) throw new Error('expected drain failure');
      expect(error.failures).toEqual([{ receiptId, error: ioError }]);
    }
    expect(fail).not.toHaveBeenCalled();
  } finally {
    listing.mockRestore();
    fault.mockRestore();
    fail.mockRestore();
  }
  expect(await fs.readFile(path, 'utf8')).toBe(bytes);
  expect(await store.getStartReceipt(receiptId)).toMatchObject({
    bindings: [{ status: 'pending', disposition: null }],
  });
});
