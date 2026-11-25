/**
 * Conformance for due continuations no waker can resume, on the SQL stores, run by the
 * SQLite and PostgreSQL integration tests: a due continuation is listed as `owner_lost` with
 * `continuation` while no waker is recorded or every recorded one is a process provably
 * gone, and a live process, a schedule or a one-shot pass keeps it out.
 */
import { expect, test } from 'bun:test';
import { currentProcessOwner } from '@archon/paths/process-owner';
import { listAttentionQueue, readAttentionQueueItem } from '@archon/workflows/attention-queue';
import { CONFORMANCE_CODEBASE_ID } from '@archon/workflows/store-conformance';
import { itemDeps, type Harness } from './item-asks.conformance';

export function describeSqlContinuationWakerConformance(makeHarness: () => Promise<Harness>): void {
  test('a due continuation is listed while no waker can resume it', async () => {
    const harness = await makeHarness();
    try {
      const { queue } = itemDeps(harness);
      const listed = async () =>
        (await listAttentionQueue(queue)).filter(
          item => 'kind' in item && item.kind === 'owner_lost'
        );
      const run = await harness.store.createWorkflowRun({
        workflow_name: 'review',
        user_message: '',
        codebase_id: CONFORMANCE_CODEBASE_ID,
      });
      await harness.store.claimPendingWorkflowRun(run.id);
      // An answered gate is due: only a waker's pass resumes it.
      await harness.store.pauseWorkflowRun(run.id, {
        nodeId: 'review',
        message: 'Ship it?',
        type: 'approval',
        pauseId: 'first',
        resolved: 'approved',
      });
      const due = (wakers: string) => [
        expect.objectContaining({
          kind: 'owner_lost',
          run: expect.objectContaining({ id: run.id }),
          observedStatus: 'paused',
          continuation: { wakers },
        }),
      ];

      // Nothing ever woke continuations on this install.
      expect(await listed()).toEqual(due('none_recorded'));
      expect(await readAttentionQueueItem(queue, run.id)).toEqual(due('none_recorded')[0]);

      // This process is alive, so it may still pass.
      const self = { kind: 'process', ...currentProcessOwner } as const;
      await harness.store.recordContinuationWaker(self);
      expect(await listed()).toEqual([]);

      // An earlier incarnation of this pid is provably gone, as a process that recorded
      // itself and then died leaves it; a live process recording itself forgets that row.
      await harness.db.query('DELETE FROM remote_agent_continuation_wakers');
      await harness.db.query(
        `INSERT INTO remote_agent_continuation_wakers (id, host, kind, pid, instance, recorded_at)
         VALUES ('gone', $1, 'process', $2, $3, $4)`,
        [self.host, self.pid, crypto.randomUUID(), new Date().toISOString()]
      );
      expect(await listed()).toEqual(due('all_gone'));
      await harness.store.recordContinuationWaker(self);
      expect(await harness.store.listContinuationWakers()).toEqual([self]);

      // A schedule restarts its watcher, and a one-shot pass may run again: neither lists.
      await harness.db.query('DELETE FROM remote_agent_continuation_wakers');
      await harness.store.recordContinuationWaker({ kind: 'schedule', host: self.host });
      expect(await listed()).toEqual([]);
      await harness.store.removeContinuationSchedule(self.host);
      expect(await listed()).toEqual(due('none_recorded'));
      await harness.store.recordContinuationWaker({ kind: 'pass', host: self.host });
      expect(await listed()).toEqual([]);
    } finally {
      await harness.close();
    }
  });
}
