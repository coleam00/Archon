import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowHost } from '@archon/core/workflows/file-host';
import { isRunOwnedByThisProcess } from '@archon/core/services/run-live-owner';
import { registerHostProviders } from '@archon/core/providers/register-host-providers';
import { clearRegistry } from '@archon/providers';
import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { defaultPlatformPolicies } from '@archon/adapters/platform-policies';
import { ContainerBackend } from '@archon/isolation';
import * as credentials from '@archon/workflows/run-preflight';
import * as subprocess from '@archon/workflows/subprocess';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowResumeOptions } from '@archon/workflows/engine-port';
import { makeTestResolvedWorkflow } from '@archon/workflows/test-utils';
import { executionClaim } from '@archon/workflows/store';
import { captureCommand } from '../test-support/command';
import { CLIAdapter } from '../adapters/cli-adapter';
import * as receipts from '../utils/detached-resume-receipt';
import { workflowRunCommand } from './workflow-run-owned';
import * as preflight from './workflow-run-preflight';
import * as launch from './workflow-run-launch';
import { OwnedRunLease } from '../utils/owned-run-lease';

const roots = trackTempRoots();
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  clearRegistry();
});
function watch<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}

async function fixture(body: (f: Awaited<ReturnType<typeof prepare>>) => Promise<void>) {
  const root = roots(await realpath(await mkdtemp(join(tmpdir(), 'container-resume-'))));
  const result = await captureCommand({ ARCHON_HOME: join(root, 'home') }, async () => {
    setPlatformPolicies(defaultPlatformPolicies);
    await registerHostProviders();
    await body(await prepare(root));
  });
  expect(result.status, result.output).toBe(0);
}

async function prepare(root: string) {
  const cwd = join(root, 'folder');
  await mkdir(join(cwd, '.archon/workflows'), { recursive: true });
  await writeFile(
    join(cwd, '.archon/workflows/resume.yaml'),
    'name: resume\ndescription: resume proof\nnodes:\n  - id: first\n    bash: echo first\n  - id: second\n    depends_on: [first]\n    bash: echo second\n'
  );
  const host = await createFileWorkflowHost(join(root, 'store'));
  const codebase = await host.records.codebases.createCodebase({
    name: 'folder',
    default_cwd: cwd,
    kind: 'folder',
  });
  const store = host.deps.store;
  const envId = 'retained-overlay';
  const overlay = { contents: 'unapplied edits' };
  const resume = watch(spyOn(ContainerBackend.prototype, 'resumeEnv')).mockImplementation(
    async id => {
      expect(id).toBe(envId);
      return {
        cwd,
        execContext: { kind: 'container', containerId: 'restarted' },
        envId,
        overlayMode: 'native',
      };
    }
  );
  const destroy = watch(spyOn(ContainerBackend.prototype, 'destroy')).mockResolvedValue();
  const suspend = watch(spyOn(ContainerBackend.prototype, 'suspend')).mockResolvedValue();
  watch(spyOn(ContainerBackend.prototype, 'finalize')).mockResolvedValue({
    requiresApproval: false,
  });
  const apply = watch(spyOn(ContainerBackend.prototype, 'applyChanges')).mockImplementation(
    async id => {
      expect(id).toBe(envId);
      expect(overlay.contents).toBe('unapplied edits');
      return { filesApplied: 1, filesDeleted: 0, warnings: [] };
    }
  );
  const discard = watch(spyOn(ContainerBackend.prototype, 'discardChanges')).mockResolvedValue();
  const auth = watch(spyOn(credentials, 'assertRunCredentials')).mockResolvedValue();
  const execute = watch(spyOn(subprocess, 'runSubprocess')).mockImplementation(async context => {
    expect(context).toEqual({ kind: 'container', containerId: 'restarted' });
    return { stdout: 'second', stderr: '', credentialValues: [] };
  });
  async function paused(decision?: 'approved' | 'rejected') {
    const run = await store.createWorkflowRun({
      workflow_name: 'resume',
      user_message: '',
      codebase_id: codebase.id,
      metadata: { isolation: 'container', isolation_env_id: envId },
    });
    await store.claimPendingWorkflowRun(run.id, cwd);
    await store.persistWorkflowEvent({
      workflow_run_id: run.id,
      event_type: 'node_completed',
      step_name: 'first',
      data: { node_output: 'first' },
    });
    if (decision)
      await store.persistWorkflowEvent({
        workflow_run_id: run.id,
        event_type: 'node_completed',
        step_name: 'second',
        data: { node_output: 'second' },
      });
    await store.pauseWorkflowRun(
      run.id,
      {
        type: decision ? 'writeback' : 'approval',
        nodeId: decision ? '__writeback__' : 'review',
        message: 'Review',
        pauseId: 'original-pause',
        ...(decision ? { resolved: decision } : {}),
      },
      decision ? { pending_writeback: { envId }, decision_evidence: decision } : {}
    );
    const candidate = await store.getWorkflowRun(run.id);
    if (!candidate) throw new Error('Missing paused run');
    return candidate;
  }
  const accepted = mock((_runId: string) => {});
  watch(spyOn(receipts, 'consumeDetachedResumeReceiptRequest')).mockReturnValue(accepted);
  const command = (run: WorkflowRun) =>
    workflowRunCommand(host, cwd, 'resume', '', {
      resume: true,
      continuationRun: run,
      folder: true,
      quiet: true,
    });
  return {
    accepted,
    host,
    store,
    cwd,
    envId,
    overlay,
    resume,
    destroy,
    suspend,
    apply,
    discard,
    auth,
    execute,
    paused,
    command,
  };
}

test('two commands with the same candidate restart only the admitted container', async () => {
  await fixture(async f => {
    const candidate = await f.paused();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const restart = f.resume.getMockImplementation()!;
    let restarts = 0;
    f.resume.mockImplementation(async id => {
      if (++restarts === 1) {
        entered.resolve();
        await finish.promise;
      }
      return restart(id);
    });
    const listeners = process.listenerCount('SIGTERM');
    const winner = f.command(candidate).then(
      () => undefined,
      error => error
    );
    try {
      await entered.promise;
      expect(process.listenerCount('SIGTERM')).toBe(listeners + 1);
      expect(isRunOwnedByThisProcess(candidate.id)).toBe(false);
      const loser = f.command(candidate);
      // A second restart is allowed through to expose pre-admission provisioning.
      await loser.catch(() => {});
      expect(f.resume).toHaveBeenCalledTimes(1);
      expect(f.destroy).not.toHaveBeenCalled();
      expect(f.suspend).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.accepted).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      const error = await winner;
      if (f.resume.mock.calls.length === 1) expect(error).toBeUndefined();
    }
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.accepted).toHaveBeenCalledTimes(1);
    expect(f.accepted).toHaveBeenCalledWith(candidate.id);
    expect(f.destroy).toHaveBeenCalledTimes(1);
  });
});

test('a stale candidate never restarts or tears down another execution', async () => {
  await fixture(async f => {
    const candidate = await f.paused();
    const admitted = await f.store.resumeWorkflowRun(candidate.id);
    await f.command(candidate);
    expect(f.resume).not.toHaveBeenCalled();
    expect(f.destroy).not.toHaveBeenCalled();
    expect(f.suspend).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(executionClaim((await f.store.getWorkflowRun(candidate.id))?.metadata ?? {})).toBe(
      executionClaim(admitted.metadata)
    );
  });
});

test.each([undefined, 'approved', 'rejected'] as const)(
  'successful continuation with decision %s retains prepared context',
  async decision => {
    await fixture(async f => {
      const candidate = await f.paused(decision);
      await f.command(
        decision
          ? candidate
          : {
              ...candidate,
              metadata: { ...candidate.metadata, isolation_env_id: 'stale-candidate-env' },
            }
      );
      expect(f.resume).toHaveBeenCalledTimes(1);
      expect(f.auth).toHaveBeenLastCalledWith(f.host.deps, expect.anything(), {
        cwd: f.cwd,
        execContext: { kind: 'container', containerId: 'restarted' },
      });
      expect(f.execute).toHaveBeenCalledTimes(decision ? 0 : 1);
      expect(f.apply).toHaveBeenCalledTimes(decision === 'approved' ? 1 : 0);
      expect(f.discard).toHaveBeenCalledTimes(decision === 'rejected' ? 1 : 0);
      expect((await f.store.getWorkflowRun(candidate.id))?.status).toBe('completed');
      expect(
        (await f.store.listWorkflowEvents(candidate.id)).find(
          event => event.event_type === 'container_resumed'
        )?.data
      ).toMatchObject({ overlayMode: 'native', containerId: 'restarted' });
      expect(f.destroy).toHaveBeenCalledTimes(1);
    });
  }
);

test.each(['restart', 'credentials'] as const)(
  '%s rejection preserves pause, decisions and overlay and permits retry',
  async failure => {
    await fixture(async f => {
      const candidate = await f.paused('approved');
      const beforeEvents = await f.store.listWorkflowEvents(candidate.id);
      if (failure === 'restart') f.resume.mockRejectedValueOnce(new Error('restart refused'));
      else {
        f.auth.mockImplementation(async (...args) => {
          if (typeof args[2] === 'object' && args[2]?.execContext?.kind === 'container')
            throw new Error('credentials refused');
          return;
        });
      }
      await expect(f.command(candidate)).rejects.toThrow(
        `${failure === 'restart' ? 'restart' : 'credentials'} refused`
      );
      expect(await f.store.getWorkflowRun(candidate.id)).toEqual(candidate);
      expect(await f.store.listWorkflowEvents(candidate.id)).toEqual(beforeEvents);
      expect(f.overlay.contents).toBe('unapplied edits');
      expect(f.destroy).not.toHaveBeenCalled();
      expect(f.suspend).not.toHaveBeenCalled();
      expect(f.apply).not.toHaveBeenCalled();
      expect(f.accepted).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
      f.auth.mockResolvedValue();
      await f.command(candidate);
      expect(f.apply).toHaveBeenCalledTimes(1);
      expect((await f.store.getWorkflowRun(candidate.id))?.metadata.writeback_outcome).toBe(
        'applied'
      );
    });
  }
);

for (const stage of ['admission', 'restart', 'credentials', 'conversation', 'lease'] as const) {
  for (const successor of stage === 'admission' ? [false] : [false, true]) {
    test.each(['SIGINT', 'SIGTERM'] as const)(
      `resume interruption during ${stage} preserves ${successor ? 'successor' : 'pause'} on %s`,
      async signal => {
        await fixture(async f => {
          const candidate = await f.paused('approved');
          let events = await f.store.listWorkflowEvents(candidate.id);
          const baseline = process.listeners(signal);
          const entered = Promise.withResolvers<void>();
          const finish = Promise.withResolvers<void>();
          const block = async () => {
            entered.resolve();
            await finish.promise;
          };
          if (stage === 'admission') {
            const resume = f.host.engine.resume.bind(f.host.engine);
            watch(spyOn(f.host.engine, 'resume')).mockImplementationOnce(async input => {
              await block();
              return resume(input);
            });
          } else if (stage === 'restart') {
            const restart = f.resume.getMockImplementation()!;
            f.resume.mockImplementationOnce(async id => {
              await block();
              return restart(id);
            });
          } else if (stage === 'credentials') {
            f.auth.mockImplementation(async (...args) => {
              if (typeof args[2] === 'object' && args[2]?.execContext?.kind === 'container')
                await block();
            });
          } else if (stage === 'conversation') {
            watch(spyOn(launch, 'recordConversationLaunch')).mockImplementationOnce(block);
          } else watch(spyOn(OwnedRunLease.prototype, 'start')).mockImplementationOnce(block);
          const pending = f.command(candidate).catch(error => error);
          let expected = candidate;
          try {
            await entered.promise;
            if (successor) {
              await f.store.pauseWorkflowRun(candidate.id, {
                type: 'approval',
                nodeId: 'successor',
                message: 'Review',
                pauseId: 'new-pause',
              });
              expected = await f.store.resumeWorkflowRun(candidate.id);
              events = await f.store.listWorkflowEvents(candidate.id);
            }
            const handlers = process
              .listeners(signal)
              .filter(handler => !baseline.includes(handler));
            expect(handlers).toHaveLength(1);
            handlers[0]?.(signal);
          } finally {
            finish.resolve();
          }
          const error = await pending;
          expect(error).toBeInstanceOf(Error);
          const interruption = { message: `Resume preparation interrupted (${signal})` };
          expect(error).toMatchObject({
            cause: successor ? { cause: interruption } : interruption,
          });
          if (successor) expect(error.message).toContain('lost execution ownership');
          expect(f.resume).toHaveBeenCalledTimes(stage === 'admission' ? 0 : 1);
          expect(await f.store.getWorkflowRun(candidate.id)).toEqual(expected);
          expect(await f.store.listWorkflowEvents(candidate.id)).toEqual(events);
          expect(f.overlay.contents).toBe('unapplied edits');
          expect(f.destroy).not.toHaveBeenCalled();
          expect(f.suspend).not.toHaveBeenCalled();
          expect(f.apply).not.toHaveBeenCalled();
          expect(f.accepted).not.toHaveBeenCalled();
          expect(f.execute).not.toHaveBeenCalled();
          expect(process.listeners(signal)).toEqual(baseline);
          if (!successor) {
            f.auth.mockResolvedValue();
            await f.command(candidate);
            expect(f.apply).toHaveBeenCalledTimes(1);
          }
        });
      }
    );
  }
}

test('invalid prepared options undo admission before execution', async () => {
  await fixture(async f => {
    const candidate = await f.paused();
    const events = await f.store.listWorkflowEvents(candidate.id);
    const options: WorkflowResumeOptions = {};
    Reflect.set(options, 'preCreatedRun', candidate);
    await expect(
      f.host.engine.resume({
        platform: new CLIAdapter(),
        conversationId: 'resume-proof',
        cwd: f.cwd,
        userMessage: '',
        run: candidate,
        legacyWorkflow: makeTestResolvedWorkflow({ name: 'resume' }),
        prepareExecution: async admitted => {
          expect(admitted.status).toBe('running');
          expect(executionClaim(admitted.metadata)).not.toBe(executionClaim(candidate.metadata));
          return { cwd: f.cwd, options };
        },
      })
    ).rejects.toThrow("Cannot supply 'preCreatedRun'");
    expect(await f.store.getWorkflowRun(candidate.id)).toEqual(candidate);
    expect(await f.store.listWorkflowEvents(candidate.id)).toEqual(events);
    expect(f.execute).not.toHaveBeenCalled();
  });
});

test.each([false, true])(
  'preparation preserves caller container options (partial: %s)',
  async partial => {
    await fixture(async f => {
      const candidate = await f.paused();
      const admission = await f.host.engine.resume({
        platform: new CLIAdapter(),
        conversationId: 'resume-proof',
        cwd: f.cwd,
        userMessage: '',
        run: candidate,
        legacyWorkflow: makeTestResolvedWorkflow({
          name: 'resume',
          nodes: [{ id: 'second', bash: 'echo second' }],
        }),
        options: {
          execContext: { kind: 'container', containerId: 'restarted' },
          container: {
            envId: f.envId,
            writeBack: 'auto',
            backend: {
              suspend: f.suspend,
              prepareSuspend: async () => async () => undefined,
              finalize: async () => ({ requiresApproval: false }),
              applyChanges: f.apply,
              discardChanges: f.discard,
            },
          },
        },
        prepareExecution: async () => ({
          cwd: f.cwd,
          ...(partial ? { options: { codebaseId: candidate.codebase_id ?? undefined } } : {}),
        }),
      });
      if (!admission.accepted) throw new Error('Expected admission');
      expect(await admission.settled).toMatchObject({ success: true });
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(f.execute.mock.calls[0]?.[0]).toEqual({ kind: 'container', containerId: 'restarted' });
    });
  }
);

test.each(['execContext', 'container', 'both'] as const)(
  'preparation replaces container isolation as a unit (%s)',
  async field => {
    await fixture(async f => {
      const candidate = await f.paused(field === 'both' ? 'approved' : undefined);
      const events = await f.store.listWorkflowEvents(candidate.id);
      const container = {
        envId: f.envId,
        writeBack: 'auto' as const,
        backend: {
          suspend: f.suspend,
          prepareSuspend: async () => async () => undefined,
          finalize: async () => ({ requiresApproval: false }),
          applyChanges: f.apply,
          discardChanges: f.discard,
        },
      };
      const callerApply = mock(async () => ({
        filesApplied: 0,
        filesDeleted: 0,
        warnings: [],
      }));
      const pending = f.host.engine.resume({
        platform: new CLIAdapter(),
        conversationId: 'resume-proof',
        cwd: f.cwd,
        userMessage: '',
        run: candidate,
        legacyWorkflow: makeTestResolvedWorkflow({
          name: 'resume',
          nodes: [{ id: 'second', bash: 'echo second' }],
        }),
        options: {
          execContext: { kind: 'container', containerId: 'old-container' },
          container: {
            ...container,
            backend: { ...container.backend, applyChanges: callerApply },
          },
        },
        prepareExecution: async () => ({
          cwd: f.cwd,
          options: {
            ...(field !== 'container'
              ? { execContext: { kind: 'container' as const, containerId: 'restarted' } }
              : {}),
            ...(field !== 'execContext' ? { container } : {}),
          },
        }),
      });
      if (field === 'both') {
        const admission = await pending;
        if (!admission.accepted) throw new Error('Expected admission');
        expect(await admission.settled).toMatchObject({ success: true });
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.apply).toHaveBeenCalledTimes(1);
        expect(f.apply).toHaveBeenCalledWith(f.envId);
        expect((await f.store.getWorkflowRun(candidate.id))?.metadata.writeback_outcome).toBe(
          'applied'
        );
      } else {
        await expect(
          pending.then(async admission => {
            if (admission.accepted) await admission.settled;
            return admission;
          })
        ).rejects.toThrow(
          field === 'execContext'
            ? 'Container execution requires a container backend context'
            : 'Container backend requires a container execution context'
        );
        expect(await f.store.getWorkflowRun(candidate.id)).toEqual(candidate);
        expect(await f.store.listWorkflowEvents(candidate.id)).toEqual(events);
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.apply).not.toHaveBeenCalled();
      }
      expect(callerApply).not.toHaveBeenCalled();
      expect(f.discard).not.toHaveBeenCalled();
      expect(f.suspend).not.toHaveBeenCalled();
    });
  }
);

for (const stage of ['notice', 'announcement', 'subscription', 'lease'] as const) {
  test.each(['SIGINT', 'SIGTERM'] as const)(
    `fresh container cleanup during ${stage} on %s`,
    async signal => {
      await fixture(async f => {
        watch(spyOn(ContainerBackend.prototype, 'prepare')).mockResolvedValue({
          cwd: f.cwd,
          execContext: { kind: 'container', containerId: 'restarted' },
          envId: f.envId,
          overlayMode: 'native',
        });
        const baseline = process.listeners(signal);
        const exited = Promise.withResolvers<void>();
        watch(spyOn(process, 'exit')).mockImplementation((() => exited.resolve()) as never);
        let interrupted = false;
        const interrupt = async () => {
          const handlers = process.listeners(signal).filter(handler => !baseline.includes(handler));
          expect(handlers).toHaveLength(1);
          handlers[0]?.(signal);
          await exited.promise;
          expect(f.destroy).toHaveBeenCalledWith(f.envId);
          interrupted = true;
        };
        if (stage === 'notice')
          watch(spyOn(preflight, 'maybePrintTierNotice')).mockImplementation(interrupt);
        if (stage === 'announcement')
          watch(spyOn(CLIAdapter.prototype, 'sendMessage')).mockImplementationOnce(interrupt);
        if (stage === 'subscription')
          watch(spyOn(f.host.engine, 'subscribe')).mockImplementationOnce(async () => {
            await interrupt();
            return { close: async () => undefined };
          });
        if (stage === 'lease')
          watch(spyOn(OwnedRunLease.prototype, 'start')).mockImplementationOnce(interrupt);
        await workflowRunCommand(f.host, f.cwd, 'resume', '', { folder: true, container: true });
        expect(interrupted).toBe(true);
        expect(process.listeners(signal)).toEqual(baseline);
      });
    }
  );
}
