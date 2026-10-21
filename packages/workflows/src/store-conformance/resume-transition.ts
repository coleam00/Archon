import { expect, test } from 'bun:test';
import { executionClaim } from '../store';
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
