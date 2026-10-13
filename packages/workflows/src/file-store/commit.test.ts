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
  await store.cancelFanOutRun(run.id, 'fan_out_gate');
  const before = await readFile(join(dir, 'log.jsonl'), 'utf8');
  await store.recoverCancelledFanOutRun(run.id);
  expect(await store.listWorkflowEvents(run.id)).toEqual([]);
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
