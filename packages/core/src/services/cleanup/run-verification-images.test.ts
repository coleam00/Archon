import { expect, mock, test } from 'bun:test';
import { hostname, tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from '@archon/workflows/file-store';
import { enterRunExecution } from '@archon/workflows/run-scratch';
import {
  isTerminalRunStatus,
  RESUMABLE_WORKFLOW_STATUSES,
  workflowRunStatusSchema,
} from '@archon/workflows/schemas/workflow-run';
import { mockWorkflowRun } from '../../test/mocks/workflow-run';
import { createRunResourceRelease } from './run-verification-images';

const trackTempRoot = trackTempRoots();

test.each(workflowRunStatusSchema.options)(
  'fresh %s status controls Docker cleanup',
  async status => {
    const run = {
      ...mockWorkflowRun,
      status,
      metadata: { execution_owner: { host: hostname(), pid: process.pid } },
    };
    const release = mock(async (_id: string, _env?: string) => {});
    await createRunResourceRelease({ getWorkflowRun: async () => run }, release)(run.id);
    expect(release.mock.calls).toEqual(
      isTerminalRunStatus(status) && !RESUMABLE_WORKFLOW_STATUSES.includes(status)
        ? [[run.id, undefined]]
        : []
    );
  }
);

test.each([
  {},
  { execution_owner: { host: 'remote', pid: process.pid } },
  { execution_owner: { host: hostname(), pid: process.ppid } },
])('ambiguous or live owner keeps images', async metadata => {
  const release = mock(async (_id: string, _env?: string) => {});
  const run = { ...mockWorkflowRun, status: 'completed' as const, metadata };
  await createRunResourceRelease({ getWorkflowRun: async () => run }, release)(run.id);
  expect(release).not.toHaveBeenCalled();
});

test('nested executions retain images until both leave, with precise container identity', async () => {
  const run = {
    ...mockWorkflowRun,
    status: 'cancelled' as const,
    metadata: {
      execution_owner: { host: hostname(), pid: process.pid },
      isolation: 'container',
      isolation_env_id: 'env-a',
    },
  };
  const release = mock(async (_id: string, _env?: string) => {});
  const cleanup = createRunResourceRelease({ getWorkflowRun: async () => run }, release);
  const outer = enterRunExecution(run.id);
  const inner = enterRunExecution(run.id);
  try {
    await cleanup(run.id);
    inner();
    await cleanup(run.id);
    expect(release).not.toHaveBeenCalled();
  } finally {
    outer();
  }
  await cleanup(run.id);
  expect(release.mock.calls).toEqual([[run.id, 'env-a']]);
});

test.each([undefined, '', 42])(
  'container identity %p cannot authorize deletion',
  async isolation_env_id => {
    const release = mock(async (_id: string, _env?: string) => {});
    const run = {
      ...mockWorkflowRun,
      status: 'completed' as const,
      metadata: {
        execution_owner: { host: hostname(), pid: process.pid },
        isolation: 'container',
        isolation_env_id,
      },
    };
    await expect(
      createRunResourceRelease({ getWorkflowRun: async () => run }, release)(run.id)
    ).rejects.toThrow('Missing container identity');
    expect(release).not.toHaveBeenCalled();
  }
);

test('missing rows skip cleanup while lookup and Docker errors reach the caller', async () => {
  const release = mock(async (_id: string) => {
    throw new Error('Docker unavailable');
  });
  await createRunResourceRelease({ getWorkflowRun: async () => null }, release)('missing');
  expect(release).not.toHaveBeenCalled();
  await expect(
    createRunResourceRelease(
      {
        getWorkflowRun: async () => {
          throw new Error('store unavailable');
        },
      },
      release
    )('missing')
  ).rejects.toThrow('store unavailable');
  const run = {
    ...mockWorkflowRun,
    status: 'completed' as const,
    metadata: { execution_owner: { host: hostname(), pid: process.pid } },
  };
  await expect(
    createRunResourceRelease({ getWorkflowRun: async () => run }, release)(run.id)
  ).rejects.toThrow('Docker unavailable');
  expect(release).toHaveBeenCalledWith(run.id, undefined);
});

test('a failed run cannot authorize asynchronous deletion before a concurrent resume', async () => {
  const store = await createFileWorkflowStore({
    root: trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-image-resume-'))),
  });
  const run = await store.createWorkflowRun({ workflow_name: 'verification', user_message: '' });
  await store.claimPendingWorkflowRun(run.id);
  await store.updateWorkflowRun(run.id, {
    metadata: { execution_owner: { host: hostname(), pid: process.pid } },
  });
  await store.failWorkflowRun(run.id, 'verification failed');
  let deletedDuringExecution = false;
  const release = mock(async () => {
    await store.resumeWorkflowRun(run.id);
    const leave = enterRunExecution(run.id);
    try {
      deletedDuringExecution = (await store.getWorkflowRun(run.id))?.status === 'running';
    } finally {
      leave();
    }
  });
  await createRunResourceRelease(store, release)(run.id);
  expect(release).not.toHaveBeenCalled();
  expect(deletedDuringExecution).toBe(false);
});
