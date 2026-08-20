import { describe, test, expect } from 'bun:test';
import { deriveNodeStatuses, type WorkflowGraphNode } from './workflow-graph';
import { toRunEvent, type FanOutView } from './event';

type Raw = Parameters<typeof toRunEvent>[0];

function raw(over: Partial<Raw> & { event_type: string }): Raw {
  return {
    id: 'e1',
    workflow_run_id: 'r1',
    step_index: null,
    step_name: 'spread',
    data: {},
    created_at: '2026-06-05T10:00:00Z',
    ...over,
  };
}

function sampleView(): FanOutView {
  return {
    tally: {
      total: 3,
      completed: 1,
      failed: 0,
      cancelledByEngine: 0,
      cancelledOutOfBand: 0,
      neverRan: 2,
      notCompleted: 2,
    },
    headline: '2 of 3 children did not complete',
    tallyText: '2 of 3 children did not complete (1 completed, 2 never ran)',
    attentionLines: ['[1] never ran · x', '[2] never ran · x'],
    overflowCount: 0,
  };
}

const nodes: WorkflowGraphNode[] = [
  { id: 'plan', dependsOn: [], kind: 'bash' },
  { id: 'spread', dependsOn: ['plan'], kind: 'workflow' },
];

describe('deriveNodeStatuses — fan-out tally forwarding (#2451)', () => {
  test('forwards a completed fan-out node status plus its derived tally', () => {
    const events = [
      toRunEvent(raw({ event_type: 'node_completed', step_name: 'plan', data: { name: 'plan' } })),
      toRunEvent(
        raw({
          event_type: 'node_completed',
          step_name: 'spread',
          data: { name: 'spread', node_output: '[]' },
          fan_out_view: sampleView(),
        })
      ),
    ];
    const withStatus = deriveNodeStatuses(nodes, events);
    const spread = withStatus.find(n => n.id === 'spread');
    // Lifecycle stays 'completed' — the tally drives amber ATTENTION, not a failed status.
    expect(spread?.status).toBe('completed');
    expect(spread?.fanOut?.notCompleted).toBe(2);
    expect(spread?.fanOut?.total).toBe(3);
    // A non-fan-out node has no tally.
    const plan = withStatus.find(n => n.id === 'plan');
    expect(plan?.fanOut).toBeNull();
  });

  test('a node with no events stays pending with null fanOut', () => {
    const withStatus = deriveNodeStatuses(nodes, []);
    expect(withStatus.every(n => n.status === 'pending')).toBe(true);
    expect(withStatus.every(n => n.fanOut === null)).toBe(true);
  });

  // M3 (#2451): on resume a completed fan-out node re-emits `node_skipped_prior_success`
  // with NO fan-out view. The prior-tally retention branch must keep the earlier tally so
  // the amber-attention badge survives — a naive `e.fanOut?.tally ?? null` would drop it.
  test('retains a prior fan-out tally when a later resume-skip transition carries none', () => {
    const events = [
      toRunEvent(raw({ event_type: 'node_completed', step_name: 'plan', data: { name: 'plan' } })),
      toRunEvent(
        raw({
          event_type: 'node_completed',
          step_name: 'spread',
          data: { name: 'spread', node_output: '[]' },
          fan_out_view: sampleView(),
        })
      ),
      toRunEvent(
        raw({
          event_type: 'node_skipped_prior_success',
          step_name: 'spread',
          data: { name: 'spread' },
        })
      ),
    ];
    const withStatus = deriveNodeStatuses(nodes, events);
    const spread = withStatus.find(n => n.id === 'spread');
    expect(spread?.status).toBe('skipped');
    expect(spread?.fanOut?.notCompleted).toBe(2);
    expect(spread?.fanOut?.total).toBe(3);
  });
});
