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
