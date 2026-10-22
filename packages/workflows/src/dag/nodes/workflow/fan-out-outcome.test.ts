import { describe, expect, it } from 'bun:test';
import type { ChildWorkflowOutcome } from '../../child-run';
import type { WorkflowRun } from '../../../schemas';
import type { IWorkflowStore } from '../../../store';
import {
  describeUnfinishedFanOut,
  fanOutOutcome,
  fanOutOutcomeSchema,
} from '../../../schemas/fan-out-outcome';
import { runCancelReasonSchema } from '../../../schemas/run-terminal-reason';
import { buildFanOutOutcome, cancelledOutcomeFor, classifyFanOutSlot } from './fan-out-outcome';

function row(status: WorkflowRun['status'], metadata: Record<string, unknown> = {}): WorkflowRun {
  return { id: `child-${status}`, status, metadata } as WorkflowRun;
}

function outcome(status: ChildWorkflowOutcome['status'], error?: string): ChildWorkflowOutcome {
  return { childRunId: 'child', status, ...(error !== undefined ? { error } : {}) };
}

describe('classifyFanOutSlot', () => {
  it('reads a slot with no child row as not started, keeping its refusal as the record', () => {
    expect(classifyFanOutSlot(2, outcome('failed', 'input refused'), undefined, undefined)).toEqual(
      { index: 2, outcome: 'not_started', error: 'input refused' }
    );
  });

  it('lets the terminal row decide over the pass outcome', () => {
    // runChildWorkflow returns `failed` after its setup catch cancelled the row; a resume
    // reads that row as cancelled. Both must classify the same.
    expect(
      classifyFanOutSlot(
        0,
        outcome('failed', 'Sub-run errored'),
        row('cancelled'),
        'precondition_failed'
      )
    ).toEqual({
      index: 0,
      outcome: 'cancelled_by_engine',
      child_run_id: 'child-cancelled',
      cancel_reason: 'precondition_failed',
    });
    expect(classifyFanOutSlot(0, outcome('failed', 'x'), row('completed'), undefined)).toEqual({
      index: 0,
      outcome: 'completed',
      child_run_id: 'child-completed',
    });
  });

  it("keeps a failed child's error, falling back to the row's", () => {
    expect(
      classifyFanOutSlot(1, outcome('failed'), row('failed', { error: 'exit 1' }), undefined)
    ).toEqual({ index: 1, outcome: 'failed', child_run_id: 'child-failed', error: 'exit 1' });
  });

  it('falls back to the pass outcome while the row is not terminal', () => {
    expect(classifyFanOutSlot(0, outcome('failed', 'e'), row('running'), undefined)).toMatchObject({
      outcome: 'failed',
      child_run_id: 'child-running',
      error: 'e',
    });
  });
});

describe('cancelledOutcomeFor', () => {
  it('attributes every recorded cancel reason', () => {
    const expected = {
      fan_out: 'cancelled_by_engine',
      precondition_failed: 'cancelled_by_engine',
      halt_node: 'cancelled_by_workflow',
      approval_rejected: 'cancelled_by_workflow',
      operator: 'cancelled_out_of_band',
      conversation_reset: 'cancelled_out_of_band',
    } as const;
    for (const reason of runCancelReasonSchema.options) {
      expect(cancelledOutcomeFor(reason, undefined)).toBe(expected[reason]);
    }
  });

  it('treats a fan-out row tag as engine-owned and no record as unattributed', () => {
    expect(cancelledOutcomeFor(undefined, 'fan_out_checkout_check')).toBe('cancelled_by_engine');
    expect(cancelledOutcomeFor(undefined, undefined)).toBe('cancelled_unattributed');
    expect(cancelledOutcomeFor(undefined, 'something_else')).toBe('cancelled_unattributed');
  });
});

describe('fanOutOutcomeSchema', () => {
  const slots = fanOutOutcome([
    { index: 0, outcome: 'completed', child_run_id: 'a' },
    { index: 1, outcome: 'failed', child_run_id: 'b' },
    { index: 2, outcome: 'not_started', error: 'refused' },
  ]);

  it('accepts the constructed outcome and tallies every slot', () => {
    expect(fanOutOutcomeSchema.parse(slots).tally).toEqual({
      total: 3,
      completed: 1,
      failed: 1,
      not_started: 1,
      cancelled_by_engine: 0,
      cancelled_by_workflow: 0,
      cancelled_out_of_band: 0,
      cancelled_unattributed: 0,
    });
    expect(describeUnfinishedFanOut(slots.tally)).toBe(
      '2 of 3 children did not complete (1 failed, 1 not started)'
    );
  });

  it('rejects a tally that disagrees with its slots, and out-of-order slots', () => {
    expect(
      fanOutOutcomeSchema.safeParse({ ...slots, tally: { ...slots.tally, completed: 3 } }).success
    ).toBe(false);
    expect(
      fanOutOutcomeSchema.safeParse({ ...slots, slots: [...slots.slots].reverse() }).success
    ).toBe(false);
  });
});

describe('buildFanOutOutcome', () => {
  function storeWith(rows: WorkflowRun[], cancelReasons: Record<string, string>): IWorkflowStore {
    return {
      findChildRuns: async () => rows,
      listEventsForRuns: async (ids: readonly string[]) =>
        new Map(
          ids
            .filter(id => cancelReasons[id] !== undefined)
            .map(id => [id, [{ data: { cancel_reason: cancelReasons[id] } }]])
        ),
    } as unknown as IWorkflowStore;
  }
  const child = (id: string, index: number, status: WorkflowRun['status']): WorkflowRun =>
    ({
      id,
      status,
      metadata: { parent_node_id: 'work', child_index: index },
    }) as unknown as WorkflowRun;

  it('keeps every slot of a wide fan-out and tallies them exactly', async () => {
    const width = 600;
    const rows = Array.from({ length: width }, (_, i) =>
      child(`c${String(i)}`, i, i % 7 === 0 ? 'failed' : 'completed')
    );
    const outcomes = rows.map(r =>
      outcome(r.status === 'failed' ? 'failed' : 'completed', undefined)
    );
    const built = await buildFanOutOutcome(storeWith(rows, {}), 'parent', 'work', outcomes);
    if (!('outcome' in built)) throw new Error('expected an outcome');
    expect(built.outcome.slots).toHaveLength(width);
    expect(built.outcome.tally.failed).toBe(Math.ceil(width / 7));
    expect(built.outcome.tally.completed).toBe(width - Math.ceil(width / 7));
    expect(fanOutOutcomeSchema.safeParse(built.outcome).success).toBe(true);
  });

  it('attributes a cancelled child from its recorded cancel event', async () => {
    const rows = [child('c0', 0, 'completed'), child('c1', 1, 'cancelled')];
    const built = await buildFanOutOutcome(storeWith(rows, { c1: 'operator' }), 'parent', 'work', [
      outcome('completed'),
      outcome('cancelled'),
    ]);
    if (!('outcome' in built)) throw new Error('expected an outcome');
    expect(built.outcome.slots[1]).toEqual({
      index: 1,
      outcome: 'cancelled_out_of_band',
      child_run_id: 'c1',
      cancel_reason: 'operator',
    });
  });

  it('returns a read failure instead of classifying any slot', async () => {
    const error = new Error('db down');
    const store = {
      findChildRuns: async () => {
        throw error;
      },
    } as unknown as IWorkflowStore;
    expect(
      await buildFanOutOutcome(store, 'parent', 'work', [outcome('completed'), outcome('failed')])
    ).toEqual({ lookupError: error });
  });
});
