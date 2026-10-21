import { expect, test } from 'bun:test';
import { DETACHED_LAUNCH_METADATA_KEY, executionClaim } from '../store';
import type { WorkflowStoreHarness } from '../store-conformance';
import type { ApprovalContext } from '../schemas/workflow-run';

const approval: ApprovalContext = {
  nodeId: 'review',
  message: 'Choose',
  type: 'approval',
  pauseId: 'first',
};

export function describeExecutionFailureConformance(getHarness: () => WorkflowStoreHarness): void {
  test.each([
    'pending',
    'wrong token',
    'running',
    'paused',
    'completed',
    'failed',
    'cancelled',
    'missing',
  ] as const)('detached startup failure condition preserves ownership: %s', async state => {
    const harness = getHarness();
    const { store } = harness;
    const run = await store.createWorkflowRun({
      workflow_name: 'startup',
      user_message: '',
      metadata: { [DETACHED_LAUNCH_METADATA_KEY]: 'launch-token' },
    });
    if (state !== 'pending' && state !== 'wrong token' && state !== 'missing') {
      await store.claimPendingWorkflowRun(run.id);
      if (state === 'paused') await store.pauseWorkflowRun(run.id, approval);
      if (state === 'completed') await store.completeWorkflowRun(run.id, { duration_ms: 0 });
      if (state === 'failed') await store.failWorkflowRun(run.id, 'first failure');
      if (state === 'cancelled') await store.cancelWorkflowRun(run.id);
    }
    const before = await store.getWorkflowRun(run.id);
    const events = await store.listWorkflowEvents(run.id);
    const reports = harness.terminalReports();
    expect(
      await store.failWorkflowRun(
        state === 'missing' ? crypto.randomUUID() : run.id,
        'startup failed',
        {
          exitReason: 'launch_failed',
          pendingLaunchToken: state === 'wrong token' ? 'stale-token' : 'launch-token',
        }
      )
    ).toEqual({ failed: state === 'pending' });
    if (state === 'pending') {
      expect(await store.getWorkflowRun(run.id)).toMatchObject({
        status: 'failed',
        metadata: { error: 'startup failed', stop_reason: { reason: 'launch_failed' } },
      });
      expect(
        (await store.listWorkflowEvents(run.id)).filter(
          event => event.event_type === 'workflow_failed'
        )
      ).toHaveLength(1);
      expect(harness.terminalReports()).toEqual([...reports, run.id]);
    } else {
      expect(await store.getWorkflowRun(run.id)).toEqual(before);
      expect(await store.listWorkflowEvents(run.id)).toEqual(events);
      expect(harness.terminalReports()).toEqual(reports);
    }
  });
  for (const claimedBefore of [false, true]) {
    test.each([
      'running',
      'successor',
      'pending',
      'paused',
      'completed',
      'failed',
      'cancelled',
      'missing',
    ] as const)(
      `execution-scoped failure preserves ownership (resumed: ${claimedBefore}): %s`,
      async state => {
        const harness = getHarness();
        const { store } = harness;
        const run = await store.createWorkflowRun({ workflow_name: 'signal', user_message: '' });
        await store.claimPendingWorkflowRun(run.id);
        if (claimedBefore) {
          await store.pauseWorkflowRun(run.id, approval);
          await store.resumeWorkflowRun(run.id);
        }
        const predecessor = await store.getWorkflowRun(run.id);
        if (!predecessor) throw new Error('Missing predecessor');
        const expectedExecutionClaim = executionClaim(predecessor.metadata);
        if (state === 'successor') {
          await store.pauseWorkflowRun(run.id, approval);
          await store.resumeWorkflowRun(run.id);
        } else if (state === 'pending') {
          await store.updateWorkflowRun(run.id, { status: 'pending' });
        } else if (state === 'paused') await store.pauseWorkflowRun(run.id, approval);
        else if (state === 'completed') await store.completeWorkflowRun(run.id, { duration_ms: 0 });
        else if (state === 'failed') await store.failWorkflowRun(run.id, 'earlier failure');
        else if (state === 'cancelled') await store.cancelWorkflowRun(run.id);
        const before = await store.getWorkflowRun(run.id);
        const events = await store.listWorkflowEvents(run.id);
        const reports = harness.terminalReports();
        expect(
          await store.failWorkflowRun(
            state === 'missing' ? crypto.randomUUID() : run.id,
            'signal',
            {
              expectedExecutionClaim,
              exitReason: 'process_terminated',
              signal: 'SIGTERM',
            }
          )
        ).toEqual({ failed: state === 'running' });
        if (state === 'running') {
          expect(await store.getWorkflowRun(run.id)).toMatchObject({
            status: 'failed',
            metadata: { stop_reason: { reason: 'process_terminated', signal: 'SIGTERM' } },
          });
          expect(
            (await store.listWorkflowEvents(run.id)).filter(
              event => event.event_type === 'workflow_failed'
            )
          ).toHaveLength(1);
          expect(harness.terminalReports()).toEqual([...reports, run.id]);
        } else {
          expect(await store.getWorkflowRun(run.id)).toEqual(before);
          expect(await store.listWorkflowEvents(run.id)).toEqual(events);
          expect(harness.terminalReports()).toEqual(reports);
        }
      }
    );
  }
}
