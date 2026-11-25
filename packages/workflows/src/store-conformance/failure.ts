import { expect, test } from 'bun:test';
import { DETACHED_LAUNCH_METADATA_KEY, executionClaim } from '../store';
import type { WorkflowStoreHarness } from '../store-conformance';
import type { WorkflowRunFailureOptions } from '../workflow-run-failure';
import { approval } from './fixtures';

export function describeExecutionFailureConformance(getHarness: () => WorkflowStoreHarness): void {
  test('a paused run fails only with includePaused, and a terminal run never moves', async () => {
    const { store } = getHarness();
    const run = await store.createWorkflowRun({ workflow_name: 'paused-fail', user_message: '' });
    await store.claimPendingWorkflowRun(run.id);
    await store.pauseWorkflowRun(run.id, approval);
    // Without the option a paused row is not this caller's to fail.
    await expect(store.failWorkflowRun(run.id, 'boom')).rejects.toThrow();
    expect((await store.getWorkflowRun(run.id))?.status).toBe('paused');
    expect(
      await store.failWorkflowRun(run.id, 'write unknown', {
        exitReason: 'outcome_unknown',
        includePaused: true,
      })
    ).toMatchObject({ failed: true });
    expect(await store.getWorkflowRun(run.id)).toMatchObject({
      status: 'failed',
      metadata: { stop_reason: { reason: 'outcome_unknown' } },
    });
    expect(
      await store.failWorkflowRun(run.id, 'again', {
        exitReason: 'node_error',
        includePaused: true,
      })
    ).toEqual({ failed: false });
    expect((await store.getWorkflowRun(run.id))?.metadata).toMatchObject({
      stop_reason: { reason: 'outcome_unknown' },
    });
  });

  for (const condition of ['detached', 'pending', 'combined'] as const) {
    const options: WorkflowRunFailureOptions = {
      exitReason: 'launch_failed',
      ...(condition !== 'pending' ? { pendingLaunchToken: 'launch-token' } : {}),
      ...(condition !== 'detached' ? { pendingOnly: true } : {}),
    };
    const states = [
      'pending',
      'wrong token',
      'running',
      'paused',
      'completed',
      'failed',
      'cancelled',
      'missing',
    ] as const;
    test.each(states.filter(state => condition !== 'pending' || state !== 'wrong token'))(
      `startup failure preserves ownership (${condition}): %s`,
      async state => {
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
              ...options,
              ...(state === 'wrong token' ? { pendingLaunchToken: 'stale-token' } : {}),
            }
          )
        ).toEqual({
          failed: state === 'pending',
        });
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
      }
    );
  }
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
  test.each(['pending', 'running', 'paused'] as const)(
    'a pending-only cancel writes only a pending run: %s',
    async state => {
      const harness = getHarness();
      const { store } = harness;
      const run = await store.createWorkflowRun({ workflow_name: 'refused', user_message: '' });
      if (state !== 'pending') await store.claimPendingWorkflowRun(run.id);
      if (state === 'paused') await store.pauseWorkflowRun(run.id, approval);
      const before = await store.getWorkflowRun(run.id);
      const events = await store.listWorkflowEvents(run.id);
      expect(
        await store.cancelWorkflowRun(
          run.id,
          { cancel_reason: 'precondition_failed' },
          { pendingOnly: true }
        )
      ).toEqual({ cancelled: state === 'pending' });
      if (state === 'pending') {
        expect((await store.getWorkflowRun(run.id))?.status).toBe('cancelled');
      } else {
        expect(await store.getWorkflowRun(run.id)).toEqual(before);
        expect(await store.listWorkflowEvents(run.id)).toEqual(events);
      }
    }
  );
}
