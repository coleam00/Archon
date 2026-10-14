import { expect, spyOn, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from './store';
import * as commitModule from './commit';
const roots = trackTempRoots();
test('independent processes claim one pending run exactly once', async () => {
  const root = roots(await mkdtemp(join(tmpdir(), 'file-claim-')));
  const store = await createFileWorkflowStore({ root });
  const run = await store.createWorkflowRun({ workflow_name: 'race', user_message: '' });
  const script = `import {createFileWorkflowStore} from ${JSON.stringify(join(import.meta.dir, 'store.ts'))};
const store=await createFileWorkflowStore({root:${JSON.stringify(root)}});
console.log(JSON.stringify(await store.claimPendingWorkflowRun(${JSON.stringify(run.id)})));`;
  const children = Array.from({ length: 8 }, () =>
    Bun.spawn([process.execPath, '-e', script], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, LOG_LEVEL: 'silent' },
    })
  );
  const results = await Promise.all(
    children.map(async child => {
      const [output, error, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(error).not.toContain('Error');
      expect(exit).toBe(0);
      return JSON.parse(output);
    })
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  expect((await store.getWorkflowRun(run.id))?.status).toBe('running');
}, 30000);

test('independent processes admit one resource holder and queue the remaining launches', async () => {
  const root = roots(await mkdtemp(join(tmpdir(), 'file-admission-race-')));
  const store = await createFileWorkflowStore({ root });
  const script = `import {createFileWorkflowStore} from ${JSON.stringify(join(import.meta.dir, 'store.ts'))};
const store=await createFileWorkflowStore({root:${JSON.stringify(root)}});
const intent=JSON.parse(process.env.TEST_START_INTENT);
console.log(JSON.stringify(await store.admitResourceStart(intent)));`;
  const ids = Array.from({ length: 8 }, () => crypto.randomUUID());
  const results = await Promise.all(
    ids.map(async id => {
      const intent = {
        resource: 'race',
        capacity: 1,
        hostId: 'host',
        overlap: 'queue',
        launch: {
          version: 2,
          run: {
            id,
            workflow_name: 'race',
            codebase_id: 'codebase',
            user_message: '',
            metadata: {},
          },
          execution: {
            cwd: '/race',
            conversationId: 'correlation',
            isolation: { kind: 'in-place' },
          },
        },
      };
      const child = Bun.spawn([process.execPath, '-e', script], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, LOG_LEVEL: 'silent', TEST_START_INTENT: JSON.stringify(intent) },
      });
      const [output, error, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exit, error).toBe(0);
      return JSON.parse(output);
    })
  );
  expect(results.filter(row => row.status === 'admitted')).toHaveLength(1);
  expect(results.filter(row => row.status === 'queued')).toHaveLength(7);
  expect(await store.listQueuedResourceStartsForHost('host')).toHaveLength(7);
  expect((await Promise.all(ids.map(id => store.getWorkflowRun(id)))).filter(Boolean)).toHaveLength(
    1
  );
}, 30000);

test('independent event writers and a reconnecting reader have no gaps', async () => {
  const root = roots(await mkdtemp(join(tmpdir(), 'file-feed-')));
  const store = await createFileWorkflowStore({ root });
  const run = await store.createWorkflowRun({ workflow_name: 'race', user_message: '' });
  let cursor = await store.getWorkflowEventHead();
  const children = Array.from({ length: 8 }, (_, index) =>
    Bun.spawn(
      [
        process.execPath,
        '-e',
        `
import {createFileWorkflowStore} from ${JSON.stringify(join(import.meta.dir, 'store.ts'))};
const store = await createFileWorkflowStore({root:${JSON.stringify(root)}});
await store.persistWorkflowEvent({workflow_run_id:${JSON.stringify(run.id)},event_type:'workflow_started',data:{index:${index}}});
`,
      ],
      { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LOG_LEVEL: 'silent' } }
    )
  );
  let finished = false;
  const exits = Promise.all(
    children.map(async child => {
      const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(exit).toBe(0);
      expect(stderr).not.toContain('Error');
    })
  ).finally(() => {
    finished = true;
  });
  const seen: string[] = [];
  do {
    const reader = await createFileWorkflowStore({ root });
    const page = await reader.readWorkflowEventsAfter(cursor, { limit: 1 });
    seen.push(...page.events.map(({ event }) => event.id));
    cursor = page.next;
    await new Promise(resolve => setTimeout(resolve, 1));
  } while (!finished);
  await exits;
  for (;;) {
    const page = await store.readWorkflowEventsAfter(cursor, { limit: 1 });
    if (page.next === cursor) break;
    seen.push(...page.events.map(({ event }) => event.id));
    cursor = page.next;
  }
  const committed = await store.listWorkflowEvents(run.id);
  expect(committed).toHaveLength(8);
  expect(seen.sort()).toEqual(committed.map(event => event.id).sort());
}, 30000);

// Creation must look for a deleted run's archive under the same lock deletion takes; otherwise
// a deletion between that check and the write lets the ID be reused and hides retained history.
test('creation racing an independent deletion cannot reuse the run ID', async () => {
  const root = roots(await mkdtemp(join(tmpdir(), 'file-reserve-')));
  const store = await createFileWorkflowStore({ root });
  const input = { id: 'contested-run', workflow_name: 'race', user_message: '' };
  const run = await store.createWorkflowRun(input);
  const head = await store.getWorkflowEventHead();
  await store.persistWorkflowEvent({ workflow_run_id: run.id, event_type: 'workflow_started' });
  await store.cancelWorkflowRun(run.id);
  const committed = await store.listWorkflowEvents(run.id);

  const isRunArchived = commitModule.isRunArchived;
  let observed!: () => void;
  const observation = new Promise<void>(resolve => (observed = resolve));
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  const check = spyOn(commitModule, 'isRunArchived').mockImplementation(async (...args) => {
    const archived = await isRunArchived(...args);
    observed();
    await gate;
    return archived;
  });
  try {
    const creation = store.createWorkflowRun(input).then(
      () => 'created',
      (error: Error) => error.message
    );
    await observation;
    expect(await isRunArchived(root, run.id)).toBe(false);
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import {createFileWorkflowStore} from ${JSON.stringify(join(import.meta.dir, 'store.ts'))};
const store=await createFileWorkflowStore({root:${JSON.stringify(root)}});
await store.deleteWorkflowRun(${JSON.stringify(run.id)});`,
      ],
      { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LOG_LEVEL: 'info' } }
    );
    // Hold creation until the deletion has either finished or is waiting on the store lock.
    let waiting!: () => void;
    const lockWait = new Promise<void>(resolve => (waiting = resolve));
    const stdout = (async () => {
      let output = '';
      for await (const chunk of child.stdout) {
        output += new TextDecoder().decode(chunk);
        if (output.includes('file_store.lock_wait')) waiting();
      }
    })();
    await Promise.race([child.exited, lockWait]);
    release();
    const [outcome, exit, stderr] = await Promise.all([
      creation,
      child.exited,
      new Response(child.stderr).text(),
      stdout,
    ]);
    expect(stderr).not.toContain('Error');
    expect(exit).toBe(0);
    expect(outcome).toBe('Duplicate run');
  } finally {
    check.mockRestore();
  }
  expect(await store.getWorkflowRun(run.id)).toBeNull();
  let cursor = head;
  for (const event of committed) {
    const page = await store.readWorkflowEventsAfter(cursor, { limit: 1 });
    expect(page.events.map(row => row.event)).toEqual([event]);
    cursor = page.next;
  }
  expect((await store.readWorkflowEventsAfter(cursor, { limit: 1 })).events).toEqual([]);
}, 30000);
