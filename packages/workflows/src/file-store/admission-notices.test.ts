import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
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
