import { describe, expect, test } from 'bun:test';
import { subscribeRunSlotRelease } from '../run-slot-release';
import { resourceStartFixtures } from '../resource-start-conformance';
import { deadlineWaitCursor } from '../store';
import type { WorkflowStoreHarness } from '../store-conformance';
import {
  approval,
  CONFORMANCE_CODEBASE_ID,
  CONFORMANCE_CONVERSATION_ID,
  gateEvents,
  running,
  wait,
} from './fixtures';

export function describeRunSlotReleaseConformance(
  label: string,
  makeHarness: () => Promise<WorkflowStoreHarness>
): void {
  describe(`committed slot release: ${label}`, () => {
    test.each(['complete', 'fail', 'cancel', 'fan-out', 'reject', 'reset'] as const)(
      '%s publishes only after the winning commit',
      async mode => {
        const harness = await makeHarness();
        const { store } = harness;
        const releases: string[] = [];
        const dispose = subscribeRunSlotRelease(store, async ids => {
          for (const id of ids) {
            const run = await store.getWorkflowRun(id);
            expect(run?.status).toBe(
              mode === 'complete' ? 'completed' : mode === 'fail' ? 'failed' : 'cancelled'
            );
            expect(await store.listWorkflowEvents(id)).toContainEqual(
              expect.objectContaining({ event_type: `workflow_${run?.status}` })
            );
            releases.push(id);
          }
        });
        try {
          const run = await running(store, {
            origin: { conversationId: CONFORMANCE_CONVERSATION_ID },
          });
          if (mode === 'reject' || mode === 'reset') await store.pauseWorkflowRun(run.id, approval);
          const write = () => {
            switch (mode) {
              case 'complete':
                return store.completeWorkflowRun(run.id, { duration_ms: 1 });
              case 'fail':
                return store.failWorkflowRun(run.id, 'failure');
              case 'cancel':
                return store.cancelWorkflowRun(run.id);
              case 'fan-out':
                return store.cancelFanOutRun(run.id, 'fan_out_sibling');
              case 'reject':
                return store.resolveAndCancelApprovalGate(run.id, gateEvents(0), {
                  reason: 'rejected',
                });
              case 'reset':
                return store.cancelResumableRunsForConversation(CONFORMANCE_CONVERSATION_ID);
            }
          };
          await write();
          expect(releases).toEqual([run.id]);
          await write().catch(() => undefined);
          expect(releases).toEqual([run.id]);
        } finally {
          dispose();
          await harness.close();
        }
      }
    );

    test('bulk reset publishes every changed run and excludes unchanged runs', async () => {
      const harness = await makeHarness();
      const { store } = harness;
      const releases: string[] = [];
      const dispose = subscribeRunSlotRelease(store, async ids => {
        releases.push(...ids);
      });
      try {
        const first = await running(store, {
          origin: { conversationId: CONFORMANCE_CONVERSATION_ID },
        });
        const second = await running(store, {
          origin: { conversationId: CONFORMANCE_CONVERSATION_ID },
        });
        await store.pauseWorkflowRun(first.id, approval);
        await store.pauseWorkflowRun(second.id, approval);
        await running(store);
        await store.cancelResumableRunsForConversation(CONFORMANCE_CONVERSATION_ID);
        expect(releases.sort()).toEqual([first.id, second.id].sort());
      } finally {
        dispose();
        await harness.close();
      }
    });

    test('stale terminal claims and failed writes publish nothing', async () => {
      const harness = await makeHarness();
      const { store } = harness;
      const releases: string[] = [];
      const dispose = subscribeRunSlotRelease(store, async ids => {
        releases.push(...ids);
      });
      try {
        const run = await running(store);
        expect(
          await store.failWorkflowRun(run.id, 'stale', { expectedExecutionClaim: 'stale' })
        ).toEqual({ failed: false });
        const pending = await store.createWorkflowRun({
          workflow_name: 'pending',
          user_message: '',
        });
        await expect(store.completeWorkflowRun(pending.id, { duration_ms: 1 })).rejects.toThrow();
        expect(releases).toEqual([]);
        expect((await store.getWorkflowRun(run.id))?.status).toBe('running');
        expect((await store.getWorkflowRun(pending.id))?.status).toBe('pending');
      } finally {
        dispose();
        await harness.close();
      }
    });

    test('pause release publishes only when the exact cursor frees a slot', async () => {
      const harness = await makeHarness();
      const { store } = harness;
      const releases: string[] = [];
      const dispose = subscribeRunSlotRelease(store, async ids => {
        releases.push(...ids);
      });
      try {
        const { start } = resourceStartFixtures(
          CONFORMANCE_CODEBASE_ID,
          CONFORMANCE_CONVERSATION_ID
        );
        const intent = start();
        const id = intent.launch.run.id;
        await store.admitResourceStart(intent);
        await store.claimPendingWorkflowRun(id);
        await store.pauseWorkflowRunForWait(id, wait, { kind: 'started', stepName: 'wait' });
        const cursor = deadlineWaitCursor(wait);
        expect(
          await store.releasePausedRunSlot(id, { ...cursor, resumeAt: '2027-01-01T00:00:00.000Z' })
        ).toEqual({ released: false });
        expect(releases).toEqual([]);
        expect(await store.releasePausedRunSlot(id, cursor)).toEqual({ released: true });
        expect(releases).toEqual([id]);
        expect(await store.releasePausedRunSlot(id, cursor)).toEqual({ released: false });
        expect(releases).toEqual([id]);
        expect((await store.getWorkflowRun(id))?.status).toBe('paused');
      } finally {
        dispose();
        await harness.close();
      }
    });
  });
}
