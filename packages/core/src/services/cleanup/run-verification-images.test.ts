import { expect, mock, spyOn, test } from 'bun:test';
import * as isolation from '@archon/isolation';
import { hostname, tmpdir } from 'node:os';
import { mkdtemp, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from '@archon/workflows/file-store';
import { FAN_OUT_CANCEL_REASONS } from '@archon/workflows/store';
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

test.each([...FAN_OUT_CANCEL_REASONS])(
  'a %s child retains images across same-ID recovery',
  async reason => {
    const store = await createFileWorkflowStore({
      root: trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-image-fan-out-resume-'))),
    });
    const run = await store.createWorkflowRun({ workflow_name: 'verification', user_message: '' });
    await store.claimPendingWorkflowRun(run.id);
    await store.updateWorkflowRun(run.id, {
      metadata: { execution_owner: { host: hostname(), pid: process.pid } },
    });
    await store.cancelFanOutRun(run.id, reason);
    let deletedDuringExecution = false;
    const release = mock(async () => {
      await store.recoverCancelledFanOutRun(run.id);
      deletedDuringExecution = (await store.getWorkflowRun(run.id))?.status === 'running';
    });
    await createRunResourceRelease(store, release)(run.id);
    expect(deletedDuringExecution).toBe(false);
    expect(release).not.toHaveBeenCalled();
    expect((await store.recoverCancelledFanOutRun(run.id)).status).toBe('running');
  }
);

test.each([...FAN_OUT_CANCEL_REASONS])(
  'a completed run with stale %s metadata still releases images',
  async reason => {
    const run = {
      ...mockWorkflowRun,
      status: 'completed' as const,
      metadata: {
        execution_owner: { host: hostname(), pid: process.pid },
        cancelled_reason: reason,
      },
    };
    const release = mock(async (_id: string, _env?: string) => {});
    await createRunResourceRelease({ getWorkflowRun: async () => run }, release)(run.id);
    expect(release.mock.calls).toEqual([[run.id, undefined]]);
  }
);

test.each(['completed', 'cancelled'] as const)(
  'Docker-free host skips optional cleanup for %s runs',
  async status => {
    const run = {
      ...mockWorkflowRun,
      status,
      metadata: { execution_owner: { host: hostname(), pid: process.pid } },
    };
    const previousPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const cleanup = createRunResourceRelease({ getWorkflowRun: async () => run });
      await expect(cleanup(run.id)).resolves.toBeUndefined();
    } finally {
      process.env.PATH = previousPath;
    }
  }
);

test.each([false, true])(
  'Docker disappearing after host setup remains a failure (container=%s)',
  async container => {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-docker-capability-')));
    const executable = join(root, process.platform === 'win32' ? 'docker.cmd' : 'docker');
    await writeFile(
      executable,
      process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n',
      { mode: 0o755 }
    );
    const run = {
      ...mockWorkflowRun,
      status: 'completed' as const,
      metadata: {
        execution_owner: { host: hostname(), pid: process.pid },
        ...(container ? { isolation: 'container', isolation_env_id: 'env-a' } : {}),
      },
    };
    const previousPath = process.env.PATH;
    process.env.PATH = root;
    const docker = isolation.dockerCli;
    const probe = spyOn(isolation, 'dockerCli').mockImplementation((args, options) =>
      args[0] === 'version'
        ? Promise.resolve({ stdout: '28.0.0', stderr: '' })
        : docker(args, options)
    );
    try {
      await expect(docker(['version', '--format', '{{.Server.Version}}'])).resolves.toEqual({
        stdout: '',
        stderr: '',
      });
      const cleanup = createRunResourceRelease({ getWorkflowRun: async () => run });
      expect(probe).toHaveBeenCalledWith(
        ['version', '--format', '{{.Server.Version}}'],
        expect.objectContaining({ timeout: 10_000 })
      );
      await unlink(executable);
      await expect(cleanup(run.id)).rejects.toThrow('Verification image cleanup failed');
    } finally {
      probe.mockRestore();
      process.env.PATH = previousPath;
    }
  }
);

test.skipIf(!Bun.which('docker'))(
  'a Docker CLI without a reachable daemon does not fail completed or cancelled host runs',
  async () => {
    const previousHost = process.env.DOCKER_HOST;
    const previousContext = process.env.DOCKER_CONTEXT;
    process.env.DOCKER_HOST = 'tcp://127.0.0.1:1';
    process.env.DOCKER_CONTEXT = '';
    try {
      for (const status of ['completed', 'cancelled'] as const) {
        const run = {
          ...mockWorkflowRun,
          status,
          metadata: { execution_owner: { host: hostname(), pid: process.pid } },
        };
        await expect(
          createRunResourceRelease({ getWorkflowRun: async () => run })(run.id)
        ).resolves.toBeUndefined();
      }
      const run = {
        ...mockWorkflowRun,
        status: 'completed' as const,
        metadata: {
          execution_owner: { host: hostname(), pid: process.pid },
          isolation: 'container',
          isolation_env_id: 'env-a',
        },
      };
      await expect(
        createRunResourceRelease({ getWorkflowRun: async () => run })(run.id)
      ).rejects.toThrow('Verification image cleanup failed');
    } finally {
      if (previousHost === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = previousHost;
      if (previousContext === undefined) delete process.env.DOCKER_CONTEXT;
      else process.env.DOCKER_CONTEXT = previousContext;
    }
  }
);

test('host cleanup discovers images when Docker becomes reachable during execution', async () => {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-docker-start-')));
  await writeFile(join(root, process.platform === 'win32' ? 'docker.cmd' : 'docker'), '', {
    mode: 0o755,
  });
  const previousPath = process.env.PATH;
  process.env.PATH = root;
  const docker = spyOn(isolation, 'dockerCli')
    .mockRejectedValueOnce(new Error('daemon not running at host setup'))
    .mockResolvedValue({ stdout: '', stderr: '' });
  try {
    const run = {
      ...mockWorkflowRun,
      status: 'completed' as const,
      metadata: { execution_owner: { host: hostname(), pid: process.pid } },
    };
    await createRunResourceRelease({ getWorkflowRun: async () => run })(run.id);
    expect(docker.mock.calls.map(([args]) => args)).toEqual([
      ['version', '--format', '{{.Server.Version}}'],
      ['version', '--format', '{{.Server.Version}}'],
      [
        'image',
        'ls',
        '--all',
        '--quiet',
        '--no-trunc',
        '--filter',
        `label=archon.run_id=${run.id}`,
      ],
    ]);
  } finally {
    docker.mockRestore();
    process.env.PATH = previousPath;
  }
});

test('container cleanup requires Docker even when the host started without it', async () => {
  const run = {
    ...mockWorkflowRun,
    status: 'completed' as const,
    metadata: {
      execution_owner: { host: hostname(), pid: process.pid },
      isolation: 'container',
      isolation_env_id: 'env-a',
    },
  };
  const emptyPath = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-no-docker-')));
  const previousPath = process.env.PATH;
  process.env.PATH = emptyPath;
  try {
    const cleanup = createRunResourceRelease({ getWorkflowRun: async () => run });
    await expect(cleanup(run.id)).rejects.toThrow('Verification image cleanup failed');
  } finally {
    process.env.PATH = previousPath;
  }
});
