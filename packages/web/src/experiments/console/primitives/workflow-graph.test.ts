import { describe, test, expect } from 'bun:test';
import { deriveNodeStatuses, type WorkflowGraphNode } from './workflow-graph';
import { toRunEvent } from './event';

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
          data: {
            name: 'spread',
            node_output: '[]',
            fan_out: {
              children: [
                { kind: 'completed', index: 0, childRunId: 'a' },
                { kind: 'never_ran', index: 1, reason: 'unresolved_target', error: 'x' },
                { kind: 'never_ran', index: 2, reason: 'unresolved_target', error: 'x' },
              ],
            },
          },
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
});
