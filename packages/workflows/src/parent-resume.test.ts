// @archon-test-isolated
import { expect, mock, spyOn, test } from 'bun:test';
import { createMockDeps, createMockPlatform, makeWorkflowRun } from './dag/test-utils';
import * as executor from './executor';
import * as source from './run-source';
import * as resume from './run-resume';
import { WorkflowExecutionHandoffError } from './engine-port';
import { resolveWorkflow } from './graph-plan';
import { continueBlockedRun } from './parent-resume';
import { liveSourceRoots } from './workflow-source';

test('auto-resume propagates a published-pause error without failing the successor', async () => {
  const deps = createMockDeps();
  const run = makeWorkflowRun('parent', { working_path: '/project' });
  const workflow = resolveWorkflow({
    name: run.workflow_name,
    description: 'Parent',
    nodes: [
      {
        id: 'review',
        kind: 'gate',
        message: 'Review',
        decisions: [{ id: 'approve' }],
        decisionsAuthored: false,
        captureResponse: false,
      },
    ],
  });
  const cause = new WorkflowExecutionHandoffError(
    run.id,
    new Error('post-publication read failed')
  );
  const resolve = spyOn(source, 'resolveContinuationWorkflow').mockResolvedValue({
    workflow,
    roots: liveSourceRoots('/project'),
    workflows: [],
    errors: [],
  });
  const hydrate = spyOn(resume, 'hydrateResumableRun').mockResolvedValue({
    preCreatedRun: run,
    priorCompletedNodes: new Map(),
    resumeCause: 'continue_after_wait',
    priorFailedNodes: new Map(),
    priorUsage: {},
    priorNodeSessions: [],
  });
  const execute = spyOn(executor, 'executeWorkflow').mockRejectedValue(cause);
  try {
    await expect(
      continueBlockedRun(
        deps,
        createMockPlatform(),
        'conversation',
        run,
        mock(async () => {}),
        {}
      )
    ).rejects.toBe(cause);
    expect(deps.store.failWorkflowRun).not.toHaveBeenCalled();
  } finally {
    execute.mockRestore();
    hydrate.mockRestore();
    resolve.mockRestore();
  }
});

test('auto-resume notifies the operator when parent hydration fails', async () => {
  const deps = createMockDeps();
  const run = makeWorkflowRun('parent', { status: 'paused', working_path: '/project' });
  const workflow = resolveWorkflow({
    name: run.workflow_name,
    description: 'Parent',
    nodes: [{ id: 'work', kind: 'agent', source: { kind: 'command', name: 'work' } }],
  });
  const resolve = spyOn(source, 'resolveContinuationWorkflow').mockResolvedValue({
    workflow,
    roots: liveSourceRoots('/project'),
    workflows: [],
    errors: [],
  });
  const hydrate = spyOn(resume, 'hydrateResumableRun').mockRejectedValue(
    new Error('database unavailable')
  );
  const execute = spyOn(executor, 'executeWorkflow');
  const notifyStuck = mock(async (_reason: string) => {});
  try {
    const result = await continueBlockedRun(
      deps,
      createMockPlatform(),
      'conversation',
      run,
      notifyStuck,
      { childRunId: 'child', childStatus: 'completed' }
    );
    expect(result).toBeUndefined();
    expect(hydrate).toHaveBeenCalledWith(deps, run);
    expect(notifyStuck).toHaveBeenCalledTimes(1);
    expect(notifyStuck).toHaveBeenCalledWith('preparing the parent for resume failed');
    expect(execute).not.toHaveBeenCalled();
    expect(deps.store.failWorkflowRun).not.toHaveBeenCalled();
    expect(run.status).toBe('paused');
  } finally {
    execute.mockRestore();
    hydrate.mockRestore();
    resolve.mockRestore();
  }
});
