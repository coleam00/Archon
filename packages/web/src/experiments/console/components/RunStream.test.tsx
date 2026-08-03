import { describe, test, expect } from 'bun:test';
import { pairToolEvents } from './RunStream';
import { toRunEvent } from '../primitives/event';

type Raw = Parameters<typeof toRunEvent>[0];

function raw(over: Partial<Raw> & { event_type: string }): Raw {
  return {
    id: 'e1',
    workflow_run_id: 'r1',
    step_index: null,
    step_name: 'node-a',
    data: {},
    created_at: '2026-06-05T10:00:00Z',
    ...over,
  };
}

describe('pairToolEvents — node identity threading', () => {
  test('each paired call carries its source event nodeId (step_name) + duration', () => {
    const events = [
      toRunEvent(
        raw({
          id: 's1',
          event_type: 'tool_called',
          step_name: 'plan',
          data: { tool_name: 'Read', tool_input: { path: 'a' } },
        })
      ),
      toRunEvent(
        raw({
          id: 'c1',
          event_type: 'tool_completed',
          step_name: 'plan',
          data: { tool_name: 'Read', duration_ms: 120 },
        })
      ),
      toRunEvent(
        raw({
          id: 's2',
          event_type: 'tool_called',
          step_name: 'implement',
          data: { tool_name: 'Bash', tool_input: { cmd: 'ls' } },
        })
      ),
      toRunEvent(
        raw({
          id: 'c2',
          event_type: 'tool_completed',
          step_name: 'implement',
          data: { tool_name: 'Bash', duration_ms: 300 },
        })
      ),
    ];

    const paired = pairToolEvents(events);
    expect(paired).toHaveLength(2);
    const byId = new Map(paired.map(p => [p.id, p]));
    expect(byId.get('s1')?.nodeId).toBe('plan');
    expect(byId.get('s1')?.call.durationMs).toBe(120);
    expect(byId.get('s2')?.nodeId).toBe('implement');
    expect(byId.get('s2')?.call.durationMs).toBe(300);
  });

  test('a tool_called with a null step_name stays unattributed (nodeId null)', () => {
    const paired = pairToolEvents([
      toRunEvent(
        raw({ id: 's1', event_type: 'tool_called', step_name: null, data: { tool_name: 'Read' } })
      ),
    ]);
    expect(paired).toHaveLength(1);
    expect(paired[0]?.nodeId).toBeNull();
  });
});
