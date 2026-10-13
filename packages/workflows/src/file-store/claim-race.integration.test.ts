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
