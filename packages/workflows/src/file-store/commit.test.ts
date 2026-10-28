import { createHash } from 'node:crypto';
import type { StateRevision } from '../state-document-store';
import { expect, spyOn, test } from 'bun:test';
import { appendFile, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from './store';
import * as commitModule from './commit';
import { readRunState } from './commit';
import { WorkflowEventCursorError, type WorkflowEventCursor } from '../store';
const roots = trackTempRoots();
async function fixture() {
  const root = roots(await mkdtemp(join(tmpdir(), 'file-commit-')));
  const store = await createFileWorkflowStore({ root });
  const run = await store.createWorkflowRun({ workflow_name: 'crash', user_message: '' });
  const dir = join(root, 'runs', run.id);
  return { root, store, run, dir };
}
const crashSteps = ['intent', 'log', 'snapshot', 'document', 'index', 'head'] as const;
test.each([...crashSteps])('redo after crash at %s applies exactly once', async step => {
  const { root, store, run, dir } = await fixture();
  const head = await store.getWorkflowEventHead();
  const old = await readFile(join(dir, 'log.jsonl'), 'utf8');
  const event = {
    id: crypto.randomUUID(),
    workflow_run_id: run.id,
    event_type: 'workflow_started',
    event_order: 1,
    step_name: null,
    step_index: null,
    data: {},
    created_at: new Date().toISOString(),
  };
  const line = {
    seq: 2,
    at: new Date().toISOString(),
    run: { ...run, status: 'running' },
    events: [event],
    retract: [],
  };
  await writeFile(
    join(root, 'intent.json'),
    JSON.stringify({
      seq: 2,
      lines: [line],
      documents: { 'host/fixture.json': { value: 42 } },
      deleteRuns: [],
    })
  );
  if (crashSteps.indexOf(step) >= 1)
    await appendFile(join(dir, 'log.jsonl'), `${JSON.stringify(line)}\n`);
  if (crashSteps.indexOf(step) >= 2)
    await writeFile(join(dir, 'run.json'), JSON.stringify({ seq: 2, run: line.run }));
  if (crashSteps.indexOf(step) >= 3) {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'host'));
    await writeFile(join(root, 'host/fixture.json'), JSON.stringify({ value: 42 }));
  }
  if (crashSteps.indexOf(step) >= 4)
    await writeFile(
      join(root, 'feed-index.json'),
      JSON.stringify({ format: 1, seq: 2, runs: { [run.id]: 2 } })
    );
  if (crashSteps.indexOf(step) >= 5)
    await writeFile(join(root, 'head.json'), JSON.stringify({ format: 1, seq: 2 }));
  expect(
    (await store.readWorkflowEventsAfter(head, { limit: 1 })).events.map(({ event }) => event)
  ).toEqual([event]);
  expect((await store.getWorkflowRun(run.id))?.status).toBe('running');
  expect(await store.listWorkflowEvents(run.id)).toEqual([event]);
  const contents = await readFile(join(dir, 'log.jsonl'), 'utf8');
  expect(contents.startsWith(old)).toBe(true);
  expect(contents.trim().split('\n')).toHaveLength(2);
  expect(JSON.parse(contents.trim().split('\n')[1]!)).toEqual(JSON.parse(JSON.stringify(line)));
  if (step !== 'intent') expect(contents).toBe(old + JSON.stringify(line) + '\n');
  await createFileWorkflowStore({ root });
  expect(await readFile(join(dir, 'log.jsonl'), 'utf8')).toBe(contents);
  expect(JSON.parse(await readFile(join(root, 'host/fixture.json'), 'utf8'))).toEqual({
    value: 42,
  });
});
test('a torn UTF-8 tail is ignored, repaired by a writer, and deleting the snapshot loses nothing', async () => {
  const { root, store, run, dir } = await fixture();
  const before = await readFile(join(dir, 'log.jsonl'));
  await appendFile(join(dir, 'log.jsonl'), Buffer.from([123, 34, 0xe2, 0x82]));
  expect((await readRunState(root, run.id))?.run.status).toBe('pending');
  expect((await store.getWorkflowRun(run.id))?.status).toBe('pending');
  await store.claimPendingWorkflowRun(run.id);
  const after = await readFile(join(dir, 'log.jsonl'));
  expect(after.subarray(0, before.length)).toEqual(before);
  expect(after.toString('utf8').split('\n').filter(Boolean)).toHaveLength(2);
  await unlink(join(dir, 'run.json'));
  expect((await store.getWorkflowRun(run.id))?.status).toBe('running');
  expect(JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')).seq).toBe(2);
});
test('retraction hides only cancelled fan-out events without rewriting the log', async () => {
  const { store, run, dir } = await fixture();
  await store.claimPendingWorkflowRun(run.id);
  await store.cancelFanOutRun(run.id, 'fan_out_orphan');
  const before = await readFile(join(dir, 'log.jsonl'), 'utf8');
  await store.recoverCancelledFanOutRun(run.id);
  expect((await store.listWorkflowEvents(run.id)).map(event => event.event_type)).toEqual([
    'workflow_resumed',
  ]);
  const after = await readFile(join(dir, 'log.jsonl'), 'utf8');
  expect(after.startsWith(before)).toBe(true);
  expect(JSON.parse(after.trim().split('\n').at(-1)!).retract).toHaveLength(1);
});
test('unknown head format fails at open', async () => {
  const { root } = await fixture();
  await writeFile(join(root, 'head.json'), JSON.stringify({ format: 99, seq: 1 }));
  await expect(createFileWorkflowStore({ root })).rejects.toThrow();
});
test('CAS losers leave the head and log bytes unchanged', async () => {
  const { root, store, run, dir } = await fixture();
  await store.claimPendingWorkflowRun(run.id);
  const log = await readFile(join(dir, 'log.jsonl'));
  const head = await readFile(join(root, 'head.json'));
  expect(await store.claimPendingWorkflowRun(run.id)).toBeNull();
  expect(await readFile(join(dir, 'log.jsonl'))).toEqual(log);
  expect(await readFile(join(root, 'head.json'))).toEqual(head);
});

test('a snapshot behind its log is rebuilt before a read or write', async () => {
  const { store, run, dir } = await fixture();
  const old = await readFile(join(dir, 'run.json'));
  await store.claimPendingWorkflowRun(run.id);
  await writeFile(join(dir, 'run.json'), old);
  expect((await store.getWorkflowRun(run.id))?.status).toBe('running');
  await writeFile(join(dir, 'run.json'), old);
  expect(await store.claimPendingWorkflowRun(run.id)).toBeNull();
  expect((await store.getWorkflowRun(run.id))?.status).toBe('running');
});

test('cleanup deletes old runs without reading any run event log under the lock', async () => {
  const { store, run } = await fixture();
  await store.cancelWorkflowRun(run.id);
  await Bun.sleep(2);
  const reads = spyOn(commitModule, 'readRunState');
  try {
    expect(await store.deleteOldWorkflowRuns(0)).toEqual({ count: 1 });
    expect(reads).not.toHaveBeenCalled();
  } finally {
    reads.mockRestore();
  }
});

test('feed reads committed events when a disposable snapshot is missing', async () => {
  const { store, run, dir } = await fixture();
  const head = await store.getWorkflowEventHead();
  await store.persistWorkflowEvent({ workflow_run_id: run.id, event_type: 'workflow_started' });
  await unlink(join(dir, 'run.json'));
  expect(
    (await store.readWorkflowEventsAfter(head, { limit: 1 })).events.map(
      ({ event }) => event.event_type
    )
  ).toEqual(['workflow_started']);
});

test('active feed reads skip unrelated runs and rebuild a missing index from logs', async () => {
  const { root, store, run, dir } = await fixture();
  const other = await store.createWorkflowRun({ workflow_name: 'other', user_message: '' });
  await store.persistWorkflowEvent({ workflow_run_id: other.id, event_type: 'workflow_started' });
  const head = await store.getWorkflowEventHead();
  await store.persistWorkflowEvent({
    workflow_run_id: run.id,
    event_type: 'workflow_started',
  });
  const expected = (await store.listWorkflowEvents(run.id))[0]!;
  const otherLogPath = join(root, 'runs', other.id, 'log.jsonl');
  const otherSnapshotPath = join(root, 'runs', other.id, 'run.json');
  const otherSnapshot = await readFile(otherSnapshotPath);
  const otherLog = await readFile(otherLogPath);
  await writeFile(otherSnapshotPath, 'invalid snapshot');
  await writeFile(otherLogPath, 'invalid log\n');
  expect(
    (await store.readWorkflowEventsAfter(head, { limit: 1 })).events.map(row => row.event.id)
  ).toEqual([expected.id]);
  await writeFile(otherLogPath, otherLog);
  await writeFile(otherSnapshotPath, otherSnapshot);
  await unlink(join(root, 'feed-index.json'));
  expect(
    (await store.readWorkflowEventsAfter(head, { limit: 1 })).events.map(row => row.event.id)
  ).toEqual([expected.id]);
  await unlink(join(root, 'feed-index.json'));
  await unlink(join(dir, 'run.json'));
  const reopened = await createFileWorkflowStore({ root });
  expect(
    (await reopened.readWorkflowEventsAfter(head, { limit: 1 })).events.map(row => row.event.id)
  ).toEqual([expected.id]);
  expect(
    JSON.parse(await readFile(join(root, 'feed-index.json'), 'utf8')).runs[run.id]
  ).toBeDefined();
});

test('missing and stale indexes are rebuilt before commits without losing earlier events', async () => {
  const { root, store, run } = await fixture();
  const head = await store.getWorkflowEventHead();
  const stale = await readFile(join(root, 'feed-index.json'));
  const other = await store.createWorkflowRun({ workflow_name: 'other', user_message: '' });
  await store.persistWorkflowEvent({
    workflow_run_id: run.id,
    event_type: 'workflow_started',
  });
  await writeFile(join(root, 'feed-index.json'), stale);
  await store.persistWorkflowEvent({
    workflow_run_id: other.id,
    event_type: 'workflow_completed',
  });
  await unlink(join(root, 'feed-index.json'));
  await store.persistWorkflowEvent({
    workflow_run_id: run.id,
    event_type: 'workflow_started',
  });
  expect(
    (await store.readWorkflowEventsAfter(head, { limit: 10 })).events.map(row => row.event.id)
  ).toEqual([
    (await store.listWorkflowEvents(run.id))[0]!.id,
    (await store.listWorkflowEvents(other.id))[0]!.id,
    (await store.listWorkflowEvents(run.id))[1]!.id,
  ]);
});

test('feed rejects a syntactically valid cursor beyond the committed head', async () => {
  const { store } = await fixture();
  await expect(
    store.readWorkflowEventsAfter('file:999.0' as WorkflowEventCursor, { limit: 1 })
  ).rejects.toBeInstanceOf(WorkflowEventCursorError);
});

test('explicit deletion retains feed payloads across reopen and index rebuild', async () => {
  const { root, store, run } = await fixture();
  const head = await store.getWorkflowEventHead();
  await store.cancelWorkflowRun(run.id);
  const committed = await store.listWorkflowEvents(run.id);
  await store.deleteWorkflowRun(run.id);
  expect(await store.getWorkflowRun(run.id)).toBeNull();
  expect(await store.listWorkflowEvents(run.id)).toEqual([]);
  await unlink(join(root, 'feed-index.json'));
  const reopened = await createFileWorkflowStore({ root });
  expect(
    (await reopened.readWorkflowEventsAfter(head, { limit: 1 })).events.map(row => row.event)
  ).toEqual(committed);
});

test.each(['explicit', 'cleanup'] as const)(
  '%s deletion reserves the run ID for the store lifetime',
  async deletion => {
    const { root, store } = await fixture();
    const input = { id: 'reserved-run', workflow_name: 'reserved', user_message: '' };
    const run = await store.createWorkflowRun(input);
    const head = await store.getWorkflowEventHead();
    await store.persistWorkflowEvent({ workflow_run_id: run.id, event_type: 'workflow_started' });
    await store.cancelWorkflowRun(run.id);
    const committed = await store.listWorkflowEvents(run.id);
    const remove = async (target: typeof store) => {
      if (deletion === 'explicit') await target.deleteWorkflowRun(run.id);
      else {
        await Bun.sleep(2);
        await target.deleteOldWorkflowRuns(0);
      }
    };
    await remove(store);
    const archivePath = join(root, 'archived-runs', run.id, 'log.jsonl');
    const archive = await readFile(archivePath);
    const deletedHead = await store.getWorkflowEventHead();
    await expect(store.createWorkflowRun(input)).rejects.toThrow('Duplicate run');
    expect(await store.getWorkflowEventHead()).toBe(deletedHead);
    expect(await store.getWorkflowRun(run.id)).toBeNull();
    expect(
      (await store.readWorkflowEventsAfter(head, { limit: 10 })).events.map(row => row.event)
    ).toEqual(committed);

    await unlink(join(root, 'feed-index.json'));
    const reopened = await createFileWorkflowStore({ root });
    await expect(reopened.createWorkflowRun(input)).rejects.toThrow('Duplicate run');
    await expect(
      reopened.persistWorkflowEvent({ workflow_run_id: run.id, event_type: 'workflow_started' })
    ).rejects.toThrow('Run missing');
    await remove(reopened);
    expect(await readFile(archivePath)).toEqual(archive);
    let cursor = head;
    for (const event of committed) {
      const page = await reopened.readWorkflowEventsAfter(cursor, { limit: 1 });
      expect(page.events.map(row => row.event)).toEqual([event]);
      cursor = page.next;
    }
    expect((await reopened.readWorkflowEventsAfter(cursor, { limit: 1 })).events).toEqual([]);
    const fresh = await reopened.createWorkflowRun({ ...input, id: 'fresh-reserved-run' });
    expect(fresh.id).toBe('fresh-reserved-run');
  }
);

const deletionCrashSteps = ['intent', 'archive', 'delete', 'index', 'head'] as const;
test.each([...deletionCrashSteps])(
  'deletion redo retains feed payloads after crash at %s',
  async step => {
    const { root, store, run, dir } = await fixture();
    const head = await store.getWorkflowEventHead();
    await store.cancelWorkflowRun(run.id);
    const committed = await store.listWorkflowEvents(run.id);
    const seq = JSON.parse(await readFile(join(root, 'head.json'), 'utf8')).seq + 1;
    await writeFile(
      join(root, 'intent.json'),
      JSON.stringify({ seq, lines: [], documents: {}, deleteRuns: [run.id] })
    );
    if (deletionCrashSteps.indexOf(step) >= 1) {
      const { mkdir, rename } = await import('node:fs/promises');
      const archived = join(root, 'archived-runs', run.id);
      await mkdir(archived, { recursive: true });
      await rename(join(dir, 'log.jsonl'), join(archived, 'log.jsonl'));
    }
    if (deletionCrashSteps.indexOf(step) >= 2) {
      const { removeTempTree } = await import('@archon/paths/test-utils');
      await removeTempTree(dir);
    }
    if (deletionCrashSteps.indexOf(step) >= 3) {
      const index = JSON.parse(await readFile(join(root, 'feed-index.json'), 'utf8'));
      index.seq = seq;
      await writeFile(join(root, 'feed-index.json'), JSON.stringify(index));
    }
    if (deletionCrashSteps.indexOf(step) >= 4)
      await writeFile(join(root, 'head.json'), JSON.stringify({ format: 1, seq }));
    const reopened = await createFileWorkflowStore({ root });
    expect(await reopened.getWorkflowRun(run.id)).toBeNull();
    expect(
      (await reopened.readWorkflowEventsAfter(head, { limit: 1 })).events.map(row => row.event)
    ).toEqual(committed);
  }
);

const stateCrashSteps = ['intent', 'name', 'scratch', 'published', 'deleted', 'head'] as const;
test.each([...stateCrashSteps])('state redo preserves immutable files after %s', async step => {
  const { root, store } = await fixture();
  const { rename, mkdir, stat } = await import('node:fs/promises');
  const dir = `state/${createHash('sha256')
    .update(JSON.stringify(['_install', 'ledger']))
    .digest('hex')}`;
  const name = `${dir}/name.json`;
  const revision = `${dir}/2.json`;
  const obsolete = `${dir}/1.json`;
  await mkdir(join(root, dir), { recursive: true });
  const row: StateRevision = {
    name: 'ledger',
    revision: 2,
    value: null,
    operation: { op: 'delete' },
    writer: { kind: 'surface', via: 'cli' },
    createdAt: new Date().toISOString(),
  };
  await writeFile(
    join(root, obsolete),
    JSON.stringify({ ...row, revision: 1, value: {}, operation: { op: 'put' } })
  );
  const seq = JSON.parse(await readFile(join(root, 'head.json'), 'utf8')).seq + 1;
  const immutableDocuments = {
    [name]: { scope: { kind: 'install' }, name: 'ledger' },
    [revision]: row,
  };
  await writeFile(
    join(root, 'intent.json'),
    JSON.stringify({
      seq,
      lines: [],
      documents: {},
      deleteRuns: [],
      immutableDocuments,
      deleteDocuments: [obsolete],
    })
  );
  if (stateCrashSteps.indexOf(step) >= 1)
    await writeFile(join(root, name), JSON.stringify(immutableDocuments[name]));
  let inode: number | undefined;
  if (stateCrashSteps.indexOf(step) >= 2) {
    await writeFile(
      join(root, `${revision}.publish.tmp`),
      JSON.stringify(immutableDocuments[revision])
    );
  }
  if (stateCrashSteps.indexOf(step) >= 3) {
    await rename(join(root, `${revision}.publish.tmp`), join(root, revision));
    inode = (await stat(join(root, revision))).ino;
  }
  if (stateCrashSteps.indexOf(step) >= 4) await unlink(join(root, obsolete));
  if (stateCrashSteps.indexOf(step) >= 5)
    await writeFile(join(root, 'head.json'), JSON.stringify({ format: 1, seq }));
  expect(await store.getStateDocument({ kind: 'install' }, 'ledger')).toBeNull();
  expect(await store.listStateRevisions({ kind: 'install' }, 'ledger')).toEqual([row]);
  expect(await readFile(join(root, revision), 'utf8')).toBe(JSON.stringify(row));
  expect(await Bun.file(join(root, obsolete)).exists()).toBe(false);
  if (inode !== undefined) expect((await stat(join(root, revision))).ino).toBe(inode);
  expect(await Bun.file(join(root, `${revision}.publish.tmp`)).exists()).toBe(false);
  const head = await readFile(join(root, 'head.json'));
  await createFileWorkflowStore({ root });
  expect(await readFile(join(root, 'head.json'))).toEqual(head);
  expect(String(await store.getWorkflowEventHead())).toBe(`file:${seq}.9007199254740991`);
});

test('immutable publication rejects different bytes and retains the recovery intent', async () => {
  const { root } = await fixture();
  await commitModule.commit(root, [], async () => ({
    result: undefined,
    changes: { immutableDocuments: { 'state/test/1.json': { value: 1 } } },
  }));
  const before = await readFile(join(root, 'state/test/1.json'));
  await expect(
    commitModule.commit(root, [], async () => ({
      result: undefined,
      changes: { immutableDocuments: { 'state/test/1.json': { value: 2 } } },
    }))
  ).rejects.toThrow('Immutable store document differs');
  expect(await readFile(join(root, 'state/test/1.json'))).toEqual(before);
  expect(await Bun.file(join(root, 'intent.json')).exists()).toBe(true);
});

test('cancellation retains structured cleanup warnings across reopen', async () => {
  const { root, store, run } = await fixture();
  const warnings = ['Output still held; use lsof on the checkout.'];
  await store.cancelWorkflowRun(run.id, {
    cancel_reason: 'operator',
    reason: warnings[0],
    warnings,
  });
  const reopened = await createFileWorkflowStore({ root });
  const events = await reopened.listWorkflowEvents(run.id);
  expect(events.find(event => event.event_type === 'workflow_cancelled')?.data).toMatchObject({
    reason: warnings[0],
    warnings,
  });
});
