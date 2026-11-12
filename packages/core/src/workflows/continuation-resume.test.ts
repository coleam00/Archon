// @archon-test-isolated
import { beforeEach, expect, mock, test } from 'bun:test';
import { getArchonWorkspacesPath } from '@archon/paths';
import { WorkflowExecutionHandoffError } from '@archon/workflows/engine-port';
import type { IWorkflowEngine, WorkflowResumeInput } from '@archon/workflows/engine-port';
import type { WorkflowDeps } from '@archon/workflows/deps';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { HeadlessPlatform } from './headless-platform';

const pausedRun: WorkflowRun = {
  origin: { conversationId: 'sdk-run' },
  id: 'run',
  workflow_name: 'deliver',
  conversation_id: 'sdk-run',
  parent_conversation_id: null,
  codebase_id: null,
  status: 'paused',
  outcome: null,
  user_message: 'deliver',
  metadata: {},
  started_at: new Date(),
  completed_at: null,
  last_activity_at: null,
  working_path: '/work',
  user_id: null,
  parent_run_id: null,
  adopted_from_run_id: null,
  output_root: null,
  checkout_baseline: null,
};
const close = mock(async () => {});
mock.module('../services/run-live-owner', () => ({
  startRunLiveOwner: async () => ({ close }),
  RunLiveOwnerAlreadyOwnedError: class extends Error {},
}));
const resolveRunWorkflow = mock(async () => ({
  ok: true,
  workflow: { name: 'deliver', nodes: [] },
}));
mock.module('./resolve-run-workflow', () => ({ resolveRunWorkflow }));
const { resumeRunContinuation } = await import('./continuation-resume');
beforeEach(() => {
  close.mockClear();
  resolveRunWorkflow.mockClear();
});

function headlessHost(run: WorkflowRun) {
  const resume = mock<IWorkflowEngine['resume']>(async () => ({
    accepted: true,
    runId: run.id,
    settled: Promise.resolve({ success: true, workflowRunId: run.id }),
  }));
  const engine = { resume } as unknown as IWorkflowEngine;
  const deps = { store: { getWorkflowRun: async () => run } } as unknown as WorkflowDeps;
  return { host: { deps, engine }, resume };
}
const headlessContext = async () =>
  ({ kind: 'ready', platform: new HeadlessPlatform(), conversationId: 'sdk-run' }) as const;

test('a codebase run without a project resolver stays unresolved and is never resumed', async () => {
  const { host, resume } = headlessHost({ ...pausedRun, codebase_id: 'cb' });
  const admission = await resumeRunContinuation(host, pausedRun.id, headlessContext);
  expect(admission).toEqual({
    kind: 'unavailable',
    reason: expect.stringContaining('only the Archon host that registered it'),
  });
  expect(resume).not.toHaveBeenCalled();
});

test('a codebase-less paused run resumes from the workspaces path without host records', async () => {
  const { host, resume } = headlessHost(pausedRun);
  const admission = await resumeRunContinuation(host, pausedRun.id, headlessContext);
  expect(admission.kind).toBe('accepted');
  expect(resolveRunWorkflow).toHaveBeenCalledWith(
    host.deps,
    pausedRun,
    getArchonWorkspacesPath(),
    expect.any(HeadlessPlatform)
  );
  const input = resume.mock.calls[0]?.[0] as WorkflowResumeInput;
  expect(input.cwd).toBe('/work');
  expect(input.options).toEqual({});
  if (admission.kind === 'accepted') await admission.settled;
  expect(close).toHaveBeenCalledTimes(1);
});

test('an engine refusal closes its live owner before returning not-accepted', async () => {
  const { host, resume } = headlessHost(pausedRun);
  resume.mockResolvedValueOnce({ accepted: false, reason: 'nothing-to-resume' });
  let closed = false;
  close.mockImplementationOnce(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    closed = true;
  });

  const admission = await resumeRunContinuation(host, pausedRun.id, headlessContext);

  expect(resume).toHaveBeenCalledTimes(1);
  expect(admission).toEqual({ kind: 'not-accepted' });
  expect(close).toHaveBeenCalledTimes(1);
  expect(closed).toBe(true);
});

for (const result of ['completed', 'rejected', 'handed-off', 'superseded', 'refused'] as const) {
  test(`continuation ${result} notifies only its owned settlement after owner close`, async () => {
    const { host, resume } = headlessHost(pausedRun);
    const order: string[] = [];
    close.mockImplementationOnce(async () => {
      order.push('close');
    });
    const effect = mock(async (runId: string) => {
      expect(runId).toBe(pausedRun.id);
      order.push('drain');
    });
    const settlement = Promise.withResolvers<Awaited<ReturnType<IWorkflowEngine['submit']>>>();
    resume.mockResolvedValueOnce(
      result === 'refused'
        ? { accepted: false, reason: 'nothing-to-resume' }
        : { accepted: true, runId: pausedRun.id, settled: settlement.promise }
    );
    const admission = await resumeRunContinuation(
      { ...host, afterOwnedExecution: effect },
      pausedRun.id,
      headlessContext
    );
    if (admission.kind === 'accepted') {
      expect(order).toEqual([]);
      if (result === 'superseded')
        settlement.reject(
          new WorkflowExecutionHandoffError(pausedRun.id, new Error('successor owns execution'))
        );
      else if (result === 'rejected') settlement.reject(new Error('execution failure'));
      else
        settlement.resolve(
          result === 'handed-off'
            ? {
                success: true,
                handedOff: true,
                workflowRunId: pausedRun.id,
                observedStatus: 'running',
              }
            : { success: true, workflowRunId: pausedRun.id }
        );
      if (result === 'superseded')
        await expect(admission.settled).rejects.toBeInstanceOf(WorkflowExecutionHandoffError);
      else if (result === 'rejected')
        await expect(admission.settled).rejects.toThrow('execution failure');
      else await admission.settled;
    }
    expect(order).toEqual(
      result === 'refused' || result === 'handed-off' || result === 'superseded'
        ? ['close']
        : ['close', 'drain']
    );
  });
}

test('a failed host drain preserves the accepted execution result', async () => {
  const { host } = headlessHost(pausedRun);
  const admission = await resumeRunContinuation(
    {
      ...host,
      afterOwnedExecution: async () => {
        throw new Error('dispatch failed');
      },
    },
    pausedRun.id,
    headlessContext
  );
  if (admission.kind !== 'accepted') throw new Error('Expected admission');
  expect(await admission.settled).toEqual({ success: true, workflowRunId: pausedRun.id });
});

test('a failed owner close reports the error without draining or replacing execution', async () => {
  const { host } = headlessHost(pausedRun);
  close.mockRejectedValueOnce(new Error('owner close failed'));
  const effect = mock(async () => undefined);
  const admission = await resumeRunContinuation(
    { ...host, afterOwnedExecution: effect },
    pausedRun.id,
    headlessContext
  );
  if (admission.kind !== 'accepted') throw new Error('Expected admission');
  expect(await admission.settled).toMatchObject({ success: true });
  expect(effect).not.toHaveBeenCalled();
});
