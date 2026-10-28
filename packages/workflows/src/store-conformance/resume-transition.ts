import { expect, test } from 'bun:test';
import { executionClaim, WorkflowNotResumableError } from '../store';
import type { WorkflowStoreHarness } from '../store-conformance';

const approval = { nodeId: 'review', message: 'Choose', type: 'approval' as const };
const schedule = {
  reason: 'quota',
  resumeAt: '2026-01-02T00:00:00.000Z',
  deadlineAt: '2026-01-03T00:00:00.000Z',
  attempt: 1,
  maxAttempts: 3,
};

export function describeResumeTransitionConformance(getHarness: () => WorkflowStoreHarness): void {
  test.each([
    { status: 'failed', error: 'original error' },
    { status: 'failed', error: '' },
    { status: 'failed', error: null },
    { status: 'failed', error: undefined },
    { status: 'failed', error: 42 },
    { status: 'paused', error: undefined },
  ] as const)(
    'resume from %j has one winner and preserves cleared failure evidence',
    async ({ status, error }) => {
      const { store } = getHarness();
      const run = await store.createWorkflowRun({
        workflow_name: 'resume',
        user_message: '',
        metadata: { keep: true },
      });
      await store.claimPendingWorkflowRun(run.id);
      if (status === 'failed')
        await store.failWorkflowRun(run.id, typeof error === 'string' ? error : '', {
          exitReason: 'node_error',
        });
      else await store.pauseWorkflowRun(run.id, approval);
      await store.updateWorkflowRun(run.id, { metadata: { error } });
      const before = (await store.listWorkflowEvents(run.id)).map(event => event.event_type);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => store.resumeWorkflowRun(run.id))
      );
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      for (const result of results)
        if (result.status === 'rejected')
          expect(result.reason).toBeInstanceOf(WorkflowNotResumableError);
      expect(await store.getWorkflowRun(run.id)).toMatchObject({
        status: 'running',
        completed_at: null,
        metadata: { keep: true },
      });
      const metadata = (await store.getWorkflowRun(run.id))?.metadata;
      expect(metadata).not.toHaveProperty('error');
      expect(metadata).not.toHaveProperty('stop_reason');
      // Only the winning resume writes, and a resumed pause is in the feed.
      expect((await store.listWorkflowEvents(run.id)).map(event => event.event_type)).toEqual([
        ...before,
        ...(status === 'failed' ? ['workflow_resumed'] : ['workflow_unpaused']),
      ]);
      if (status === 'failed') {
        const resumed = (await store.listWorkflowEvents(run.id)).find(
          event => event.event_type === 'workflow_resumed'
        );
        expect(resumed?.data).toEqual(typeof error === 'string' && error !== '' ? { error } : {});
      }
    }
  );
  test.each([
    ['failed', false],
    ['failed', true],
    ['paused', false],
    ['running', false],
  ] as const)(
    'resume clears lifecycle metadata and claims only an untriggered failed schedule (%s, triggered=%j)',
    async (status, triggered) => {
      const harness = getHarness();
      const { store } = harness;
      const run = await store.createWorkflowRun({ workflow_name: 'resume', user_message: '' });
      await store.claimPendingWorkflowRun(run.id);
      if (status === 'failed') await store.failWorkflowRun(run.id, 'quota');
      else if (status === 'paused') await store.pauseWorkflowRun(run.id, approval);
      const scheduled = {
        ...schedule,
        ...(triggered ? { triggeredAt: '2026-01-01T00:00:00.000Z' } : {}),
      };
      const cleared = {
        error: 'prior failure',
        stop_reason: { reason: 'node_error' },
        tool_call_attention: { calls: [] },
        continuation_retry_at: '2026-01-02T00:00:00.000Z',
        capacity_wait: { since: '2026-01-01T00:00:00.000Z' },
        source_release: { nodeId: 'check', retryAt: '2026-01-02T00:00:00.000Z' },
      };
      await store.updateWorkflowRun(run.id, {
        metadata: { ...cleared, scheduled_resume: scheduled, keep: { nested: true } },
      });
      await harness.backdate(run.id, { last_activity_at: new Date('2000-01-01') });
      const before = await store.listWorkflowEvents(run.id);
      const resumed = await store.resumeWorkflowRun(run.id);
      for (const key of Object.keys(cleared)) expect(resumed.metadata).not.toHaveProperty(key);
      expect(resumed.metadata.keep).toEqual({ nested: true });
      expect(executionClaim(resumed.metadata)).not.toBeNull();
      const claimsSchedule = status === 'failed' && !triggered;
      expect(resumed.metadata.scheduled_resume).toEqual(
        claimsSchedule ? { ...scheduled, triggeredAt: expect.any(String) } : scheduled
      );
      const events = (await store.listWorkflowEvents(run.id)).slice(before.length);
      expect(events.map(event => event.event_type)).toEqual([
        'workflow_resumed',
        ...(status === 'paused' ? ['workflow_unpaused'] : []),
        ...(claimsSchedule ? ['quota_resume_triggered'] : []),
      ]);
      expect(events[0]?.data).toEqual({ error: 'prior failure' });
      if (claimsSchedule)
        expect(events.at(-1)?.data).toEqual({
          attempt: schedule.attempt,
          resume_at: schedule.resumeAt,
        });
    }
  );
}
