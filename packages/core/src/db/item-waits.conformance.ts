/**
 * Conformance for waits on the SQL stores, run by the SQLite and PostgreSQL integration
 * tests: a completed run opens its waits in the write that completes it and a newer set
 * replaces the open one; a receipt whose binding wakes a wait starts the next stage on the
 * wait's item once, and only for the exact value the wait names; an open wait past its
 * deadline is in the attention queue until it closes.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { listAttentionQueue } from '@archon/workflows/attention-queue';
import type { ItemWait } from '@archon/workflows/schemas/item-wait';
import type {
  ResourceStartBindingIntent,
  SourceReceiptAcceptance,
} from '@archon/workflows/schemas/resource-start';
import { CONFORMANCE_CODEBASE_ID } from '@archon/workflows/store-conformance';
import { withdrawAttentionItem } from '../operations/attention-items';
import { itemDeps, operator, type Harness } from './item-asks.conformance';

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
  options: { deliveryId?: string; workflow?: string; bindingId?: string } = {}
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
    wake: { workflowName: options.workflow ?? 'host', wait: 'checks', about, input: 'waited' },
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

export async function accept(
  receipt: SourceReceiptAcceptance,
  project: string | null
): Promise<string> {
  const { acceptStartReceipt } = await import('./start-receipt-writes');
  return (await acceptStartReceipt(receipt, async () => project)).receiptId;
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
