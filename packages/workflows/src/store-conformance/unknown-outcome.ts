import { beforeEach, describe, expect, test } from 'bun:test';
import { readSourceRelease } from '../schemas';
import {
  WorkflowNotResumableError,
  deadlineWaitCursor,
  executionClaim,
  type IWorkflowStore,
  type ResumeClaimCursor,
} from '../store';
import type { WorkflowStoreHarness } from '../store-conformance';
import { approval, failWithSchedule, rejection, running, schedule, wait } from './fixtures';

/** The execution claim the run's row carries now. */
async function claimOf(store: IWorkflowStore, id: string): Promise<string | null> {
  const run = await store.getWorkflowRun(id);
  if (run === null) throw new Error('run vanished');
  return executionClaim(run.metadata);
}

/** A run the automatic claim of `kind` could take, holding the failure `kind` of `write`. */
async function heldFor(
  store: IWorkflowStore,
  kind: 'wait' | 'answered' | 'source' | 'child' | 'quota',
  failureKind: string
): Promise<{ id: string; cursor: ResumeClaimCursor }> {
  const run = await running(store);
  await store.persistWorkflowEvent({
    workflow_run_id: run.id,
    event_type: 'node_failed',
    step_name: 'write',
    data: { error: 'timed out', failure_kind: failureKind },
  });
  if (kind === 'wait') {
    await store.pauseWorkflowRunForWait(run.id, wait, { kind: 'started', stepName: 'wait' });
    return { id: run.id, cursor: deadlineWaitCursor(wait) };
  }
  if (kind === 'answered') {
    await store.pauseWorkflowRun(run.id, approval);
    await store.resolveApprovalGate(
      run.id,
      { approval: { ...approval, resolved: 'approved' } },
      []
    );
    return {
      id: run.id,
      cursor: { kind: 'answered', nodeId: approval.nodeId, pauseId: 'first' },
    };
  }
  if (kind === 'source') {
    await store.releaseRunForUnreadableSource(run.id, {
      claimId: await claimOf(store, run.id),
      nodeId: 'check',
      error: 'EACCES',
      retryAt: new Date().toISOString(),
    });
    const release = readSourceRelease((await store.getWorkflowRun(run.id))?.metadata);
    if (release === undefined) throw new Error('run was not released');
    const { path: _path, ...rest } = release;
    return { id: run.id, cursor: { kind: 'source', ...rest } };
  }
  if (kind === 'child') {
    await store.pauseWorkflowRun(run.id, {
      nodeId: 'sub',
      message: 'child paused',
      type: 'child_workflow',
      childRunId: 'child-1',
    });
    return { id: run.id, cursor: { kind: 'child', childRunId: 'child-1' } };
  }
  await failWithSchedule(store, run.id);
  return {
    id: run.id,
    cursor: { kind: 'quota', attempt: schedule.attempt, resumeAt: schedule.resumeAt },
  };
}

export function describeUnknownOutcomeConformance(getHarness: () => WorkflowStoreHarness): void {
  describe('a run that holds a failure whose outcome is unknown', () => {
    let store: IWorkflowStore;
    beforeEach(() => {
      store = getHarness().store;
    });

    for (const kind of ['wait', 'answered', 'source', 'child', 'quota'] as const) {
      test(`refuses the automatic ${kind} claim and admits a resume by hand`, async () => {
        const held = await heldFor(store, kind, 'outcome_unknown');
        const before = await store.getWorkflowRun(held.id);
        expect(await rejection(store.resumeWorkflowRun(held.id, held.cursor))).toBeInstanceOf(
          WorkflowNotResumableError
        );
        expect(await store.getWorkflowRun(held.id)).toEqual(before);
        expect((await store.resumeWorkflowRun(held.id)).status).toBe('running');

        // The same claim of a run whose failure is of another kind is admitted.
        const ordinary = await heldFor(store, kind, 'exec_failed');
        expect((await store.resumeWorkflowRun(ordinary.id, ordinary.cursor)).status).toBe(
          'running'
        );
      });
    }

    test('admits the automatic claim once a later record of the node completed', async () => {
      const held = await heldFor(store, 'wait', 'outcome_unknown');
      await store.persistWorkflowEvent({
        workflow_run_id: held.id,
        event_type: 'node_completed',
        step_name: 'write',
        data: { node_output: '' },
      });
      expect((await store.resumeWorkflowRun(held.id, held.cursor)).status).toBe('running');
    });

    test('admits the automatic claim when a completed fan-out join absorbed the instance', async () => {
      const scope = 'refine.__archon_fan_out__fan__root';
      const absorbed = await running(store);
      const live = await running(store);
      for (const run of [absorbed, live]) {
        await store.persistWorkflowEvent({
          workflow_run_id: run.id,
          event_type: 'fan_out_instances',
          step_name: scope,
          data: {},
        });
        await store.persistWorkflowEvent({
          workflow_run_id: run.id,
          event_type: 'node_failed',
          step_name: `${scope}__abc__write`,
          data: { error: 'timed out', failure_kind: 'outcome_unknown' },
        });
      }
      await store.persistWorkflowEvent({
        workflow_run_id: absorbed.id,
        event_type: 'node_completed',
        step_name: 'refine.fan',
        data: { node_output: '' },
      });
      // An audit event on the absorbed step after the join completed is not a node record.
      await store.persistWorkflowEvent({
        workflow_run_id: absorbed.id,
        event_type: 'node_session_resumed',
        step_name: `${scope}__abc__write`,
        data: {},
      });
      for (const run of [absorbed, live])
        await store.pauseWorkflowRunForWait(run.id, wait, { kind: 'started', stepName: 'wait' });
      expect((await store.resumeWorkflowRun(absorbed.id, deadlineWaitCursor(wait))).status).toBe(
        'running'
      );
      expect(
        await rejection(store.resumeWorkflowRun(live.id, deadlineWaitCursor(wait)))
      ).toBeInstanceOf(WorkflowNotResumableError);
    });

    test('a failure under the pass own claim also fails the row it paused, and no other', async () => {
      const own = await running(store);
      const claim = await claimOf(store, own.id);
      await store.pauseWorkflowRunForWait(own.id, wait, { kind: 'started', stepName: 'wait' });
      const options = {
        exitReason: 'outcome_unknown' as const,
        expectedExecutionClaim: claim,
        pausedUnderClaim: true as const,
      };
      expect(await store.failWorkflowRun(own.id, 'unknown', options)).toEqual({ failed: true });
      expect(await store.getWorkflowRun(own.id)).toMatchObject({
        status: 'failed',
        metadata: { stop_reason: { reason: 'outcome_unknown' } },
      });

      // A claim taken since the pause belongs to another pass: its row is left as it is.
      const taken = await running(store);
      const old = await claimOf(store, taken.id);
      await store.pauseWorkflowRunForWait(taken.id, wait, { kind: 'started', stepName: 'wait' });
      await store.resumeWorkflowRun(taken.id, deadlineWaitCursor(wait));
      await store.pauseWorkflowRun(taken.id, approval);
      const before = await store.getWorkflowRun(taken.id);
      expect(
        await store.failWorkflowRun(taken.id, 'unknown', {
          ...options,
          expectedExecutionClaim: old,
        })
      ).toEqual({ failed: false });
      expect(await store.getWorkflowRun(taken.id)).toEqual(before);
    });
  });
}
