// @archon-test-isolated
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from './file-store/store';
import { executionClaim } from './store';
import { describe, expect, it, mock } from 'bun:test';
import {
  createMockDeps,
  createMockPlatform,
  deliveredMessages,
  persistedEvents,
} from './dag/test-utils';
import { getWorkflowEventEmitter, type WorkflowEmitterEvent } from './event-emitter';
import { releaseUnreadableRunSource } from './source-release';
import type { SourceReleaseWrite } from './store';
import { resolveRunExecutionMode, type ContainerWriteBackBackend } from './container-context';

const roots = trackTempRoots();
const release: SourceReleaseWrite = {
  claimId: null,
  nodeId: 'workflow-source',
  error: 'read denied',
  retryAt: new Date().toISOString(),
};
const execContext = { kind: 'container' as const, containerId: 'cid' };
function setup() {
  const deps = createMockDeps();
  const platform = createMockPlatform();
  const stop = mock(async () => undefined);
  const backend = {
    prepareSuspend: mock(async () => stop),
    suspend: mock(async () => undefined),
    finalize: mock(async () => ({ requiresApproval: false })),
    applyChanges: mock(async () => ({ filesApplied: 0, filesDeleted: 0, warnings: [] })),
    discardChanges: mock(async () => undefined),
  } satisfies ContainerWriteBackBackend;
  const container = { envId: 'env', writeBack: 'approve' as const, backend };
  const run = () =>
    releaseUnreadableRunSource(
      deps,
      platform,
      'conv',
      'run',
      release,
      resolveRunExecutionMode(execContext, container)
    );
  return { deps, platform, stop, backend, run };
}

describe('source release suspension', () => {
  it.each(['preparation', 'stop'] as const)(
    '%s failure preserves the release and reports its diagnostic',
    async phase => {
      const { deps, platform, stop, backend } = setup();
      const error = new Error(`${phase} failed`);
      if (phase === 'preparation') backend.prepareSuspend.mockRejectedValue(error);
      else stop.mockRejectedValue(error);
      const root = roots(await mkdtemp(join(tmpdir(), 'source-release-')));
      const store = await createFileWorkflowStore({ root });
      const pending = await store.createWorkflowRun({
        workflow_name: 'unreadable',
        user_message: '',
      });
      const active = await store.claimPendingWorkflowRun(pending.id);
      if (!active) throw new Error('run was not claimed');
      const live: WorkflowEmitterEvent[] = [];
      const unsubscribe = getWorkflowEventEmitter().subscribe(event => {
        if (event.runId === active.id) live.push(event);
      });
      try {
        expect(
          await releaseUnreadableRunSource(
            { ...deps, store },
            platform,
            'conv',
            active.id,
            { ...release, claimId: executionClaim(active.metadata) },
            resolveRunExecutionMode(execContext, { envId: 'env', writeBack: 'approve', backend })
          )
        ).toEqual({ released: true });
        expect(await store.getWorkflowRun(active.id)).toMatchObject({
          status: 'paused',
          metadata: { source_release: { nodeId: 'workflow-source' } },
        });
        expect(deliveredMessages(platform).join('\n')).toContain(error.message);
        const events = await store.listWorkflowEvents(active.id);
        expect(events.map(event => event.event_type)).toEqual(['source_released']);
        expect(deps.store.failWorkflowRun).not.toHaveBeenCalled();
        expect(deps.store.completeWorkflowRun).not.toHaveBeenCalled();
        expect(live).not.toContainEqual(
          expect.objectContaining({ type: 'container_lifecycle', phase: 'stopped' })
        );
      } finally {
        unsubscribe();
      }
    }
  );

  it('releases a resumed claim through the real store and stops its container once', async () => {
    const { deps, platform, backend, stop } = setup();
    const root = roots(await mkdtemp(join(tmpdir(), 'source-release-resumed-')));
    const store = await createFileWorkflowStore({ root });
    const pending = await store.createWorkflowRun({
      workflow_name: 'unreadable',
      user_message: '',
    });
    const active = await store.claimPendingWorkflowRun(pending.id);
    if (!active) throw new Error('run was not claimed');
    await store.pauseWorkflowRun(active.id, {
      nodeId: 'review',
      message: 'Choose',
      type: 'approval',
      pauseId: 'first',
    });
    const resumed = await store.resumeWorkflowRun(active.id);
    const claimId = executionClaim(resumed.metadata);
    expect(claimId).not.toBeNull();
    expect(
      await releaseUnreadableRunSource(
        { ...deps, store: { ...store, createWorkflowEvent: deps.store.createWorkflowEvent } },
        platform,
        'conv',
        resumed.id,
        { ...release, claimId },
        resolveRunExecutionMode(execContext, { envId: 'env', writeBack: 'approve', backend })
      )
    ).toEqual({ released: true });
    expect(await store.getWorkflowRun(resumed.id)).toMatchObject({
      status: 'paused',
      metadata: {
        pause_cause: 'source_release',
        continuation_retry_at: release.retryAt,
        source_release: { nodeId: release.nodeId },
      },
    });
    expect(stop).toHaveBeenCalledTimes(1);
    const events = await store.listWorkflowEvents(resumed.id);
    expect(events.filter(event => event.event_type === 'source_released')).toHaveLength(1);
    expect(
      persistedEvents(deps.store).filter(event => event.event_type === 'container_stopped')
    ).toHaveLength(1);
  });

  it('reports a stopped container only after the source pause commits', async () => {
    const { deps, platform, stop, backend, run } = setup();
    deps.store.releaseRunForUnreadableSource.mockImplementation(
      async (_id, _release, beforePublish) => {
        expect(backend.prepareSuspend).toHaveBeenCalledWith('env', 'cid', 2_000);
        expect(stop).not.toHaveBeenCalled();
        await beforePublish?.();
        expect(stop).toHaveBeenCalledTimes(1);
        expect(persistedEvents(deps.store)).toEqual([]);
        expect(deliveredMessages(platform)).toEqual([]);
        return { released: true };
      }
    );
    expect(await run()).toEqual({ released: true });
    expect(persistedEvents(deps.store)).toContainEqual(
      expect.objectContaining({ event_type: 'container_stopped' })
    );
    expect(backend.suspend).not.toHaveBeenCalled();
  });

  it('host execution does no backend preparation or suspension', async () => {
    const { deps, platform, backend, stop } = setup();
    await releaseUnreadableRunSource(
      deps,
      platform,
      'conv',
      'run',
      release,
      resolveRunExecutionMode()
    );
    expect(backend.prepareSuspend).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(deps.store.releaseRunForUnreadableSource.mock.calls[0]?.[2]).toBeUndefined();
  });

  it('a losing release never stops or announces suspension', async () => {
    const { deps, platform, stop, run } = setup();
    deps.store.releaseRunForUnreadableSource.mockResolvedValue({ released: false });
    expect(await run()).toEqual({ released: false });
    expect(stop).not.toHaveBeenCalled();
    expect(persistedEvents(deps.store)).toEqual([]);
    expect(deliveredMessages(platform)).toEqual([]);
  });

  it.each([false, true])(
    'preserves a store rejection after action entry=%s without success reporting',
    async enter => {
      const { deps, platform, stop, run } = setup();
      const error = new Error('store failed');
      deps.store.releaseRunForUnreadableSource.mockImplementation(
        async (_id, _release, beforePublish) => {
          if (enter) await beforePublish?.();
          throw error;
        }
      );
      await expect(run()).rejects.toBe(error);
      expect(stop).toHaveBeenCalledTimes(enter ? 1 : 0);
      expect(persistedEvents(deps.store)).toEqual([]);
      expect(deliveredMessages(platform)).toEqual([]);
      expect(deps.store.failWorkflowRun).not.toHaveBeenCalled();
    }
  );

  it('can repeat the stop action during transaction replay', async () => {
    const { deps, stop, run } = setup();
    deps.store.releaseRunForUnreadableSource.mockImplementation(
      async (_id, _release, beforePublish) => {
        await beforePublish?.();
        await beforePublish?.();
        return { released: true };
      }
    );
    await run();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(
      persistedEvents(deps.store).filter(event => event.event_type === 'container_stopped')
    ).toHaveLength(1);
  });
});
