import { expect, mock, spyOn, test } from 'bun:test';
import * as isolation from '@archon/isolation';
import { hostname, tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { getArchonHome, getRunArtifactsDirForRoot } from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from '@archon/workflows/file-store';
import { FAN_OUT_CANCEL_REASONS, type IWorkflowStore } from '@archon/workflows/store';
import { enterRunExecution } from '@archon/workflows/run-scratch';
import {
  isTerminalRunStatus,
  RESUMABLE_WORKFLOW_STATUSES,
  workflowRunStatusSchema,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import { mockWorkflowRun } from '../../test/mocks/workflow-run';
import { createRunResourceRelease, VERIFICATION_IMAGE_RECORD_DIR } from './run-verification-images';

const trackTempRoot = trackTempRoots();

// A run's output_root is trusted only inside ARCHON_HOME, a scratch directory under test.
const outputRoot = () => trackTempRoot(mkdtempSync(join(getArchonHome(), 'image-run-')));

/** A fresh output root holding the run's image record, as `docker build --iidfile` writes it. */
function recordImage(runId: string): string {
  const root = outputRoot();
  const record = join(getRunArtifactsDirForRoot(root, runId), VERIFICATION_IMAGE_RECORD_DIR);
  mkdirSync(record, { recursive: true });
  writeFileSync(join(record, 'check'), 'sha256:built');
  return root;
}

function recordedRun<T extends Partial<WorkflowRun>>(overrides: T): WorkflowRun & T {
  const run = { ...mockWorkflowRun, ...overrides };
  return { ...run, output_root: recordImage(run.id) };
}

/** The file store records no output root; serve the run as one that recorded an image. */
function withRecordedImage(store: Pick<IWorkflowStore, 'getWorkflowRun'>, runId: string) {
  const output_root = recordImage(runId);
  return {
    getWorkflowRun: async (id: string) => {
      const run = await store.getWorkflowRun(id);
      return run && { ...run, output_root };
    },
  };
}

const CONTAINER = { isolation: 'container', isolation_env_id: 'env-a' } as const;

test.each([
  ['host', 'completed', 'no record'],
  ['host', 'cancelled', 'empty record'],
  ['host', 'completed', 'subdirectory only'],
  ['container', 'completed', 'no record'],
  ['container', 'cancelled', 'empty record'],
] as const)(
  'a %s run that recorded no image never asks Docker (%s, %s)',
  async (isolationKind, status, record) => {
    const root = outputRoot();
    const run = {
      ...mockWorkflowRun,
      status,
      output_root: root,
      metadata: {
        execution_owner: { host: hostname(), pid: process.pid },
        ...(isolationKind === 'container' ? CONTAINER : {}),
      },
    };
    if (record !== 'no record')
      mkdirSync(
        join(
          getRunArtifactsDirForRoot(root, run.id),
          VERIFICATION_IMAGE_RECORD_DIR,
          record === 'subdirectory only' ? 'backend' : ''
        ),
        { recursive: true }
      );
    const docker = spyOn(isolation, 'dockerCli').mockRejectedValue(
      new Error('Cannot connect to the Docker daemon')
    );
    const warning = spyOn(console, 'error').mockImplementation(() => {});
    const ownerRelease = mock(async (_id: string, _env: string) => {});
    try {
      const cleanup = createRunResourceRelease({ getWorkflowRun: async () => run });
      await expect(cleanup(run.id, ownerRelease)).resolves.toBeUndefined();
      expect(docker).not.toHaveBeenCalled();
      expect(ownerRelease).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      docker.mockRestore();
    }
  }
);

test.each(workflowRunStatusSchema.options)(
  'fresh %s status controls Docker cleanup',
  async status => {
    const run = recordedRun({
      status,
      metadata: { execution_owner: { host: hostname(), pid: process.pid } },
    });
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
  const run = recordedRun({ status: 'completed' as const, metadata });
  await createRunResourceRelease({ getWorkflowRun: async () => run }, release)(run.id);
  expect(release).not.toHaveBeenCalled();
});

test('nested executions retain images until both leave, with precise container identity', async () => {
  const run = recordedRun({
    status: 'cancelled' as const,
    metadata: {
      execution_owner: { host: hostname(), pid: process.pid },
      isolation: 'container',
      isolation_env_id: 'env-a',
    },
  });
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
    const run = recordedRun({
      status: 'completed' as const,
      metadata: {
        execution_owner: { host: hostname(), pid: process.pid },
        isolation: 'container',
        isolation_env_id,
      },
    });
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
  const run = recordedRun({
    status: 'completed' as const,
    metadata: { execution_owner: { host: hostname(), pid: process.pid } },
  });
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
  await createRunResourceRelease(withRecordedImage(store, run.id), release)(run.id);
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
    await createRunResourceRelease(withRecordedImage(store, run.id), release)(run.id);
    expect(deletedDuringExecution).toBe(false);
    expect(release).not.toHaveBeenCalled();
    expect((await store.recoverCancelledFanOutRun(run.id)).status).toBe('running');
  }
);

test.each([...FAN_OUT_CANCEL_REASONS])(
  'a completed run with stale %s metadata still releases images',
  async reason => {
    const run = recordedRun({
      status: 'completed' as const,
      metadata: {
        execution_owner: { host: hostname(), pid: process.pid },
        cancelled_reason: reason,
      },
    });
    const release = mock(async (_id: string, _env?: string) => {});
    await createRunResourceRelease({ getWorkflowRun: async () => run }, release)(run.id);
    expect(release.mock.calls).toEqual([[run.id, undefined]]);
  }
);

test.each([
  ['completed', 'daemon unavailable'],
  ['cancelled', 'daemon unavailable'],
  ['completed', 'arbitrary inventory failure'],
] as const)(
  'a %s host run that recorded an image warns when inventory fails: %s',
  async (status, message) => {
    const docker = spyOn(isolation, 'dockerCli').mockRejectedValue(new Error(message));
    const warning = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const run = recordedRun({
        status,
        metadata: { execution_owner: { host: hostname(), pid: process.pid } },
      });
      const cleanup = createRunResourceRelease({ getWorkflowRun: async () => run });
      const warnings = await cleanup(run.id);
      expect(warnings).toEqual([expect.any(String)]);
      const text = warning.mock.calls.flat().join(' ');
      expect(warnings).toEqual([text]);
      expect(text).toContain(run.id);
      expect(text).toContain('inconclusive');
      expect(warning).toHaveBeenCalledTimes(1);
      expect(docker).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
      docker.mockRestore();
    }
  }
);

test.each(workflowRunStatusSchema.options)(
  'container %s cleanup without an owner never calls host Docker',
  async status => {
    const run = recordedRun({
      status,
      metadata: {
        execution_owner: { host: hostname(), pid: process.pid },
        isolation: 'container',
        isolation_env_id: 'env-a',
      },
    });
    const docker = spyOn(isolation, 'dockerCli').mockRejectedValue(new Error('wrong daemon'));
    try {
      const cleanup = createRunResourceRelease({ getWorkflowRun: async () => run });
      if (isTerminalRunStatus(status) && !RESUMABLE_WORKFLOW_STATUSES.includes(status)) {
        await expect(cleanup(run.id)).rejects.toThrow('Missing container resource owner');
      } else {
        await expect(cleanup(run.id)).resolves.toBeUndefined();
      }
      expect(docker).not.toHaveBeenCalled();
    } finally {
      docker.mockRestore();
    }
  }
);

test.each(['inspect', 'container-use', 'removal', 'container-inventory', 'isolation-container'])(
  '%s failure remains fatal at the run cleanup boundary',
  async stage => {
    const container = stage === 'container-inventory' || stage === 'isolation-container';
    const run = recordedRun({
      status: 'completed' as const,
      metadata: {
        execution_owner: { host: hostname(), pid: process.pid },
        ...(container ? { isolation: 'container', isolation_env_id: 'env-a' } : {}),
      },
    });
    const failure = new Error('same Docker failure');
    const warning = spyOn(console, 'error').mockImplementation(() => {});
    const runner: isolation.DockerRunner = async args => {
      if (
        (stage === 'inspect' && args[1] === 'inspect') ||
        (stage === 'container-use' && args[0] === 'container') ||
        (stage === 'removal' && args[1] === 'rm') ||
        (stage === 'container-inventory' && args[0] === 'image' && args[1] === 'ls') ||
        (stage === 'isolation-container' && args[0] === 'container')
      )
        throw failure;
      return {
        stdout:
          args[0] === 'container'
            ? ''
            : args[1] === 'ls'
              ? 'sha256:owned'
              : JSON.stringify({ id: 'sha256:owned', parent: '', owner: run.id }),
        stderr: '',
      };
    };
    try {
      const cleanup = createRunResourceRelease({ getWorkflowRun: async () => run }, (id, env) =>
        isolation.releaseRunVerificationImages(id, env, runner)
      );
      const error = await cleanup(run.id).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw new Error('Expected cleanup failure');
      expect(error.errors[0]).toBe(failure);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  }
);

test.each([false, true])('container owner overrides host cleanup (failure=%s)', async fails => {
  const run = recordedRun({
    status: 'completed' as const,
    metadata: {
      execution_owner: { host: hostname(), pid: process.pid },
      isolation: 'container',
      isolation_env_id: 'env-owned',
    },
  });
  const hostRelease = mock(async () => {
    throw new Error('wrong daemon');
  });
  const failure = new isolation.VerificationImageInventoryError(run.id, new Error('owner offline'));
  const ownerRelease = mock(async (_id: string, _env: string) => {
    if (fails) throw failure;
  });
  const cleanup = createRunResourceRelease({ getWorkflowRun: async () => run }, hostRelease);
  const result = cleanup(run.id, ownerRelease);
  if (fails) await expect(result).rejects.toBe(failure);
  else await result;
  expect(ownerRelease.mock.calls).toEqual([[run.id, 'env-owned']]);
  expect(hostRelease).not.toHaveBeenCalled();
});

test('container callback cannot change host cleanup ownership', async () => {
  const run = recordedRun({
    status: 'completed' as const,
    metadata: { execution_owner: { host: hostname(), pid: process.pid } },
  });
  const hostRelease = mock(async (_id: string, _env?: string) => {});
  const ownerRelease = mock(async (_id: string, _env: string) => {});
  await createRunResourceRelease({ getWorkflowRun: async () => run }, hostRelease)(
    run.id,
    ownerRelease
  );
  expect(hostRelease.mock.calls).toEqual([[run.id, undefined]]);
  expect(ownerRelease).not.toHaveBeenCalled();
});

test.each(workflowRunStatusSchema.options)(
  'backend callback respects %s eligibility and writer shutdown',
  async status => {
    const run = recordedRun({
      status,
      metadata: {
        execution_owner: { host: hostname(), pid: process.pid },
        isolation: 'container',
        isolation_env_id: 'env-owned',
      },
    });
    const hostRelease = mock(async () => {
      throw new Error('wrong daemon');
    });
    const ownerRelease = mock(async (_id: string, _env: string) => {});
    const cleanup = createRunResourceRelease({ getWorkflowRun: async () => run }, hostRelease);
    const leave = enterRunExecution(run.id);
    try {
      await cleanup(run.id, ownerRelease);
      expect(ownerRelease).not.toHaveBeenCalled();
    } finally {
      leave();
    }
    await cleanup(run.id, ownerRelease);
    expect(ownerRelease.mock.calls).toEqual(
      isTerminalRunStatus(status) && !RESUMABLE_WORKFLOW_STATUSES.includes(status)
        ? [[run.id, 'env-owned']]
        : []
    );
    expect(hostRelease).not.toHaveBeenCalled();
  }
);
