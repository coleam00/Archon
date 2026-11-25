/**
 * Conformance for the starts a settled set causes, on the SQL stores: the write that
 * settles a set writes the receipt of each `on.asksSettled` binding it matches, once, and
 * a set that does not settle, or a close that cannot write its starts, writes none.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import type { ItemAsk } from '@archon/workflows/schemas/item-ask';
import type { SourceReceiptAcceptance } from '@archon/workflows/schemas/resource-start';
import { asksResultMetadata } from '@archon/workflows/schemas/run-metadata';
import type { IWorkflowStore } from '@archon/workflows/store';
import { CONFORMANCE_CODEBASE_ID } from '@archon/workflows/store-conformance';
import { openAskItems } from '@archon/workflows/queue-items-without-run';
import { answerAttentionItem, withdrawAttentionItem } from '../operations/attention-items';
import {
  ask,
  completeWithAsks,
  itemDeps,
  openRefs,
  operator,
  settledEvents,
  type Harness,
} from './item-asks.conformance';

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

/**
 * Completes a run of `plan` on `issue-1` with `asks`, carrying the input and result every
 * binding built by `asksSettledFile` reads, so a receipt it writes is matched.
 */
async function completePlan(harness: Harness, asks: readonly ItemAsk[]): Promise<string> {
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
    asksResultMetadata({ summary: 'half planned' }),
    { asks }
  );
  return run.id;
}

/** The receipts a run's settlement wrote, with each one's outcome and started workflow. */
async function startsFor(harness: Harness, runId: string) {
  const receipts = await Promise.all(
    (await receiptsFor(harness, runId)).map(listed => harness.store.getStartReceipt(listed.id))
  );
  return receipts.map(receipt => ({
    sourceInstanceId: receipt?.sourceInstanceId,
    outcome: receipt?.outcome,
    display: receipt?.sourceActor?.display,
    workflows: receipt?.bindings.map(binding => binding.intent?.launch.workflowName),
  }));
}

async function receiptsFor(harness: Harness, runId: string) {
  const listed = await harness.store.listStartReceipts();
  return listed.filter(receipt => receipt.deliveryId === runId);
}

export function describeSqlItemAskStartConformance(makeHarness: () => Promise<Harness>): void {
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
        asksResultMetadata({ summary: 'half planned' }),
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
      // The binding's inputs, and nothing else: the answers, the run's result and its inputs.
      expect(Object.keys(receipt?.bindings[0]?.intent?.eventInputs ?? {}).sort()).toEqual([
        'decisions',
        'issue',
        'progress',
      ]);
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

  test("a binding reading the item's answers gets every set settled on the item, oldest answer first, the closing one included", async () => {
    const harness = await makeHarness();
    const file = asksSettledFile('build-after-check', 'answered');
    const { store, directory } = await storeWithBindings(harness, {
      'build-after-check.json': {
        ...file,
        on: {
          asksSettled: {
            workflowName: 'check',
            settled: 'answered',
            inputs: { decisions: { answers: true }, decided: { item: 'answers' } },
          },
        },
      },
    });
    try {
      const deps = itemDeps(harness, store);
      // plan settles first: one withdrawn, then the ask it left first is answered, so the
      // list follows when each was closed, not the order they were left.
      await completeWithAsks(harness, [ask('Keep the flag?'), ask('Rename it?')]);
      const [keep, rename] = await openRefs(harness);
      await withdrawAttentionItem(deps, rename ?? '', operator, 'cli');
      // Close times are milliseconds; keep the two apart so the order is not a tie.
      await Bun.sleep(5);
      await answerAttentionItem(deps, keep ?? '', { choose: ['keep'] }, operator, 'cli');
      // A check set replaced before it settled, and an open ask from review, are left out.
      await completeWithAsks(harness, [ask('Replaced?')], { workflow: 'check' });
      await completeWithAsks(harness, [ask('Still open?')], { workflow: 'review' });
      const check = await completeWithAsks(harness, [ask('Ship it?')], { workflow: 'check' });
      const ship = (await openAskItems(harness.store)).find(
        item => 'message' in item && item.message === 'Ship it?'
      );
      await answerAttentionItem(
        deps,
        ship !== undefined && 'ref' in ship ? ship.ref : '',
        { choose: ['drop'] },
        operator,
        'cli'
      );

      const [listed] = await receiptsFor(harness, check);
      const receipt = await harness.store.getStartReceipt(listed?.id ?? '');
      expect(receipt?.outcome).toBe('matched');
      const inputs = receipt?.bindings[0]?.intent?.eventInputs;
      // The settled set is this settlement's only, without the asking workflow.
      expect(inputs?.decisions).toEqual([
        expect.not.objectContaining({ workflowName: expect.anything() }),
      ]);
      expect(inputs?.decisions).toMatchObject([{ question: 'Ship it?', closedAs: 'answered' }]);
      expect(inputs?.decided).toMatchObject([
        { question: 'Rename it?', closedAs: 'withdrawn', answer: null, workflowName: 'plan' },
        { question: 'Keep the flag?', closedAs: 'answered', workflowName: 'plan' },
        {
          question: 'Ship it?',
          closedAs: 'answered',
          answer: { decision: 'drop', text: '' },
          workflowName: 'check',
        },
      ]);
      expect(inputs?.decided).toHaveLength(3);
    } finally {
      await removeTempTree(directory);
      await harness.close();
    }
  });

  test('a result with nulls reaches the binding as written, at any depth and whole', async () => {
    const harness = await makeHarness();
    const file = asksSettledFile('build-after-answers', 'answered');
    const { store, directory } = await storeWithBindings(harness, {
      'build-after-answers.json': {
        ...file,
        on: {
          asksSettled: {
            workflowName: 'plan',
            settled: 'answered',
            inputs: { choice: { result: '/choice' }, whole: { result: '' } },
          },
        },
      },
    });
    try {
      const result = { choice: null, nested: { value: null, kept: 1 } };
      const run = await harness.store.createWorkflowRun({
        workflow_name: 'plan',
        user_message: '',
        codebase_id: CONFORMANCE_CODEBASE_ID,
        item_key: 'issue-1',
      });
      await harness.store.claimPendingWorkflowRun(run.id);
      await harness.store.completeWorkflowRun(
        run.id,
        { duration_ms: 1 },
        asksResultMetadata(result),
        { asks: [ask('Keep the flag?')] }
      );
      const [ref] = await openRefs(harness);
      await answerAttentionItem(
        itemDeps(harness, store),
        ref ?? '',
        { choose: ['keep'] },
        operator,
        'cli'
      );
      const [listed] = await receiptsFor(harness, run.id);
      const receipt = await harness.store.getStartReceipt(listed?.id ?? '');
      expect(receipt?.outcome).toBe('matched');
      expect(receipt?.bindings[0]?.intent?.eventInputs).toEqual({ choice: null, whole: result });
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
      const withdrawn = await completePlan(harness, [ask('A?'), ask('B?')]);
      for (const ref of await openRefs(harness))
        await withdrawAttentionItem(deps, ref, operator, 'cli');
      expect(await startsFor(harness, withdrawn)).toEqual([
        {
          sourceInstanceId: 'after-withdrawn',
          outcome: 'matched',
          display: 'withdrawn',
          workflows: ['build'],
        },
      ]);

      const mixed = await completePlan(harness, [ask('C?'), ask('D?')]);
      const [c, d] = await openRefs(harness);
      await withdrawAttentionItem(deps, c ?? '', operator, 'cli');
      await answerAttentionItem(deps, d ?? '', { choose: ['keep'] }, operator, 'cli');
      expect(await startsFor(harness, mixed)).toEqual([
        {
          sourceInstanceId: 'after-answers',
          outcome: 'matched',
          display: 'answered',
          workflows: ['build'],
        },
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
      const first = await completePlan(harness, [ask('A?'), ask('B?')]);
      const [a, b] = await openRefs(harness);
      await answerAttentionItem(deps, a ?? '', { choose: ['keep'] }, operator, 'cli');
      const second = await completePlan(harness, [ask('C?')]);
      expect(
        await answerAttentionItem(deps, b ?? '', { choose: ['keep'] }, operator, 'cli')
      ).toEqual({ kind: 'none' });
      expect(await withdrawAttentionItem(deps, b ?? '', operator, 'cli')).toMatchObject({
        kind: 'refused',
      });
      expect(await receiptsFor(harness, first)).toEqual([]);
      expect(await settledEvents(harness, first)).toEqual([]);
      // The set that replaced it still starts its binding when it settles.
      const [c] = await openRefs(harness);
      await answerAttentionItem(deps, c ?? '', { choose: ['keep'] }, operator, 'cli');
      expect(await startsFor(harness, second)).toMatchObject([{ outcome: 'matched' }]);
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

  test('a start that cannot be written rolls the settling close back with it', async () => {
    const harness = await makeHarness();
    try {
      const runId = await completeWithAsks(harness, [ask('A?'), ask('B?')]);
      const [a, b] = await openRefs(harness);
      const deps = itemDeps(harness);
      await answerAttentionItem(deps, a ?? '', { choose: ['keep'] }, operator, 'cli');
      // A receipt with no delivery id whose id already exists fails its insert.
      const taken: SourceReceiptAcceptance = {
        receipt: {
          id: randomUUID(),
          sourceInstanceId: 'taken',
          deliveryId: null,
          contentDigest: 'digest',
          receivedAt: new Date().toISOString(),
          occurredAt: null,
          sourceActor: null,
        },
        outcome: 'unmatched',
        reason: 'test',
        bindings: [],
      };
      await harness.store.acceptStartReceipt(taken);
      const itemAsks = await import('./item-asks');
      await expect(
        itemAsks.answerItemAsk(
          {
            askId: (b ?? '').slice('ask:'.length),
            answer: { decision: 'keep', text: '' },
            via: 'cli',
            by: null,
            fromRun: null,
          },
          () => [taken]
        )
      ).rejects.toThrow(`Source receipt id '${taken.receipt.id}' already exists`);
      expect(await openRefs(harness)).toEqual([b ?? '']);
      expect(await settledEvents(harness, runId)).toEqual([]);
    } finally {
      await harness.close();
    }
  });
}
