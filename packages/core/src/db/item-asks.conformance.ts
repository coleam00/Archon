/**
 * Conformance for asks on the SQL stores, run by the SQLite and PostgreSQL integration
 * tests through the same harness as the rest of the store: a completed run opens its asks
 * in the write that completes it, a newer set replaces the open one, and answering or
 * withdrawing closes an ask once and settles its set once.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import type { ItemAsk } from '@archon/workflows/schemas/item-ask';
import type { IWorkflowStore } from '@archon/workflows/store';
import { openAskItems } from '@archon/workflows/attention-queue';
import { readItemOfRun } from '@archon/workflows/item-read';
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

function itemDeps(harness: Harness, store: IWorkflowStore = harness.store) {
  return {
    queue: attentionQueueSource(store, {
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

const PROJECT_CWD = '/srv/conformance';

/** An asks-settled trigger file for `plan` that starts `build`, settling as `settled`. */
function asksSettledFile(sourceInstanceId: string, settled: string): Record<string, unknown> {
  return {
    version: 1,
    sourceInstanceId,
    binding: {
      bindingId: 'build',
      bindingRevision: null,
      hostId: 'factory-host',
      runAsUserId: 'factory-operator',
      resource: 'build',
      overlap: 'queue',
      launch: {
        cwd: PROJECT_CWD,
        workflowName: 'build',
        inputs: {},
        isolation: { kind: 'default' },
      },
    },
    on: {
      asksSettled: {
        workflowName: 'plan',
        settled,
        inputs: {
          decisions: { answers: true },
          issue: { input: 'issue' },
          progress: { result: '/summary' },
        },
      },
    },
  };
}

/**
 * The harness store with its ask closes wired to asks-settled bindings read from `files`,
 * as the store adapter wires them to `ARCHON_HOME/triggers`, with every binding launching
 * in the item's project. The caller removes `directory`.
 */
async function storeWithBindings(
  harness: Harness,
  files: Record<string, unknown>
): Promise<{ store: IWorkflowStore; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'archon-asks-settled-'));
  for (const [name, value] of Object.entries(files))
    await writeFile(
      join(directory, name),
      typeof value === 'string' ? value : JSON.stringify(value)
    );
  const [{ createAsksSettledStarts }, itemAsks] = await Promise.all([
    import('../workflows/asks-settled'),
    import('./item-asks'),
  ]);
  const prepare = createAsksSettledStarts({
    triggersDirectory: () => directory,
    getItem: id => harness.store.getItem(id),
    getItemAsk: id => harness.store.getItemAsk(id),
    projectKeyOf: async () => {
      const [item] = (
        await harness.db.query<{ project_key: string }>(
          'SELECT project_key FROM remote_agent_items LIMIT 1'
        )
      ).rows;
      return item?.project_key ?? null;
    },
  });
  return {
    directory,
    store: {
      ...harness.store,
      answerItemAsk: async input => itemAsks.answerItemAsk(input, await prepare(input.askId)),
      withdrawItemAsk: async input => itemAsks.withdrawItemAsk(input, await prepare(input.askId)),
    },
  };
}

async function receiptsFor(harness: Harness, runId: string) {
  const listed = await harness.store.listStartReceipts();
  return listed.filter(receipt => receipt.deliveryId === runId);
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

  test("an item keeps its asks' answers and settled sets after their runs are deleted or cleaned up", async () => {
    const harness = await makeHarness();
    try {
      const deps = itemDeps(harness);
      const kept = await completeWithAsks(harness, [ask('Keep the flag?'), ask('Rename it?')]);
      const [one, two] = await openRefs(harness);
      await answerAttentionItem(deps, one ?? '', { choose: ['drop'] }, operator, 'cli');
      await withdrawAttentionItem(deps, two ?? '', operator, 'api');
      const swept = await completeWithAsks(harness, [ask('Ship it?')], { workflow: 'review' });
      const [three] = await openRefs(harness);
      await withdrawAttentionItem(deps, three ?? '', operator, 'cli');
      // A third set, half answered and then replaced, never settles.
      await completeWithAsks(harness, [ask('Split it?'), ask('Now?')], { workflow: 'triage' });
      const [four] = await openRefs(harness);
      await answerAttentionItem(deps, four ?? '', { recommended: true }, operator, 'cli');
      const latest = await completeWithAsks(harness, [], { workflow: 'triage' });

      const source = attentionQueueSource(harness.store, {
        findLatestByCodebaseAndWorkingPath: async () => null,
      });
      const before = await readItemOfRun(source, latest);
      const answersOf = (read: typeof before) =>
        (read?.answers ?? []).map(answer =>
          answer.kind === 'ask'
            ? {
                kind: answer.kind,
                runId: answer.runId,
                question: answer.question,
                chosen: answer.chosen?.id ?? null,
                withdrawn: answer.withdrawn,
              }
            : answer.kind === 'asks_settled'
              ? {
                  kind: answer.kind,
                  runId: answer.runId,
                  answered: answer.answered,
                  withdrawn: answer.withdrawn,
                }
              : { kind: answer.kind }
        );
      const expected = answersOf(before);
      expect(expected).toEqual([
        { kind: 'ask', runId: kept, question: 'Keep the flag?', chosen: 'drop', withdrawn: false },
        { kind: 'ask', runId: kept, question: 'Rename it?', chosen: null, withdrawn: true },
        { kind: 'asks_settled', runId: kept, answered: 1, withdrawn: 1 },
        { kind: 'ask', runId: swept, question: 'Ship it?', chosen: null, withdrawn: true },
        { kind: 'asks_settled', runId: swept, answered: 0, withdrawn: 1 },
        expect.objectContaining({ question: 'Split it?', chosen: 'keep' }),
      ]);

      // One run deleted by hand, one by age.
      const { deleteWorkflowRun } = await import('./workflow-run-writes');
      await deleteWorkflowRun(kept);
      await harness.backdate(swept, { started_at: new Date('2020-01-01T00:00:00Z') });
      await harness.db.query(
        'UPDATE remote_agent_workflow_runs SET active_phase_started_at = NULL WHERE id = $1',
        [swept]
      );
      expect(await harness.store.deleteOldWorkflowRuns(1)).toEqual({ count: 1 });
      expect(await harness.store.getWorkflowRun(kept)).toBeNull();
      expect(await harness.store.getWorkflowRun(swept)).toBeNull();

      const after = await readItemOfRun(source, latest);
      expect(answersOf(after)).toEqual(expected);
      expect(after?.degraded).toEqual([]);
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

  test('two closes racing for the last open asks of a set settle it once', async () => {
    const harness = await makeHarness();
    try {
      const deps = itemDeps(harness);
      for (const round of [1, 2, 3]) {
        const runId = await completeWithAsks(harness, [ask('A?'), ask('B?'), ask('C?')], {
          item: `race-${String(round)}`,
        });
        const [a, b, c] = await openRefs(harness);
        await withdrawAttentionItem(deps, a ?? '', operator, 'cli');
        const results = await Promise.all([
          answerAttentionItem(deps, b ?? '', { choose: ['keep'] }, operator, 'cli'),
          withdrawAttentionItem(deps, c ?? '', operator, 'api'),
        ]);
        expect(results.filter(result => 'settled' in result && result.settled)).toHaveLength(1);
        expect(await settledEvents(harness, runId)).toEqual([{ answered: 1, withdrawn: 2 }]);
      }
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

  test('the last answer of a set starts its asks-settled binding once, with every answer', async () => {
    const harness = await makeHarness();
    const { store, directory } = await storeWithBindings(harness, {
      'build-after-answers.json': asksSettledFile('build-after-answers', 'answered'),
    });
    try {
      const run = await harness.store.createWorkflowRun({
        workflow_name: 'plan',
        user_message: '',
        codebase_id: CONFORMANCE_CODEBASE_ID,
        item_key: 'issue-1',
        metadata: { inputs: { issue: 'Fix the login page' } },
      });
      await harness.store.claimPendingWorkflowRun(run.id);
      await harness.store.completeWorkflowRun(
        run.id,
        { duration_ms: 1 },
        { asks_result: { summary: 'half planned' } },
        { asks: [ask('Keep the flag?'), ask('Rename it?')] }
      );
      const deps = itemDeps(harness, store);
      const [one, two] = await openRefs(harness);
      const first = await answerAttentionItem(
        deps,
        one ?? '',
        { choose: ['keep'] },
        operator,
        'cli'
      );
      expect(first).toMatchObject({ kind: 'ask_answered', settled: false, startReceipts: [] });
      expect(await receiptsFor(harness, run.id)).toEqual([]);

      const last = await answerAttentionItem(
        deps,
        two ?? '',
        { choose: ['drop'], text: 'Nobody reads it' },
        { kind: 'operator', declared: 'reviewer' },
        'api'
      );
      expect(last).toMatchObject({ kind: 'ask_answered', settled: true });
      // The same answer again changes nothing and starts nothing more.
      expect(
        await answerAttentionItem(
          deps,
          two ?? '',
          { choose: ['drop'], text: 'Nobody reads it' },
          { kind: 'operator', declared: 'reviewer' },
          'api'
        )
      ).toMatchObject({ kind: 'unchanged' });

      const receipts = await receiptsFor(harness, run.id);
      expect(receipts).toHaveLength(1);
      // Nothing followed the commit here, as if the process died: the start waits as one
      // pending binding for its host's next drain.
      expect(
        (await harness.store.listPendingStartBindings({ hostId: 'factory-host' })).map(binding =>
          'receiptId' in binding ? binding.receiptId : binding.document
        )
      ).toEqual([receipts[0]?.id]);
      const receipt = await harness.store.getStartReceipt(receipts[0]?.id ?? '');
      expect(receipt).toMatchObject({
        sourceInstanceId: 'build-after-answers',
        outcome: 'matched',
        itemKey: 'issue-1',
        sourceActor: { source: 'archon-asks-settled', id: run.id, display: 'answered' },
      });
      expect(receipt?.bindings).toHaveLength(1);
      expect(receipt?.bindings[0]?.intent).toMatchObject({
        runAsUserId: 'factory-operator',
        launch: { workflowName: 'build' },
        eventInputs: {
          issue: 'Fix the login page',
          progress: 'half planned',
          decisions: [
            {
              question: 'Keep the flag?',
              closedAs: 'answered',
              answer: { decision: 'keep', text: '' },
              option: { id: 'keep', does: 'Keep the flag.' },
              by: { declared: 'maintainer' },
              via: 'cli',
            },
            {
              question: 'Rename it?',
              closedAs: 'answered',
              answer: { decision: 'drop', text: 'Nobody reads it' },
              option: { id: 'drop', does: 'Drop the flag.' },
              by: { declared: 'reviewer' },
              via: 'api',
            },
          ],
        },
      });
    } finally {
      await removeTempTree(directory);
      await harness.close();
    }
  });

  test('a withdrawn set starts only a binding for withdrawn sets; a mixed set counts as answered', async () => {
    const harness = await makeHarness();
    const { store, directory } = await storeWithBindings(harness, {
      'after-answers.json': asksSettledFile('after-answers', 'answered'),
      'after-withdrawn.json': asksSettledFile('after-withdrawn', 'withdrawn'),
    });
    try {
      const deps = itemDeps(harness, store);
      const withdrawn = await completeWithAsks(harness, [ask('A?'), ask('B?')]);
      for (const ref of await openRefs(harness))
        await withdrawAttentionItem(deps, ref, operator, 'cli');
      expect(
        (await receiptsFor(harness, withdrawn)).map(receipt => receipt.sourceInstanceId)
      ).toEqual(['after-withdrawn']);

      const mixed = await completeWithAsks(harness, [ask('C?'), ask('D?')]);
      const [c, d] = await openRefs(harness);
      await withdrawAttentionItem(deps, c ?? '', operator, 'cli');
      await answerAttentionItem(deps, d ?? '', { choose: ['keep'] }, operator, 'cli');
      expect((await receiptsFor(harness, mixed)).map(receipt => receipt.sourceInstanceId)).toEqual([
        'after-answers',
      ]);
    } finally {
      await removeTempTree(directory);
      await harness.close();
    }
  });

  test('a set replaced before it settles starts nothing', async () => {
    const harness = await makeHarness();
    const { store, directory } = await storeWithBindings(harness, {
      'build-after-answers.json': asksSettledFile('build-after-answers', 'any'),
    });
    try {
      const deps = itemDeps(harness, store);
      const first = await completeWithAsks(harness, [ask('A?'), ask('B?')]);
      const [a, b] = await openRefs(harness);
      await answerAttentionItem(deps, a ?? '', { choose: ['keep'] }, operator, 'cli');
      await completeWithAsks(harness, [ask('C?')]);
      expect(
        await answerAttentionItem(deps, b ?? '', { choose: ['keep'] }, operator, 'cli')
      ).toEqual({ kind: 'none' });
      expect(await withdrawAttentionItem(deps, b ?? '', operator, 'cli')).toMatchObject({
        kind: 'refused',
      });
      expect(await receiptsFor(harness, first)).toEqual([]);
      expect(await settledEvents(harness, first)).toEqual([]);
    } finally {
      await removeTempTree(directory);
      await harness.close();
    }
  });

  test('a broken trigger file refuses only the close that settles the set, and records nothing', async () => {
    const harness = await makeHarness();
    const { store, directory } = await storeWithBindings(harness, {
      'build-after-answers.json': asksSettledFile('build-after-answers', 'answered'),
      'broken.json': '{ "on": ',
    });
    try {
      const deps = itemDeps(harness, store);
      const runId = await completeWithAsks(harness, [ask('A?'), ask('B?')]);
      const [a, b] = await openRefs(harness);
      expect(
        await answerAttentionItem(deps, a ?? '', { choose: ['keep'] }, operator, 'cli')
      ).toMatchObject({ kind: 'ask_answered', settled: false });
      await expect(
        answerAttentionItem(deps, b ?? '', { choose: ['keep'] }, operator, 'cli')
      ).rejects.toThrow(join(directory, 'broken.json'));
      expect(await openRefs(harness)).toEqual([b ?? '']);
      expect(await settledEvents(harness, runId)).toEqual([]);
      expect(await receiptsFor(harness, runId)).toEqual([]);
    } finally {
      await removeTempTree(directory);
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
