import { expect, test } from 'bun:test';
import { appendFile, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from './store';
import { readRunState } from './commit';
const roots = trackTempRoots();
async function fixture() {
  const root = roots(await mkdtemp(join(tmpdir(), 'file-commit-')));
  const store = await createFileWorkflowStore({ root });
  const run = await store.createWorkflowRun({ workflow_name: 'crash', user_message: '' });
  const dir = join(root, 'runs', run.id);
  return { root, store, run, dir };
}
test.each(['intent', 'log', 'snapshot', 'document', 'head'] as const)(
  'redo after crash at %s applies exactly once',
  async step => {
    const { root, store, run, dir } = await fixture();
    const old = await readFile(join(dir, 'log.jsonl'), 'utf8');
    const event = {
      id: crypto.randomUUID(),
      workflow_run_id: run.id,
      event_type: 'workflow_started',
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
    const steps = ['intent', 'log', 'snapshot', 'document', 'head'];
    if (steps.indexOf(step) >= 1)
      await appendFile(join(dir, 'log.jsonl'), `${JSON.stringify(line)}\n`);
    if (steps.indexOf(step) >= 2)
      await writeFile(join(dir, 'run.json'), JSON.stringify({ seq: 2, run: line.run }));
    if (steps.indexOf(step) >= 3) {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(root, 'host'));
      await writeFile(join(root, 'host/fixture.json'), JSON.stringify({ value: 42 }));
    }
    if (steps.indexOf(step) >= 4)
      await writeFile(join(root, 'head.json'), JSON.stringify({ format: 1, seq: 2 }));
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
  }
);
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
