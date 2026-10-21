// @archon-test-isolated
import { expect, it, mock } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  createMockDeps,
  createMockPlatform,
  setMockArtifactHome,
  spyOnNodeExec,
} from './dag/test-utils';
import { executeWorkflow } from './executor';
import { createFileWorkflowStore } from './file-store/store';
import { resolveWorkflow } from './graph-plan';
import { workflowDefinitionSchema, type WorkflowRun } from './schemas';
import { executionClaim, type IWorkflowStore, type PersistedNodeOutput } from './store';
import { getWorkflowEventEmitter, type WorkflowEmitterEvent } from './event-emitter';

const roots = trackTempRoots();
const cases = [
  'complete',
  'no-completed',
  'all-failed',
  'mixed-failure',
  'evidence',
  'event-error',
] as const;

it.each([...cases])(
  'host pause stops old %s handling after resume without accounting',
  async mode => {
    const root = roots(await mkdtemp(join(tmpdir(), 'host-pause-')));
    setMockArtifactHome(root);
    const store = await createFileWorkflowStore({ root: join(root, 'store') });
    const created = await store.createWorkflowRun({
      workflow_name: 'pause',
      user_message: '',
      working_path: root,
    });
    await store.updateWorkflowRun(created.id, { output_root: join(root, 'output') });
    const run = await store.claimPendingWorkflowRun(created.id);
    if (!run) throw new Error('not claimed');
    const workflow = resolveWorkflow(
      workflowDefinitionSchema.parse({
        name: 'pause',
        description: 'Host pause fixture',
        ...(mode === 'evidence' ? { evidence_policy: { required: true } } : {}),
        nodes: [
          ...(mode === 'no-completed' || mode === 'all-failed' || mode === 'event-error'
            ? []
            : [{ id: 'work', bash: 'echo done' }]),
          ...(mode === 'mixed-failure' || mode === 'all-failed'
            ? [{ id: 'broken', bash: 'exit 1' }]
            : []),
          { id: 'review', wait: { duration_ms: 3_600_000 } },
        ],
      })
    );
    const transport = spyOnNodeExec().mockRejectedValue(
      Object.assign(new Error('Command failed'), { code: 1, stdout: '', stderr: 'failed' })
    );
    const update = mock<IWorkflowStore['updateWorkflowRun']>((...args) =>
      store.updateWorkflowRun(...args)
    );
    const complete = mock<IWorkflowStore['completeWorkflowRun']>((...args) =>
      store.completeWorkflowRun(...args)
    );
    const fail = mock<IWorkflowStore['failWorkflowRun']>((...args) =>
      store.failWorkflowRun(...args)
    );
    let successor: WorkflowRun | undefined;
    const live: WorkflowEmitterEvent[] = [];
    const unsubscribe = getWorkflowEventEmitter().subscribe(event => {
      if (event.runId === run.id) live.push(event);
    });
    try {
      const result = await executeWorkflow(
        createMockDeps({
          ...store,
          updateWorkflowRun: update,
          completeWorkflowRun: complete,
          failWorkflowRun: fail,
          pauseWorkflowRunForWait: async (...args) => {
            await store.pauseWorkflowRunForWait(...args);
            update.mockClear();
            successor = await store.resumeWorkflowRun(run.id);
          },
          persistWorkflowEvent: async event => {
            if (mode === 'event-error' && event.event_type === 'node_suspended')
              throw new Error('Suspension event unavailable');
            await store.persistWorkflowEvent(event);
          },
        }),
        createMockPlatform(),
        'conv',
        root,
        workflow,
        '',
        undefined,
        {
          preCreatedRun: run,
          priorCompletedNodes: new Map<string, PersistedNodeOutput>(
            mode === 'no-completed' || mode === 'all-failed' || mode === 'event-error'
              ? []
              : [['work', { output: 'done' }]]
          ),
          resolvedBaseBranch: 'main',
        }
      );
      if (!successor) throw new Error('Successor was not claimed');
      expect(executionClaim(successor.metadata)).not.toBe(executionClaim(run.metadata));
      expect(result).toMatchObject(
        mode === 'event-error'
          ? { success: false, error: expect.stringContaining('Suspension event unavailable') }
          : { success: true, paused: true }
      );
      expect(await store.getWorkflowRun(run.id)).toEqual(successor);
      expect(update).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
      const events = await store.listWorkflowEvents(run.id);
      expect(events.some(event => event.event_type === 'node_failed')).toBe(
        mode === 'mixed-failure' || mode === 'all-failed'
      );
      expect(events.some(event => event.event_type === 'evidence_validation_failed')).toBe(false);
      expect(
        live.some(event => ['workflow_completed', 'workflow_failed'].includes(event.type))
      ).toBe(false);
    } finally {
      unsubscribe();
      transport.mockRestore();
    }
  }
);
