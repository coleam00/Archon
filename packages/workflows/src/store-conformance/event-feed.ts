import { beforeEach, describe, expect, test } from 'bun:test';
import {
  FAN_OUT_CANCEL_REASONS,
  WorkflowEventCursorError,
  type WorkflowEventCursor,
  type IWorkflowStore,
} from '../store';
import type { WorkflowStoreHarness } from '../store-conformance';
import {
  CONFORMANCE_CONVERSATION_ID,
  approval,
  wait,
  create,
  running,
  types,
  rejection,
  gateEvents,
} from './fixtures';
import { assertWorkflowEventFeedRace } from './races';

export function describeEventFeedConformance(getHarness: () => WorkflowStoreHarness): void {
  describe('events and feeds', () => {
    let harness: WorkflowStoreHarness;
    let store: IWorkflowStore;
    beforeEach(() => {
      harness = getHarness();
      store = harness.store;
    });

    test('feed starts at the head and pages interleaved runs once in commit order', async () => {
      const empty = await store.getWorkflowEventHead();
      expect(await store.readWorkflowEventsAfter(empty, { limit: 1 })).toEqual({
        events: [],
        next: empty,
      });
      const a = await create(store),
        b = await create(store);
      const writes = [a, b, a, b];
      for (const [index, run] of writes.entries())
        await store.persistWorkflowEvent({
          workflow_run_id: run.id,
          event_type: 'workflow_started',
          data: { index },
        });
      const full = await store.readWorkflowEventsAfter(empty, { limit: 10 });
      expect(full.events.map(({ event }) => event.data.index)).toEqual([0, 1, 2, 3]);
      const persisted = [
        ...(await store.listWorkflowEvents(a.id)),
        ...(await store.listWorkflowEvents(b.id)),
      ].sort((a, b) => Number(a.data.index) - Number(b.data.index));
      expect(full.events.map(({ event }) => event)).toEqual(persisted);
      let cursor = empty;
      const ids: string[] = [];
      for (let index = 0; index < 4; index++) {
        const page = await store.readWorkflowEventsAfter(cursor, { limit: 1 });
        expect(page.events).toHaveLength(1);
        ids.push(...page.events.map(({ event }) => event.id));
        cursor = page.next;
      }
      expect(ids).toEqual(full.events.map(({ event }) => event.id));
      expect((await store.readWorkflowEventsAfter(cursor, { limit: 1 })).events).toEqual([]);
      expect(
        (await store.readWorkflowEventsAfter(await store.getWorkflowEventHead(), { limit: 1 }))
          .events
      ).toEqual([]);
    });
    test('feed keeps gate events adjacent and advances past filtered rows', async () => {
      const run = await running(store);
      const head = await store.getWorkflowEventHead();
      for (let index = 0; index < 3; index++)
        await store.persistWorkflowEvent({
          workflow_run_id: run.id,
          event_type: 'workflow_started',
        });
      await store.pauseWorkflowRun(run.id, approval);
      await store.resolveApprovalGate(
        run.id,
        { approval: { ...approval, resolved: 'approved' } },
        gateEvents(0)
      );
      const page = await store.readWorkflowEventsAfter(head, {
        limit: 10,
        eventTypes: ['approval_received', 'node_completed'],
      });
      expect(page.events.map(({ event }) => event.event_type)).toEqual([
        'approval_received',
        'node_completed',
      ]);
      expect((await store.readWorkflowEventsAfter(page.next, { limit: 10 })).events).toEqual([]);
      const skipped = await store.readWorkflowEventsAfter(head, {
        limit: 3,
        eventTypes: ['node_completed'],
      });
      expect(skipped.events).toEqual([]);
      expect(skipped.next).not.toBe(head);
      expect(
        (await store.readWorkflowEventsAfter(skipped.next, { limit: 10 })).events.map(
          ({ event }) => event.event_type
        )
      ).toEqual(['approval_received', 'node_completed']);
    });
    test('feed pages a single commit spanning multiple runs without overlapping positions', async () => {
      const first = await running(store, {
        origin: { conversationId: CONFORMANCE_CONVERSATION_ID },
      });
      const second = await running(store, {
        origin: { conversationId: CONFORMANCE_CONVERSATION_ID },
      });
      await store.pauseWorkflowRun(first.id, approval);
      await store.pauseWorkflowRun(second.id, approval);
      const head = await store.getWorkflowEventHead();
      await store.cancelResumableRunsForConversation(CONFORMANCE_CONVERSATION_ID);
      const a = await store.readWorkflowEventsAfter(head, { limit: 1 });
      const b = await store.readWorkflowEventsAfter(a.next, { limit: 1 });
      expect(a.events).toHaveLength(1);
      expect(b.events).toHaveLength(1);
      expect(a.events[0]?.cursor).not.toBe(b.events[0]?.cursor);
      expect(
        [a.events[0]?.event.workflow_run_id, b.events[0]?.event.workflow_run_id].sort()
      ).toEqual([first.id, second.id].sort());
      expect((await store.readWorkflowEventsAfter(b.next, { limit: 1 })).events).toEqual([]);
    });

    test.each([...FAN_OUT_CANCEL_REASONS])(
      'feed retains cancellations after recovery of %s',
      async reason => {
        const run = await running(store);
        const head = await store.getWorkflowEventHead();
        await store.cancelFanOutRun(run.id, reason);
        const committed = await store.listWorkflowEvents(run.id);
        await store.recoverCancelledFanOutRun(run.id);
        expect(await types(store, run.id)).toEqual(['workflow_resumed']);
        expect(
          (await store.readWorkflowEventsAfter(head, { limit: 1 })).events.map(row => row.event)
        ).toEqual(committed);
      }
    );
    test('feed retains terminal events after cleanup from an earlier cursor', async () => {
      const run = await running(store);
      const head = await store.getWorkflowEventHead();
      await store.completeWorkflowRun(run.id, { duration_ms: 1 });
      const committed = await store.listWorkflowEvents(run.id);
      await harness.backdate(run.id, {
        started_at: new Date('2000-01-01'),
        last_activity_at: new Date('2000-01-01'),
      });
      await store.deleteOldWorkflowRuns(1);
      expect(await store.getWorkflowRun(run.id)).toBeNull();
      expect(
        (await store.readWorkflowEventsAfter(head, { limit: 1 })).events.map(row => row.event)
      ).toEqual(committed);
    });
    test('feed never reuses a position after fan-out recovery deletes the newest event', async () => {
      const run = await running(store);
      await store.cancelFanOutRun(run.id, 'fan_out_orphan');
      const head = await store.getWorkflowEventHead();
      await store.recoverCancelledFanOutRun(run.id);
      await store.persistWorkflowEvent({ workflow_run_id: run.id, event_type: 'workflow_started' });
      expect(
        (await store.readWorkflowEventsAfter(head, { limit: 10 })).events.map(
          ({ event }) => event.event_type
        )
      ).toEqual(['workflow_resumed', 'workflow_started']);
    });
    test('feed never reuses a position after run cleanup deletes the newest event', async () => {
      const run = await running(store);
      await store.completeWorkflowRun(run.id, { duration_ms: 1 });
      const head = await store.getWorkflowEventHead();
      await harness.backdate(run.id, {
        started_at: new Date('2000-01-01'),
        last_activity_at: new Date('2000-01-01'),
      });
      await store.deleteOldWorkflowRuns(1);
      expect(await store.getWorkflowRun(run.id)).toBeNull();
      const next = await create(store);
      await store.persistWorkflowEvent({
        workflow_run_id: next.id,
        event_type: 'workflow_started',
      });
      expect(
        (await store.readWorkflowEventsAfter(head, { limit: 10 })).events.map(
          ({ event }) => event.workflow_run_id
        )
      ).toEqual([next.id]);
    });
    test('feed rejects malformed cursors, cursors beyond its head and invalid page limits', async () => {
      for (const cursor of ['foreign:1', 'sql:-1', 'file:NaN.0', 'memory:1.5']) {
        expect(
          await rejection(
            store.readWorkflowEventsAfter(cursor as WorkflowEventCursor, { limit: 1 })
          )
        ).toBeInstanceOf(WorkflowEventCursorError);
      }
      const head = await store.getWorkflowEventHead();
      const beyondHead = head.replace(/[0-9]+/, order => String(BigInt(order) + 1000n));
      expect(
        await rejection(
          store.readWorkflowEventsAfter(beyondHead as WorkflowEventCursor, { limit: 1 })
        )
      ).toBeInstanceOf(WorkflowEventCursorError);
      for (const limit of [0, -1, 1.5, Infinity])
        expect(
          await rejection(
            store.readWorkflowEventsAfter(await store.getWorkflowEventHead(), { limit })
          )
        ).toBeInstanceOf(RangeError);
    });
    test('feed has no gaps while eight writers commit', async () => {
      await assertWorkflowEventFeedRace(store);
    });

    test('events retain commit order, support exclusion and group requested runs', async () => {
      const first = await create(store);
      const second = await create(store);
      for (let index = 0; index < 20; index++)
        await store.persistWorkflowEvent({
          workflow_run_id: index % 2 === 0 ? first.id : second.id,
          event_type: 'workflow_artifact',
          data: { index },
        });
      const rows = await store.listWorkflowEvents(first.id);
      expect(rows.map(row => row.data.index)).toEqual(
        Array.from({ length: 10 }, (_, index) => index * 2)
      );
      expect(new Set(rows.map(row => row.id)).size).toBe(10);
      for (const row of rows) expect(row.created_at).toMatch(/(?:Z|[+-]\d{2}:\d{2})$/);
      expect(
        await store.listWorkflowEvents(first.id, { excludeEventTypes: ['workflow_artifact'] })
      ).toEqual([]);
      const grouped = await store.listEventsForRuns([second.id, first.id], ['workflow_artifact']);
      expect(grouped.get(first.id)).toEqual(rows);
      expect(grouped.get(second.id)?.map(row => row.data.index)).toEqual(
        Array.from({ length: 10 }, (_, index) => index * 2 + 1)
      );
      expect(await store.listEventsForRuns([], ['workflow_artifact'])).toEqual(new Map());
      expect(await store.listEventsForRuns([first.id], [])).toEqual(new Map([[first.id, []]]));
    });
    test('unawaited event writes for a run read back in issue order', async () => {
      // The executor fires workflow_started without awaiting it and then writes node
      // events. Each burst starts on an idle store, where concurrent writes race.
      for (let attempt = 0; attempt < 20; attempt++) {
        const run = await running(store);
        const writes: Promise<unknown>[] = [
          store.createWorkflowEvent({ workflow_run_id: run.id, event_type: 'workflow_started' }),
        ];
        const expected = ['workflow_started'];
        for (const node of ['plan', 'build', 'test']) {
          const event = { workflow_run_id: run.id, step_name: node };
          writes.push(
            store.persistWorkflowEventIfRunning({ ...event, event_type: 'node_started' }),
            store.createWorkflowEvent({ ...event, event_type: 'workflow_artifact' }),
            store.persistWorkflowEvent({
              ...event,
              event_type: 'node_completed',
              data: { node_output: node },
            })
          );
          expected.push(
            `node_started:${node}`,
            `workflow_artifact:${node}`,
            `node_completed:${node}`
          );
        }
        await Promise.all(writes);
        const events = await store.listWorkflowEvents(run.id);
        expect(
          events.map(event =>
            event.step_name ? `${event.event_type}:${event.step_name}` : event.event_type
          )
        ).toEqual(expected);
      }
    });
    test('provider events follow emission order within attempts and honor the node cursor', async () => {
      const run = await create(store);
      for (const [stepName, attemptId, seq] of [
        ['build', 'first', 1],
        ['build', 'first', 0],
        ['other', 'other', 0],
        ['build', 'second', 0],
      ] as const) {
        await store.persistWorkflowEvent({
          workflow_run_id: run.id,
          event_type: 'provider_event',
          step_name: stepName,
          data: {
            attemptId,
            seq,
            observedAt: wait.waitingSince,
            event: { type: 'agent_message_chunk', text: 'hello' },
          },
        });
      }
      const records = await store.listProviderEvents(run.id, { stepName: 'build' });
      expect(records.map(row => [row.attemptId, row.seq])).toEqual([
        ['first', 0],
        ['first', 1],
        ['second', 0],
      ]);
      expect(
        await store.listProviderEvents(run.id, {
          stepName: 'build',
          after: { attemptId: 'first', seq: 0 },
        })
      ).toEqual(records.slice(1));
      expect(
        await store.listProviderEvents(run.id, {
          stepName: 'build',
          after: { attemptId: 'absent', seq: 0 },
        })
      ).toEqual([]);
      expect(await store.listProviderEvents(run.id)).toHaveLength(4);
    });
  });
}
