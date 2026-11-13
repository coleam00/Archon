import { expect, test } from 'bun:test';
import { executionClaim, WorkflowNotResumableError } from '../store';
import { workflowPathPriorityTime } from '../workflow-path-lock';
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
  test('a resumed old run yields to the current checkout holder and keeps creation listing order', async () => {
    const { store, backdate } = getHarness();
    const path = '/timestamp-priority';
    const old = await store.createWorkflowRun({
      workflow_name: 'old',
      user_message: '',
      working_path: path,
    });
    await store.claimPendingWorkflowRun(old.id);
    await store.failWorkflowRun(old.id, 'failed');
    const creation = new Date(Date.now() - 4 * 3600_000);
    await backdate(old.id, { started_at: creation });
    const holder = await store.createWorkflowRun({
      workflow_name: 'holder',
      user_message: '',
      working_path: path,
    });
    await store.claimPendingWorkflowRun(holder.id);
    await backdate(holder.id, { started_at: new Date(creation.getTime() + 3600_000) });
    for (let attempt = 0; attempt < 2; attempt++) {
      const resumed = await store.resumeWorkflowRun(old.id);
      expect(resumed.started_at).toEqual(creation);
      const current = await store.getWorkflowRun(holder.id);
      if (!current) throw new Error('Missing holder');
      expect(
        (
          await store.getActiveWorkflowRunByPath(path, {
            id: old.id,
            startedAt: workflowPathPriorityTime(resumed),
          })
        )?.id
      ).toBe(holder.id);
      expect(
        await store.getActiveWorkflowRunByPath(path, {
          id: holder.id,
          startedAt: workflowPathPriorityTime(current),
        })
      ).toBeNull();
      expect((await store.getActiveWorkflowRunByPath(path))?.id).toBe(holder.id);
      expect(
        (await store.listWorkflowRuns()).runs
          .filter(run => [old.id, holder.id].includes(run.id))
          .map(run => run.id)
      ).toEqual([holder.id, old.id]);
      expect(resumed.active_phase_started_at?.getTime()).toBeGreaterThan(
        creation.getTime() + 3600_000
      );
      await store.failWorkflowRun(old.id, 'again');
    }
  });

  test("a run resumed at exactly the holder's priority time yields despite its lower id", async () => {
    const { store, backdate } = getHarness();
    const path = '/equal-priority';
    const tie = new Date('2021-01-01T00:00:00.000Z');
    const create = (id: string) =>
      store.createWorkflowRun({ id, workflow_name: 'tie', user_message: '', working_path: path });
    const contender = await create('00000000-0000-4000-8000-0000000000a1');
    await store.claimPendingWorkflowRun(contender.id);
    await store.failWorkflowRun(contender.id, 'failed');
    const holder = await create('00000000-0000-4000-8000-0000000000b2');
    await store.claimPendingWorkflowRun(holder.id);
    await backdate(holder.id, { started_at: tie });
    const resumed = await store.resumeWorkflowRun(contender.id);
    await backdate(resumed.id, {
      started_at: new Date('2020-01-01T00:00:00.000Z'),
      active_phase_started_at: tie,
    });
    expect(
      (await store.getActiveWorkflowRunByPath(path, { id: resumed.id, startedAt: tie }))?.id
    ).toBe(holder.id);
  });

  test('path priority agrees on milliseconds, null phases and newer legacy-writer creation times', async () => {
    const { store, backdate } = getHarness();
    const path = '/priority-compatibility';
    const runs = await Promise.all(
      [0, 1].map(() =>
        store.createWorkflowRun({ workflow_name: 'priority', user_message: '', working_path: path })
      )
    );
    runs.sort((a, b) => (a.id < b.id ? -1 : 1));
    const [a, b] = runs;
    if (!a || !b) throw new Error('Missing fixture');
    for (const run of runs) await store.claimPendingWorkflowRun(run.id);
    const creation = new Date('2020-01-01');
    const phase = new Date('2021-01-01T00:00:00.123Z');
    for (const run of runs)
      await backdate(run.id, { started_at: creation, active_phase_started_at: phase });
    const check = async (first: string, second: string) => {
      const earlier = await store.getWorkflowRun(first);
      const later = await store.getWorkflowRun(second);
      if (!earlier || !later) throw new Error('Missing priority fixture');
      expect((await store.getActiveWorkflowRunByPath(path))?.id).toBe(first);
      expect(
        await store.getActiveWorkflowRunByPath(path, {
          id: first,
          startedAt: workflowPathPriorityTime(earlier),
        })
      ).toBeNull();
      expect(
        (
          await store.getActiveWorkflowRunByPath(path, {
            id: second,
            startedAt: workflowPathPriorityTime(later),
          })
        )?.id
      ).toBe(first);
    };
    await backdate(a.id, {
      started_at: new Date('2019-01-01'),
      active_phase_started_at: new Date(phase.getTime() + 1),
    });
    await check(b.id, a.id);
    await backdate(a.id, { active_phase_started_at: null });
    await check(a.id, b.id);
    // An old writer resets started_at without knowing about the phase column.
    await backdate(a.id, { started_at: new Date('2022-01-01'), active_phase_started_at: phase });
    await check(b.id, a.id);
  });

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
      const creation = new Date('2000-01-01');
      await harness.backdate(run.id, { started_at: creation, last_activity_at: creation });
      const before = await store.listWorkflowEvents(run.id);
      const resumed = await store.resumeWorkflowRun(run.id);
      expect(resumed.started_at).toEqual(creation);
      expect(resumed.active_phase_started_at?.getTime()).toBeGreaterThan(creation.getTime());
      expect(resumed.last_activity_at).toEqual(resumed.active_phase_started_at);
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
