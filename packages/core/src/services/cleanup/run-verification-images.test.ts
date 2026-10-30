import { expect, mock, test } from 'bun:test';
import { hostname } from 'node:os';
import { enterRunExecution } from '@archon/workflows/run-scratch';
import {
  isTerminalRunStatus,
  workflowRunStatusSchema,
} from '@archon/workflows/schemas/workflow-run';
import { mockWorkflowRun } from '../../test/mocks/workflow-run';
import { createRunResourceRelease } from './run-verification-images';

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
    expect(release.mock.calls).toEqual(isTerminalRunStatus(status) ? [[run.id, undefined]] : []);
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
      status: 'failed' as const,
      metadata: {
        execution_owner: { host: hostname(), pid: process.pid },
        isolation: 'container',
        isolation_env_id,
      },
    };
    await createRunResourceRelease({ getWorkflowRun: async () => run }, release)(run.id);
    expect(release).not.toHaveBeenCalled();
  }
);

test('missing rows and failed lookups or Docker calls never fail terminal work', async () => {
  const release = mock(async (_id: string) => {
    throw new Error('Docker unavailable');
  });
  await createRunResourceRelease({ getWorkflowRun: async () => null }, release)('missing');
  expect(release).not.toHaveBeenCalled();
  await createRunResourceRelease(
    {
      getWorkflowRun: async () => {
        throw new Error('store unavailable');
      },
    },
    release
  )('missing');
  const run = {
    ...mockWorkflowRun,
    status: 'completed' as const,
    metadata: { execution_owner: { host: hostname(), pid: process.pid } },
  };
  await createRunResourceRelease({ getWorkflowRun: async () => run }, release)(run.id);
  expect(release).toHaveBeenCalledWith(run.id, undefined);
});
