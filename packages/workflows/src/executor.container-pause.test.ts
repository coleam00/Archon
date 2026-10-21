// @archon-test-isolated
import { describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  createMockDeps,
  createMockPlatform,
  deliveredMessages,
  mockLogFn,
  setMockArtifactHome,
} from './dag/test-utils';
import { createFileWorkflowStore } from './file-store/store';
import { executeWorkflow } from './executor';
import { resolveWorkflow } from './graph-plan';
import { workflowDefinitionSchema, type WorkflowRun } from './schemas';
import { approvalContextSchema } from './schemas/workflow-run';
import { executionClaim, type IWorkflowStore } from './store';
import type { ContainerWriteBackBackend } from './container-context';
import { getWorkflowEventEmitter, type WorkflowEmitterEvent } from './event-emitter';

import * as untilBash from './dag/nodes/loop-group/until-bash';

const roots = trackTempRoots();
const approval = { nodeId: 'review', type: 'approval' as const, message: 'Review' };
const summary = {
  added: ['x'],
  modified: [],
  deleted: [],
  symlinks: [],
  skipped: [],
  totalCount: 1,
  truncated: false,
};
const paths = ['ordinary', 'writeback', 'unresolved'] as const;
type PausePath = (typeof paths)[number];

async function setup(path: PausePath, ordinaryNodes?: unknown[]) {
  const root = roots(await mkdtemp(join(tmpdir(), 'container-pause-')));
  setMockArtifactHome(root);
  const store = await createFileWorkflowStore({ root: join(root, 'store') });
  let run = await store.createWorkflowRun({
    workflow_name: 'pause',
    user_message: '',
    working_path: root,
    metadata: { isolation: 'container', isolation_env_id: 'env' },
  });
  await store.updateWorkflowRun(run.id, { output_root: join(root, 'output') });
  const claimed = await store.claimPendingWorkflowRun(run.id);
  if (!claimed) throw new Error('not claimed');
  run = claimed;
  if (path === 'unresolved') {
    await store.pauseWorkflowRun(
      run.id,
      { ...approval, nodeId: '__writeback__', type: 'writeback' },
      {
        pending_writeback: { envId: 'env', summary },
      }
    );
    run = await store.resumeWorkflowRun(run.id);
  }
  const stop = mock(async () => undefined);
  const backend = {
    suspend: mock(async () => undefined),
    prepareSuspend: mock(async () => stop),
    finalize: mock(async () => ({ requiresApproval: true, changeSummary: summary })),
    applyChanges: mock(async () => ({ filesApplied: 1, filesDeleted: 0, warnings: [] })),
    discardChanges: mock(async () => undefined),
  } satisfies ContainerWriteBackBackend;
  const platform = createMockPlatform();
  const workflow = resolveWorkflow(
    workflowDefinitionSchema.parse({
      name: 'pause',
      description: 'Pause fixture',
      nodes:
        path === 'ordinary'
          ? (ordinaryNodes ?? [{ id: 'review', approval: { message: 'Review' } }])
          : [{ id: 'work', bash: 'echo done' }],
    })
  );
  const live: WorkflowEmitterEvent[] = [];
  const unsubscribe = getWorkflowEventEmitter().subscribe(event => {
    if (event.runId === run.id) live.push(event);
  });
  const pendingEvents: Promise<void>[] = [];
  const createWorkflowEvent: IWorkflowStore['createWorkflowEvent'] = input => {
    const pending = store.createWorkflowEvent(input);
    pendingEvents.push(pending);
    return pending;
  };
  const execute = async (overrides: Partial<IWorkflowStore> = {}, executionRun = run) => {
    const result = await executeWorkflow(
      createMockDeps({ ...store, createWorkflowEvent, ...overrides }),
      platform,
      'conv',
      root,
      workflow,
      '',
      undefined,
      {
        preCreatedRun: executionRun,
        priorCompletedNodes: new Map(path === 'ordinary' ? [] : [['work', { output: 'done' }]]),
        execContext: { kind: 'container', containerId: 'cid' },
        container: { envId: 'env', writeBack: 'approve', backend },
        resolvedBaseBranch: 'main',
      }
    );
    await Promise.all(pendingEvents);
    return result;
  };
  return { store, run, backend, stop, platform, live, unsubscribe, execute };
}

function stopped(live: WorkflowEmitterEvent[]) {
  return live.filter(event => event.type === 'container_lifecycle' && event.phase === 'stopped');
}

describe('container pause segment ownership through the executor', () => {
  it.each(['approved', 'rejected'] as const)(
    'normal write-back pause resumes after %s',
    async decision => {
      const f = await setup('writeback');
      try {
        expect(await f.execute()).toMatchObject({ success: true, paused: true });
        expect(f.stop).toHaveBeenCalledTimes(1);
        const paused = await f.store.getWorkflowRun(f.run.id);
        const approval = approvalContextSchema.parse(paused?.metadata.approval);
        expect(
          await f.store.resolveApprovalGate(
            f.run.id,
            {
              approval: { ...approval, resolved: decision },
            },
            []
          )
        ).toEqual({ resolved: true });
        const resumed = await f.store.resumeWorkflowRun(f.run.id);
        expect(await f.execute({}, resumed)).toMatchObject({ success: true });
        expect((await f.store.getWorkflowRun(f.run.id))?.status).toBe('completed');
        expect(f.backend.applyChanges).toHaveBeenCalledTimes(decision === 'approved' ? 1 : 0);
        expect(f.backend.discardChanges).toHaveBeenCalledTimes(decision === 'rejected' ? 1 : 0);
        expect(f.stop).toHaveBeenCalledTimes(1);
      } finally {
        f.unsubscribe();
      }
    }
  );
  for (const suspension of [
    { approval: { message: 'Review' } },
    { wait: { duration_ms: 3_600_000 } },
  ]) {
    for (const nested of [false, true]) {
      it.each(['resume-before-read', 'resume-after-read', 'read-failure'] as const)(
        `ordinary ${'approval' in suspension ? 'gate' : 'wait'} (nested=${nested}): %s retains publication`,
        async order => {
          const leaf = { id: 'review', ...suspension };
          const group = (id: string, nodes: unknown[]) => ({
            id,
            loop_group: { max_iterations: 2, until_bash: 'echo MUST_NOT_RUN', nodes },
          });
          const pauseNode = nested ? group('outer', [group('inner', [leaf])]) : leaf;
          const f = await setup('ordinary', [
            pauseNode,
            { id: 'after', bash: 'echo MUST_NOT_RUN', depends_on: [pauseNode.id] },
          ]);
          const completion = spyOn(untilBash, 'runGroupUntilBash');
          let published = false;
          let statusReadsAfterPublication = 0;
          let successor: WorkflowRun | undefined;
          const publishedPause = async () => {
            published = true;
            if (order === 'resume-before-read')
              successor = await f.store.resumeWorkflowRun(f.run.id);
          };
          try {
            const result = await f.execute({
              pauseWorkflowRun: async (...args) => {
                await f.store.pauseWorkflowRun(...args);
                await publishedPause();
              },
              pauseWorkflowRunForWait: async (...args) => {
                await f.store.pauseWorkflowRunForWait(...args);
                await publishedPause();
              },
              getWorkflowRunStatus: async id => {
                if (published) {
                  statusReadsAfterPublication++;
                  if (order === 'read-failure' && statusReadsAfterPublication === 1)
                    throw new Error('status read unavailable after publication');
                }
                const status = await f.store.getWorkflowRunStatus(id);
                if (published && order === 'resume-after-read' && successor === undefined) {
                  successor = await f.store.resumeWorkflowRun(id);
                }
                return status;
              },
            });
            expect(published).toBe(true);
            if (order === 'resume-after-read')
              expect(statusReadsAfterPublication).toBeGreaterThan(0);
            expect(result).toMatchObject({ success: true, paused: true });
            const row = await f.store.getWorkflowRun(f.run.id);
            expect(row?.status).toBe(order === 'read-failure' ? 'paused' : 'running');
            expect(executionClaim(row?.metadata ?? {})).toBe(
              executionClaim((successor ?? f.run).metadata)
            );
            expect(f.stop).toHaveBeenCalledTimes(order === 'read-failure' ? 1 : 0);
            const events = await f.store.listWorkflowEvents(f.run.id);
            expect(
              events.some(e =>
                ['workflow_failed', 'workflow_completed', 'loop_iteration_completed'].includes(
                  e.event_type
                )
              )
            ).toBe(false);
            expect(events.some(e => e.step_name === 'after')).toBe(false);
            if (nested) {
              expect(events.filter(e => e.event_type === 'loop_iteration_started')).toHaveLength(2);
              expect(completion).not.toHaveBeenCalled();
            }
          } finally {
            completion.mockRestore();
            f.unsubscribe();
          }
        }
      );
    }
  }

  for (const path of paths) {
    it.each([false, true])(
      `${path}: resume wins before cleanup (successor paused=%s)`,
      async pausedAgain => {
        const f = await setup(path);
        const successor: { run?: WorkflowRun } = {};
        let pausedObservations = 0;
        const resume = async () => {
          successor.run = await f.store.resumeWorkflowRun(f.run.id);
          if (pausedAgain) await f.store.pauseWorkflowRun(f.run.id, approval);
        };
        const overrides: Partial<IWorkflowStore> =
          path === 'ordinary'
            ? {
                getWorkflowRunStatus: async id => {
                  const status = await f.store.getWorkflowRunStatus(id);
                  // Resume after the layer walker reads its paused snapshot.
                  if (status === 'paused' && ++pausedObservations === 1) await resume();
                  return status;
                },
              }
            : {
                pauseWorkflowRun: async (...args) => {
                  await f.store.pauseWorkflowRun(...args);
                  await resume();
                },
              };
        try {
          expect(await f.execute(overrides)).toEqual({
            success: true,
            paused: true,
            workflowRunId: f.run.id,
          });
          const next = await f.store.getWorkflowRun(f.run.id);
          expect(next?.status).toBe(pausedAgain ? 'paused' : 'running');
          expect(executionClaim(next?.metadata ?? {})).not.toBe(executionClaim(f.run.metadata));
          expect(executionClaim(next?.metadata ?? {})).toBe(
            executionClaim(successor.run?.metadata ?? {})
          );
          expect(f.stop).not.toHaveBeenCalled();
          expect(f.backend.suspend).not.toHaveBeenCalled();
          expect(stopped(f.live)).toEqual([]);
          const events = await f.store.listWorkflowEvents(f.run.id);
          expect(
            events.some(event =>
              ['workflow_completed', 'workflow_failed', 'container_stopped'].includes(
                event.event_type
              )
            )
          ).toBe(false);
          if (path !== 'ordinary') {
            expect(next?.metadata.pending_writeback).toEqual({ envId: 'env', summary });
            expect(next?.metadata.writeback_resolved).toBeUndefined();
            expect(f.backend.applyChanges).not.toHaveBeenCalled();
            expect(f.backend.discardChanges).not.toHaveBeenCalled();
          }
          expect(f.backend.prepareSuspend).toHaveBeenCalledWith('env', 'cid');
        } finally {
          f.unsubscribe();
        }
      }
    );

    it(`${path}: cancellation during preparation retains its terminal result and parent hook`, async () => {
      const f = await setup(path);
      const parent = await f.store.createWorkflowRun({
        workflow_name: 'parent',
        user_message: '',
        working_path: f.run.working_path ?? undefined,
      });
      let parentRead = false;
      f.backend.prepareSuspend.mockImplementation(async () => {
        await f.store.cancelWorkflowRun(f.run.id);
        return f.stop;
      });
      try {
        expect(
          await f.execute({
            getWorkflowRun: async id => {
              if (id === parent.id) parentRead = true;
              const run = await f.store.getWorkflowRun(id);
              return run?.id === f.run.id ? { ...run, parent_run_id: parent.id } : run;
            },
          })
        ).toMatchObject({ success: false });
        expect((await f.store.getWorkflowRun(f.run.id))?.status).toBe('cancelled');
        expect(parentRead).toBe(true);
        expect(f.stop).not.toHaveBeenCalled();
        expect(stopped(f.live)).toEqual([]);
      } finally {
        f.unsubscribe();
      }
    });

    it.each(['preparation', 'stop'] as const)(
      `${path}: %s failure survives a store completion failure`,
      async failure => {
        const f = await setup(path);
        const backendError = new Error(`${failure} failed before store completion`);
        const storeError = new Error('store completion failed');
        if (failure === 'preparation') f.backend.prepareSuspend.mockRejectedValue(backendError);
        else f.stop.mockRejectedValue(backendError);
        try {
          expect(
            await f.execute({
              withPausedExecution: async (id, claim, action) => {
                await f.store.withPausedExecution(id, claim, action);
                throw storeError;
              },
            })
          ).toMatchObject({ success: true, paused: true });
          for (const [error, diagnostic] of [
            [backendError, 'dag.container_suspend_on_pause_failed'],
            [storeError, 'dag.container_pause_cleanup_unconfirmed'],
          ] as const) {
            expect(
              mockLogFn.mock.calls.some(
                ([data, message]) =>
                  message === diagnostic &&
                  typeof data === 'object' &&
                  data !== null &&
                  'err' in data &&
                  data.err === error
              )
            ).toBe(true);
          }
          expect((await f.store.getWorkflowRun(f.run.id))?.status).toBe('paused');
          expect(stopped(f.live)).toEqual([]);
          expect(deliveredMessages(f.platform).join('\n')).toContain(
            'cleanup could not be confirmed'
          );
        } finally {
          f.unsubscribe();
        }
      }
    );

    it(`${path}: a losing preparation failure emits no stale diagnostic`, async () => {
      const f = await setup(path);
      const error = new Error('old preparation failed');
      f.backend.prepareSuspend.mockImplementation(async () => {
        await f.store.resumeWorkflowRun(f.run.id);
        throw error;
      });
      try {
        expect(await f.execute()).toMatchObject({ success: true, paused: true });
        expect((await f.store.getWorkflowRun(f.run.id))?.status).toBe('running');
        expect(f.stop).not.toHaveBeenCalled();
        expect(stopped(f.live)).toEqual([]);
        expect(deliveredMessages(f.platform).join('\n')).not.toContain(error.message);
      } finally {
        f.unsubscribe();
      }
    });

    it(`${path}: cleanup holds resume until stop settles`, async () => {
      const f = await setup(path);
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const order: string[] = [];
      f.stop.mockImplementation(async () => {
        entered.resolve();
        await finish.promise;
        order.push('stopped');
      });
      const execution = f.execute();
      await entered.promise;
      const resume = f.store.resumeWorkflowRun(f.run.id).then(run => {
        order.push('resumed');
        return run;
      });
      finish.resolve();
      try {
        expect(await execution).toMatchObject({ success: true, paused: true });
        expect((await resume).status).toBe('running');
        expect(order).toEqual(['stopped', 'resumed']);
        expect(f.stop).toHaveBeenCalledTimes(1);
        expect(stopped(f.live)).toHaveLength(1);
      } finally {
        finish.resolve();
        await Promise.allSettled([execution, resume]);
        f.unsubscribe();
      }
    });

    it.each(['preparation', 'stop', 'store-before', 'store-after'] as const)(
      `${path}: %s failure preserves a successful pause`,
      async failure => {
        const f = await setup(path);
        const error = new Error(`${failure} failed`);
        if (failure === 'preparation') f.backend.prepareSuspend.mockRejectedValue(error);
        if (failure === 'stop') f.stop.mockRejectedValue(error);
        const overrides: Partial<IWorkflowStore> = failure.startsWith('store-')
          ? {
              withPausedExecution: async (id, claim, action) => {
                if (failure === 'store-after') await f.store.withPausedExecution(id, claim, action);
                throw error;
              },
            }
          : {};
        try {
          expect(await f.execute(overrides)).toMatchObject({ success: true, paused: true });
          expect((await f.store.getWorkflowRun(f.run.id))?.status).toBe('paused');
          expect(stopped(f.live)).toEqual([]);
          expect(
            (await f.store.listWorkflowEvents(f.run.id)).some(event =>
              ['workflow_failed', 'container_stopped'].includes(event.event_type)
            )
          ).toBe(false);
          expect(deliveredMessages(f.platform).join('\n')).toContain(error.message);
          expect(
            mockLogFn.mock.calls.some(
              ([data]) =>
                typeof data === 'object' && data !== null && 'err' in data && data.err === error
            )
          ).toBe(true);
        } finally {
          f.unsubscribe();
        }
      }
    );
  }
});
