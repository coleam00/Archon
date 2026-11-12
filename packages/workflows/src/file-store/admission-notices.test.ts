import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { ResourceStartBindingIntent } from '../schemas/resource-start';
import { resourceStartFixtures } from '../resource-start-conformance';
import { admissionNoticeCursor } from '../admission-notice';
import { WorkflowEventCursorError } from '../store';
import { createFileWorkflowStore } from './store';
import { createAdmissionTransaction } from './admission-transaction';
import { commit } from './commit';
import * as persistence from './commit';
import * as fs from 'node:fs/promises';
import { pathFor } from './admission-documents';

const roots = trackTempRoots();

test('admission cursors replay multiple requests in one commit after reopening', async () => {
  const root = roots(await mkdtemp(join(tmpdir(), 'admission-notices-')));
  const store = await createFileWorkflowStore({ root });
  const { start } = resourceStartFixtures('codebase', 'conversation');
  const holder = start();
  await store.admitResourceStart(holder);
  const receiptId = crypto.randomUUID();
  const requests = [start('skip'), start('skip')];
  const binding = (bindingId: string): ResourceStartBindingIntent => ({
    ...requests[0],
    bindingId,
    bindingRevision: null,
    runAsUserId: 'operator',
    launch: { cwd: '/test', workflowName: 'test', inputs: {}, isolation: { kind: 'in-place' } },
  });
  await store.acceptStartReceipt({
    receipt: {
      id: receiptId,
      sourceInstanceId: 'source',
      deliveryId: 'delivery',
      contentDigest: 'digest',
      receivedAt: '2026-01-01T00:00:00.000Z',
      occurredAt: null,
      sourceActor: null,
    },
    outcome: 'matched',
    bindings: [binding('binding-0'), binding('binding-1')],
  });
  const head = await store.getAdmissionNoticeHead();
  await commit(root, [], async runs => {
    const tx = createAdmissionTransaction(root);
    for (const [index, request] of requests.entries())
      await tx.admit(
        { ...request, receipt: { receiptId, bindingId: `binding-${String(index)}` } },
        runs
      );
    return { result: undefined, changes: { documents: await tx.changedDocuments() } };
  });
  const reopened = await createFileWorkflowStore({ root });
  const first = await reopened.readAdmissionNoticesAfter(head, { limit: 1 });
  const second = await reopened.readAdmissionNoticesAfter(first.next, { limit: 1 });
  expect(first.caughtUp).toBe(false);
  expect(second.caughtUp).toBe(true);
  expect([...first.notices, ...second.notices].map(row => row.facts.requestId)).toEqual(
    requests.map(request => request.launch.run.id).sort()
  );
  for (const { facts } of [...first.notices, ...second.notices]) {
    expect(facts.receivedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(facts.blocker).toEqual({ kind: 'run', id: holder.launch.run.id });
    expect(await reopened.getWorkflowRun(facts.requestId)).toBeNull();
  }
  expect(await reopened.readAdmissionNoticesAfter(second.next, { limit: 1 })).toMatchObject({
    notices: [],
    caughtUp: true,
  });
  expect(await reopened.getAdmissionNoticeHead()).toBe(second.next);
  await expect(
    reopened.readAdmissionNoticesAfter(
      admissionNoticeCursor('file-admission:[9007199254740991,null]'),
      { limit: 1 }
    )
  ).rejects.toBeInstanceOf(WorkflowEventCursorError);
});

async function fixture() {
  const root = roots(await mkdtemp(join(tmpdir(), 'admission-index-')));
  const store = await createFileWorkflowStore({ root });
  const { start } = resourceStartFixtures('codebase', 'conversation');
  await store.admitResourceStart(start());
  const fire = async (receivedAt: string) => {
    const request = start('skip');
    const receiptId = crypto.randomUUID();
    await store.acceptStartReceipt({
      receipt: {
        id: receiptId,
        sourceInstanceId: 'source',
        deliveryId: receiptId,
        contentDigest: 'digest',
        receivedAt,
        occurredAt: null,
        sourceActor: null,
      },
      outcome: 'matched',
      bindings: [
        {
          ...request,
          bindingId: 'binding',
          bindingRevision: null,
          runAsUserId: 'operator',
          launch: {
            cwd: '/test',
            workflowName: 'test',
            inputs: {},
            isolation: { kind: 'in-place' },
          },
        },
      ],
    });
    await store.admitResourceStart({ ...request, receipt: { receiptId, bindingId: 'binding' } });
    return request.launch.run.id;
  };
  return { root, store, fire };
}

test('warm admission reads touch only selected documents, including after reopening', async () => {
  const { root, store, fire } = await fixture();
  const old = await fire('2025-01-01T00:00:00.000Z');
  await store.readAdmissionNoticesAfter(null, { limit: 10 });
  const head = await store.getAdmissionNoticeHead();
  const reads = spyOn(persistence, 'readJson');
  const documents = () =>
    reads.mock.calls
      .map(([path]) => path)
      .filter(path => /resource\/(receipts|requests)\//.test(path));
  try {
    expect(await store.readAdmissionNoticesAfter(head, { limit: 1 })).toMatchObject({
      notices: [],
      caughtUp: true,
    });
    expect(documents()).toEqual([]);
    const first = await fire('2026-01-03T00:00:00.000Z');
    const second = await fire('2026-01-02T00:00:00.000Z');
    const reopened = await createFileWorkflowStore({ root });
    reads.mockClear();
    const page = await reopened.readAdmissionNoticesAfter(head, { limit: 1 });
    expect(page.notices.map(row => row.facts.requestId)).toEqual([first]);
    expect(documents()).toHaveLength(2);
    expect(documents()).not.toContain(join(root, pathFor('requests', old)));
    reads.mockClear();
    const next = await reopened.readAdmissionNoticesAfter(page.next, { limit: 1 });
    expect(next.notices.map(row => row.facts.requestId)).toEqual([second]);
    expect(next.caughtUp).toBe(true);
    expect(documents()).toHaveLength(2);
  } finally {
    reads.mockRestore();
  }
});

test('selective history reads only qualifying receipts despite delayed admission order', async () => {
  const { root, store, fire } = await fixture();
  await fire('2025-01-01T00:00:00.000Z');
  const first = await fire('2026-01-03T00:00:00.000Z');
  await fire('2026-01-01T23:59:59.999Z');
  const second = await fire('2026-01-02T00:00:00.000Z');
  await store.readAdmissionNoticesAfter(null, { limit: 10 });
  const reads = spyOn(persistence, 'readJson');
  const directories = spyOn(fs, 'readdir');
  try {
    const recent = await store.readAdmissionNoticesAfter(null, {
      limit: 1,
      since: new Date('2026-01-02'),
    });
    expect(recent.notices.map(row => row.facts.requestId)).toEqual([first]);
    const tail = await store.readAdmissionNoticesAfter(recent.next, {
      limit: 1,
      since: new Date('2026-01-02'),
    });
    expect(tail.notices.map(row => row.facts.requestId)).toEqual([second]);
    expect(tail.caughtUp).toBe(true);
    expect(
      reads.mock.calls.filter(([path]) => /resource\/(receipts|requests)\//.test(path))
    ).toHaveLength(4);
    expect(directories.mock.calls.map(([path]) => String(path))).not.toContain(
      join(root, 'admission-notice-index/days/2025-01-01')
    );
    expect(directories.mock.calls.map(([path]) => String(path))).not.toContain(
      join(root, 'resource/receipts')
    );
  } finally {
    reads.mockRestore();
    directories.mockRestore();
  }
});

test('a missing or stale disposable index rebuilds retained history and preserves cursors', async () => {
  const { root, store, fire } = await fixture();
  const ids = [await fire('2026-01-02T00:00:00.000Z'), await fire('2026-01-01T00:00:00.000Z')];
  const first = await store.readAdmissionNoticesAfter(null, { limit: 1 });
  const index = join(root, 'admission-notice-index');
  await rm(index, { recursive: true, force: true });
  const reopened = await createFileWorkflowStore({ root });
  expect(
    (await reopened.readAdmissionNoticesAfter(first.next, { limit: 1 })).notices.map(
      row => row.facts.requestId
    )
  ).toEqual([ids[1]]);
  // Simulate an older writer that does not know about the disposable index.
  const snapshot = await persistence.readJson(join(index, 'head.json'));
  ids.push(await fire('2026-01-03T00:00:00.000Z'));
  await persistence.replaceJson(join(index, 'head.json'), snapshot);
  expect(
    (await store.readAdmissionNoticesAfter(null, { limit: 10 })).notices.map(
      row => row.facts.requestId
    )
  ).toEqual(ids);
});

test('an unrelated commit backlog is scanned in bounded pages without losing a later notice', async () => {
  const { root, store, fire } = await fixture();
  const head = await store.getAdmissionNoticeHead();
  await store.readAdmissionNoticesAfter(null, { limit: 1 });
  for (let i = 0; i < 105; i++)
    await commit(root, [], async () => ({
      result: undefined,
      changes: { documents: { 'noise.json': i } },
    }));
  const id = await fire('2026-01-01T00:00:00.000Z');
  const reads = spyOn(persistence, 'readJson');
  try {
    const first = await store.readAdmissionNoticesAfter(head, { limit: 1 });
    expect(first.notices).toEqual([]);
    expect(first.caughtUp).toBe(false);
    expect(
      reads.mock.calls.filter(([path]) => path.includes('/admission-notice-index/commits/'))
    ).toHaveLength(100);
    const second = await store.readAdmissionNoticesAfter(first.next, { limit: 1 });
    expect(second.notices.map(row => row.facts.requestId)).toEqual([id]);
    expect(second.caughtUp).toBe(true);
  } finally {
    reads.mockRestore();
  }
});

test.each(['days', 'commits'])(
  'redo after an interrupted %s index update publishes the admission exactly once',
  async part => {
    const { root, store, fire } = await fixture();
    await store.readAdmissionNoticesAfter(null, { limit: 1 });
    let interrupted = false;
    const rename = fs.rename;
    const writes = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!interrupted && String(to).includes(`/admission-notice-index/${part}/`)) {
        interrupted = true;
        throw new Error('interrupted index publication');
      }
      return rename(from, to);
    });
    try {
      await expect(fire('2026-01-01T00:00:00.000Z')).rejects.toThrow(
        'interrupted index publication'
      );
    } finally {
      writes.mockRestore();
    }
    expect(interrupted).toBe(true);
    const reopened = await createFileWorkflowStore({ root });
    const page = await reopened.readAdmissionNoticesAfter(null, { limit: 10 });
    expect(page.notices).toHaveLength(1);
    expect(page.caughtUp).toBe(true);
    expect((await reopened.readAdmissionNoticesAfter(page.next, { limit: 10 })).notices).toEqual(
      []
    );
    expect(
      (await reopened.readAdmissionNoticesAfter(null, { limit: 10, since: new Date('2026-01-01') }))
        .notices
    ).toEqual(page.notices);
  }
);
