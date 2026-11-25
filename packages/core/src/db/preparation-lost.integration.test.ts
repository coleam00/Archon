// @archon-test-isolated
/**
 * A binding whose preparer died stays `preparing`, and nothing prepares it again. The
 * attention queue lists it once this process can prove the preparer gone, and never on a
 * guess: a live preparer, one with no record, or one on another host is not listed.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, realpath } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { listAttentionQueue } from '@archon/workflows/attention-queue';
import { closeDatabase, getDatabase, resetDatabase } from './connection';
import { createWorkflowStore } from '../workflows/store-adapter';
import { attentionQueueSource } from '../operations/attention-queue';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const originalArchonHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;
let root = '';

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'archon-preparation-lost-')));
  process.env.ARCHON_HOME = root;
  delete process.env.DATABASE_URL;
  resetDatabase();
  await getDatabase().query(
    `INSERT INTO remote_agent_users (id, display_name) VALUES ($1, 'Test')`,
    [USER_ID]
  );
});

afterEach(async () => {
  await closeDatabase();
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await removeTempTree(root);
});

/** A receipt with one binding of `workflow` on item `issue-1`, claimed for preparation. */
async function claimed(store: ReturnType<typeof createWorkflowStore>) {
  const receiptId = crypto.randomUUID();
  await store.acceptStartReceipt({
    receipt: {
      id: receiptId,
      sourceInstanceId: 'source',
      deliveryId: null,
      contentDigest: receiptId,
      receivedAt: new Date().toISOString(),
      occurredAt: null,
      sourceActor: null,
      itemKey: 'issue-1',
    },
    outcome: 'matched',
    bindings: [
      {
        bindingId: 'build',
        bindingRevision: null,
        hostId: 'host',
        runAsUserId: USER_ID,
        resource: 'pool',
        capacity: 1,
        overlap: 'queue',
        launch: { cwd: root, workflowName: 'build', inputs: {}, isolation: { kind: 'in-place' } },
      },
    ],
  });
  const identity = { receiptId, bindingId: 'build', ownerId: crypto.randomUUID() };
  expect(await store.claimStartBindingPreparation(identity)).toBe(true);
  return identity;
}

async function setPreparer(receiptId: string, preparer: unknown): Promise<void> {
  await getDatabase().query(
    'UPDATE remote_agent_start_receipt_bindings SET preparation_process = $2 WHERE receipt_id = $1',
    [receiptId, preparer === null ? null : JSON.stringify(preparer)]
  );
}

/** A pid on this host that no process has any more. */
async function exitedPid(): Promise<number> {
  const child = Bun.spawn(['true']);
  await child.exited;
  return child.pid;
}

test('a binding whose preparer is gone is listed with its recovery, and only then', async () => {
  const store = createWorkflowStore();
  const source = attentionQueueSource(store, {
    findLatestByCodebaseAndWorkingPath: async () => null,
  });
  const lost = async () =>
    (await listAttentionQueue(source)).filter(
      item => 'kind' in item && item.kind === 'preparation_lost'
    );
  const identity = await claimed(store);

  // Claimed by this live process: not listed.
  expect(await lost()).toEqual([]);
  // Claimed by an older binary, which records no process: unknown, not listed.
  await setPreparer(identity.receiptId, null);
  expect(await lost()).toEqual([]);
  // On another host: unknown, not listed.
  const pid = await exitedPid();
  await setPreparer(identity.receiptId, { host: `${hostname()}-other`, pid, instance: 'x' });
  expect(await lost()).toEqual([]);

  // On this host, and no process has its pid: gone.
  await setPreparer(identity.receiptId, { host: hostname(), pid, instance: 'x' });
  expect(await lost()).toEqual([
    expect.objectContaining({
      kind: 'preparation_lost',
      ref: `preparing:${identity.receiptId}:build`,
      start: {
        receiptId: identity.receiptId,
        bindingId: 'build',
        hostId: 'host',
        workflow: 'build',
        itemKey: 'issue-1',
        ownerId: identity.ownerId,
      },
      pausedAt: expect.any(String),
    }),
  ]);

  // The recovery it names returns the binding to pending, which closes it.
  expect(await store.resetStartBindingPreparation(identity)).toBe(true);
  expect(await lost()).toEqual([]);
  const row = await getDatabase().query<{ preparation_process: string | null }>(
    'SELECT preparation_process FROM remote_agent_start_receipt_bindings WHERE receipt_id = $1',
    [identity.receiptId]
  );
  expect(row.rows[0]?.preparation_process ?? null).toBeNull();
});
