/**
 * Conformance for asks on the SQL stores, run by the SQLite and PostgreSQL integration
 * tests through the same harness as the rest of the store: a completed run opens its asks
 * in the write that completes it, a newer set replaces the open one, and answering or
 * withdrawing closes an ask once and settles its set once.
 */
import { expect, test } from 'bun:test';
import type { ItemAsk } from '@archon/workflows/schemas/item-ask';
import { openAskItems } from '@archon/workflows/attention-queue';
import { watchAttentionQueue, type AttentionStreamLine } from '@archon/workflows/attention-watch';
import type { WorkflowStoreHarness } from '@archon/workflows/store-conformance';
import { CONFORMANCE_CODEBASE_ID } from '@archon/workflows/store-conformance';
import { answerAttentionItem, withdrawAttentionItem } from '../operations/attention-items';
import { attentionQueueSource, watchSource } from '../operations/attention-queue';
import type { RunActor } from '../operations/run-authorization';
import type { IDatabase } from './adapters/types';

type Harness = WorkflowStoreHarness & { db: IDatabase };

function ask(question: string): ItemAsk {
  return {
    question,
    context: 'The plan can go two ways.',
    options: [
      { id: 'keep', does: 'Keep the flag.', cost: 'One more flag to maintain.' },
      { id: 'drop', does: 'Drop the flag.', cost: 'Older configs break.' },
    ],
    recommendation: { option: 'keep', why: 'Nothing depends on dropping it yet.' },
    artifacts: [],
  };
}

const operator = { kind: 'operator', declared: 'maintainer' } satisfies RunActor;
const notUsed = async (): Promise<never> => {
  throw new Error('not used for an ask');
};

function itemDeps(harness: Harness) {
  return {
    queue: attentionQueueSource(harness.store, {
      findLatestByCodebaseAndWorkingPath: async () => null,
    }),
    operations: {
      answerWorkflow: notUsed,
      respondToWorkflow: notUsed,
      assertRunActionAllowed: async () => undefined,
    },
  };
}

/** Complete a run of `workflow` on `item` that leaves `asks`. */
async function completeWithAsks(
  harness: Harness,
  asks: readonly ItemAsk[],
  options: { item?: string; workflow?: string } = {}
): Promise<string> {
  const run = await harness.store.createWorkflowRun({
    workflow_name: options.workflow ?? 'plan',
    user_message: '',
    codebase_id: CONFORMANCE_CODEBASE_ID,
    item_key: options.item ?? 'issue-1',
  });
  await harness.store.claimPendingWorkflowRun(run.id);
  await harness.store.completeWorkflowRun(run.id, { duration_ms: 1 }, undefined, { asks });
  return run.id;
}

async function openRefs(harness: Harness): Promise<string[]> {
  const items = await openAskItems(harness.store);
  return items.flatMap(item => ('ref' in item ? [item.ref] : []));
}

async function settledEvents(harness: Harness, runId: string) {
  const events = await harness.store.listWorkflowEvents(runId);
  return events.filter(event => event.event_type === 'asks_settled').map(event => event.data);
}

export function describeSqlItemAskConformance(makeHarness: () => Promise<Harness>): void {
  test('a completed run opens its asks on its item; a failed run opens none', async () => {
    const harness = await makeHarness();
    try {
      const runId = await completeWithAsks(harness, [ask('Keep the flag?'), ask('Rename it?')]);
      const items = await openAskItems(harness.store);
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({
        kind: 'attention',
        form: 'select',
        other: true,
        message: 'Keep the flag?',
        context: 'The plan can go two ways.',
        recommendation: { option: 'keep' },
        item: { key: 'issue-1' },
        askedIn: { runId, workflow: 'plan' },
      });
      expect(items[0] && 'run' in items[0] ? items[0].run : undefined).toBeUndefined();

      const failed = await harness.store.createWorkflowRun({
        workflow_name: 'other',
        user_message: '',
        codebase_id: CONFORMANCE_CODEBASE_ID,
        item_key: 'issue-1',
      });
      await harness.store.claimPendingWorkflowRun(failed.id);
      await harness.store.failWorkflowRun(failed.id, 'boom');
      expect(await openRefs(harness)).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  test('a run with no item that leaves asks is refused, and its completion does not commit', async () => {
    const harness = await makeHarness();
    try {
      const run = await harness.store.createWorkflowRun({
        workflow_name: 'plan',
        user_message: '',
      });
      await harness.store.claimPendingWorkflowRun(run.id);
      await expect(
        harness.store.completeWorkflowRun(run.id, { duration_ms: 1 }, undefined, {
          asks: [ask('Keep the flag?')],
        })
      ).rejects.toThrow('has no item');
      expect((await harness.store.getWorkflowRun(run.id))?.status).toBe('running');
    } finally {
      await harness.close();
    }
  });

  test('a completion that loses to a failed or cancelled run opens no asks', async () => {
    const harness = await makeHarness();
    try {
      for (const end of ['fail', 'cancel'] as const) {
        const run = await harness.store.createWorkflowRun({
          workflow_name: 'plan',
          user_message: '',
          codebase_id: CONFORMANCE_CODEBASE_ID,
          item_key: `lost-${end}`,
        });
        await harness.store.claimPendingWorkflowRun(run.id);
        if (end === 'fail') await harness.store.failWorkflowRun(run.id, 'boom');
        else await harness.store.cancelWorkflowRun(run.id);
        await expect(
          harness.store.completeWorkflowRun(run.id, { duration_ms: 1 }, undefined, {
            asks: [ask('Keep the flag?')],
          })
        ).rejects.toThrow();
      }
      expect(await openRefs(harness)).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  test('a run that left open asks is not deleted, by hand or by cleanup, until they close', async () => {
    const harness = await makeHarness();
    try {
      const runId = await completeWithAsks(harness, [ask('Keep the flag?')]);
      // Imported here, after the harness has pointed the connection at its database.
      const { deleteWorkflowRun } = await import('./workflow-run-writes');
      await expect(deleteWorkflowRun(runId)).rejects.toThrow('open ask(s)');
      await harness.backdate(runId, { started_at: new Date('2020-01-01T00:00:00Z') });
      await harness.db.query(
        'UPDATE remote_agent_workflow_runs SET active_phase_started_at = NULL WHERE id = $1',
        [runId]
      );
      expect(await harness.store.deleteOldWorkflowRuns(1)).toEqual({ count: 0 });
      // Still answerable by its run's rule, and once closed the run deletes as before.
      const [ref] = await openRefs(harness);
      expect(
        await withdrawAttentionItem(itemDeps(harness), ref ?? '', operator, 'cli')
      ).toMatchObject({ kind: 'withdrawn', settled: true });
      expect(await harness.store.deleteOldWorkflowRuns(1)).toEqual({ count: 1 });
      expect(await harness.store.getWorkflowRun(runId)).toBeNull();
    } finally {
      await harness.close();
    }
  });

  test('a later completed run of the same workflow on the item replaces the open asks', async () => {
    const harness = await makeHarness();
    try {
      const first = await completeWithAsks(harness, [ask('Keep the flag?'), ask('Rename it?')]);
      const [answeredRef] = await openRefs(harness);
      await answerAttentionItem(
        itemDeps(harness),
        answeredRef ?? '',
        { choose: ['keep'] },
        operator,
        'cli'
      );
      // Another workflow's asks and another item's stay open.
      await completeWithAsks(harness, [ask('Other workflow?')], { workflow: 'triage' });
      await completeWithAsks(harness, [ask('Other item?')], { item: 'issue-2' });
      const second = await completeWithAsks(harness, [ask('Ship it?')]);

      const open = await openAskItems(harness.store);
      expect(open.map(item => ('message' in item ? item.message : item)).sort()).toEqual(
        ['Other item?', 'Other workflow?', 'Ship it?'].sort()
      );
      const firstRows = await harness.db.query<{
        closed_as: string;
        replaced_by_run_id: string | null;
      }>(
        'SELECT closed_as, replaced_by_run_id FROM remote_agent_item_asks WHERE run_id = $1 ORDER BY position',
        [first]
      );
      // The answered ask keeps its answer; only the open one is replaced. Nothing settles.
      expect(firstRows.rows).toEqual([
        { closed_as: 'answered', replaced_by_run_id: null },
        { closed_as: 'replaced', replaced_by_run_id: second },
      ]);
      expect(await settledEvents(harness, first)).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  test('answering settles the set once; a repeat changes nothing and a different answer is refused', async () => {
    const harness = await makeHarness();
    try {
      const runId = await completeWithAsks(harness, [ask('Keep the flag?'), ask('Rename it?')]);
      const deps = itemDeps(harness);
      const [one, two] = await openRefs(harness);
      if (one === undefined || two === undefined) throw new Error('Expected two asks');
      const fromRun = { runId, nodePath: 'review' };
      const first = await answerAttentionItem(
        deps,
        one,
        { choose: ['keep'] },
        { ...operator, fromRun },
        'cli'
      );
      expect(first).toMatchObject({ kind: 'ask_answered', settled: false });
      expect(await openRefs(harness)).toEqual([two]);

      const last = await answerAttentionItem(
        deps,
        two,
        { recommended: true, text: 'fine' },
        operator,
        'api'
      );
      expect(last).toMatchObject({ kind: 'ask_answered', settled: true });
      expect(
        await answerAttentionItem(deps, two, { choose: ['keep'], text: 'fine' }, operator, 'api')
      ).toMatchObject({
        kind: 'unchanged',
      });
      expect(await answerAttentionItem(deps, two, { choose: ['drop'] }, operator, 'api')).toEqual({
        kind: 'refused',
        reason: 'already_answered',
      });
      expect(await withdrawAttentionItem(deps, two, operator, 'api')).toEqual({
        kind: 'refused',
        closedAs: 'answered',
      });
      expect(await settledEvents(harness, runId)).toEqual([{ answered: 2, withdrawn: 0 }]);

      // Who answered, from where, is recorded on the event and the row.
      const answered = (await harness.store.listWorkflowEvents(runId)).find(
        event => event.event_type === 'ask_answered'
      );
      expect(answered?.data).toMatchObject({
        via: 'cli',
        by: { declared: 'maintainer' },
        fromRun,
        answer: { decision: 'keep', text: '' },
      });
      const stored = await harness.store.getItemAsk(one.slice('ask:'.length));
      expect(stored?.closed).toMatchObject({
        as: 'answered',
        act: { via: 'cli', by: { declared: 'maintainer' }, fromRun },
      });
      // An answer outside the ask's options is refused before anything is written.
      const [third] = [await completeWithAsks(harness, [ask('Again?')], { item: 'issue-3' })];
      const [ref] = (await openRefs(harness)).filter(candidate => candidate !== one);
      await expect(
        answerAttentionItem(deps, ref ?? '', { choose: ['other'] }, operator, 'cli')
      ).rejects.toThrow("needs text with option 'other'");
      expect(await settledEvents(harness, third)).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  test('withdrawing the last open ask settles the set and records that nothing was answered', async () => {
    const harness = await makeHarness();
    try {
      const runId = await completeWithAsks(harness, [ask('Keep the flag?'), ask('Rename it?')]);
      const deps = itemDeps(harness);
      const [one, two] = await openRefs(harness);
      expect(await withdrawAttentionItem(deps, one ?? '', operator, 'cli')).toMatchObject({
        kind: 'withdrawn',
        settled: false,
      });
      expect(await withdrawAttentionItem(deps, one ?? '', operator, 'cli')).toMatchObject({
        kind: 'unchanged',
      });
      expect(await withdrawAttentionItem(deps, two ?? '', operator, 'cli')).toMatchObject({
        kind: 'withdrawn',
        settled: true,
      });
      expect(await settledEvents(harness, runId)).toEqual([{ answered: 0, withdrawn: 2 }]);
      expect(
        await answerAttentionItem(deps, one ?? '', { choose: ['keep'] }, operator, 'cli')
      ).toEqual({
        kind: 'none',
      });

      const mixed = await completeWithAsks(harness, [ask('A?'), ask('B?')], { item: 'issue-2' });
      const [a, b] = await openRefs(harness);
      await answerAttentionItem(deps, a ?? '', { choose: ['drop'] }, operator, 'cli');
      await withdrawAttentionItem(deps, b ?? '', operator, 'cli');
      expect(await settledEvents(harness, mixed)).toEqual([{ answered: 1, withdrawn: 1 }]);
      // A run-held ref is answered, never withdrawn.
      expect(await withdrawAttentionItem(deps, mixed, operator, 'cli')).toEqual({
        kind: 'not_an_ask',
      });
    } finally {
      await harness.close();
    }
  });

  test('a watch sees an ask open and close, and says why from the stored row', async () => {
    const harness = await makeHarness();
    const lines: AttentionStreamLine[] = [];
    const deps = itemDeps(harness);
    const watch = await watchAttentionQueue(
      harness.store,
      watchSource(deps.queue),
      line => {
        lines.push(line);
      },
      { scope: { kind: 'all' }, pollIntervalMs: 20 }
    );
    const resolved = async (count: number) => {
      for (let i = 0; i < 200; i++) {
        const found = lines.filter(line => line.type === 'resolved');
        if (found.length >= count) return found;
        await Bun.sleep(10);
      }
      throw new Error(`Expected ${String(count)} resolved line(s), saw ${JSON.stringify(lines)}`);
    };
    try {
      await completeWithAsks(harness, [ask('A?'), ask('B?')]);
      for (let i = 0; i < 200 && lines.filter(line => line.type === 'attention').length < 2; i++)
        await Bun.sleep(10);
      const [a, b] = await openRefs(harness);
      // Nothing else happens: the answer's own event wakes the watch.
      await answerAttentionItem(deps, a ?? '', { choose: ['keep'] }, operator, 'cli');
      expect((await resolved(1))[0]).toMatchObject({
        ref: a,
        reason: 'answered',
        answeredVia: 'cli',
        answeredBy: { declared: 'maintainer' },
        answeredFromRun: null,
        workflow: 'plan',
      });
      await withdrawAttentionItem(deps, b ?? '', operator, 'cli');
      expect((await resolved(2))[1]).toMatchObject({ ref: b, reason: 'withdrawn' });

      await completeWithAsks(harness, [ask('C?')]);
      for (let i = 0; i < 200 && lines.filter(line => line.type === 'attention').length < 3; i++)
        await Bun.sleep(10);
      const next = await completeWithAsks(harness, [ask('D?')]);
      expect((await resolved(3))[2]).toMatchObject({ reason: 'replaced', replacedByRunId: next });
      // An ask's own events on its completed run repeat no terminal line.
      expect(lines.filter(line => line.type === 'terminal')).toHaveLength(3);
    } finally {
      await watch.close();
      await harness.close();
    }
  });
}
