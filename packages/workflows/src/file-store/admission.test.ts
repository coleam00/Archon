import { createHash } from 'node:crypto';
import { expect, spyOn, test } from 'bun:test';
import { ZodError } from 'zod';
import { mkdtemp, readdir, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join, win32, posix } from 'node:path';
import * as pathModule from 'node:path';
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

test.each(['none', 'id', 'launch-id'])(
  'receipt-linked inspection validates membership IDs (%s) without requiring launch origin',
  async damage => {
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
          launch: {
            cwd: '/test',
            workflowName: 'test',
            inputs: {},
            isolation: { kind: 'in-place' },
          },
        },
      ],
    });
    const owner = { ...first.receipt, ownerId: 'owner' };
    expect(await store.claimStartBindingPreparation(owner)).toBe(true);
    await store.completeStartBindingPreparation({ ...owner, launch: first.launch });
    const second = { ...intent(), capacity: 2 };
    second.launch.execution.cwd = '/second';
    await store.admitResourceStart(second);
    const firstPath = join(
      root,
      'resource/requests',
      `${createHash('sha256').update(first.launch.run.id).digest('hex')}.json`
    );
    const legacy = JSON.parse(await readFile(firstPath, 'utf8'));
    delete legacy.launch.run.metadata.resource_start;
    await writeFile(firstPath, JSON.stringify(legacy));
    if (damage !== 'none') {
      const path = join(
        root,
        'resource/requests',
        `${createHash('sha256').update(first.launch.run.id).digest('hex')}.json`
      );
      const row = JSON.parse(await readFile(path, 'utf8'));
      if (damage === 'id') row.id = crypto.randomUUID();
      else row.launch.run.id = crypto.randomUUID();
      const bytes = JSON.stringify(row);
      await writeFile(path, bytes);
      await expect(store.getStartReceipt(receiptId)).rejects.toThrow('inconsistent membership');
      expect(await readFile(path, 'utf8')).toBe(bytes);
      return;
    }
    const receipt = await store.getStartReceipt(receiptId);
    expect(receipt?.bindings.map(item => item.disposition?.requestId)).toEqual([
      first.launch.run.id,
    ]);
    expect(receipt).not.toHaveProperty('createdAt');
    expect(receipt?.bindings[0]).not.toHaveProperty('requestIds');
    expect(await store.getResourceStartRequest(first.launch.run.id)).not.toHaveProperty('position');
    const queued = { ...intent(), capacity: 2 };
    expect(await store.admitResourceStart(queued)).toMatchObject({ status: 'queued' });
    await store.cancelWorkflowRun(first.launch.run.id);
    expect(await store.listQueuedResourceStartsForHost('host')).toMatchObject([
      { id: queued.launch.run.id, status: 'queued' },
    ]);
    expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toMatchObject(
      [{ requestId: queued.launch.run.id, status: 'admitted' }]
    );
  }
);

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

test('a persisted malformed guard stays inspectable without stalling independent queued work', async () => {
  const { root, store } = await fixture();
  const holder = intent(),
    malformed = intent(),
    independent = intent();
  independent.launch.execution.cwd = '/independent';
  await store.admitResourceStart(holder);
  await store.admitResourceStart(malformed);
  await store.admitResourceStart(independent);
  const id = malformed.launch.run.id;
  const path = join(
    root,
    'resource/requests',
    `${createHash('sha256').update(id).digest('hex')}.json`
  );
  const row = JSON.parse(await readFile(path, 'utf8'));
  row.launch.run.metadata.admission_checkout_guard = 'false';
  await writeFile(path, JSON.stringify(row));
  await store.cancelWorkflowRun(holder.launch.run.id);
  expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toMatchObject([
    { runId: independent.launch.run.id },
  ]);
  expect(await store.getResourceStartRequest(id)).toMatchObject({
    status: 'queued',
    launch: { run: { metadata: { admission_checkout_guard: 'false' } } },
  });
  expect(await store.getWorkflowRun(id)).toBeNull();
  expect(await store.withdrawQueuedResourceStart(id)).toMatchObject({ run: { id } });
});

async function finishRun(root: string, id: string): Promise<void> {
  await commitModule.commit(root, [id], async runs => {
    const run = runs.get(id)!;
    run.status = 'completed';
    return { result: undefined, changes: { runs: [{ run }] } };
  });
}

async function corruptRequest(
  root: string,
  id: string,
  corruption: 'launch' | 'json' | 'null' | 'queued' | 'skipped' | 'withdrawn' | 'missing'
): Promise<void> {
  const path = join(
    root,
    'resource/requests',
    `${createHash('sha256').update(id).digest('hex')}.json`
  );
  if (corruption === 'missing') {
    await unlink(path);
    return;
  }
  const row = JSON.parse(await readFile(path, 'utf8'));
  const value = corruption === 'launch' ? { ...row, launch: {} } : { ...row, status: corruption };
  await writeFile(
    path,
    corruption === 'json' ? '{' : JSON.stringify(corruption === 'null' ? null : value)
  );
}

for (const corruption of ['launch', 'json', 'missing'] as const) {
  for (const status of [
    'pending',
    'expired-pending',
    'running',
    'paused',
    'completed',
    'failed',
    'cancelled',
  ] as const) {
    test(`foreign request ${corruption} corruption respects ${status} checkout occupancy`, async () => {
      const { root, store } = await fixture();
      const foreign = intent();
      foreign.resource = 'foreign';
      foreign.hostId = 'foreign-host';
      await store.admitResourceStart(foreign);
      const id = foreign.launch.run.id;
      const active = status === 'pending' || status === 'running' || status === 'paused';
      await commitModule.commit(root, [id], async runs => {
        const run = runs.get(id)!;
        run.status = status === 'expired-pending' ? 'pending' : status;
        run.started_at = new Date(Date.now() - (status === 'expired-pending' ? 600_000 : 0));
        run.working_path = '/test';
        return { result: undefined, changes: { runs: [{ run }] } };
      });
      await corruptRequest(root, id, corruption);
      const blocked = intent();
      expect(await store.admitResourceStart(blocked)).toMatchObject(
        active ? { status: 'queued', blocker: { kind: 'run', id } } : { status: 'admitted' }
      );
      if (active) {
        const skipped = { ...intent(), resource: 'skip', overlap: 'skip' as const };
        expect(await store.admitResourceStart(skipped)).toMatchObject({
          status: 'skipped',
          blocker: { kind: 'run', id },
        });
      }
      for (const kind of ['guarded', 'read-only', 'branchless'] as const) {
        const independent = intent();
        independent.resource = kind;
        if (kind === 'guarded') independent.launch.execution.cwd = '/independent';
        if (kind === 'read-only') independent.launch.run.metadata.admission_checkout_guard = false;
        if (kind === 'branchless') independent.launch.execution.isolation = { kind: 'worktree' };
        expect(await store.admitResourceStart(independent)).toMatchObject({ status: 'admitted' });
        await finishRun(root, independent.launch.run.id);
      }
      if (!active) await finishRun(root, blocked.launch.run.id);
      const aliasStore = await createFileWorkflowStore({
        root,
        listReusableCheckouts: async () => [
          { codebaseId: 'codebase', branch: 'alias', workingPath: '/test' },
        ],
      });
      const alias = { ...intent(), resource: 'alias' };
      alias.launch.execution.isolation = { kind: 'worktree', branch: 'alias' };
      expect(await aliasStore.admitResourceStart(alias)).toMatchObject(
        active ? { status: 'queued', blocker: { kind: 'run', id } } : { status: 'admitted' }
      );
      expect((await store.listQueuedResourceStartsForHost('host')).map(row => row.id)).toEqual(
        active ? [alias.launch.run.id, blocked.launch.run.id] : []
      );
      if (active) {
        expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toEqual(
          []
        );
        await finishRun(root, id);
        expect((await store.listQueuedResourceStartsForHost('host')).map(row => row.id)).toContain(
          blocked.launch.run.id
        );
        expect(
          await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })
        ).toMatchObject([{ runId: blocked.launch.run.id }]);
      }
    });
  }
}

test.each(['launch', 'json', 'null', 'queued', 'skipped', 'withdrawn', 'missing'] as const)(
  'an unknown corrupt foreign checkout (%s) permits independent work but blocks guarded starts',
  async corruption => {
    const { root, store } = await fixture();
    const foreign = { ...intent(), resource: 'foreign' };
    const local = intent();
    local.launch.execution.cwd = '/local';
    await store.admitResourceStart(foreign);
    await store.admitResourceStart(local);
    const queued = [intent(), intent(), intent()];
    queued[1]!.launch.run.metadata.admission_checkout_guard = false;
    queued[2]!.launch.execution.isolation = { kind: 'worktree' };
    for (const start of queued) await store.admitResourceStart(start);
    const id = foreign.launch.run.id;
    await corruptRequest(root, id, corruption);
    for (const isolation of [
      { kind: 'in-place' },
      { kind: 'worktree', branch: 'explicit' },
    ] as const) {
      for (const overlap of ['queue', 'skip'] as const) {
        const start = { ...intent(), resource: crypto.randomUUID(), overlap };
        start.launch.execution.isolation = isolation;
        expect(await store.admitResourceStart(start)).toMatchObject({
          status: overlap === 'queue' ? 'queued' : 'skipped',
          blocker: { kind: 'run', id },
        });
      }
    }
    for (const template of queued.slice(1)) {
      const start = {
        ...template,
        resource: crypto.randomUUID(),
        launch: { ...template.launch, run: { ...template.launch.run, id: crypto.randomUUID() } },
      };
      expect(await store.admitResourceStart(start)).toMatchObject({ status: 'admitted' });
      await finishRun(root, start.launch.run.id);
    }
    for (const status of ['failed', 'paused'] as const) {
      await commitModule.commit(root, [local.launch.run.id], async runs => {
        const run = runs.get(local.launch.run.id)!;
        run.status = status;
        return { result: undefined, changes: { runs: [{ run }] } };
      });
      if (status === 'failed')
        await expect(store.resumeWorkflowRun(local.launch.run.id)).rejects.toBeInstanceOf(
          WorkflowResourceBusyError
        );
      else expect((await store.resumeWorkflowRun(local.launch.run.id)).status).toBe('running');
    }
    await finishRun(root, local.launch.run.id);
    for (const start of queued.slice(1)) {
      expect(
        await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })
      ).toMatchObject([{ runId: start.launch.run.id }]);
      await finishRun(root, start.launch.run.id);
    }
    expect(await store.getWorkflowRun(queued[0]!.launch.run.id)).toBeNull();
    expect((await store.getWorkflowRun(id))?.status).toBe('pending');
    await expect(store.admitResourceStart({ ...intent(), resource: 'foreign' })).rejects.toThrow();
    await expect(
      store.drainResourceStarts({ resource: 'foreign', hostId: 'host' })
    ).rejects.toThrow();
    await finishRun(root, id);
    expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toMatchObject(
      [{ runId: queued[0]!.launch.run.id }]
    );
  }
);

test.each([
  'id',
  'resource',
  'resource-mismatch',
  'id-mismatch',
  'launch-id-mismatch',
  'status-admitted',
  'status-skipped',
  'status-withdrawn',
  'overlap',
  'blocker',
  'launch',
  'position',
] as const)(
  'host listing isolates a selected request with corrupt %s and drains an independent resource',
  async field => {
    const { root, store } = await fixture();
    const holder = intent(),
      queued = intent();
    const otherHolder = intent(),
      corrupt = intent();
    for (const start of [otherHolder, corrupt]) {
      start.resource = 'other';
      start.launch.execution.cwd = '/other';
    }
    await store.admitResourceStart(holder);
    await store.admitResourceStart(queued);
    await store.admitResourceStart(otherHolder);
    await store.admitResourceStart(corrupt);
    const path = join(
      'resource/requests',
      `${createHash('sha256').update(corrupt.launch.run.id).digest('hex')}.json`
    );
    const target = join(root, path);
    const row = JSON.parse(await readFile(target, 'utf8'));
    const intact = structuredClone(row);
    const relationshipMismatch = field.endsWith('-mismatch') || field.startsWith('status-');
    if (field === 'resource-mismatch') row.resource = 'wrong-resource';
    else if (field === 'id-mismatch') row.id = crypto.randomUUID();
    else if (field === 'launch-id-mismatch') row.launch.run.id = crypto.randomUUID();
    else if (field.startsWith('status-')) row.status = field.slice('status-'.length);
    else row[field] = field === 'blocker' ? {} : null;
    const damaged = JSON.stringify(row);
    await writeFile(target, damaged);
    const listedBefore = await store.listQueuedResourceStartsForHost('host');
    const damagedEntry = listedBefore.find(row => row.id === corrupt.launch.run.id);
    expect(damagedEntry).toBeDefined();
    if (!damagedEntry || !('error' in damagedEntry)) throw new Error('expected listing failure');
    expect(damagedEntry.error).toBeInstanceOf(Error);
    await finishRun(root, holder.launch.run.id);
    const listed = await store.listQueuedResourceStartsForHost('host');
    const healthy = listed.flatMap(row => ('error' in row ? [] : [row]));
    expect(healthy.map(row => row.id)).toEqual([queued.launch.run.id]);
    for (const resource of new Set(healthy.map(row => row.resource))) {
      expect(await store.drainResourceStarts({ resource, hostId: 'host' })).toMatchObject([
        { status: 'admitted', runId: queued.launch.run.id },
      ]);
    }
    expect(await readFile(target, 'utf8')).toBe(damaged);
    expect(await store.getWorkflowRun(corrupt.launch.run.id)).toBeNull();
    expect(await store.getWorkflowRun(otherHolder.launch.run.id)).toMatchObject({
      status: 'pending',
    });
    if (!relationshipMismatch)
      await expect(store.getResourceStartRequest(corrupt.launch.run.id)).rejects.toThrow();
    expect(await store.drainResourceStarts({ resource: 'other', hostId: 'host' })).toEqual([]);
    if (relationshipMismatch) {
      await expect(store.admitResourceStart({ ...intent(), resource: 'other' })).rejects.toThrow(
        'Queued resource request'
      );
      await store.claimPendingWorkflowRun(otherHolder.launch.run.id, '/other');
      await store.pauseWorkflowRunForWait(
        otherHolder.launch.run.id,
        {
          owner: 'node',
          nodeId: 'wait',
          kind: 'time',
          waitingSince: '2026-01-01T00:00:00.000Z',
          resumeAt: '2026-01-02T00:00:00.000Z',
        },
        { kind: 'started', stepName: 'wait' }
      );
      await expect(store.resumeWorkflowRun(otherHolder.launch.run.id)).rejects.toThrow(
        'Queued resource request'
      );
      await writeFile(target, JSON.stringify(intact));
      await finishRun(root, otherHolder.launch.run.id);
      expect(await store.drainResourceStarts({ resource: 'other', hostId: 'host' })).toMatchObject([
        { status: 'admitted', runId: corrupt.launch.run.id },
      ]);
    }
  }
);

const occupancyUnrelatedFields = ['hostId', 'id', 'overlap', 'blocker', 'position'] as const;

function damagedHolderRequest(intact: Record<string, unknown>, corruption: string): string {
  const row = structuredClone(intact);
  for (const field of occupancyUnrelatedFields) {
    if (corruption === `missing-${field}`) delete row[field];
    if (corruption === `invalid-${field}`) row[field] = {};
  }
  if (corruption === 'missing-resource') delete row.resource;
  if (corruption === 'invalid-resource') row.resource = 42;
  if (corruption === 'resource-mismatch') row.resource = 'wrong-resource';
  if (corruption === 'missing-status') delete row.status;
  if (corruption === 'invalid-status') row.status = 'unsupported';
  return corruption === 'json' ? '{' : JSON.stringify(corruption === 'null' ? null : row);
}

async function releasedHolderFixture(
  membership: 'retained' | 'upgrade-before-release' | 'released-before-upgrade',
  corruption: string
) {
  const { root, store: originalStore } = await fixture();
  let store = originalStore;
  const holder = intent();
  const queued = intent();
  queued.launch.run.metadata.admission_checkout_guard = false;
  const resuming = intent();
  resuming.launch.execution.cwd = '/resuming';
  resuming.launch.run.metadata.admission_checkout_guard = false;
  await store.admitResourceStart(holder);
  await store.admitResourceStart(queued);
  await store.claimPendingWorkflowRun(holder.launch.run.id, '/test');
  const wait = {
    owner: 'node' as const,
    nodeId: 'wait',
    kind: 'time' as const,
    waitingSince: '2026-01-01T00:00:00.000Z',
    resumeAt: '2026-01-02T00:00:00.000Z',
  };
  await store.pauseWorkflowRunForWait(holder.launch.run.id, wait, {
    kind: 'started',
    stepName: 'wait',
  });
  const slotPath = join(
    root,
    'resource/slots',
    `${createHash('sha256').update(holder.resource).digest('hex')}.json`
  );
  if (membership === 'upgrade-before-release') {
    const shippedSlot = JSON.parse(await readFile(slotPath, 'utf8'));
    delete shippedSlot.admitted;
    await writeFile(slotPath, JSON.stringify(shippedSlot));
  }
  const cursor = { kind: 'wait' as const, nodeId: wait.nodeId, resumeAt: wait.resumeAt };
  expect(await store.releasePausedRunSlot(holder.launch.run.id, cursor)).toEqual({
    released: true,
  });
  await store.admitResourceStart(resuming);
  await store.claimPendingWorkflowRun(resuming.launch.run.id, '/resuming');
  await store.pauseWorkflowRunForWait(resuming.launch.run.id, wait, {
    kind: 'started',
    stepName: 'wait',
  });
  await store.releasePausedRunSlot(resuming.launch.run.id, cursor);
  if (membership === 'released-before-upgrade') {
    const shippedSlot = JSON.parse(await readFile(slotPath, 'utf8'));
    delete shippedSlot.admitted;
    await writeFile(slotPath, JSON.stringify(shippedSlot));
  }
  const path = join(
    root,
    'resource/requests',
    `${createHash('sha256').update(holder.launch.run.id).digest('hex')}.json`
  );
  const intact = JSON.parse(await readFile(path, 'utf8'));
  const damaged = damagedHolderRequest(intact, corruption);
  await writeFile(path, damaged);
  store = await createFileWorkflowStore({ root });
  const unknownMembership = membership === 'released-before-upgrade';
  const readable =
    corruption === 'intact' ||
    corruption === 'resource-mismatch' ||
    occupancyUnrelatedFields.some(field =>
      [`missing-${field}`, `invalid-${field}`].includes(corruption)
    );
  const serializes = corruption === 'intact' || (unknownMembership && readable);
  return {
    root,
    store,
    holder,
    queued,
    resuming,
    wait,
    cursor,
    slotPath,
    path,
    damaged,
    intact,
    unknownMembership,
    readable,
    serializes,
    corruption,
  };
}

type ReleasedHolderFixture = Awaited<ReturnType<typeof releasedHolderFixture>>;

async function checkLocalHolderDecisions(context: ReleasedHolderFixture) {
  const {
    root,
    store,
    holder,
    queued,
    resuming,
    wait,
    cursor,
    path,
    damaged,
    unknownMembership,
    serializes,
    corruption,
  } = context;
  let head = await readFile(join(root, 'head.json'), 'utf8');
  for (const overlap of ['queue', 'skip'] as const) {
    const next = { ...intent(), overlap };
    next.launch.run.metadata.admission_checkout_guard = false;
    if (serializes)
      expect(await store.admitResourceStart(next)).toMatchObject({
        status: overlap === 'queue' ? 'queued' : 'skipped',
        blocker: { kind: 'run', id: holder.launch.run.id },
      });
    else await expect(store.admitResourceStart(next)).rejects.toThrow();
    if (serializes) head = await readFile(join(root, 'head.json'), 'utf8');
    expect(await store.getWorkflowRun(next.launch.run.id)).toBeNull();
  }
  if (serializes)
    expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toEqual([]);
  else
    await expect(
      store.drainResourceStarts({ resource: 'resource', hostId: 'host' })
    ).rejects.toThrow();
  if (corruption === 'intact' || (unknownMembership && context.readable)) {
    await store.resumeWorkflowRun(resuming.launch.run.id);
    await store.pauseWorkflowRunForWait(resuming.launch.run.id, wait, {
      kind: 'started',
      stepName: 'wait',
    });
    await store.releasePausedRunSlot(resuming.launch.run.id, cursor);
    head = await readFile(join(root, 'head.json'), 'utf8');
  } else {
    await expect(store.resumeWorkflowRun(resuming.launch.run.id)).rejects.toThrow();
    await expect(store.resumeWorkflowRun(holder.launch.run.id)).rejects.toThrow();
  }
  expect(await store.getWorkflowRun(queued.launch.run.id)).toBeNull();
  expect((await store.getWorkflowRun(holder.launch.run.id))?.status).toBe('paused');
  expect((await store.getWorkflowRun(resuming.launch.run.id))?.status).toBe('paused');
  expect(await readFile(path, 'utf8')).toBe(damaged);
  expect(await readFile(join(root, 'head.json'), 'utf8')).toBe(head);
}

async function checkForeignHolderDecisions(context: ReleasedHolderFixture) {
  const { root, store, holder, unknownMembership, readable } = context;
  for (const resource of ['wrong-resource', 'foreign-reader']) {
    const foreignReader = { ...intent(), resource };
    foreignReader.launch.run.metadata.admission_checkout_guard = false;
    if (unknownMembership) {
      if (readable)
        expect(await store.admitResourceStart(foreignReader)).toMatchObject({
          status: 'queued',
          blocker: { kind: 'run', id: holder.launch.run.id },
        });
      else await expect(store.admitResourceStart(foreignReader)).rejects.toThrow();
    } else {
      expect(await store.admitResourceStart(foreignReader)).toMatchObject({ status: 'admitted' });
      await finishRun(root, foreignReader.launch.run.id);
    }
  }
}

test.each(
  (['retained', 'upgrade-before-release', 'released-before-upgrade'] as const).flatMap(membership =>
    [
      'intact',
      'json',
      'null',
      'missing-resource',
      'invalid-resource',
      'resource-mismatch',
      'missing-status',
      'invalid-status',
      ...occupancyUnrelatedFields.flatMap(field => [`missing-${field}`, `invalid-${field}`]),
    ].map(corruption => ({ membership, corruption }))
  )
)(
  '$membership paused holder with request $corruption preserves checkout ownership',
  async ({ membership, corruption }) => {
    const context = await releasedHolderFixture(membership, corruption);
    await checkLocalHolderDecisions(context);
    await checkForeignHolderDecisions(context);
    const { root, store, holder, queued, wait, cursor, path } = context;
    if (context.unknownMembership && context.readable) {
      const independent = { ...intent(), resource: 'independent' };
      independent.launch.execution.cwd = '/independent';
      const independentQueued = {
        ...independent,
        launch: {
          ...independent.launch,
          run: { ...independent.launch.run, id: crypto.randomUUID() },
        },
      };
      expect(await store.admitResourceStart(independent)).toMatchObject({ status: 'admitted' });
      expect(await store.admitResourceStart(independentQueued)).toMatchObject({ status: 'queued' });
      await finishRun(root, independent.launch.run.id);
      expect(
        await store.drainResourceStarts({ resource: 'independent', hostId: 'host' })
      ).toMatchObject([{ runId: independentQueued.launch.run.id }]);
      await finishRun(root, independentQueued.launch.run.id);
    }
    await writeFile(path, JSON.stringify(context.intact));
    if (membership === 'released-before-upgrade') {
      expect(await store.resumeWorkflowRun(holder.launch.run.id)).toMatchObject({
        status: 'running',
      });
      await store.pauseWorkflowRunForWait(holder.launch.run.id, wait, {
        kind: 'started',
        stepName: 'wait',
      });
      await store.releasePausedRunSlot(holder.launch.run.id, cursor);
    }
    expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toEqual([]);
    await finishRun(root, holder.launch.run.id);
    expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toMatchObject(
      [{ runId: queued.launch.run.id }]
    );
  }
);

test('a paused manual holder permits a foreign reader beside an old released slot', async () => {
  const { store, slotPath, wait } = await releasedHolderFixture(
    'released-before-upgrade',
    'intact'
  );
  const manual = await store.createWorkflowRun(intent().launch.run);
  await store.claimPendingWorkflowRun(manual.id, '/manual');
  await store.pauseWorkflowRunForWait(manual.id, wait, { kind: 'started', stepName: 'wait' });
  const reader = { ...intent(), resource: 'manual-reader' };
  reader.launch.execution.cwd = '/manual';
  reader.launch.run.metadata.admission_checkout_guard = false;
  const slotBefore = await readFile(slotPath, 'utf8');
  expect(await store.admitResourceStart(reader)).toMatchObject({ status: 'admitted' });
  expect(await readFile(slotPath, 'utf8')).toBe(slotBefore);
  expect(await store.getWorkflowRun(manual.id)).toMatchObject({
    status: 'paused',
    metadata: { wait },
  });
});

const queuedCorruptions = [
  'json',
  'null',
  'missing-host',
  'invalid-host',
  'missing-status',
  'invalid-status',
  'missing-request',
  'slot-json',
  'slot-null',
  'slot-queue',
  'launch',
] as const;
async function corruptQueuedDocument(
  root: string,
  id: string,
  corruption: (typeof queuedCorruptions)[number]
): Promise<string> {
  const slot = corruption.startsWith('slot-');
  const key = slot ? 'foreign' : id;
  const path = posix.join(
    'resource',
    slot ? 'slots' : 'requests',
    `${createHash('sha256').update(key).digest('hex')}.json`
  );
  const target = join(root, path);
  const row = JSON.parse(await readFile(target, 'utf8'));
  switch (corruption) {
    case 'missing-request':
      await unlink(target);
      return path;
    case 'json':
    case 'slot-json':
      await writeFile(target, '{');
      return path;
    case 'null':
    case 'slot-null':
      await writeFile(target, 'null');
      return path;
    case 'missing-host':
      delete row.hostId;
      break;
    case 'invalid-host':
      row.hostId = 42;
      break;
    case 'missing-status':
      delete row.status;
      break;
    case 'invalid-status':
      row.status = 'unsupported';
      break;
    case 'slot-queue':
      row.queue = 42;
      break;
    case 'launch':
      row.launch = {};
      break;
  }
  await writeFile(target, JSON.stringify(row));
  return path;
}

for (const corruption of queuedCorruptions) {
  test(`host listing and drain isolate another host's queued ${corruption} corruption`, async () => {
    const { root, store } = await fixture();
    const holder = intent(),
      queued = intent();
    const foreignHolder = intent(),
      foreignQueued = intent();
    for (const start of [foreignHolder, foreignQueued]) {
      start.resource = 'foreign';
      start.hostId = 'foreign-host';
      start.launch.execution.cwd = '/foreign';
    }
    await store.admitResourceStart(holder);
    await store.admitResourceStart(queued);
    await store.admitResourceStart(foreignHolder);
    await store.admitResourceStart(foreignQueued);
    const path = await corruptQueuedDocument(root, foreignQueued.launch.run.id, corruption);
    const unclassified = !['launch', 'missing-status', 'invalid-status'].includes(corruption);
    const checkListing = async () => {
      const listed = await store.listQueuedResourceStartsForHost('host');
      expect(listed.filter(row => !('error' in row)).map(row => row.id)).toEqual([
        queued.launch.run.id,
      ]);
      const failures = listed.filter(row => 'error' in row);
      expect(failures).toHaveLength(unclassified ? 1 : 0);
      if (unclassified) {
        expect(failures[0]?.error).toBeInstanceOf(Error);
        expect(failures[0]?.resource).toBeUndefined();
        const failure = failures[0]!;
        if (!('error' in failure) || !(failure.error instanceof Error))
          throw new Error('expected listing failure');
        expect(failure.error.message).toContain(path);
        expect(failure.error.cause).toBeInstanceOf(Error);
      }
      return listed;
    };
    await checkListing();
    await finishRun(root, holder.launch.run.id);
    const listed = await checkListing();
    for (const resource of new Set(
      listed.flatMap(row => ('error' in row ? [] : [row])).map(row => row.resource)
    )) {
      expect(await store.drainResourceStarts({ resource, hostId: 'host' })).toMatchObject([
        { status: 'admitted', runId: queued.launch.run.id },
      ]);
    }
    expect(await store.listQueuedResourceStartsForHost('foreign-host')).toMatchObject([
      { error: expect.any(Error) },
    ]);
    expect(await store.getWorkflowRun(foreignQueued.launch.run.id)).toBeNull();
    expect(await store.getWorkflowRun(foreignHolder.launch.run.id)).toMatchObject({
      status: 'pending',
    });
    if (corruption.startsWith('slot-'))
      await expect(
        store.drainResourceStarts({ resource: 'foreign', hostId: 'foreign-host' })
      ).rejects.toThrow();
    else
      expect(
        await store.drainResourceStarts({ resource: 'foreign', hostId: 'foreign-host' })
      ).toEqual([]);
  });
}

test.each(['posix', 'win32'] as const)(
  'host listing uses canonical membership keys under %s paths',
  async platform => {
    const { root, store } = await fixture();
    const holder = intent(),
      queued = intent();
    await store.admitResourceStart(holder);
    await store.admitResourceStart(queued);
    const nativeJoin = pathModule.join;
    const relativeJoin = platform === 'win32' ? win32.join : posix.join;
    const paths = spyOn(pathModule, 'join').mockImplementation((...parts: string[]) =>
      parts[0] === 'resource' ? relativeJoin(...parts) : nativeJoin(...parts)
    );
    try {
      expect((await store.listQueuedResourceStartsForHost('host')).map(row => row.id)).toEqual([
        queued.launch.run.id,
      ]);
      const target = nativeJoin(
        root,
        'resource/requests',
        `${createHash('sha256').update(queued.launch.run.id).digest('hex')}.json`
      );
      const row = JSON.parse(await readFile(target, 'utf8'));
      await writeFile(target, JSON.stringify({ ...row, resource: 'wrong-resource' }));
      expect(await store.listQueuedResourceStartsForHost('host')).toMatchObject([
        { id: queued.launch.run.id, resource: undefined, error: expect.any(Error) },
      ]);
    } finally {
      paths.mockRestore();
    }
  }
);

test('an old released holder without admission evidence keeps manual read-only concurrency', async () => {
  const { root, store, holder, queued, path } = await releasedHolderFixture(
    'released-before-upgrade',
    'intact'
  );
  await unlink(path);
  expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toMatchObject([
    { runId: queued.launch.run.id },
  ]);
  await finishRun(root, queued.launch.run.id);
  for (const overlap of ['queue', 'skip'] as const) {
    const start = { ...intent(), overlap, resource: crypto.randomUUID() };
    expect(await store.admitResourceStart(start)).toMatchObject({
      status: overlap === 'queue' ? 'queued' : 'skipped',
      blocker: { kind: 'run', id: holder.launch.run.id },
    });
  }
  const reader = intent();
  reader.launch.run.metadata.admission_checkout_guard = false;
  expect(await store.admitResourceStart(reader)).toMatchObject({ status: 'admitted' });
  expect((await store.getWorkflowRun(holder.launch.run.id))?.status).toBe('paused');
});

test.each([
  undefined,
  null,
  {},
  { ...currentProcessOwner, host: 1 },
  { ...currentProcessOwner, pid: 0 },
  { ...currentProcessOwner, pid: -1 },
  { ...currentProcessOwner, pid: 1.5 },
  { ...currentProcessOwner, pid: Number.MAX_SAFE_INTEGER + 1 },
  { ...currentProcessOwner, instance: null },
])(
  'foreign membership ignores malformed attempt owner %j for admission, drain and resume',
  async owner => {
    const { root, store } = await fixture();
    const foreign = intent();
    foreign.resource = 'foreign';
    foreign.launch.execution.cwd = '/foreign';
    const holder = intent();
    const queued = intent();
    const resuming = intent();
    resuming.resource = 'resume';
    resuming.launch.execution.cwd = '/resume';
    for (const start of [foreign, holder, queued, resuming]) await store.admitResourceStart(start);
    const guarded = { ...intent(), resource: 'guarded' };
    guarded.launch.execution.cwd = '/foreign';
    expect(await store.admitResourceStart(guarded)).toMatchObject({ status: 'queued' });
    await finishRun(root, holder.launch.run.id);
    await store.updateWorkflowRun(resuming.launch.run.id, { status: 'paused' });
    await store.updateWorkflowRun(foreign.launch.run.id, { status: 'paused' });
    const path = join(
      root,
      'resource/slots',
      `${createHash('sha256').update('foreign').digest('hex')}.json`
    );
    const slot = JSON.parse(await readFile(path, 'utf8'));
    slot.holders.push({ kind: 'attempt', id: 'damaged-attempt', owner });
    const damaged = JSON.stringify(slot);
    await writeFile(path, damaged);
    const incoming = intent();
    incoming.resource = 'incoming';
    incoming.launch.execution.cwd = '/incoming';
    expect(await store.admitResourceStart(incoming)).toMatchObject({ status: 'admitted' });
    expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toMatchObject(
      [{ runId: queued.launch.run.id }]
    );
    expect(await store.resumeWorkflowRun(resuming.launch.run.id)).toMatchObject({
      status: 'running',
    });
    await store.updateWorkflowRun(resuming.launch.run.id, { status: 'paused' });
    slot.admitted.push(resuming.launch.run.id);
    await writeFile(path, JSON.stringify(slot));
    await expect(store.resumeWorkflowRun(resuming.launch.run.id)).rejects.toThrow(
      `Admitted resource request '${resuming.launch.run.id}' disagrees with its slot membership`
    );
    await writeFile(path, damaged);
    await expect(
      store.admitResourceStart({ ...intent(), resource: 'foreign' })
    ).rejects.toBeInstanceOf(ProcessOwnerRecordError);
    await expect(
      store.drainResourceStarts({ resource: 'foreign', hostId: 'host' })
    ).rejects.toBeInstanceOf(ProcessOwnerRecordError);
    await expect(store.resumeWorkflowRun(foreign.launch.run.id)).rejects.toBeInstanceOf(
      ProcessOwnerRecordError
    );
    expect(await readFile(path, 'utf8')).toBe(damaged);
    await corruptRequest(root, foreign.launch.run.id, 'missing');
    for (const overlap of ['queue', 'skip'] as const) {
      const start = { ...intent(), resource: crypto.randomUUID(), overlap };
      start.launch.execution.cwd = '/foreign';
      expect(await store.admitResourceStart(start)).toMatchObject({
        status: overlap === 'queue' ? 'queued' : 'skipped',
        blocker: { kind: 'run', id: foreign.launch.run.id },
      });
    }
    expect(await store.drainResourceStarts({ resource: 'guarded', hostId: 'host' })).toEqual([]);
    expect((await store.getWorkflowRun(foreign.launch.run.id))?.status).toBe('paused');
    await finishRun(root, foreign.launch.run.id);
    expect(await store.drainResourceStarts({ resource: 'guarded', hostId: 'host' })).toMatchObject([
      { runId: guarded.launch.run.id },
    ]);
  }
);

test.each(['paused', 'failed'] as const)(
  'an intact pre-upgrade released %s run resumes without slot repair',
  async status => {
    const { root, store, holder, queued } = await releasedHolderFixture(
      'released-before-upgrade',
      'intact'
    );
    if (status === 'failed') {
      await commitModule.commit(root, [holder.launch.run.id], async runs => {
        const run = runs.get(holder.launch.run.id)!;
        return { result: undefined, changes: { runs: [{ run: { ...run, status: 'failed' } }] } };
      });
      await expect(store.resumeWorkflowRun(holder.launch.run.id)).rejects.toBeInstanceOf(
        WorkflowResourceBusyError
      );
      await store.withdrawQueuedResourceStart(queued.launch.run.id);
    }
    expect(await store.resumeWorkflowRun(holder.launch.run.id)).toMatchObject({
      status: 'running',
    });
  }
);

test.each(
  (['first', 'repeated', 'before retry'] as const).flatMap(refusal =>
    (['admission', 'drain', 'paused resume', 'failed resume'] as const).map(operation => ({
      refusal,
      operation,
    }))
  )
)(
  'historical continuation with $refusal refusal keeps priority over $operation',
  async ({ refusal, operation }) => {
    const { root, store, holder, queued, resuming } = await releasedHolderFixture(
      'released-before-upgrade',
      'intact'
    );
    await store.withdrawQueuedResourceStart(queued.launch.run.id);
    const occupant = intent();
    occupant.launch.execution.cwd = '/occupant';
    expect(await store.admitResourceStart(occupant)).toMatchObject({ status: 'admitted' });
    const existingWait = { since: '2026-01-02T00:00:00.000Z' };
    if (refusal !== 'first') {
      await store.updateWorkflowRun(holder.launch.run.id, {
        metadata: { capacity_wait: existingWait },
      });
    }
    if (refusal !== 'before retry')
      await expect(store.resumeWorkflowRun(holder.launch.run.id)).rejects.toMatchObject({
        blocker: { kind: 'run', id: occupant.launch.run.id },
        refusal: 'waiting',
      });
    if (refusal !== 'first')
      expect((await store.getWorkflowRun(holder.launch.run.id))?.metadata.capacity_wait).toEqual(
        existingWait
      );
    const incoming = intent();
    incoming.launch.execution.cwd = '/incoming';
    if (operation === 'drain')
      expect(await store.admitResourceStart(incoming)).toMatchObject({ status: 'queued' });
    if (operation === 'failed resume') {
      await commitModule.commit(root, [resuming.launch.run.id], async runs => ({
        result: undefined,
        changes: { runs: [{ run: { ...runs.get(resuming.launch.run.id)!, status: 'failed' } }] },
      }));
    }
    await finishRun(root, occupant.launch.run.id);
    if (operation === 'admission')
      expect(await store.admitResourceStart(incoming)).toMatchObject({
        status: 'queued',
        blocker: { kind: 'run', id: holder.launch.run.id },
      });
    else if (operation === 'drain')
      expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toEqual([]);
    else
      await expect(store.resumeWorkflowRun(resuming.launch.run.id)).rejects.toMatchObject({
        blocker: { kind: 'run', id: holder.launch.run.id },
      });
    expect(await store.resumeWorkflowRun(holder.launch.run.id)).toMatchObject({
      status: 'running',
    });
    await finishRun(root, holder.launch.run.id);
    if (operation === 'admission' || operation === 'drain')
      expect(
        await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })
      ).toMatchObject([{ runId: incoming.launch.run.id }]);
    else
      expect(await store.resumeWorkflowRun(resuming.launch.run.id)).toMatchObject({
        status: 'running',
      });
  }
);

test.each(['document', 'launch', 'both'] as const)(
  'pre-retry admission rejects a historical waiter with mismatched %s identity',
  async damage => {
    const { root, store, holder, queued, path, intact } = await releasedHolderFixture(
      'released-before-upgrade',
      'intact'
    );
    await store.withdrawQueuedResourceStart(queued.launch.run.id);
    await store.updateWorkflowRun(holder.launch.run.id, {
      metadata: { capacity_wait: { since: '2026-01-02T00:00:00.000Z' } },
    });
    const damaged = structuredClone(intact);
    if (damage !== 'launch') damaged.id = crypto.randomUUID();
    if (damage !== 'document') damaged.launch.run.id = crypto.randomUUID();
    await writeFile(path, JSON.stringify(damaged));
    const incoming = intent();
    incoming.launch.execution.cwd = '/incoming';
    const head = await readFile(join(root, 'head.json'), 'utf8');
    await expect(store.admitResourceStart(incoming)).rejects.toThrow(
      'does not identify the waiting run'
    );
    expect(await readFile(join(root, 'head.json'), 'utf8')).toBe(head);
    expect(await store.getResourceStartRequest(incoming.launch.run.id)).toBeNull();
  }
);

for (const status of ['paused', 'failed'] as const) {
  test.each(['document', 'launch', 'both'] as const)(
    `historical ${status} resume rejects mismatched %s request identity`,
    async damage => {
      const { root, store, holder, queued, path, intact } = await releasedHolderFixture(
        'released-before-upgrade',
        'intact'
      );
      await store.withdrawQueuedResourceStart(queued.launch.run.id);
      if (status === 'failed')
        await commitModule.commit(root, [holder.launch.run.id], async runs => ({
          result: undefined,
          changes: { runs: [{ run: { ...runs.get(holder.launch.run.id)!, status: 'failed' } }] },
        }));
      const damaged = structuredClone(intact);
      if (damage !== 'launch') damaged.id = crypto.randomUUID();
      if (damage !== 'document') damaged.launch.run.id = crypto.randomUUID();
      await writeFile(path, JSON.stringify(damaged));
      const head = await readFile(join(root, 'head.json'), 'utf8');
      await expect(store.resumeWorkflowRun(holder.launch.run.id)).rejects.toThrow(
        'does not identify the resumed run'
      );
      expect(await readFile(join(root, 'head.json'), 'utf8')).toBe(head);
      expect((await store.getWorkflowRun(holder.launch.run.id))?.status).toBe(status);
      await writeFile(path, JSON.stringify(intact));
      expect(await store.resumeWorkflowRun(holder.launch.run.id)).toMatchObject({
        status: 'running',
      });
    }
  );
}

test.each(
  (['admission', 'drain', 'paused resume', 'failed resume'] as const).flatMap(operation =>
    (['admitted', 'holders', 'json'] as const).flatMap(damage =>
      [false, true].map(independent => ({ operation, damage, independent }))
    )
  )
)(
  'damaged foreign slot $damage during $operation with independent=$independent',
  async ({ operation, damage, independent }) => {
    const { root, store } = await fixture();
    const foreign = { ...intent(), resource: 'foreign' };
    foreign.launch.run.metadata.admission_checkout_guard = false;
    const contender = intent();
    contender.launch.run.metadata.admission_checkout_guard = false;
    if (operation.includes('resume')) contender.launch.execution.cwd = '/contender';
    foreign.launch.execution.cwd = contender.launch.execution.cwd;
    if (operation !== 'admission') {
      const occupant = intent();
      occupant.launch.execution.cwd = '/occupant';
      await store.admitResourceStart(occupant);
      if (operation === 'drain') await store.admitResourceStart(contender);
      else {
        await finishRun(root, occupant.launch.run.id);
        await store.admitResourceStart(contender);
        if (operation === 'paused resume')
          await store.updateWorkflowRun(contender.launch.run.id, { status: 'paused' });
        else await store.failWorkflowRun(contender.launch.run.id, 'failed');
      }
      await finishRun(root, occupant.launch.run.id);
    }
    if (independent) {
      foreign.launch.execution.cwd = '/foreign';
      const manual = intent().launch.run;
      await store.createWorkflowRun(manual);
      await store.claimPendingWorkflowRun(manual.id, '/manual');
    }
    await store.admitResourceStart(foreign);
    const path = join(
      root,
      'resource/slots',
      `${createHash('sha256').update('foreign').digest('hex')}.json`
    );
    const slot = JSON.parse(await readFile(path, 'utf8'));
    const damagedSlot = damage === 'json' ? '{' : JSON.stringify({ ...slot, [damage]: 42 });
    await writeFile(path, damagedSlot);
    const head = await readFile(join(root, 'head.json'), 'utf8');
    const attempt = () =>
      operation === 'admission'
        ? store.admitResourceStart(contender)
        : operation === 'drain'
          ? store.drainResourceStarts({ resource: 'resource', hostId: 'host' })
          : store.resumeWorkflowRun(contender.launch.run.id);
    const expectProgress = async () => {
      if (operation === 'admission') expect(await attempt()).toMatchObject({ status: 'admitted' });
      else if (operation === 'drain')
        expect(await attempt()).toMatchObject([{ runId: contender.launch.run.id }]);
      else expect(await attempt()).toMatchObject({ status: 'running' });
    };
    if (independent) {
      await expectProgress();
      expect((await store.getWorkflowRun(foreign.launch.run.id))?.status).toBe('pending');
      expect(await readFile(path, 'utf8')).toBe(damagedSlot);
      return;
    }
    await expect(attempt()).rejects.toMatchObject({
      message: `Invalid resource slot membership 'resource/slots/${createHash('sha256').update('foreign').digest('hex')}.json'`,
      cause: expect.any(damage === 'json' ? SyntaxError : ZodError),
    });
    expect(await readFile(join(root, 'head.json'), 'utf8')).toBe(head);
    expect((await store.getWorkflowRun(foreign.launch.run.id))?.status).toBe('pending');
    await writeFile(path, JSON.stringify(slot));
    await expectProgress();
  }
);

test.each(
  (['paused', 'failed'] as const).flatMap(status =>
    (['admitted', 'holders'] as const).map(damage => ({ status, damage }))
  )
)(
  'historical $status resume rejects surviving contradictory membership with malformed $damage',
  async ({ status, damage }) => {
    const { root, store, holder, queued, path, intact, slotPath } = await releasedHolderFixture(
      'released-before-upgrade',
      'resource-mismatch'
    );
    await store.withdrawQueuedResourceStart(queued.launch.run.id);
    if (status === 'failed')
      await commitModule.commit(root, [holder.launch.run.id], async runs => ({
        result: undefined,
        changes: { runs: [{ run: { ...runs.get(holder.launch.run.id)!, status: 'failed' } }] },
      }));
    const slot = JSON.parse(await readFile(slotPath, 'utf8'));
    const damagedSlot = JSON.stringify({
      ...slot,
      admitted: [holder.launch.run.id],
      holders: [{ kind: 'run', id: holder.launch.run.id }],
      [damage]: 42,
    });
    await writeFile(slotPath, damagedSlot);
    const head = await readFile(join(root, 'head.json'), 'utf8');
    const request = await readFile(path, 'utf8');
    await expect(store.resumeWorkflowRun(holder.launch.run.id)).rejects.toMatchObject({
      message: `Invalid resource slot membership 'resource/slots/${createHash('sha256').update(holder.resource).digest('hex')}.json'`,
      cause: expect.any(ZodError),
    });
    expect(await readFile(join(root, 'head.json'), 'utf8')).toBe(head);
    expect(await readFile(slotPath, 'utf8')).toBe(damagedSlot);
    expect(await readFile(path, 'utf8')).toBe(request);
    expect((await store.getWorkflowRun(holder.launch.run.id))?.status).toBe(status);
    await writeFile(slotPath, JSON.stringify(slot));
    await writeFile(path, JSON.stringify(intact));
    expect(await store.resumeWorkflowRun(holder.launch.run.id)).toMatchObject({
      status: 'running',
    });
  }
);

test.each(
  (['paused', 'failed'] as const).flatMap(status =>
    (['admitted', 'holders', 'json'] as const).map(damage => ({ status, damage }))
  )
)(
  'historical $status resume drains independently of unreadable foreign $damage membership',
  async ({ status, damage }) => {
    const { root, store, holder, queued } = await releasedHolderFixture(
      'released-before-upgrade',
      'intact'
    );
    await store.withdrawQueuedResourceStart(queued.launch.run.id);
    if (status === 'failed')
      await commitModule.commit(root, [holder.launch.run.id], async runs => ({
        result: undefined,
        changes: { runs: [{ run: { ...runs.get(holder.launch.run.id)!, status: 'failed' } }] },
      }));
    const foreign = { ...intent(), resource: 'foreign' };
    foreign.launch.execution.cwd = '/foreign';
    await store.admitResourceStart(foreign);
    const path = join(
      root,
      'resource/slots',
      `${createHash('sha256').update('foreign').digest('hex')}.json`
    );
    const slot = JSON.parse(await readFile(path, 'utf8'));
    const damagedSlot = damage === 'json' ? '{' : JSON.stringify({ ...slot, [damage]: 42 });
    await writeFile(path, damagedSlot);
    expect(await store.resumeWorkflowRun(holder.launch.run.id)).toMatchObject({
      status: 'running',
    });
    expect(await readFile(path, 'utf8')).toBe(damagedSlot);
    expect((await store.getWorkflowRun(foreign.launch.run.id))?.status).toBe('pending');
  }
);

test.each(['paused', 'failed'] as const)(
  'historical %s resume refuses a foreign slot read failure without committing',
  async status => {
    const { root, store, holder, queued, path, slotPath } = await releasedHolderFixture(
      'released-before-upgrade',
      'intact'
    );
    await store.withdrawQueuedResourceStart(queued.launch.run.id);
    if (status === 'failed')
      await commitModule.commit(root, [holder.launch.run.id], async runs => ({
        result: undefined,
        changes: { runs: [{ run: { ...runs.get(holder.launch.run.id)!, status: 'failed' } }] },
      }));
    const foreign = { ...intent(), resource: 'foreign' };
    foreign.launch.execution.cwd = '/foreign';
    await store.admitResourceStart(foreign);
    const foreignPath = join(
      root,
      'resource/slots',
      `${createHash('sha256').update('foreign').digest('hex')}.json`
    );
    const head = await readFile(join(root, 'head.json'), 'utf8');
    const request = await readFile(path, 'utf8');
    const slot = await readFile(slotPath, 'utf8');
    const foreignSlot = await readFile(foreignPath, 'utf8');
    const failure = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    const readJson = commitModule.readJson;
    const reads = spyOn(commitModule, 'readJson').mockImplementation(async document => {
      if (document === foreignPath) throw failure;
      return readJson(document);
    });
    try {
      await expect(store.resumeWorkflowRun(holder.launch.run.id)).rejects.toMatchObject({
        message: `Invalid resource slot membership 'resource/slots/${createHash('sha256').update('foreign').digest('hex')}.json'`,
        cause: failure,
      });
    } finally {
      reads.mockRestore();
    }
    expect(await readFile(join(root, 'head.json'), 'utf8')).toBe(head);
    expect(await readFile(path, 'utf8')).toBe(request);
    expect(await readFile(slotPath, 'utf8')).toBe(slot);
    expect(await readFile(foreignPath, 'utf8')).toBe(foreignSlot);
    expect((await store.getWorkflowRun(holder.launch.run.id))?.status).toBe(status);
    expect(await store.resumeWorkflowRun(holder.launch.run.id)).toMatchObject({
      status: 'running',
    });
  }
);

test('unreadable foreign membership remains relevant through a registered checkout alias', async () => {
  const { root, store } = await fixture();
  const foreign = { ...intent(), resource: 'foreign' };
  foreign.launch.execution.cwd = '/foreign';
  await store.admitResourceStart(foreign);
  const path = join(
    root,
    'resource/slots',
    `${createHash('sha256').update('foreign').digest('hex')}.json`
  );
  await writeFile(path, '{');
  const reopened = await createFileWorkflowStore({
    root,
    listReusableCheckouts: async () => [
      { codebaseId: 'codebase', branch: 'alias', workingPath: '/foreign' },
    ],
  });
  const contender = intent();
  contender.launch.execution.isolation = { kind: 'worktree', branch: 'alias' };
  await expect(reopened.admitResourceStart(contender)).rejects.toThrow(
    'Invalid resource slot membership'
  );
  expect(await reopened.getResourceStartRequest(contender.launch.run.id)).toBeNull();
});

test.each(
  (['paused', 'failed'] as const).flatMap(status =>
    (['admitted', 'holders'] as const).flatMap(membership =>
      (['missing', 'queued', 'skipped', 'withdrawn'] as const).map(requestStatus => ({
        status,
        membership,
        requestStatus,
      }))
    )
  )
)(
  '$status resume refuses $requestStatus request with retained $membership membership without committing',
  async ({ status, membership, requestStatus }) => {
    const { root, store, holder, queued, path, slotPath, intact } = await releasedHolderFixture(
      'retained',
      'intact'
    );
    await store.withdrawQueuedResourceStart(queued.launch.run.id);
    if (status === 'failed')
      await commitModule.commit(root, [holder.launch.run.id], async runs => ({
        result: undefined,
        changes: { runs: [{ run: { ...runs.get(holder.launch.run.id)!, status: 'failed' } }] },
      }));
    const membershipSlot = JSON.parse(await readFile(slotPath, 'utf8'));
    if (membership === 'holders') {
      membershipSlot.admitted = [];
      membershipSlot.holders.push({ kind: 'run', id: holder.launch.run.id });
      await writeFile(slotPath, JSON.stringify(membershipSlot));
    }
    if (requestStatus === 'missing') await unlink(path);
    else await writeFile(path, JSON.stringify({ ...intact, status: requestStatus }));
    const head = await readFile(join(root, 'head.json'), 'utf8');
    const slot = await readFile(slotPath, 'utf8');
    await expect(store.resumeWorkflowRun(holder.launch.run.id)).rejects.toThrow(
      'has slot membership but no matching admitted request'
    );
    expect(await readFile(join(root, 'head.json'), 'utf8')).toBe(head);
    expect(await readFile(slotPath, 'utf8')).toBe(slot);
    expect((await store.getWorkflowRun(holder.launch.run.id))?.status).toBe(status);
    await writeFile(path, JSON.stringify(intact));
    expect(await store.resumeWorkflowRun(holder.launch.run.id)).toMatchObject({
      status: 'running',
    });
  }
);

test.each(['paused', 'failed'] as const)(
  'historical %s resume without request or slot membership keeps the manual-run exception',
  async status => {
    const { root, store, holder, path } = await releasedHolderFixture(
      'released-before-upgrade',
      'intact'
    );
    if (status === 'failed')
      await commitModule.commit(root, [holder.launch.run.id], async runs => ({
        result: undefined,
        changes: { runs: [{ run: { ...runs.get(holder.launch.run.id)!, status: 'failed' } }] },
      }));
    await unlink(path);
    expect(await store.resumeWorkflowRun(holder.launch.run.id)).toMatchObject({
      status: 'running',
    });
  }
);
