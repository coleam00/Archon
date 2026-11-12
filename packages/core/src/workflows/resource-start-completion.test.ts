import { expect, spyOn, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { PreparedWorkflowLaunch } from '@archon/workflows/schemas/resource-start';
import { createFileWorkflowHost } from './file-host';
import { drainAfterResourceStart } from './resource-start-completion';

const roots = trackTempRoots();

test('completion resolves direct admissions from their recorded host without a receipt', async () => {
  const host = await createFileWorkflowHost(roots(await mkdtemp(join(tmpdir(), 'completion-'))));
  const launch: PreparedWorkflowLaunch = {
    version: 2,
    run: {
      id: crypto.randomUUID(),
      workflow_name: 'test',
      codebase_id: 'project',
      user_message: '',
      metadata: {},
    },
    execution: { cwd: '/project', conversationId: 'test', isolation: { kind: 'in-place' } },
  };
  const store = host.deps.store;
  await store.admitResourceStart({
    resource: 'one',
    capacity: 1,
    hostId: 'recorded-host',
    overlap: 'queue',
    launch,
  });
  const hosts: string[] = [];
  const drain = async (hostId: string) => {
    hosts.push(hostId);
  };
  await drainAfterResourceStart(host, launch.run.id, drain);
  expect(hosts).toEqual(['recorded-host']);
  await drainAfterResourceStart(host, 'ordinary-run', drain);
  expect(hosts).toEqual(['recorded-host']);
  const child = await store.createWorkflowRun({
    workflow_name: 'child',
    user_message: '',
    parent_run_id: launch.run.id,
  });
  await drainAfterResourceStart(host, child.id, drain);
  expect(hosts).toEqual(['recorded-host', 'recorded-host']);

  const queued = { ...launch, run: { ...launch.run, id: crypto.randomUUID() } };
  await store.admitResourceStart({
    resource: 'one',
    capacity: 1,
    hostId: 'other-host',
    overlap: 'queue',
    launch: queued,
  });
  await drainAfterResourceStart(host, queued.run.id, drain);
  expect(hosts).toEqual(['recorded-host', 'recorded-host']);
  const read = spyOn(store, 'getResourceStartRequest').mockRejectedValueOnce(
    new Error('unreadable admission')
  );
  try {
    await expect(drainAfterResourceStart(host, launch.run.id, drain)).rejects.toThrow(
      'unreadable admission'
    );
    expect(hosts).toEqual(['recorded-host', 'recorded-host']);
  } finally {
    read.mockRestore();
  }
});
