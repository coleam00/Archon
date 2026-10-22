import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as fileStore from '@archon/workflows/file-store';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { PreparedWorkflowLaunch } from '@archon/workflows/schemas/resource-start';
import { setPlatformPolicies } from '../platforms/registry';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { createFileWorkflowHost } from './file-host';
import { drainResourceStartHost, ResourceStartDrainError } from './resource-start-host';

const roots = trackTempRoots();

async function fixture(receiptHost: string, damagedReceiptId?: string) {
  const root = await fs.realpath(roots(await fs.mkdtemp(join(tmpdir(), 'receipt-drain-'))));
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
  const accept = async (
    hostId: string,
    resource: string,
    userId = 'operator',
    receiptId: string = crypto.randomUUID()
  ) => {
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
          runAsUserId: userId,
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
  const receiptId = await accept(receiptHost, 'damaged', 'operator', damagedReceiptId);
  const path = join(
    root,
    'resource/receipts',
    `${createHash('sha256').update(receiptId).digest('hex')}.json`
  );
  const sentinel = join(root, 'sentinel.json');
  await fs.writeFile(sentinel, 'operator evidence');
  return { host, store, healthy, foreign, receiptId, path, sentinel, accept, launch, root };
}

async function damageReceipt(path: string, damage: string): Promise<void> {
  if (damage === 'unreadable') return;
  if (damage === 'json') return fs.writeFile(path, '{');
  const row = JSON.parse(await fs.readFile(path, 'utf8'));
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
      row.id = crypto.randomUUID();
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
      row.bindings[0].hostId = row.bindings[0].hostId === 'host' ? 'other' : 'host';
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
      row.bindings[0].status = 'pending';
      row.bindings[0].intent = null;
      break;
    default:
      throw new Error('unknown receipt damage');
  }
  await fs.writeFile(path, JSON.stringify(row));
}

const receiptDamages = [
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
] as const;

for (const receiptHost of ['host', 'other']) {
  test.each([...receiptDamages])(
    `receipt %s failure from ${receiptHost} preserves independent queued progress`,
    async damage => {
      const context = await fixture(receiptHost);
      const deferredId = await context.accept('host', 'deferred');
      const { host, store, path, receiptId, healthy, foreign, sentinel } = context;
      await damageReceipt(path, damage);
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
  const { host, store, healthy, path, receiptId, root, accept } = await fixture('host');
  setPlatformPolicies([]);
  registerBuiltinProviders();
  const project = join(root, 'later');
  await fs.mkdir(join(project, '.archon/workflows'), { recursive: true });
  await fs.writeFile(
    join(project, '.archon/workflows/test.yaml'),
    'name: test\ndescription: Receipt continuation fixture\nnodes:\n  - id: work\n    bash: echo ok\n'
  );
  await host.records.codebases.createCodebase({
    name: 'later',
    kind: 'folder',
    default_cwd: project,
  });
  const user = await host.records.users.findOrCreateUserByPlatformIdentity('cli', 'operator');
  if (!user) throw new Error('expected user');
  const laterId = await accept('host', 'later', user.id);
  const firstReceipt = JSON.parse(await fs.readFile(path, 'utf8'));
  firstReceipt.createdAt = '2000-01-01T00:00:00.000Z';
  await fs.writeFile(path, JSON.stringify(firstReceipt));
  const pending = await store.listPendingStartBindings({ hostId: 'host' });
  expect(pending.map(binding => binding.receiptId)).toEqual([receiptId, laterId]);
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
      const later = await store.getStartReceipt(laterId);
      expect(later).toMatchObject({
        bindings: [{ status: 'complete', disposition: { status: 'admitted' } }],
      });
      const laterRunId = later?.bindings[0]?.disposition?.requestId;
      if (!laterRunId) throw new Error('expected later binding run');
      expect(started).toEqual([laterRunId, healthy.run.id]);
      expect(error).toBeInstanceOf(ResourceStartDrainError);
      if (!(error instanceof ResourceStartDrainError)) throw new Error('expected drain failure');
      expect(error.failures).toHaveLength(1);
      expect(error.failures[0]?.receiptId).toBe(receiptId);
      expect(error.failures[0]?.error).toMatchObject({ cause: ioError });
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

async function queuedReceiptRequest(
  context: Awaited<ReturnType<typeof fixture>>,
  ownerReceiptId: string = crypto.randomUUID(),
  includeNeighbors = false,
  admission: 'named' | 'direct' | 'metadata' | 'originless' = 'named'
) {
  const { store, launch, accept, root } = context;
  const holder = launch('broken');
  await store.admitResourceStart({
    resource: 'broken',
    capacity: 1,
    hostId: 'host',
    overlap: 'queue',
    launch: holder,
  });
  const enqueue = async () => {
    const next = launch('broken');
    expect(
      await store.admitResourceStart({
        resource: 'broken',
        capacity: 1,
        hostId: 'host',
        overlap: 'queue',
        launch: next,
        receipt: { receiptId: context.receiptId, bindingId: 'binding' },
      })
    ).toMatchObject({ status: 'queued' });
    return next;
  };
  const prefix = includeNeighbors ? await enqueue() : undefined;
  const receiptId = await accept('host', 'broken', 'operator', ownerReceiptId);
  const idle = JSON.parse(await fs.readFile(context.path, 'utf8'));
  idle.bindings[0].status = 'complete';
  await fs.writeFile(context.path, JSON.stringify(idle));
  const owner = { receiptId, bindingId: 'binding', ownerId: 'owner' };
  const broken = launch('broken');
  if (admission === 'named' || admission === 'metadata')
    broken.run.metadata.resource_start = { receiptId, bindingId: 'binding' };
  if (admission === 'direct' || admission === 'metadata') {
    expect(
      await store.admitResourceStart({
        resource: 'broken',
        capacity: 1,
        hostId: 'host',
        overlap: 'queue',
        launch: broken,
        ...(admission === 'direct' ? { receipt: { receiptId, bindingId: 'binding' } } : {}),
      })
    ).toMatchObject({ status: 'queued' });
  } else {
    expect(await store.claimStartBindingPreparation(owner)).toBe(true);
    expect(await store.completeStartBindingPreparation({ ...owner, launch: broken })).toMatchObject(
      {
        status: 'queued',
      }
    );
  }
  const successor = includeNeighbors ? await enqueue() : undefined;
  if (includeNeighbors) await store.failWorkflowRun(holder.run.id, 'fixture holder finished');
  else await store.cancelWorkflowRun(holder.run.id);
  return {
    holder,
    prefix,
    successor,
    broken,
    receiptId,
    path: join(
      root,
      'resource/receipts',
      createHash('sha256').update(receiptId).digest('hex') + '.json'
    ),
    requestPath: join(
      root,
      'resource/requests',
      createHash('sha256').update(broken.run.id).digest('hex') + '.json'
    ),
  };
}

function expectReceiptAttributionError(combined: unknown, path: string, readError?: Error): Error {
  expect(combined).toBeInstanceOf(AggregateError);
  if (!(combined instanceof AggregateError)) throw new Error('expected combined evidence');
  expect(combined.errors[0]).toBeInstanceOf(Error);
  const attributionError: unknown = combined.errors[1];
  if (!(attributionError instanceof Error)) throw new Error('expected attribution error');
  expect(attributionError.message).toContain(`resource/receipts/${basename(path)}`);
  expect(attributionError.cause).toBeInstanceOf(Error);
  if (readError) expect(attributionError.cause).toBe(readError);
  return attributionError;
}

test.each(['healthy', ...receiptDamages] as const)(
  '%s receipt attribution retains queue evidence and drains an independent resource',
  async damage => {
    const context = await fixture('host');
    const { host, store, healthy } = context;
    const { broken, receiptId, path, requestPath } = await queuedReceiptRequest(context);
    const expectedReceiptId = damage === 'healthy' ? receiptId : undefined;
    const expectedFailureCount = damage === 'healthy' ? 1 : 2;
    const row = JSON.parse(await fs.readFile(requestPath, 'utf8'));
    row.position = -1;
    await fs.writeFile(requestPath, JSON.stringify(row));
    if (damage !== 'healthy') await damageReceipt(path, damage);
    const receiptBytes = await fs.readFile(path, 'utf8');
    const receiptError = Object.assign(new Error('receipt unreadable'), { code: 'EACCES' });
    const read = fileStore.readJson;
    const fault = spyOn(fileStore, 'readJson').mockImplementation(file =>
      damage === 'unreadable' && file === path ? Promise.reject(receiptError) : read(file)
    );
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
        if (!(error instanceof ResourceStartDrainError)) throw new Error('expected drain failure');
        expect(error.failures).toHaveLength(expectedFailureCount);
        const queueFailure = error.failures.find(
          f => f.error instanceof Error && f.error.message.includes(broken.run.id)
        );
        expect(queueFailure).toBeDefined();
        expect(queueFailure?.receiptId).toBe(expectedReceiptId);
        if (!(queueFailure?.error instanceof Error) || !(queueFailure.error.cause instanceof Error))
          throw new Error('expected queue error');
        const combined = queueFailure.error.cause.cause;
        if (damage === 'healthy') {
          expect(combined).toBeInstanceOf(Error);
          expect(combined).not.toBeInstanceOf(AggregateError);
        } else {
          const attributionError = expectReceiptAttributionError(
            combined,
            path,
            damage === 'unreadable' ? receiptError : undefined
          );
          expect(error.failures[0]?.error).toMatchObject({
            message: attributionError.message,
            cause: expect.any(Error),
          });
        }
        expect(await store.getWorkflowRun(broken.run.id)).toBeNull();
      }
    } finally {
      fault.mockRestore();
    }
    expect(await fs.readFile(requestPath, 'utf8')).toBe(JSON.stringify(row));
    expect(await fs.readFile(path, 'utf8')).toBe(receiptBytes);
  }
);

test('queue listing failure preserves the preceding receipt scan diagnostic', async () => {
  const { host, store, path } = await fixture('host');
  await fs.writeFile(path, '{');
  const queueError = new Error('slot read refused');
  const fault = spyOn(store, 'listQueuedResourceStartsForHost').mockRejectedValue(queueError);
  try {
    const error = await drainResourceStartHost({
      ...host,
      hostId: 'host',
      startAdmitted: async () => {},
    }).catch((caught: unknown) => caught);
    if (!(error instanceof ResourceStartDrainError)) throw new Error('expected drain failure');
    expect(error.failures).toHaveLength(2);
    const receiptError = error.failures[0]?.error;
    if (!(receiptError instanceof Error)) throw new Error('expected receipt error');
    expect(receiptError.message).toContain(basename(path));
    expect(receiptError.cause).toBeInstanceOf(SyntaxError);
    expect(error.failures[1]?.error).toBe(queueError);
  } finally {
    fault.mockRestore();
  }
});

function combinedQueueFailure(error: unknown): AggregateError {
  if (!(error instanceof Error) || !(error.cause instanceof Error))
    throw new Error('expected queue error');
  const combined = error.cause.cause;
  expect(combined).toBeInstanceOf(AggregateError);
  if (!(combined instanceof AggregateError)) throw new Error('expected combined evidence');
  expect(combined.errors[0]).toBeInstanceOf(Error);
  return combined;
}

test.each([
  'wrong-receipt',
  'wrong-binding',
  'duplicate-membership',
  'valid-duplicate-membership',
  'direct-duplicate-membership',
  'unreadable-origin',
])('%s cannot invent receipt ownership or display another binding request', async damage => {
  const context = await fixture('host');
  const { store, host, healthy, path: claimantPath, receiptId: claimantId } = context;
  const { broken, receiptId, requestPath } = await queuedReceiptRequest(context);
  const claimant = JSON.parse(await fs.readFile(claimantPath, 'utf8'));
  claimant.bindings[0].status = 'complete';
  claimant.bindings[0].requestIds.push(broken.run.id);
  await fs.writeFile(claimantPath, JSON.stringify(claimant));
  const row = JSON.parse(await fs.readFile(requestPath, 'utf8'));
  switch (damage) {
    case 'wrong-receipt':
      row.launch.run.metadata.resource_start.receiptId = crypto.randomUUID();
      break;
    case 'wrong-binding':
      row.launch.run.metadata.resource_start.bindingId = 'other';
      break;
    case 'unreadable-origin':
      row.launch = {};
      break;
    case 'direct-duplicate-membership':
      row.launch.run.metadata = {};
      break;
  }
  await fs.writeFile(requestPath, JSON.stringify(row));
  if (damage === 'direct-duplicate-membership') {
    expect(await store.getStartReceipt(claimantId)).toMatchObject({
      bindings: [{ disposition: { requestId: broken.run.id } }],
    });
  } else await expect(store.getStartReceipt(claimantId)).rejects.toThrow();
  if (damage.endsWith('duplicate-membership')) {
    expect(await store.getStartReceipt(receiptId)).toMatchObject({
      bindings: [{ disposition: { requestId: broken.run.id } }],
    });
  } else await expect(store.getStartReceipt(receiptId)).rejects.toThrow();
  if (!['valid-duplicate-membership', 'direct-duplicate-membership'].includes(damage))
    row.position = -1;
  await fs.writeFile(requestPath, JSON.stringify(row));
  const expectedReceiptId =
    damage.endsWith('duplicate-membership') && damage !== 'direct-duplicate-membership'
      ? receiptId
      : undefined;
  const started: string[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const error = await drainResourceStartHost({
      ...host,
      hostId: 'host',
      startAdmitted: async id => {
        started.push(id);
      },
    }).catch((caught: unknown) => caught);
    if (!(error instanceof ResourceStartDrainError)) throw new Error('expected drain failure');
    const failure = error.failures.find(
      f => f.error instanceof Error && f.error.message.includes(broken.run.id)
    );
    expect(failure?.receiptId).toBe(expectedReceiptId);
    const combined = combinedQueueFailure(failure?.error);
    if (damage !== 'unreadable-origin') {
      expect(combined.errors).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining(basename(claimantPath)),
        })
      );
    }
    expect(started).toEqual([healthy.run.id]);
    expect(await store.getWorkflowRun(broken.run.id)).toBeNull();
  }
  expect(await fs.readFile(requestPath, 'utf8')).toBe(JSON.stringify(row));
  expect(await fs.readFile(claimantPath, 'utf8')).toBe(JSON.stringify(claimant));
});

test.each([
  ['json', true],
  ['json', false],
  ['unreadable', true],
  ['unreadable', false],
] as const)(
  '%s receipt (owner follows: %s) retains diagnostics and valid ownership',
  async (damage, ownerAfterDamage) => {
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ].sort((a, b) =>
      createHash('sha256')
        .update(a)
        .digest('hex')
        .localeCompare(createHash('sha256').update(b).digest('hex'))
    );
    const context = await fixture('host', ids[ownerAfterDamage ? 0 : 1]);
    const { path: damagedPath, host } = context;
    const { broken, receiptId, path, requestPath } = await queuedReceiptRequest(
      context,
      ids[ownerAfterDamage ? 1 : 0]
    );
    const row = JSON.parse(await fs.readFile(requestPath, 'utf8'));
    row.position = -1;
    await fs.writeFile(requestPath, JSON.stringify(row));
    await fs.writeFile(damagedPath, '{');
    const read = fileStore.readJson;
    const ioError = new Error('receipt read refused');
    const scanOrder = await fs.readdir(join(context.root, 'resource/receipts'));
    expect(scanOrder.indexOf(basename(damagedPath)) < scanOrder.indexOf(basename(path))).toBe(
      ownerAfterDamage
    );
    const ownerBytes = await fs.readFile(path, 'utf8');
    const damagedBytes = await fs.readFile(damagedPath, 'utf8');
    const reader = spyOn(fileStore, 'readJson').mockImplementation(file =>
      damage === 'unreadable' && file === damagedPath ? Promise.reject(ioError) : read(file)
    );
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
        if (!(error instanceof ResourceStartDrainError)) throw new Error('expected drain failure');
        const failure = error.failures.find(
          f => f.error instanceof Error && f.error.message.includes(broken.run.id)
        );
        expect(failure?.receiptId).toBe(receiptId);
        if (!(failure?.error instanceof Error) || !(failure.error.cause instanceof Error))
          throw new Error('expected queue error');
        expectReceiptAttributionError(
          failure.error.cause.cause,
          damagedPath,
          damage === 'unreadable' ? ioError : undefined
        );
        expect(started).toEqual([context.healthy.run.id]);
        expect(error.failures[0]?.error).toMatchObject({
          message: expect.stringContaining(basename(damagedPath)),
        });
      }
    } finally {
      reader.mockRestore();
    }
    expect(await fs.readFile(path, 'utf8')).toBe(ownerBytes);
    expect(await fs.readFile(damagedPath, 'utf8')).toBe(damagedBytes);
  }
);

function errorEvidence(error: unknown): Error[] {
  if (!(error instanceof Error)) return [];
  return [
    error,
    ...errorEvidence(error.cause),
    ...(error instanceof AggregateError ? error.errors.flatMap(errorEvidence) : []),
  ];
}

function expectReceiptFailureCause(evidence: Error[], damage: string, ioError: Error) {
  if (damage === 'unreadable') expect(evidence).toContain(ioError);
  if (damage === 'json') expect(evidence.some(item => item instanceof SyntaxError)).toBe(true);
  if (damage === 'schema') expect(evidence.some(item => item.name === 'ZodError')).toBe(true);
}

for (const entry of ['direct', 'host'] as const) {
  test.each([
    'healthy',
    'json',
    'schema',
    'unreadable',
    'missing',
    'no-membership',
    'no-binding',
    'conflicting-claimant',
    'direct-duplicate',
    'wrong-origin',
    'wrong-binding',
    'pending',
    'preparing',
    'failed',
    'rejected',
    'evaluated-rejected',
    'evaluated-unmatched',
  ] as const)(
    `${entry} admission proves receipt membership for valid queued rows: %s`,
    async damage => {
      const context = await fixture('host');
      const { store, path: claimantPath } = context;
      const { broken, holder, prefix, successor, path, requestPath, receiptId } =
        await queuedReceiptRequest(context, crypto.randomUUID(), true);
      if (!prefix || !successor) throw new Error('expected queue neighbors');
      const queued = { broken, holder, prefix, successor, path, requestPath, receiptId };
      const row = await damageQueuedMembership(context, queued, damage);
      await fs.writeFile(requestPath, JSON.stringify(row));
      const bytes = damage === 'missing' ? null : await fs.readFile(path, 'utf8');
      const claimantBytes = await fs.readFile(claimantPath, 'utf8');
      const ioError = new Error('named receipt read refused');
      const read = fileStore.readJson;
      const fault = spyOn(fileStore, 'readJson').mockImplementation(file =>
        damage === 'unreadable' && file === path ? Promise.reject(ioError) : read(file)
      );
      const claim = spyOn(store, 'claimStartBindingPreparation');
      const started: string[] = [];
      try {
        for (let pass = 0; pass < 3; pass++) {
          await expectMembershipPass(context, queued, entry, damage, pass, started, ioError);
        }
        if (entry === 'host' && (damage === 'pending' || damage === 'failed'))
          expect(claim).toHaveBeenCalledTimes(3);
        else expect(claim).not.toHaveBeenCalled();
      } finally {
        fault.mockRestore();
        claim.mockRestore();
      }
      await expectReceiptBytes(path, bytes);
      expect(await fs.readFile(claimantPath, 'utf8')).toBe(claimantBytes);
      if (damage !== 'healthy')
        expect(await fs.readFile(requestPath, 'utf8')).toBe(JSON.stringify(row));
    }
  );
}

type ReceiptDrainFixture = Awaited<ReturnType<typeof fixture>>;
type QueuedReceiptFixture = Awaited<ReturnType<typeof queuedReceiptRequest>>;

async function damageQueuedMembership(
  context: ReceiptDrainFixture,
  queued: QueuedReceiptFixture,
  damage: string
) {
  const { requestPath, path, broken } = queued;
  const { path: claimantPath } = context;
  const row = JSON.parse(await fs.readFile(requestPath, 'utf8'));
  switch (damage) {
    case 'conflicting-claimant':
    case 'direct-duplicate': {
      const claimant = JSON.parse(await fs.readFile(claimantPath, 'utf8'));
      claimant.bindings[0].requestIds.push(broken.run.id);
      await fs.writeFile(claimantPath, JSON.stringify(claimant));
      if (damage === 'direct-duplicate') row.launch.run.metadata = {};
      break;
    }
    case 'wrong-origin':
      row.launch.run.metadata.resource_start.receiptId = context.receiptId;
      break;
    case 'wrong-binding':
      row.launch.run.metadata.resource_start.bindingId = 'absent';
      break;
    case 'missing':
      await fs.unlink(path);
      break;
    case 'no-membership':
    case 'no-binding': {
      const receipt = JSON.parse(await fs.readFile(path, 'utf8'));
      if (damage === 'no-membership') receipt.bindings[0].requestIds = [];
      else {
        receipt.bindings[0].bindingId = 'other';
        receipt.bindings[0].intent.bindingId = 'other';
      }
      await fs.writeFile(path, JSON.stringify(receipt));
      break;
    }
    case 'pending':
    case 'preparing':
    case 'failed':
    case 'rejected':
    case 'evaluated-rejected':
    case 'evaluated-unmatched': {
      const receipt = JSON.parse(await fs.readFile(path, 'utf8'));
      receipt.bindings[0].status = damage.replace('evaluated-', '');
      if (damage.startsWith('evaluated-')) {
        receipt.bindings[0].intent = null;
        receipt.bindings[0].hostId = null;
        receipt.outcome = 'unmatched';
        row.launch.run.metadata = {};
      }
      await fs.writeFile(path, JSON.stringify(receipt));
      break;
    }
    case 'healthy':
      break;
    default:
      await damageReceipt(path, damage);
  }
  return row;
}

async function drainMembershipHost(
  context: ReceiptDrainFixture,
  requestId: string,
  damage: string,
  started: string[]
) {
  const error = await drainResourceStartHost({
    ...context.host,
    hostId: 'host',
    startAdmitted: async id => {
      started.push(id);
    },
  }).catch((caught: unknown) => caught);
  if (damage === 'healthy') {
    expect(error).toBeUndefined();
    return;
  }
  if (!(error instanceof ResourceStartDrainError)) throw new Error('expected drain failure');
  expect(
    error.failures.some(failure =>
      errorEvidence(failure.error).some(item => item.message.includes(requestId))
    )
  ).toBe(true);
}

async function expectBlockedMembership(
  context: ReceiptDrainFixture,
  queued: QueuedReceiptFixture,
  damage: string,
  ioError: Error
) {
  const { store, path: claimantPath } = context;
  const { broken, holder, path } = queued;
  expect(await store.getWorkflowRun(broken.run.id)).toBeNull();
  const inspections = await store.listQueuedResourceStartsForHost('host');
  const blocked = inspections.find(item => item.id === broken.run.id);
  expect(blocked).toHaveProperty('error');
  if (!blocked || !('error' in blocked)) throw new Error('expected receipt proof failure');
  const evidence = errorEvidence(blocked.error);
  const damagedPath =
    damage === 'wrong-origin' || damage === 'conflicting-claimant' ? claimantPath : path;
  expect(evidence.some(item => item.message.includes(basename(damagedPath)))).toBe(true);
  expectReceiptFailureCause(evidence, damage, ioError);
  const head = await fs.readFile(join(context.root, 'head.json'), 'utf8');
  await expect(
    store.admitResourceStart({
      resource: 'broken',
      capacity: 1,
      hostId: 'host',
      overlap: 'queue',
      launch: context.launch('broken'),
    })
  ).rejects.toThrow('is invalid');
  await expect(store.resumeWorkflowRun(holder.run.id)).rejects.toThrow('is invalid');
  expect(await fs.readFile(join(context.root, 'head.json'), 'utf8')).toBe(head);
}

async function expectReceiptBytes(path: string, bytes: string | null) {
  if (bytes === null) await expect(fs.stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  else expect(await fs.readFile(path, 'utf8')).toBe(bytes);
}

async function expectMembershipPass(
  context: ReceiptDrainFixture,
  queued: QueuedReceiptFixture & {
    prefix: PreparedWorkflowLaunch;
    successor: PreparedWorkflowLaunch;
  },
  entry: 'direct' | 'host',
  damage: string,
  pass: number,
  started: string[],
  ioError: Error
) {
  const { store, healthy } = context;
  const { broken, prefix, successor } = queued;
  if (pass === 1) await store.cancelWorkflowRun(prefix.run.id);
  const expected = [];
  if (pass === 0) expected.push(prefix.run.id);
  if (damage === 'healthy' && pass === 1) expected.push(broken.run.id);
  if (entry === 'host') {
    await drainMembershipHost(context, broken.run.id, damage, started);
    const expectedStarted = [prefix.run.id, healthy.run.id];
    if (damage === 'healthy' && pass > 0) expectedStarted.push(broken.run.id);
    expect(started).toEqual(expectedStarted);
  } else {
    const decisions = await store.drainResourceStarts({
      resource: 'broken',
      hostId: 'host',
    });
    expect(decisions.map(d => d.requestId)).toEqual(expected);
  }
  expect(await store.getWorkflowRun(successor.run.id)).toBeNull();
  if (damage !== 'healthy') {
    await expectBlockedMembership(context, queued, damage, ioError);
  }
}

for (const entry of ['direct', 'host'] as const) {
  for (const admission of [
    'direct',
    'metadata',
    'originless',
    'legacy',
    'legacy-claimant',
  ] as const) {
    const damages: string[] =
      admission === 'legacy-claimant'
        ? ['json', 'schema', 'unreadable']
        : admission === 'legacy'
          ? [
              'healthy',
              'json',
              'schema',
              'unreadable',
              'pending',
              'preparing',
              'failed',
              'rejected',
            ]
          : ['healthy', 'json', 'schema', 'unreadable', 'missing', 'no-membership', 'no-binding'];
    test.each(damages)(`${entry} drain retains ${admission} receipt links: %s`, async damage => {
      const context = await fixture('host');
      const queued = await queuedReceiptRequest(
        context,
        crypto.randomUUID(),
        true,
        admission === 'legacy' || admission === 'legacy-claimant' ? 'originless' : admission
      );
      const { prefix, successor, path, requestPath } = queued;
      if (!prefix || !successor) throw new Error('expected queue neighbors');
      expect(
        (await context.store.getResourceStartRequest(queued.broken.run.id))?.launch.run.metadata
          .resource_start
      ).toEqual({
        receiptId: queued.receiptId,
        bindingId: 'binding',
      });
      const row = await damageQueuedMembership(context, queued, damage);
      if (admission === 'legacy' || admission === 'legacy-claimant') row.launch.run.metadata = {};
      if (admission === 'legacy-claimant') {
        const claimant = JSON.parse(await fs.readFile(context.path, 'utf8'));
        claimant.bindings[0].requestIds.push(queued.broken.run.id);
        await fs.writeFile(context.path, JSON.stringify(claimant));
      }
      await fs.writeFile(requestPath, JSON.stringify(row));
      const bytes = damage === 'missing' ? null : await fs.readFile(path, 'utf8');
      const claimantBytes = await fs.readFile(context.path, 'utf8');
      const ioError = new Error('explicit receipt read refused');
      const read = fileStore.readJson;
      const fault = spyOn(fileStore, 'readJson').mockImplementation(file =>
        damage === 'unreadable' && file === path ? Promise.reject(ioError) : read(file)
      );
      const started: string[] = [];
      try {
        for (let pass = 0; pass < 3; pass++) {
          await expectMembershipPass(
            context,
            { ...queued, prefix, successor },
            entry,
            damage,
            pass,
            started,
            ioError
          );
        }
      } finally {
        fault.mockRestore();
      }
      await expectReceiptBytes(path, bytes);
      expect(await fs.readFile(context.path, 'utf8')).toBe(claimantBytes);
      if (admission === 'legacy-claimant') {
        const inspections = await context.store.listQueuedResourceStartsForHost('host');
        const blocked = inspections.find(item => item.id === queued.broken.run.id);
        if (!blocked || !('error' in blocked)) throw new Error('expected blocked legacy request');
        expect(blocked.receiptId).toBeUndefined();
      }
      if (damage !== 'healthy')
        expect(await fs.readFile(requestPath, 'utf8')).toBe(JSON.stringify(row));
    });
  }
}

test.each(['direct', 'preparation'] as const)(
  '%s refuses contradictory explicit receipt origins without committing',
  async entry => {
    const context = await fixture('host');
    const { store, receiptId, launch, root } = context;
    const owner = { receiptId, bindingId: 'binding', ownerId: 'owner' };
    if (entry === 'preparation') expect(await store.claimStartBindingPreparation(owner)).toBe(true);
    const prepared = launch('damaged');
    prepared.run.metadata.resource_start = { receiptId: crypto.randomUUID(), bindingId: 'binding' };
    const head = await fs.readFile(join(root, 'head.json'), 'utf8');
    const result =
      entry === 'direct'
        ? store.admitResourceStart({
            resource: 'damaged',
            capacity: 1,
            hostId: 'host',
            overlap: 'queue',
            launch: prepared,
            receipt: { receiptId, bindingId: 'binding' },
          })
        : store.completeStartBindingPreparation({ ...owner, launch: prepared });
    await expect(result).rejects.toThrow('inconsistent membership');
    expect(await store.getWorkflowRun(prepared.run.id)).toBeNull();
    expect(await store.getResourceStartRequest(prepared.run.id)).toBeNull();
    expect(await fs.readFile(join(root, 'head.json'), 'utf8')).toBe(head);
  }
);

test.each(['rejected', 'unmatched'] as const)(
  'direct admission cannot attach a prepared launch to an evaluated %s binding',
  async status => {
    const { store, root, launch } = await fixture('host');
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
      outcome: 'unmatched',
      bindings: [],
      evaluatedBindings: [
        { bindingId: 'binding', bindingRevision: null, status, reason: 'no match' },
      ],
    });
    const prepared = launch('evaluated');
    const head = await fs.readFile(join(root, 'head.json'), 'utf8');
    await expect(
      store.admitResourceStart({
        resource: 'evaluated',
        capacity: 1,
        hostId: 'host',
        overlap: 'queue',
        launch: prepared,
        receipt: { receiptId, bindingId: 'binding' },
      })
    ).rejects.toThrow('missing preparation intent');
    expect(await store.getWorkflowRun(prepared.run.id)).toBeNull();
    expect(await fs.readFile(join(root, 'head.json'), 'utf8')).toBe(head);
    expect(await store.getStartReceipt(receiptId)).toMatchObject({
      bindings: [{ status, disposition: null }],
    });
  }
);

async function damageMetadataReceipt(path: string, damage: string): Promise<void> {
  if (damage === 'missing') await fs.unlink(path);
  else if (damage === 'no-binding' || damage === 'evaluated') {
    const row = JSON.parse(await fs.readFile(path, 'utf8'));
    if (damage === 'no-binding') {
      row.bindings[0].bindingId = 'other';
      row.bindings[0].intent.bindingId = 'other';
    } else {
      row.bindings[0].intent = null;
      row.bindings[0].hostId = null;
      row.bindings[0].status = 'unmatched';
      row.outcome = 'unmatched';
    }
    await fs.writeFile(path, JSON.stringify(row));
  } else if (damage !== 'healthy') await damageReceipt(path, damage);
}

for (const overlap of ['queue', 'skip'] as const) {
  test.each(['healthy', 'json', 'schema', 'unreadable', 'missing', 'no-binding', 'evaluated'])(
    `metadata-only direct ${overlap} admission validates its receipt atomically: %s`,
    async damage => {
      const { store, receiptId, path, launch, root } = await fixture('host');
      const prepared = launch('damaged');
      prepared.run.metadata.resource_start = { receiptId, bindingId: 'binding' };
      if (overlap === 'skip')
        await store.admitResourceStart({
          resource: 'damaged',
          capacity: 1,
          hostId: 'host',
          overlap,
          launch: launch('damaged'),
        });
      await damageMetadataReceipt(path, damage);
      const bytes = damage === 'missing' ? null : await fs.readFile(path, 'utf8');
      const head = await fs.readFile(join(root, 'head.json'), 'utf8');
      const ioError = new Error('metadata origin read refused');
      const read = fileStore.readJson;
      const fault = spyOn(fileStore, 'readJson').mockImplementation(file =>
        damage === 'unreadable' && file === path ? Promise.reject(ioError) : read(file)
      );
      try {
        const input = {
          resource: 'damaged',
          capacity: 1,
          hostId: 'host',
          overlap,
          launch: prepared,
        };
        if (damage === 'healthy') {
          const result = await store.admitResourceStart(input);
          expect(result.status).toBe(overlap === 'skip' ? 'skipped' : 'admitted');
          expect(await store.getStartReceipt(receiptId)).toMatchObject({
            bindings: [{ status: 'complete', disposition: result }],
          });
        } else {
          for (let pass = 0; pass < 2; pass++) {
            const error = await store.admitResourceStart(input).catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(Error);
            expectReceiptFailureCause(errorEvidence(error), damage, ioError);
            expect(await store.getWorkflowRun(prepared.run.id)).toBeNull();
            expect(await store.getResourceStartRequest(prepared.run.id)).toBeNull();
            expect(await fs.readFile(join(root, 'head.json'), 'utf8')).toBe(head);
          }
        }
      } finally {
        fault.mockRestore();
      }
      if (damage !== 'healthy') await expectReceiptBytes(path, bytes);
    }
  );
}

test.each(['pending', 'failed'])(
  'an incomplete %s binding with a missing linked request cannot prepare again',
  async status => {
    const context = await fixture('host');
    const queued = await queuedReceiptRequest(context);
    await damageQueuedMembership(context, queued, status);
    await fs.unlink(queued.requestPath);
    const receiptBytes = await fs.readFile(queued.path, 'utf8');
    const head = await fs.readFile(join(context.root, 'head.json'), 'utf8');

    for (let pass = 0; pass < 2; pass++) {
      await expect(
        context.store.claimStartBindingPreparation({
          receiptId: queued.receiptId,
          bindingId: 'binding',
          ownerId: 'must-not-prepare',
        })
      ).rejects.toThrow('has requests on an incomplete binding');
      expect(await fs.readFile(queued.path, 'utf8')).toBe(receiptBytes);
      expect(JSON.parse(await fs.readFile(queued.path, 'utf8')).bindings[0].status).toBe(status);
      expect(await fs.readFile(join(context.root, 'head.json'), 'utf8')).toBe(head);
      expect(await context.store.getResourceStartRequest(queued.broken.run.id)).toBeNull();
    }
  }
);

for (const origin of ['named', 'legacy'] as const) {
  test.each(['pending', 'failed'])(
    `a ${origin} inconsistent %s binding does not stop independent preparation`,
    async status => {
      const context = await fixture('host');
      const { host, store, root, accept } = context;
      const queued = await queuedReceiptRequest(context);
      const row = await damageQueuedMembership(context, queued, status);
      if (origin === 'legacy') row.launch.run.metadata = {};
      await fs.writeFile(queued.requestPath, JSON.stringify(row));
      const damaged = JSON.parse(await fs.readFile(queued.path, 'utf8'));
      damaged.createdAt = '2000-01-01T00:00:00.000Z';
      const damagedBytes = JSON.stringify(damaged);
      await fs.writeFile(queued.path, damagedBytes);
      setPlatformPolicies([]);
      registerBuiltinProviders();
      const project = join(root, 'later');
      await fs.mkdir(join(project, '.archon/workflows'), { recursive: true });
      await fs.writeFile(
        join(project, '.archon/workflows/test.yaml'),
        'name: test\ndescription: Independent preparation fixture\nnodes:\n  - id: work\n    bash: echo ok\n'
      );
      await host.records.codebases.createCodebase({
        name: 'later',
        kind: 'folder',
        default_cwd: project,
      });
      const user = await host.records.users.findOrCreateUserByPlatformIdentity('cli', 'operator');
      if (!user) throw new Error('expected user');
      const laterId = await accept('host', 'later', user.id);
      const started: string[] = [];
      const head = await fs.readFile(join(root, 'head.json'), 'utf8');
      for (let pass = 0; pass < 2; pass++) {
        await expect(
          store.claimStartBindingPreparation({
            receiptId: queued.receiptId,
            bindingId: 'binding',
            ownerId: 'must-not-prepare',
          })
        ).rejects.toThrow();
        if (pass === 0) expect(await fs.readFile(join(root, 'head.json'), 'utf8')).toBe(head);
        const error = await drainResourceStartHost({
          ...host,
          hostId: 'host',
          startAdmitted: async id => {
            started.push(id);
          },
        }).catch((caught: unknown) => caught);
        if (!(error instanceof ResourceStartDrainError)) throw new Error('expected drain failure');
        expect(
          error.failures.some(
            failure =>
              failure.receiptId === queued.receiptId &&
              errorEvidence(failure.error).some(item =>
                item.message.includes(basename(queued.path))
              )
          )
        ).toBe(true);
        const later = await store.getStartReceipt(laterId);
        expect(later).toMatchObject({
          bindings: [{ status: 'complete', requestStatus: 'admitted' }],
        });
        const preparedId = later?.bindings[0]?.disposition?.requestId;
        if (!preparedId) throw new Error('expected independently prepared request');
        expect(started).toEqual([preparedId, context.healthy.run.id]);
        expect(await store.getWorkflowRun(queued.broken.run.id)).toBeNull();
        expect(await fs.readFile(queued.path, 'utf8')).toBe(damagedBytes);
        expect(await fs.readFile(queued.requestPath, 'utf8')).toBe(JSON.stringify(row));
      }
    }
  );
}
