import { describe, test, expect } from 'bun:test';
import { toRunEvent, countTerminalNodes } from './event';

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

describe('toRunEvent — base mapping', () => {
  test('maps id, runId, timestamp, nodeId from the row', () => {
    const e = toRunEvent(raw({ event_type: 'node_started', step_name: 'plan' }));
    expect(e.id).toBe('e1');
    expect(e.runId).toBe('r1');
    expect(e.timestamp).toBe('2026-06-05T10:00:00Z');
    expect(e.nodeId).toBe('plan');
  });
});

describe('toRunEvent — node transitions', () => {
  test('node_completed reads duration_ms (regression: server writes duration_ms, not duration)', () => {
    const e = toRunEvent(
      raw({
        event_type: 'node_completed',
        data: {
          duration_ms: 11370,
          node_output: '1717',
          cost_usd: 0.1399,
          stop_reason: 'end_turn',
          num_turns: 1,
        },
      })
    );
    expect(e.kind).toBe('node_transition');
    if (e.kind !== 'node_transition') throw new Error('unreachable');
    expect(e.transition).toBe('completed');
    expect(e.durationMs).toBe(11370); // was always null when reading `duration`
    expect(e.outputPreview).toBe('1717');
    expect(e.costUsd).toBe(0.1399);
    expect(e.stopReason).toBe('end_turn');
    expect(e.numTurns).toBe(1);
  });

  test('node_completed truncates a long output preview to 300 chars', () => {
    const long = 'x'.repeat(500);
    const e = toRunEvent(raw({ event_type: 'node_completed', data: { node_output: long } }));
    if (e.kind !== 'node_transition') throw new Error('unreachable');
    expect(e.outputPreview).toHaveLength(300);
  });

  test('node_started has null duration and null enrichment', () => {
    const e = toRunEvent(raw({ event_type: 'node_started' }));
    if (e.kind !== 'node_transition') throw new Error('unreachable');
    expect(e.transition).toBe('started');
    expect(e.durationMs).toBeNull();
    expect(e.outputPreview).toBeNull();
    expect(e.costUsd).toBeNull();
  });

  test('node_skipped carries when_condition reason + expr', () => {
    const e = toRunEvent(
      raw({
        event_type: 'node_skipped',
        data: { reason: 'when_condition', expr: "$classify.output.issue_type != 'bug'" },
      })
    );
    if (e.kind !== 'node_transition') throw new Error('unreachable');
    expect(e.transition).toBe('skipped');
    expect(e.skipReason).toBe('when_condition');
    expect(e.skipExpr).toBe("$classify.output.issue_type != 'bug'");
  });

  test('node_skipped trigger_rule has no expr', () => {
    const e = toRunEvent(raw({ event_type: 'node_skipped', data: { reason: 'trigger_rule' } }));
    if (e.kind !== 'node_transition') throw new Error('unreachable');
    expect(e.skipReason).toBe('trigger_rule');
    expect(e.skipExpr).toBeNull();
  });

  test('node_skipped_prior_success maps to a skipped transition (was dropped entirely)', () => {
    const e = toRunEvent(
      raw({
        event_type: 'node_skipped_prior_success',
        data: { reason: 'prior_success', node_output: '1516' },
      })
    );
    expect(e.kind).toBe('node_transition');
    if (e.kind !== 'node_transition') throw new Error('unreachable');
    expect(e.transition).toBe('skipped');
    expect(e.skipReason).toBe('prior_success');
  });

  test('node_failed maps to a failed transition (guards the map vs the skipped default)', () => {
    const e = toRunEvent(raw({ event_type: 'node_failed' }));
    expect(e.kind).toBe('node_transition');
    if (e.kind !== 'node_transition') throw new Error('unreachable');
    // Must NOT fall through to the `?? 'skipped'` default.
    expect(e.transition).toBe('failed');
    expect(e.skipReason).toBeNull();
    expect(e.outputPreview).toBeNull();
  });

  test('nodeName prefers data.name, falling back to step_name', () => {
    const named = toRunEvent(
      raw({ event_type: 'node_started', step_name: 'plan', data: { name: 'Plan the work' } })
    );
    if (named.kind !== 'node_transition') throw new Error('unreachable');
    expect(named.nodeName).toBe('Plan the work');

    const unnamed = toRunEvent(raw({ event_type: 'node_started', step_name: 'plan' }));
    if (unnamed.kind !== 'node_transition') throw new Error('unreachable');
    expect(unnamed.nodeName).toBe('plan');
  });
});

describe('toRunEvent — tool calls (regression guard)', () => {
  test('tool_called carries tool name + input, no result yet', () => {
    const e = toRunEvent(
      raw({ event_type: 'tool_called', data: { tool_name: 'Bash', tool_input: { cmd: 'ls' } } })
    );
    expect(e.kind).toBe('tool_call');
    if (e.kind !== 'tool_call') throw new Error('unreachable');
    expect(e.tool).toBe('Bash');
    expect(e.args).toEqual({ cmd: 'ls' });
    expect(e.result).toBeNull();
  });

  test('tool_completed reads duration_ms into the result', () => {
    const e = toRunEvent(
      raw({ event_type: 'tool_completed', data: { tool_name: 'Bash', duration_ms: 667 } })
    );
    if (e.kind !== 'tool_call') throw new Error('unreachable');
    expect(e.result).toEqual({ ok: true, durationMs: 667 });
  });
});

describe('toRunEvent — approvals (server writes approval_requested/approval_received)', () => {
  test('approval_requested → pending approval with the prompt', () => {
    const e = toRunEvent(
      raw({ event_type: 'approval_requested', data: { message: 'Review the plan?' } })
    );
    expect(e.kind).toBe('approval');
    if (e.kind !== 'approval') throw new Error('unreachable');
    expect(e.prompt).toBe('Review the plan?');
    expect(e.resolution).toBeNull();
  });

  test('approval_received approved → approved resolution with comment', () => {
    const e = toRunEvent(
      raw({ event_type: 'approval_received', data: { decision: 'approved', comment: 'ship it' } })
    );
    if (e.kind !== 'approval') throw new Error('unreachable');
    expect(e.resolution).toEqual({
      kind: 'approved',
      at: '2026-06-05T10:00:00Z',
      comment: 'ship it',
    });
  });

  test('approval_received rejected → rejected resolution with reason', () => {
    const e = toRunEvent(
      raw({ event_type: 'approval_received', data: { decision: 'rejected', reason: 'fix tests' } })
    );
    if (e.kind !== 'approval') throw new Error('unreachable');
    expect(e.resolution).toEqual({
      kind: 'rejected',
      at: '2026-06-05T10:00:00Z',
      reason: 'fix tests',
    });
  });

  test('approval_received with a missing/unknown decision stays unresolved (never silently approved)', () => {
    const missing = toRunEvent(raw({ event_type: 'approval_received', data: {} }));
    if (missing.kind !== 'approval') throw new Error('unreachable');
    expect(missing.resolution).toBeNull();

    const garbage = toRunEvent(raw({ event_type: 'approval_received', data: { decision: '???' } }));
    if (garbage.kind !== 'approval') throw new Error('unreachable');
    expect(garbage.resolution).toBeNull();
  });

  test('the old (never-written) approval_pending type is NOT treated as an approval', () => {
    // Guards against regressing to the pre-fix keys: approval_pending/approval_resolved
    // are not emitted by the server, so they must fall through, not render as approvals.
    const e = toRunEvent(raw({ event_type: 'approval_pending', data: { message: 'x' } }));
    expect(e.kind).not.toBe('approval');
  });
});

describe('toRunEvent — error & workflow lifecycle', () => {
  test('error prefers the `error` key over `message`', () => {
    const e = toRunEvent(
      raw({ event_type: 'error', data: { error: 'boom', message: 'ignored', recoverable: true } })
    );
    expect(e.kind).toBe('error');
    if (e.kind !== 'error') throw new Error('unreachable');
    expect(e.message).toBe('boom');
    expect(e.recoverable).toBe(true);
  });

  test('error falls back to `message` when `error` is absent', () => {
    const e = toRunEvent(raw({ event_type: 'error', data: { message: 'fallback' } }));
    if (e.kind !== 'error') throw new Error('unreachable');
    expect(e.message).toBe('fallback');
    expect(e.recoverable).toBe(false);
  });

  test('workflow_completed → a system event with a label', () => {
    const e = toRunEvent(raw({ event_type: 'workflow_completed', data: { name: 'deploy' } }));
    expect(e.kind).toBe('system');
    if (e.kind !== 'system') throw new Error('unreachable');
    expect(e.label).toBe('Workflow completed');
    expect(e.detail).toBe('deploy');
  });

  test('workflow_failed surfaces the error in `detail`', () => {
    const e = toRunEvent(raw({ event_type: 'workflow_failed', data: { error: 'node X failed' } }));
    if (e.kind !== 'system') throw new Error('unreachable');
    expect(e.label).toBe('Workflow failed');
    expect(e.detail).toBe('node X failed');
  });
});

describe('toRunEvent — fallback', () => {
  test('unknown event types fall through to a text event with a payload summary', () => {
    const e = toRunEvent(raw({ event_type: 'mystery_event', data: { foo: 'bar' } }));
    expect(e.kind).toBe('text');
    if (e.kind !== 'text') throw new Error('unreachable');
    expect(e.content).toContain('mystery_event');
  });
});

describe('countTerminalNodes', () => {
  // Build a normalized node-transition RunEvent for `nodeId` via toRunEvent.
  const node = (nodeId: string | null, eventType: string) =>
    toRunEvent(raw({ event_type: eventType, step_name: nodeId }));

  test('empty event list → 0/0', () => {
    expect(countTerminalNodes([])).toEqual({ completed: 0, total: 0 });
  });

  test('only started (in-flight) nodes are excluded from the total', () => {
    expect(countTerminalNodes([node('a', 'node_started'), node('b', 'node_started')])).toEqual({
      completed: 0,
      total: 0,
    });
  });

  test('completed counts toward completed+total; failed/skipped only toward total', () => {
    const events = [
      node('a', 'node_completed'),
      node('b', 'node_failed'),
      node('c', 'node_skipped'),
    ];
    expect(countTerminalNodes(events)).toEqual({ completed: 1, total: 3 });
  });

  test('a node seen as completed then resume-skipped counts ONCE, still completed (dedup regression)', () => {
    // A resumed run reuses one run id: the node has its original node_completed AND a
    // later node_skipped_prior_success. Raw counting would report 2/2; dedup → 1/1.
    const events = [node('a', 'node_completed'), node('a', 'node_skipped_prior_success')];
    expect(countTerminalNodes(events)).toEqual({ completed: 1, total: 1 });
  });

  test('non-node_transition events are ignored', () => {
    const events = [
      node('a', 'node_completed'),
      toRunEvent(raw({ event_type: 'tool_called', data: { tool_name: 'Bash' } })),
      toRunEvent(raw({ event_type: 'workflow_completed', data: {} })),
    ];
    expect(countTerminalNodes(events)).toEqual({ completed: 1, total: 1 });
  });

  test('a terminal event with a null nodeId is skipped (can not be deduped)', () => {
    expect(countTerminalNodes([node(null, 'node_completed')])).toEqual({ completed: 0, total: 0 });
  });
});
