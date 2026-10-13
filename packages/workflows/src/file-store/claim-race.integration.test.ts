import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from './store';
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
