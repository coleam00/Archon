import { beforeEach, describe, expect, test } from 'bun:test';
import { executionClaim, WorkflowNotResumableError, type IWorkflowStore } from '../store';
import { TERMINAL_WORKFLOW_STATUSES, readSourceRelease } from '../schemas/workflow-run';
import type { WorkflowStoreHarness } from '../store-conformance';
import {
  approval,
  wait,
  schedule,
  failWithSchedule,
  eight,
  create,
  running,
  types,
  rejection,
} from './fixtures';
import { assertWorkflowClaimRace } from './races';
import { describeResumeTransitionConformance } from './resume-transition';

export function describeRunsAndClaimsConformance(getHarness: () => WorkflowStoreHarness): void {
  describe('runs and claims', () => {
    let harness: WorkflowStoreHarness;
    let store: IWorkflowStore;
    beforeEach(() => {
      harness = getHarness();
      store = harness.store;
    });

    test.each(['paused', 'completed', 'failed', 'cancelled'] as const)(
      'running metadata write refuses a run that became %s after observation',
      async status => {
        const run = await running(store, { metadata: { preserved: true } });
        expect((await store.getWorkflowRun(run.id))?.status).toBe('running');
        if (status === 'paused') await store.updateWorkflowRun(run.id, { status });
        else if (status === 'completed')
          await store.completeWorkflowRun(run.id, { duration_ms: 1 });
        else if (status === 'failed') await store.failWorkflowRun(run.id, 'failure');
        else await store.cancelWorkflowRun(run.id);
        const before = await store.getWorkflowRun(run.id);
        expect(
          await store.updateWorkflowRunMetadataIfRunning(run.id, { end_turn_request: {} })
        ).toBe(false);
        expect(await store.getWorkflowRun(run.id)).toEqual(before);
      }
    );

    test('running metadata write merges only into a running run', async () => {
      const pending = await create(store);
      expect(await store.updateWorkflowRunMetadataIfRunning(pending.id, { request: true })).toBe(
        false
      );
      expect(
        await store.updateWorkflowRunMetadataIfRunning(crypto.randomUUID(), { request: true })
      ).toBe(false);
      const run = await running(store, { metadata: { preserved: true } });
      expect(await store.updateWorkflowRunMetadataIfRunning(run.id, { request: true })).toBe(true);
      expect((await store.getWorkflowRun(run.id))?.metadata).toMatchObject({
        preserved: true,
        request: true,
      });
    });

    test('pending claim has exactly one winner and stamps the checkout', async () => {
      await assertWorkflowClaimRace(store);
    });
    describeResumeTransitionConformance(getHarness);
    test('resume audits a legacy metadata-only error and ignores empty errors', async () => {
      for (const error of ['legacy failure', '', null]) {
        const run = await running(store, { metadata: { error } });
        await store.pauseWorkflowRun(run.id, approval);
        await store.resumeWorkflowRun(run.id);
        const events = await store.listWorkflowEvents(run.id);
        expect(events.map(event => event.event_type)).toEqual([
          ...(error ? ['workflow_resumed'] : []),
          'workflow_unpaused',
        ]);
        if (error) expect(events[0]?.data).toEqual({ error });
        expect((await store.getWorkflowRun(run.id))?.metadata).not.toHaveProperty('error');
      }
    });
    test('resume refuses stale cursors and consumes a quota schedule once', async () => {
      const run = await running(store);
      await store.pauseWorkflowRunForWait(run.id, wait, { kind: 'started', stepName: 'wait' });
      expect(
        await rejection(
          store.resumeWorkflowRun(run.id, {
            kind: 'wait',
            nodeId: 'other',
            resumeAt: wait.resumeAt,
          })
        )
      ).toBeInstanceOf(WorkflowNotResumableError);
      expect(
        await rejection(
          store.resumeWorkflowRun(run.id, {
            kind: 'wait',
            nodeId: wait.nodeId,
            resumeAt: schedule.deadlineAt,
          })
        )
      ).toBeInstanceOf(WorkflowNotResumableError);
      await store.resumeWorkflowRun(run.id, {
        kind: 'wait',
        nodeId: wait.nodeId,
        resumeAt: wait.resumeAt,
      });
      await failWithSchedule(store, run.id);
      expect(
        await rejection(
          store.resumeWorkflowRun(run.id, {
            kind: 'quota',
            attempt: 2,
            resumeAt: schedule.resumeAt,
          })
        )
      ).toBeInstanceOf(WorkflowNotResumableError);
      const result = await store.resumeWorkflowRun(run.id, {
        kind: 'quota',
        attempt: 1,
        resumeAt: schedule.resumeAt,
      });
      expect(result.metadata.scheduled_resume).toMatchObject({
        ...schedule,
        triggeredAt: expect.any(String),
      });
      expect(await types(store, run.id)).toEqual([
        'wait_started',
        'workflow_unpaused',
        'workflow_failed',
        'workflow_resumed',
        'quota_resume_triggered',
      ]);
    });
    test('a quota continuation released for an unreadable source stays due as a source continuation', async () => {
      const due = async (now: Date): Promise<boolean> =>
        (await store.listDueWorkflowContinuations(now, 50)).some(due => due.id === run.id);
      const run = await running(store);
      await failWithSchedule(store, run.id);
      const now = new Date();
      expect(await due(now)).toBe(true);
      await store.resumeWorkflowRun(run.id, {
        kind: 'quota',
        attempt: schedule.attempt,
        resumeAt: schedule.resumeAt,
      });
      expect(await due(now)).toBe(false);

      const retryAt = new Date(now.getTime() + 60_000).toISOString();
      const afterRetry = new Date(Date.parse(retryAt) + 1000);
      expect(
        await store.releaseRunForUnreadableSource(run.id, {
          claimId: executionClaim((await store.getWorkflowRun(run.id))?.metadata ?? {}),
          nodeId: 'check',
          path: '/capture/project/.archon/scripts',
          error: 'EACCES',
          retryAt,
        })
      ).toEqual({ released: true });
      const released = await store.getWorkflowRun(run.id);
      expect(released?.status).toBe('paused');
      const release = readSourceRelease(released?.metadata);
      expect(release).toMatchObject({ nodeId: 'check', path: '/capture/project/.archon/scripts' });
      if (release === undefined) throw new Error('source release not recorded');
      expect(await due(now)).toBe(false);
      expect(await due(afterRetry)).toBe(true);

      const cursor = { kind: 'source' as const, ...release };
      const laterRetry = new Date(afterRetry.getTime() + 3_600_000).toISOString();
      await store.deferWorkflowContinuation(run.id, laterRetry, {
        ...cursor,
        releasedAt: '2000-01-01T00:00:00.000Z',
      });
      expect(await due(afterRetry)).toBe(true);
      await store.deferWorkflowContinuation(run.id, laterRetry, cursor);
      expect(await due(afterRetry)).toBe(false);

      const resumed = await store.resumeWorkflowRun(run.id, cursor);
      expect(resumed.status).toBe('running');
      expect(readSourceRelease(resumed.metadata)).toBeUndefined();
      expect(await rejection(store.resumeWorkflowRun(run.id, cursor))).toBeInstanceOf(
        WorkflowNotResumableError
      );
      expect(await types(store, run.id)).toContain('source_released');
    });
    test('only stale running runs can resume; completed and cancelled runs refuse', async () => {
      const run = await running(store);
      expect(await rejection(store.resumeWorkflowRun(run.id))).toBeInstanceOf(
        WorkflowNotResumableError
      );
      await harness.backdate(run.id, { last_activity_at: new Date(Date.now() - 2 * 86_400_000) });
      expect((await store.resumeWorkflowRun(run.id)).status).toBe('running');
      await store.completeWorkflowRun(run.id, { duration_ms: 1 });
      expect(await rejection(store.resumeWorkflowRun(run.id))).toBeInstanceOf(
        WorkflowNotResumableError
      );
      const cancelled = await create(store);
      await store.cancelWorkflowRun(cancelled.id);
      expect(await rejection(store.resumeWorkflowRun(cancelled.id))).toBeInstanceOf(
        WorkflowNotResumableError
      );
    });
    test('running-only event writes explicitly allow paused runs and refuse terminal runs', async () => {
      const run = await create(store);
      const event = {
        workflow_run_id: run.id,
        event_type: 'node_completed' as const,
        step_name: 'build',
        data: { node_output: 'ok' },
      };
      expect(await store.persistWorkflowEventIfRunning(event)).toEqual({ persisted: false });
      await store.claimPendingWorkflowRun(run.id);
      expect(await store.persistWorkflowEventIfRunning(event)).toEqual({ persisted: true });
      await store.pauseWorkflowRun(run.id, approval);
      expect(await store.persistWorkflowEventIfRunning(event)).toEqual({ persisted: false });
      expect(await store.persistWorkflowEventIfRunning(event, { allowPaused: true })).toEqual({
        persisted: true,
      });
      await store.cancelWorkflowRun(run.id);
      expect(await store.persistWorkflowEventIfRunning(event, { allowPaused: true })).toEqual({
        persisted: false,
      });
      expect((await types(store, run.id)).filter(type => type === 'node_completed')).toHaveLength(
        2
      );
    });
    test('write-once checkout fields keep their first value and generic updates refuse terminal status', async () => {
      const run = await create(store);
      const baseline = { kind: 'not_git' as const, sampledAt: wait.waitingSince };
      expect(await store.recordWorkflowRunCheckoutBaseline(run.id, baseline)).toEqual(baseline);
      expect(
        await store.recordWorkflowRunCheckoutBaseline(run.id, {
          ...baseline,
          sampledAt: wait.resumeAt,
        })
      ).toEqual(baseline);
      await store.updateWorkflowRun(run.id, {
        output_root: '/first',
        working_path: '/first',
        metadata: { keep: true },
      });
      await store.updateWorkflowRun(run.id, {
        output_root: '/second',
        working_path: '/second',
        metadata: { extra: true },
      });
      expect(await store.getWorkflowRun(run.id)).toMatchObject({
        output_root: '/first',
        working_path: '/first',
        metadata: { keep: true, extra: true },
      });
      // Exercise the runtime boundary used by untyped SDK consumers.
      for (const status of TERMINAL_WORKFLOW_STATUSES) {
        const terminalUpdate = JSON.parse(JSON.stringify({ status })) as Parameters<
          IWorkflowStore['updateWorkflowRun']
        >[1];
        expect(await rejection(store.updateWorkflowRun(run.id, terminalUpdate))).toMatchObject({
          message: expect.stringContaining('lifecycle writer'),
        });
      }
      expect(await store.getWorkflowRunStatus(run.id)).toBe('pending');
    });
    test('write-back has one winner and release permits another claim', async () => {
      const run = await running(store);
      const results = await eight(() => store.claimWriteback(run.id));
      expect(results.filter(result => result.claimed)).toHaveLength(1);
      await store.releaseWritebackClaim(run.id);
      expect((await store.getWorkflowRun(run.id))?.metadata).not.toHaveProperty(
        'writeback_apply_claimed'
      );
      expect(await store.claimWriteback(run.id)).toEqual({ claimed: true });
    });
    test('path holders exclude stale pending, self and ancestors and agree on the id tiebreak', async () => {
      const path = '/locked';
      const first = await create(store, {
        id: '00000000-0000-4000-8000-000000000001',
        working_path: path,
      });
      const second = await create(store, {
        id: '00000000-0000-4000-8000-000000000002',
        working_path: path,
      });
      const tie = new Date(Date.now() - 60_000);
      for (const run of [first, second]) await harness.backdate(run.id, { started_at: tie });
      expect(
        await store.getActiveWorkflowRunByPath(path, { id: first.id, startedAt: tie })
      ).toBeNull();
      expect(
        (await store.getActiveWorkflowRunByPath(path, { id: second.id, startedAt: tie }))?.id
      ).toBe(first.id);
      expect(
        await store.getActiveWorkflowRunByPath(path, {
          id: second.id,
          startedAt: tie,
          excludeRunIds: [first.id],
        })
      ).toBeNull();
      for (const run of [first, second])
        await harness.backdate(run.id, { started_at: new Date(Date.now() - 600_000) });
      expect(await store.getActiveWorkflowRunByPath(path)).toBeNull();
      await store.claimPendingWorkflowRun(first.id);
      expect((await store.getActiveWorkflowRunByPath(path))?.id).toBe(first.id);
      await store.pauseWorkflowRun(first.id, approval);
      expect((await store.getActiveWorkflowRunByPath(path))?.id).toBe(first.id);
      await store.cancelWorkflowRun(first.id);
      expect(await store.getActiveWorkflowRunByPath(path)).toBeNull();
    });
    test('resumable lookup chooses newest matching run and includes stale running', async () => {
      const first = await running(store, { working_path: '/resume' });
      await store.failWorkflowRun(first.id, 'old');
      await harness.backdate(first.id, { started_at: new Date(Date.now() - 600_000) });
      const second = await running(store, { working_path: '/resume' });
      await store.pauseWorkflowRun(second.id, approval);
      await running(store, { workflow_name: 'other', working_path: '/resume' });
      await running(store, { working_path: '/other' });
      expect((await store.findResumableRun('conformance', '/resume'))?.id).toBe(second.id);
      await store.cancelWorkflowRun(second.id);
      expect((await store.findResumableRun('conformance', '/resume'))?.id).toBe(first.id);
      await store.resumeWorkflowRun(first.id);
      expect(await store.findResumableRun('conformance', '/resume')).toBeNull();
      await harness.backdate(first.id, { last_activity_at: new Date(Date.now() - 2 * 86_400_000) });
      expect((await store.findResumableRun('conformance', '/resume'))?.id).toBe(first.id);
    });
  });
}
