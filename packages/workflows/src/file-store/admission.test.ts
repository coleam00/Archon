import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, readdir, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { currentProcessOwner, ProcessOwnerRecordError } from '@archon/paths/process-owner';
import { trackTempRoots } from '@archon/paths/test-utils';
import { WorkflowResourceBusyError, WorkflowNotResumableError } from '../store';
import type { ResourceStartIntent } from '../schemas/resource-start';
import { createFileWorkflowStore } from './store';
import * as commitModule from './commit';
const roots = trackTempRoots();
const intent = (): ResourceStartIntent => ({
  resource: 'resource',
  capacity: 1,
  hostId: 'host',
  overlap: 'queue',
  launch: {
    version: 2,
    run: {
      id: crypto.randomUUID(),
      workflow_name: 'test',
      user_message: '',
      codebase_id: 'codebase',
      metadata: {},
    },
    execution: { cwd: '/test', conversationId: 'correlation', isolation: { kind: 'in-place' } },
  },
});
async function fixture() {
  const root = roots(await mkdtemp(join(tmpdir(), 'file-admission-')));
  return { root, store: await createFileWorkflowStore({ root }) };
}
test('failed resume cannot bypass queued promises or a new holder; paused continuation keeps its slot', async () => {
  const { root, store } = await fixture();
  const first = intent(),
    next = intent();
  await store.admitResourceStart(first);
  await store.claimPendingWorkflowRun(first.launch.run.id);
  await store.pauseWorkflowRunForWait(
    first.launch.run.id,
    {
      owner: 'node',
      nodeId: 'wait',
      kind: 'time',
      waitingSince: '2026-01-01T00:00:00.000Z',
      resumeAt: '2026-01-02T00:00:00.000Z',
    },
    { kind: 'started', stepName: 'wait' }
  );
  await store.admitResourceStart(next);
  await store.resumeWorkflowRun(first.launch.run.id);
  await store.failWorkflowRun(first.launch.run.id, 'failed');
  const head = await readFile(join(root, 'head.json'), 'utf8');
  await expect(store.resumeWorkflowRun(first.launch.run.id)).rejects.toBeInstanceOf(
    WorkflowResourceBusyError
  );
  expect(await readFile(join(root, 'head.json'), 'utf8')).toBe(head);
  await expect(
    store.resumeWorkflowRun(first.launch.run.id, {
      kind: 'wait',
      nodeId: 'stale',
      resumeAt: 'stale',
    })
  ).rejects.toBeInstanceOf(WorkflowNotResumableError);
  expect(await readFile(join(root, 'head.json'), 'utf8')).toBe(head);
  await store.drainResourceStarts({ resource: 'resource', hostId: 'host' });
  await expect(store.resumeWorkflowRun(first.launch.run.id)).rejects.toMatchObject({
    blocker: { kind: 'run', id: next.launch.run.id },
  });
  // A delayed starter cannot reclaim a run after admission has pruned its holder.
  await store.updateWorkflowRun(first.launch.run.id, { status: 'pending' });
  expect(await store.claimPendingWorkflowRun(first.launch.run.id)).toBeNull();
  await store.cancelWorkflowRun(next.launch.run.id);
  await commitModule.commit(root, [first.launch.run.id], async runs => {
    const run = runs.get(first.launch.run.id)!;
    run.status = 'failed';
    return { result: undefined, changes: { runs: [{ run }] } };
  });
  expect(await store.resumeWorkflowRun(first.launch.run.id)).toMatchObject({ status: 'running' });
});

test('holder checks use snapshots even when a snapshot is missing, and prune missing runs', async () => {
  const { root, store } = await fixture();
  const first = intent(),
    next = intent();
  await store.admitResourceStart(first);
  await unlink(join(root, 'runs', first.launch.run.id, 'run.json'));
  const reads = spyOn(commitModule, 'readRunState');
  try {
    expect(await store.admitResourceStart(next)).toMatchObject({ status: 'queued' });
    expect(reads).not.toHaveBeenCalled();
    // A missing run releases the holder, as a terminal run does.
    const { rm } = await import('node:fs/promises');
    await rm(join(root, 'runs', first.launch.run.id), { recursive: true });
    expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toHaveLength(
      1
    );
    expect(reads).not.toHaveBeenCalled();
  } finally {
    reads.mockRestore();
  }
});

test.each(['intent', 'run', 'request'] as const)(
  'admission redo at %s restores run, request and holder as one commit',
  async step => {
    const source = await fixture();
    const start = intent();
    await source.store.admitResourceStart(start);
    const line = JSON.parse(
      (await readFile(join(source.root, 'runs', start.launch.run.id, 'log.jsonl'), 'utf8')).trim()
    );
    const documents: Record<string, unknown> = {};
    for (const kind of ['requests', 'slots']) {
      for (const name of await readdir(join(source.root, 'resource', kind))) {
        const path = `resource/${kind}/${name}`;
        documents[path] = JSON.parse(await readFile(join(source.root, path), 'utf8'));
      }
    }
    const target = await fixture();
    await writeFile(
      join(target.root, 'intent.json'),
      JSON.stringify({ seq: line.seq, lines: [line], documents, deleteRuns: [] })
    );
    if (step !== 'intent') {
      const dir = join(target.root, 'runs', start.launch.run.id);
      await mkdir(dir);
      await writeFile(join(dir, 'log.jsonl'), `${JSON.stringify(line)}\n`);
    }
    if (step === 'request') {
      const path = Object.keys(documents).find(path => path.startsWith('resource/requests/'))!;
      await mkdir(join(target.root, 'resource/requests'), { recursive: true });
      await writeFile(join(target.root, path), JSON.stringify(documents[path]));
    }
    const recovered = await createFileWorkflowStore({ root: target.root });
    expect(await recovered.getResourceStartRequest(start.launch.run.id)).toMatchObject({
      status: 'admitted',
      runStatus: 'pending',
    });
    expect(
      (await readFile(join(target.root, 'runs', start.launch.run.id, 'log.jsonl'), 'utf8'))
        .trim()
        .split('\n')
    ).toHaveLength(1);
    expect(await recovered.admitResourceStart(intent())).toMatchObject({ status: 'queued' });
    expect(await recovered.claimPendingWorkflowRun(start.launch.run.id)).toMatchObject({
      status: 'running',
    });
  }
);

test('attempt holders are retained until their exact owner is provably gone', async () => {
  const { root, store } = await fixture();
  const first = intent();
  await store.admitResourceStart(first);
  await store.cancelWorkflowRun(first.launch.run.id);
  const path = join(root, 'resource/slots', (await readdir(join(root, 'resource/slots')))[0]!);
  const slot = JSON.parse(await readFile(path, 'utf8'));
  slot.holders = [{ kind: 'attempt', id: crypto.randomUUID(), owner: { ...currentProcessOwner } }];
  await writeFile(path, JSON.stringify(slot));
  const next = intent();
  expect(await store.admitResourceStart(next)).toMatchObject({ status: 'queued' });
  slot.queue = [next.launch.run.id];
  slot.holders[0].owner.pid = 2147483647;
  await writeFile(path, JSON.stringify(slot));
  expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toHaveLength(1);
});

test.each([-999999, 1.5])(
  'an attempt holder with pid %p fails admission instead of being released',
  async pid => {
    const { root, store } = await fixture();
    const first = intent();
    await store.admitResourceStart(first);
    await store.cancelWorkflowRun(first.launch.run.id);
    const path = join(root, 'resource/slots', (await readdir(join(root, 'resource/slots')))[0]!);
    const slot = JSON.parse(await readFile(path, 'utf8'));
    slot.holders = [
      { kind: 'attempt', id: crypto.randomUUID(), owner: { ...currentProcessOwner, pid } },
    ];
    const tampered = JSON.stringify(slot);
    await writeFile(path, tampered);
    const error = await store.admitResourceStart(intent()).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ProcessOwnerRecordError);
    expect((error as ProcessOwnerRecordError).source).toBe(path);
    expect(await readFile(path, 'utf8')).toBe(tampered);
  }
);

test('receipt-linked requests validate their binding and inspection follows every linked request', async () => {
  const { root, store } = await fixture();
  const first = intent();
  first.capacity = 2;
  const receiptId = crypto.randomUUID();
  first.receipt = { receiptId, bindingId: 'binding' };
  const before = await readFile(join(root, 'head.json'), 'utf8');
  await expect(store.admitResourceStart(first)).rejects.toThrow('receipt binding missing');
  expect(await readFile(join(root, 'head.json'), 'utf8')).toBe(before);
  expect(await store.getWorkflowRun(first.launch.run.id)).toBeNull();
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
        hostId: 'host',
        runAsUserId: 'operator',
        resource: 'resource',
        capacity: 2,
        overlap: 'queue',
        launch: { cwd: '/test', workflowName: 'test', inputs: {}, isolation: { kind: 'in-place' } },
      },
    ],
  });
  await store.admitResourceStart(first);
  const second = { ...intent(), capacity: 2, receipt: first.receipt };
  await store.admitResourceStart(second);
  const receipt = await store.getStartReceipt(receiptId);
  expect(receipt?.bindings.map(item => item.disposition?.requestId)).toEqual([
    first.launch.run.id,
    second.launch.run.id,
  ]);
  expect(receipt).not.toHaveProperty('createdAt');
  expect(receipt?.bindings[0]).not.toHaveProperty('requestIds');
  expect(await store.getResourceStartRequest(first.launch.run.id)).not.toHaveProperty('position');
});

test('admission cannot reuse a deleted run ID', async () => {
  const { store } = await fixture();
  const deleted = await store.createWorkflowRun({ workflow_name: 'test', user_message: '' });
  await store.cancelWorkflowRun(deleted.id);
  await store.deleteWorkflowRun(deleted.id);
  const start = intent();
  start.launch.run.id = deleted.id;
  await expect(store.admitResourceStart(start)).rejects.toThrow(
    `Run already exists: ${deleted.id}`
  );
  expect(await store.getWorkflowRun(deleted.id)).toBeNull();
});

// SQLite sorts text by code unit; localeCompare would put 'a' before 'B'.
test('admission listings order mixed-case keys by code unit', async () => {
  const { store } = await fixture();
  const receivedAt = '2026-01-01T00:00:00.000Z';
  const binding = (bindingId: string) => ({
    bindingId,
    bindingRevision: null,
    hostId: 'host',
    runAsUserId: 'operator',
    resource: 'resource',
    capacity: 1,
    overlap: 'queue' as const,
    launch: {
      cwd: '/test',
      workflowName: 'test',
      inputs: {},
      isolation: { kind: 'in-place' as const },
    },
  });
  const receiptIds = [
    'aaaaaaaa-0000-4000-8000-000000000000',
    'BBBBBBBB-0000-4000-8000-000000000000',
  ];
  for (const id of receiptIds)
    await store.acceptStartReceipt({
      receipt: {
        id,
        sourceInstanceId: 'source',
        deliveryId: null,
        contentDigest: 'digest',
        receivedAt,
        occurredAt: null,
        sourceActor: null,
      },
      outcome: 'matched',
      bindings: [binding('a'), binding('B')],
    });
  expect((await store.listStartReceipts()).map(row => row.id)).toEqual(receiptIds);
  expect((await store.getStartReceipt(receiptIds[0]))?.bindings.map(b => b.bindingId)).toEqual([
    'B',
    'a',
  ]);
  const pending = await store.listPendingStartBindings({ hostId: 'host' });
  expect(pending.filter(b => b.receiptId === receiptIds[0]).map(b => b.bindingId)).toEqual([
    'B',
    'a',
  ]);
  for (const resource of ['a', 'B'])
    for (let i = 0; i < 2; i++) {
      const start = intent();
      start.launch.execution.cwd = `/test/${resource}`;
      await store.admitResourceStart({ ...start, resource });
    }
  expect((await store.listQueuedResourceStartsForHost('host')).map(row => row.resource)).toEqual([
    'B',
    'a',
  ]);
});

for (const version of [1, 2] as const) {
  for (const guard of [undefined, false]) {
    test(`stored v${version} guard ${String(guard)} survives reopen and foreign-holder drain`, async () => {
      const { root, store } = await fixture();
      const capacity = intent().launch;
      capacity.execution.cwd = '/capacity';
      const queued = intent().launch;
      queued.run.origin = { conversationId: 'conversation', userId: 'operator' };
      const rootPath = queued.execution.cwd;
      const input = (launch: ResourceStartIntent['launch']) => ({ ...intent(), launch });
      queued.run.metadata = {
        source: { anchor: 'captured' },
        subrun_inputs: { name: 'value' },
        ...(guard === undefined ? {} : { admission_checkout_guard: guard }),
      };
      await store.admitResourceStart(input(capacity));
      expect(await store.admitResourceStart(input(queued))).toMatchObject({ status: 'queued' });
      const { origin, ...run } = queued.run;
      const stored =
        version === 2
          ? queued
          : {
              ...queued,
              version: 1,
              run: { ...run, conversation_id: origin?.conversationId, user_id: origin?.userId },
            };
      const directory = join(root, 'resource', 'requests');
      for (const name of await readdir(directory)) {
        const path = join(directory, name);
        const request = JSON.parse(await readFile(path, 'utf8'));
        if (request.id === queued.run.id)
          await writeFile(path, JSON.stringify({ ...request, launch: stored }));
      }
      const manual = await store.createWorkflowRun({ ...queued.run, id: crypto.randomUUID() });
      await store.claimPendingWorkflowRun(manual.id, rootPath);
      await store.cancelWorkflowRun(capacity.run.id);
      const reopened = await createFileWorkflowStore({ root });
      expect((await reopened.getResourceStartRequest(queued.run.id))?.launch).toEqual(queued);
      const drain = () =>
        reopened.drainResourceStarts({ resource: input(queued).resource, hostId: 'host' });
      if (guard === undefined) {
        expect(await drain()).toEqual([]);
        expect(await reopened.getWorkflowRun(queued.run.id)).toBeNull();
        await reopened.cancelWorkflowRun(manual.id);
      }
      expect(await drain()).toMatchObject([{ status: 'admitted', runId: queued.run.id }]);
      expect(await reopened.getWorkflowRun(queued.run.id)).toMatchObject({
        metadata: queued.run.metadata,
        origin: queued.run.origin,
      });
    });
  }
}
