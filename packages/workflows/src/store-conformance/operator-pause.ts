import { beforeEach, describe, expect, test } from 'bun:test';
import { continuablePauseCursor, executionClaim, type IWorkflowStore } from '../store';
import { operatorPause, type OperatorPauseRecord } from '../schemas';
import { approval, types } from './fixtures';

const request: OperatorPauseRecord = {
  requested: { at: '2026-01-01T00:00:00.000Z', via: 'cli', by: null, fromRun: null },
};

async function running(store: IWorkflowStore) {
  const run = await store.createWorkflowRun({ workflow_name: 'operator-pause', user_message: '' });
  const claimed = await store.claimPendingWorkflowRun(run.id);
  if (!claimed) throw new Error('run was not claimed');
  return claimed;
}

async function requested(store: IWorkflowStore) {
  const run = await running(store);
  expect(await store.updateWorkflowRunMetadataIfRunning(run.id, { operator_pause: request })).toBe(
    true
  );
  return run;
}

export function describeOperatorPauseConformance(getStore: () => IWorkflowStore): void {
  describe('operator pause', () => {
    let store: IWorkflowStore;
    beforeEach(() => {
      store = getStore();
    });

    test('pauses only a running run with a pending request under its own claim', async () => {
      const cancelled = await requested(store);
      await store.cancelWorkflowRun(cancelled.id);
      const gated = await requested(store);
      await store.pauseWorkflowRun(gated.id, approval);
      const unrequested = await running(store);
      const otherClaim = await requested(store);
      const refusals: [string, string | null][] = [
        [cancelled.id, executionClaim(cancelled.metadata)],
        [gated.id, executionClaim(gated.metadata)],
        [unrequested.id, executionClaim(unrequested.metadata)],
        [otherClaim.id, 'another-owner'],
      ];
      for (const [id, claimId] of refusals) {
        const before = await store.getWorkflowRun(id);
        expect(await store.pauseWorkflowRunForOperator(id, claimId)).toEqual({ paused: false });
        expect(await store.getWorkflowRun(id)).toEqual(before);
        expect(await types(store, id)).not.toContain('operator_paused');
      }
    });

    test('an operator-paused run is never continued through a stale gate and resumes clean', async () => {
      const first = await running(store);
      await store.pauseWorkflowRun(first.id, { ...approval, resolved: 'approved' });
      const run = await store.resumeWorkflowRun(first.id);
      await store.updateWorkflowRunMetadataIfRunning(run.id, { operator_pause: request });

      expect(await store.pauseWorkflowRunForOperator(run.id, executionClaim(run.metadata))).toEqual(
        { paused: true }
      );

      const paused = await store.getWorkflowRun(run.id);
      if (!paused) throw new Error('run is missing');
      expect(paused.status).toBe('paused');
      expect(paused.metadata.pause_cause).toBe('operator');
      expect(operatorPause(paused)).toMatchObject({
        state: 'paused',
        pausedAt: expect.any(String),
      });
      expect(await types(store, run.id)).toContain('operator_paused');
      expect(continuablePauseCursor(paused)).toBeUndefined();
      expect(
        (await store.listDueWorkflowContinuations(new Date(Date.now() + 3_600_000), 50)).map(
          due => due.id
        )
      ).not.toContain(run.id);

      const resumed = await store.resumeWorkflowRun(run.id);
      expect(resumed.status).toBe('running');
      expect(resumed.metadata.operator_pause).toBeUndefined();
      expect(await types(store, run.id)).toContain('workflow_unpaused');
    });
  });
}
