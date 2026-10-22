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

async function fixture(receiptHost: string) {
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
  const accept = async (hostId: string, resource: string, userId = 'operator') => {
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
  const receiptId = await accept(receiptHost, 'damaged');
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
      row.bindings[0].hostId = row.bindings[0].hostId === 'host' ? 'other' : 'host';
      break;
    case 'null-intent':
      row.bindings[0].intent = null;
      break;
    default:
      throw new Error('unknown receipt damage');
  }
  await fs.writeFile(path, JSON.stringify(row));
}

for (const receiptHost of ['host', 'other']) {
  test.each([
    'json',
    'matched-empty',
    'matched-evaluated-only',
    'unmatched-intent',
    'unsupported-intent',
    'malformed-intent',
    'schema',
    'unreadable',
    'outer-id',
    'binding-id',
    'duplicate-binding',
    'evaluated-collision',
    'duplicate-evaluated',
    'intent-binding-id',
    'intent-revision',
    'host',
    'null-intent',
  ] as const)(
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

test('unreadable receipt attribution retains queue evidence and drains an independent resource', async () => {
  const { host, store, healthy, path, launch, root } = await fixture('host');
  const holder = launch('broken');
  await store.admitResourceStart({
    resource: 'broken',
    capacity: 1,
    hostId: 'host',
    overlap: 'queue',
    launch: holder,
  });
  const broken = launch('broken');
  await store.admitResourceStart({
    resource: 'broken',
    capacity: 1,
    hostId: 'host',
    overlap: 'queue',
    launch: broken,
  });
  await store.cancelWorkflowRun(holder.run.id);
  const requestPath = join(
    root,
    'resource/requests',
    createHash('sha256').update(broken.run.id).digest('hex') + '.json'
  );
  const row = JSON.parse(await fs.readFile(requestPath, 'utf8'));
  row.launch = {};
  await fs.writeFile(requestPath, JSON.stringify(row));
  const receiptError = Object.assign(new Error('receipt unreadable'), { code: 'EACCES' });
  const read = fileStore.readJson;
  const fault = spyOn(fileStore, 'readJson').mockImplementation(file =>
    file === path ? Promise.reject(receiptError) : read(file)
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
      expect(error.failures).toHaveLength(2);
      expect(error.failures[0]?.error).toMatchObject({ cause: receiptError });
      const queueFailure = error.failures.find(
        f => f.error instanceof Error && f.error.message.includes(broken.run.id)
      );
      expect(queueFailure?.receiptId).toBeUndefined();
      if (!(queueFailure?.error instanceof Error) || !(queueFailure.error.cause instanceof Error))
        throw new Error('expected queue error');
      const combined = queueFailure.error.cause.cause;
      expect(combined).toBeInstanceOf(AggregateError);
      if (!(combined instanceof AggregateError)) throw new Error('expected combined evidence');
      expect(combined.errors[0]).toBeInstanceOf(Error);
      expect(combined.errors[1]).toBe(receiptError);
      expect(await store.getWorkflowRun(broken.run.id)).toBeNull();
    }
  } finally {
    fault.mockRestore();
  }
  expect(await fs.readFile(requestPath, 'utf8')).toBe(JSON.stringify(row));
});

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
