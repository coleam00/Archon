/**
 * Conformance for waits on the SQL stores, run by the SQLite and PostgreSQL integration
 * tests: a completed run opens its waits in the write that completes it and a newer set
 * replaces the open one; a receipt whose binding wakes a wait starts the next stage on the
 * wait's item once, and only for the exact value the wait names; an open wait past its
 * deadline is in the attention queue until it closes.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { listAttentionQueue } from '@archon/workflows/attention-queue';
import type { ItemWait } from '@archon/workflows/schemas/item-wait';
import {
  asksCheckoutMetadata,
  type ResourceStartBindingIntent,
  type SourceReceiptAcceptance,
} from '@archon/workflows/schemas/resource-start';
import { readItemStopped, runInputsMetadata } from '@archon/workflows/schemas/run-metadata';
import { CONFORMANCE_CODEBASE_ID } from '@archon/workflows/store-conformance';
import { answerAttentionItem, withdrawAttentionItem } from '../operations/attention-items';
import { createItemWaitObserver, loadWebhookSourcePlugins } from '../workflows/source-plugins';
import { wakeStart } from '../workflows/wake-start';
import {
  ask,
  completeWithAsks,
  itemDeps,
  openRefs,
  operator,
  type Harness,
} from './item-asks.conformance';

export const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

export function checks(about: string, withinMinutes = 60): ItemWait {
  return { event: 'checks', about, within_minutes: withinMinutes };
}

/** Complete a run of `workflow` on `item` that leaves `waits`. */
export async function completeWithWaits(
  harness: Harness,
  waits: readonly ItemWait[] | undefined,
  options: { item?: string; workflow?: string } = {}
): Promise<string> {
  const run = await harness.store.createWorkflowRun({
    workflow_name: options.workflow ?? 'host',
    user_message: '',
    codebase_id: CONFORMANCE_CODEBASE_ID,
    item_key: options.item ?? 'pr-7',
  });
  await harness.store.claimPendingWorkflowRun(run.id);
  await harness.store.completeWorkflowRun(
    run.id,
    { duration_ms: 1 },
    undefined,
    waits === undefined ? undefined : { waits }
  );
  return run.id;
}

export async function projectKey(harness: Harness): Promise<string> {
  const [row] = (
    await harness.db.query<{ project_key: string }>(
      'SELECT project_key FROM remote_agent_items LIMIT 1'
    )
  ).rows;
  if (row === undefined) throw new Error('No item was created');
  return row.project_key;
}

/** A source plugin's receipt for a check at `about`, whose one binding wakes `checks`. */
export function wakeReceipt(
  about: string,
  options: {
    deliveryId?: string;
    workflow?: string;
    bindingId?: string;
    wait?: string;
    item?: string;
  } = {}
): SourceReceiptAcceptance {
  const binding: ResourceStartBindingIntent = {
    bindingId: options.bindingId ?? 'next-stage',
    bindingRevision: 'rev-1',
    hostId: 'factory-host',
    runAsUserId: 'factory-operator',
    resource: 'review',
    overlap: 'queue',
    launch: {
      cwd: '/srv/conformance',
      workflowName: 'review',
      inputs: {},
      isolation: { kind: 'default' },
    },
    eventInputs: { revision: about },
    ...(options.item === undefined ? {} : { itemKey: options.item }),
    wake: {
      workflowName: options.workflow ?? 'host',
      wait: options.wait ?? 'checks',
      about,
      input: 'waited',
    },
  };
  return {
    receipt: {
      id: randomUUID(),
      sourceInstanceId: 'github',
      deliveryId: options.deliveryId ?? randomUUID(),
      contentDigest: `digest-${options.deliveryId ?? about}`,
      receivedAt: new Date().toISOString(),
      occurredAt: null,
      sourceActor: null,
    },
    outcome: 'matched',
    bindings: [binding],
  };
}

async function acceptStartReceiptFor(receipt: SourceReceiptAcceptance, project: string | null) {
  const { acceptStartReceipt } = await import('./start-receipt-writes');
  return acceptStartReceipt(receipt, async () => project);
}

export async function accept(
  receipt: SourceReceiptAcceptance,
  project: string | null
): Promise<string> {
  const { acceptStartReceipt } = await import('./start-receipt-writes');
  return (await acceptStartReceipt(receipt, async () => project, wakeStart)).receiptId;
}

/**
 * The host stage a run-ended binding started on pr-7 with the item, the base and the
 * builder's checkout, as its completion records them, ending with a `checks` wait at HEAD.
 */
async function completeWaitingHost(harness: Harness, worktree: string): Promise<string> {
  const run = await harness.store.createWorkflowRun({
    workflow_name: 'host',
    user_message: '',
    codebase_id: CONFORMANCE_CODEBASE_ID,
    item_key: 'pr-7',
    metadata: runInputsMetadata({ item: 'pr-7', land_on: 'dev' }),
  });
  await harness.store.claimPendingWorkflowRun(run.id);
  await harness.store.completeWorkflowRun(
    run.id,
    { duration_ms: 1 },
    asksCheckoutMetadata({
      handoff: { runId: 'builder-run', branch: 'archon/pr-7', commit: HEAD },
      worktree,
    }),
    { waits: [checks(HEAD)] }
  );
  return run.id;
}

/** A wake of `host` that carries its inputs, the item's answers and its checkout. */
function carryingWake(): SourceReceiptAcceptance {
  const receipt = wakeReceipt(HEAD);
  const [binding] = receipt.bindings;
  if (receipt.outcome !== 'matched' || binding?.wake === undefined)
    throw new Error('wakeReceipt makes one wake binding');
  return {
    ...receipt,
    bindings: [
      {
        ...binding,
        launch: { ...binding.launch, workflowName: 'host' },
        wake: {
          ...binding.wake,
          inputs: {
            item: { input: 'item' },
            land_on: { input: 'land_on' },
            answers: { item: 'answers' },
          },
          checkout: 'waiting-run',
        },
      },
    ],
  };
}

export async function readReceipt(harness: Harness, id: string) {
  const receipt = await harness.store.getStartReceipt(id);
  if (receipt === null) throw new Error(`Receipt ${id} was not recorded`);
  return {
    outcome: receipt.outcome,
    reason: receipt.reason,
    bindings: receipt.bindings.map(binding => ({
      status: binding.status,
      error: binding.error,
      itemKey: binding.intent?.itemKey ?? null,
      waited: binding.intent?.eventInputs?.waited ?? null,
    })),
  };
}

export function describeSqlItemWaitConformance(makeHarness: () => Promise<Harness>): void {
  test('a completed run opens its waits; a later one of its workflow replaces them', async () => {
    const harness = await makeHarness();
    try {
      const first = await completeWithWaits(harness, [checks(OLD)]);
      // A run of another workflow, or of one that declares no waits, touches nothing.
      await completeWithWaits(harness, [checks(OLD)], { workflow: 'other' });
      await completeWithWaits(harness, undefined);
      // Two sets opened in one millisecond have no order between them.
      const opened = await harness.store.listOpenItemWaits();
      expect(opened.map(wait => [wait.workflowName, wait.runId === first]).sort()).toEqual([
        ['host', true],
        ['other', false],
      ]);
      const second = await completeWithWaits(harness, [checks(HEAD)]);
      const open = await harness.store.listOpenItemWaits();
      expect(open.filter(wait => wait.workflowName === 'host')).toMatchObject([
        { runId: second, event: 'checks', about: HEAD, closed: null },
      ]);
      const [wait] = open.filter(candidate => candidate.runId === second);
      expect(Date.parse(wait?.deadlineAt ?? '') - Date.parse(wait?.openedAt ?? '')).toBe(
        60 * 60_000
      );
      // A completion that leaves none still replaces the open set.
      await completeWithWaits(harness, []);
      expect(
        (await harness.store.listOpenItemWaits()).filter(wait => wait.workflowName === 'host')
      ).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  test('an event for the waited revision starts the next stage on the item once', async () => {
    const harness = await makeHarness();
    try {
      const waiting = await completeWithWaits(harness, [
        checks(HEAD),
        { ...checks(HEAD), event: 'review' },
      ]);
      // The waiting run has ended: nothing holds a session, a checkout or a slot.
      expect((await harness.store.getWorkflowRun(waiting))?.status).toBe('completed');
      const project = await projectKey(harness);
      const delivery = wakeReceipt(HEAD, { deliveryId: 'delivery-1' });
      const id = await accept(delivery, project);
      expect(await readReceipt(harness, id)).toEqual({
        outcome: 'matched',
        reason: null,
        bindings: [
          {
            status: 'pending',
            error: null,
            itemKey: 'pr-7',
            waited: {
              event: 'checks',
              about: HEAD,
              workflow: 'host',
              runId: waiting,
              waitingSince: expect.any(String),
              deadline: expect.any(String),
            },
          },
        ],
      });
      // The set closed whole: its other wait is no longer open either.
      expect(await harness.store.listOpenItemWaits()).toEqual([]);

      // The same delivery again is a replay of the first receipt.
      const { acceptStartReceipt } = await import('./start-receipt-writes');
      expect(
        await acceptStartReceipt(
          { ...delivery, receipt: { ...delivery.receipt, id: randomUUID() } },
          async () => project
        )
      ).toEqual({ receiptId: id, replay: true });
      // Another delivery for the same wait finds the set met and starts nothing.
      const again = await accept(wakeReceipt(HEAD, { deliveryId: 'delivery-2' }), project);
      expect(await readReceipt(harness, again)).toEqual({
        outcome: 'unmatched',
        reason: `no open wait 'checks' about '${HEAD}' from 'host'`,
        bindings: [
          {
            status: 'unmatched',
            error: `no open wait 'checks' about '${HEAD}' from 'host'`,
            itemKey: null,
            waited: null,
          },
        ],
      });
    } finally {
      await harness.close();
    }
  });

  test('an observed check wakes its wait once, however often the same state is observed', async () => {
    const harness = await makeHarness();
    const root = await mkdtemp(join(tmpdir(), 'archon-observed-wake-'));
    try {
      const remote = 'https://github.com/acme/widgets.git';
      await harness.db.query(
        'UPDATE remote_agent_codebases SET repository_url = $1 WHERE id = $2',
        [remote, CONFORMANCE_CODEBASE_ID]
      );
      const waiting = await completeWithWaits(harness, [checks(HEAD)]);
      const project = await projectKey(harness);
      // A source that, like the GitHub plugin, makes one delivery per observed check state.
      const modulePath = join(root, 'source.ts');
      const configPath = join(root, 'sources.json');
      await writeFile(
        modulePath,
        `export default ({ config }) => ({
  receive: async () => ({ status: 'rejected', reason: 'unauthenticated' }),
  observe: async ({ waits, forge }) => {
    for (const wait of waits) await forge.commitChecks({ remote: wait.remote, revision: wait.about });
    return { acceptances: [{ ...config, receipt: { ...config.receipt, id: crypto.randomUUID() } }], unserved: [], failed: [] };
  },
});\n`
      );
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          sources: [
            {
              sourceInstanceId: 'github',
              module: modulePath,
              // As the plugin makes it: one binding, on the wait's item.
              config: wakeReceipt(HEAD, {
                deliveryId: 'observe:check:77:completed:success:next-stage:pr-7',
                item: 'pr-7',
              }),
              observe: { everySeconds: 15 },
            },
          ],
        })
      );
      const sources = await loadWebhookSourcePlugins(configPath, {
        acceptReceipt: input => acceptStartReceiptFor(input, project),
        isKnownUser: async () => true,
        hasDeliveryReceipt: (source, delivery) =>
          harness.store.hasStartReceiptForDelivery(source, delivery),
        getReceipt: id => harness.store.getStartReceipt(id),
      });
      const reads: string[] = [];
      const observer = createItemWaitObserver({
        sources,
        store: harness.store,
        forge: {
          commitChecks: async request => {
            reads.push(`${request.remote}@${request.revision}`);
            return {} as never;
          },
          prReviews: async () => {
            throw new Error('No review is read for a check wait');
          },
          issuesWithLabel: async () => {
            throw new Error('No label is read for a check wait');
          },
          labelAdded: async () => {
            throw new Error('No label is read for a check wait');
          },
          issuesOpened: async () => {
            throw new Error('No opened issue is read for a check wait');
          },
        },
      });
      const at = (seconds: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + seconds * 1000);

      const [first] = (await observer?.pass(at(0))) ?? [];
      expect(reads).toEqual([`${remote}@${HEAD}`]);
      expect(first?.receipts).toHaveLength(1);
      expect(await readReceipt(harness, first?.receipts[0] ?? '')).toMatchObject({
        outcome: 'matched',
        bindings: [{ status: 'pending', itemKey: 'pr-7', waited: { runId: waiting } }],
      });
      expect(await harness.store.listOpenItemWaits()).toEqual([]);

      // The woken stage ends waiting at the same commit; the check it was woken by is the
      // same delivery when observed again, a replay, and does not wake it twice.
      await completeWithWaits(harness, [checks(HEAD)]);
      const [again] = (await observer?.pass(at(15))) ?? [];
      expect(again).toMatchObject({ waits: 1, reads: 1, receipts: [] });
      expect(await harness.store.listOpenItemWaits()).toHaveLength(1);
    } finally {
      await removeTempTree(root);
      await harness.close();
    }
  });

  test("a wake starts the waiting run's stage again with its inputs, the item's answers and its checkout", async () => {
    const harness = await makeHarness();
    const worktree = await mkdtemp(join(tmpdir(), 'archon-waiting-worktree-'));
    try {
      await completeWithAsks(harness, [ask('Keep the flag?')], { item: 'pr-7' });
      const [ref] = await openRefs(harness);
      await answerAttentionItem(
        itemDeps(harness),
        ref ?? '',
        { choose: ['keep'] },
        operator,
        'cli'
      );
      const waiting = await completeWaitingHost(harness, worktree);
      // A later run of another workflow on the item is not the run that left the wait.
      const later = await harness.store.createWorkflowRun({
        workflow_name: 'build',
        user_message: '',
        codebase_id: CONFORMANCE_CODEBASE_ID,
        item_key: 'pr-7',
        metadata: runInputsMetadata({ item: 'pr-99', land_on: 'main' }),
      });
      await harness.store.claimPendingWorkflowRun(later.id);
      await harness.store.completeWorkflowRun(later.id, { duration_ms: 1 }, undefined);

      const id = await accept(carryingWake(), await projectKey(harness));
      const receipt = await harness.store.getStartReceipt(id);
      const intent = receipt?.bindings[0]?.intent;
      expect(receipt?.outcome).toBe('matched');
      expect(intent?.itemKey).toBe('pr-7');
      expect(intent?.eventInputs).toMatchObject({
        item: 'pr-7',
        land_on: 'dev',
        answers: [{ question: 'Keep the flag?', closedAs: 'answered', workflowName: 'plan' }],
        waited: { runId: waiting },
      });
      expect(intent?.checkoutFrom).toEqual({
        runId: 'builder-run',
        branch: 'archon/pr-7',
        commit: HEAD,
      });
      expect(await harness.store.listOpenItemWaits()).toEqual([]);
    } finally {
      await removeTempTree(worktree);
      await harness.close();
    }
  });

  test('a wake whose checkout is gone leaves the wait open and records the refusal on the waiting run', async () => {
    const harness = await makeHarness();
    const worktree = await mkdtemp(join(tmpdir(), 'archon-waiting-worktree-'));
    try {
      const waiting = await completeWaitingHost(harness, worktree);
      await rm(worktree, { recursive: true });
      const id = await accept(carryingWake(), await projectKey(harness));
      const receipt = await harness.store.getStartReceipt(id);
      expect(receipt?.outcome).toBe('unmatched');
      expect(receipt?.bindings).toMatchObject([{ status: 'rejected' }]);
      expect(receipt?.reason).toContain(`the worktree at '${worktree}'`);
      expect((await harness.store.listOpenItemWaits()).map(wait => wait.runId)).toEqual([waiting]);
      const run = await harness.store.getWorkflowRun(waiting);
      expect(readItemStopped(run?.metadata ?? {})?.refused).toMatchObject([
        { receiptId: id, workflow: 'host', reason: 'checkout_refused' },
      ]);
      // Listed beside its open wait, so the refusal shows now.
      expect(
        (await harness.store.listStoppedItemRuns()).map(stopped => 'id' in stopped && stopped.id)
      ).toEqual([waiting]);
    } finally {
      await removeTempTree(worktree);
      await harness.close();
    }
  });

  test('an event about a revision the item has moved past starts nothing', async () => {
    const harness = await makeHarness();
    try {
      // The item first waited at OLD, then a later run of its workflow at HEAD.
      await completeWithWaits(harness, [checks(OLD)]);
      await completeWithWaits(harness, [checks(HEAD)]);
      const project = await projectKey(harness);
      // However the source marked it, a delivery about OLD is compared with what is open.
      const id = await accept(wakeReceipt(OLD), project);
      expect(await readReceipt(harness, id)).toMatchObject({
        outcome: 'unmatched',
        reason: `no open wait 'checks' about '${OLD}' from 'host'`,
      });
      expect((await harness.store.listOpenItemWaits()).map(wait => wait.about)).toEqual([HEAD]);
    } finally {
      await harness.close();
    }
  });

  test('a wake in another project, or for another workflow, matches nothing', async () => {
    const harness = await makeHarness();
    try {
      await completeWithWaits(harness, [checks(HEAD)]);
      const project = await projectKey(harness);
      const elsewhere = await accept(wakeReceipt(HEAD), 'someone/else');
      expect((await readReceipt(harness, elsewhere)).outcome).toBe('unmatched');
      const unregistered = await accept(wakeReceipt(HEAD), null);
      expect(await readReceipt(harness, unregistered)).toMatchObject({
        outcome: 'unmatched',
        bindings: [{ status: 'rejected' }],
      });
      const other = await accept(wakeReceipt(HEAD, { workflow: 'build' }), project);
      expect((await readReceipt(harness, other)).outcome).toBe('unmatched');
      expect(await harness.store.listOpenItemWaits()).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  test('a wake that matches waits on two items starts nothing and names both', async () => {
    const harness = await makeHarness();
    try {
      await completeWithWaits(harness, [checks(HEAD)], { item: 'pr-7' });
      await completeWithWaits(harness, [checks(HEAD)], { item: 'issue-3' });
      const id = await accept(wakeReceipt(HEAD), await projectKey(harness));
      const read = await readReceipt(harness, id);
      expect(read).toMatchObject({ outcome: 'unmatched', bindings: [{ status: 'rejected' }] });
      expect(read.reason).toContain('pr-7');
      expect(read.reason).toContain('issue-3');
      expect(await harness.store.listOpenItemWaits()).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  test('a wake meets only a wait of the event it names', async () => {
    const harness = await makeHarness();
    try {
      await completeWithWaits(harness, [checks(HEAD)]);
      const id = await accept(wakeReceipt(HEAD, { wait: 'review' }), await projectKey(harness));
      expect((await readReceipt(harness, id)).outcome).toBe('unmatched');
      expect((await harness.store.listOpenItemWaits()).map(wait => wait.event)).toEqual(['checks']);
    } finally {
      await harness.close();
    }
  });

  test('an event that names its item wakes only that item, even when another waits at the commit', async () => {
    const harness = await makeHarness();
    try {
      const review = { event: 'review', about: HEAD, within_minutes: 60 };
      await completeWithWaits(harness, [review], { item: 'pr-7' });
      const project = await projectKey(harness);
      // A review of pr-8 at the same commit: pr-7's wait is not about it.
      const elsewhere = await accept(wakeReceipt(HEAD, { wait: 'review', item: 'pr-8' }), project);
      expect((await readReceipt(harness, elsewhere)).outcome).toBe('unmatched');
      expect(await harness.store.listOpenItemWaits()).toHaveLength(1);
      // With pr-8 waiting too, each item's review wakes its own item.
      await completeWithWaits(harness, [review], { item: 'pr-8' });
      for (const item of ['pr-8', 'pr-7']) {
        const id = await accept(wakeReceipt(HEAD, { wait: 'review', item }), project);
        expect(await readReceipt(harness, id)).toMatchObject({
          outcome: 'matched',
          bindings: [{ itemKey: item }],
        });
      }
      expect(await harness.store.listOpenItemWaits()).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  test('an open wait is in the attention queue once overdue, until it closes', async () => {
    const harness = await makeHarness();
    try {
      const deps = itemDeps(harness);
      const listed = async () =>
        (await listAttentionQueue(deps.queue)).filter(
          item => 'kind' in item && item.kind === 'overdue_wait'
        );
      await completeWithWaits(harness, [checks(HEAD, 60)]);
      expect(await listed()).toEqual([]);
      // Move the deadline into the past, as the passing of the hour would.
      await harness.db.query('UPDATE remote_agent_item_waits SET deadline_at = $1', [
        new Date(Date.now() - 60_000).toISOString(),
      ]);
      const [overdue] = await listed();
      expect(overdue).toMatchObject({
        kind: 'overdue_wait',
        item: { key: 'pr-7' },
        waitingIn: { workflow: 'host' },
        waits: [{ event: 'checks', about: HEAD }],
        pausedAt: expect.any(String),
      });
      if (overdue === undefined || !('ref' in overdue)) throw new Error('No overdue wait');
      // A late event still meets it.
      await accept(wakeReceipt(HEAD), await projectKey(harness));
      expect(await listed()).toEqual([]);

      // A withdrawal closes it too, and starts nothing.
      await completeWithWaits(harness, [checks(OLD, 1)]);
      await harness.db.query(
        'UPDATE remote_agent_item_waits SET deadline_at = $1 WHERE closed_as IS NULL',
        [new Date(Date.now() - 60_000).toISOString()]
      );
      const [again] = await listed();
      if (again === undefined || !('ref' in again)) throw new Error('No overdue wait');
      expect(await withdrawAttentionItem(deps, again.ref, operator, 'cli')).toMatchObject({
        kind: 'withdrawn',
        startReceipts: [],
      });
      expect(await listed()).toEqual([]);
      expect(await withdrawAttentionItem(deps, again.ref, operator, 'cli')).toMatchObject({
        kind: 'unchanged',
      });
    } finally {
      await harness.close();
    }
  });
}
