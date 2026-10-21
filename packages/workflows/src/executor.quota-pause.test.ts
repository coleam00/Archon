// @archon-test-isolated
import { expect, it, mock } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  createMockDeps,
  createMockPlatform,
  mockSendQueryDag,
  setMockArtifactHome,
} from './dag/test-utils';
import { executeWorkflow } from './executor';
import { createFileWorkflowStore } from './file-store/store';
import { resolveWorkflow } from './graph-plan';
import { workflowDefinitionSchema } from './schemas';
import { WorkflowRunPauseConflictError, type IWorkflowStore } from './store';

const roots = trackTempRoots();

it.each(['storage', 'conflict', 'normal', 'storage-running'] as const)(
  'quota pause interleaving: %s',
  async mode => {
    const root = roots(await mkdtemp(join(tmpdir(), 'quota-pause-')));
    setMockArtifactHome(root);
    const store = await createFileWorkflowStore({ root: join(root, 'store') });
    const created = await store.createWorkflowRun({
      workflow_name: 'quota',
      user_message: '',
      working_path: root,
    });
    await store.updateWorkflowRun(created.id, { output_root: join(root, 'output') });
    const run = await store.claimPendingWorkflowRun(created.id);
    if (!run) throw new Error('not claimed');
    const resetAt = new Date(Date.now() + 600_000).toISOString();
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'result',
        isError: true,
        cost: 0.25,
        sessionId: 'quota-session',
        failure: { class: 'quota_exhausted', evidence: 'Limit reached', resetAt },
      };
    });
    const approval = { nodeId: 'review', type: 'approval' as const, message: 'Review' };
    const storageError = new Error('Quota pause storage failed');
    const pause = mock<IWorkflowStore['pauseWorkflowRunForWait']>(async (...args) => {
      if (mode === 'normal') return store.pauseWorkflowRunForWait(...args);
      if (mode !== 'storage-running') await store.pauseWorkflowRun(run.id, approval);
      if (mode === 'conflict') return store.pauseWorkflowRunForWait(...args);
      throw storageError;
    });
    const fail = mock<IWorkflowStore['failWorkflowRun']>((...args) =>
      store.failWorkflowRun(...args)
    );
    const result = await executeWorkflow(
      createMockDeps({ ...store, pauseWorkflowRunForWait: pause, failWorkflowRun: fail }),
      createMockPlatform(),
      'conv',
      root,
      resolveWorkflow(
        workflowDefinitionSchema.parse({
          name: 'quota',
          description: 'Quota pause fixture',
          nodes: [{ id: 'work', prompt: 'Work' }],
        })
      ),
      '',
      undefined,
      { preCreatedRun: run, resolvedBaseBranch: 'main' }
    );
    expect(pause).toHaveBeenCalledTimes(1);
    const persisted = await store.getWorkflowRun(run.id);
    expect(persisted?.metadata.total_cost_usd).toBe(0.25);
    const events = await store.listWorkflowEvents(run.id);
    expect(events.filter(event => event.event_type === 'wait_started')).toHaveLength(
      mode === 'normal' ? 1 : 0
    );
    if (mode === 'storage' || mode === 'storage-running') {
      expect(result).toEqual({
        success: false,
        workflowRunId: run.id,
        error: storageError.message,
      });
    } else {
      expect(result).toMatchObject({ success: true, paused: true });
    }
    if (mode === 'storage-running') {
      expect(persisted?.status).toBe('failed');
      expect(fail).toHaveBeenCalledTimes(1);
    } else {
      expect(persisted?.status).toBe('paused');
      expect(fail).not.toHaveBeenCalled();
      expect(events.some(event => event.event_type === 'workflow_failed')).toBe(false);
      if (mode === 'normal')
        expect(persisted?.metadata.wait).toMatchObject({ kind: 'quota', resumeAt: resetAt });
      else expect(persisted?.metadata.approval).toMatchObject(approval);
    }
    if (mode === 'conflict') {
      await expect(pause.mock.results[0]?.value).rejects.toBeInstanceOf(
        WorkflowRunPauseConflictError
      );
    }
  }
);
