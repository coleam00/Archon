import { describe, test, expect } from 'bun:test';
import { toRunEvent, countTerminalNodes, foldNodeRuns, type RunNodeState } from './event';

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
  test('integration operations retain target, producer and result without interpreting their policy', () => {
    const result = { ok: true, result: { observation: 'red' } };
    const event = toRunEvent(
      raw({
        event_type: 'integration_operation',
        data: {
          integration: 'example',
          operation: 'inspect',
          operationId: 'operation-42',
          target: { id: 'item-7' },
          plugin: { name: 'sample', version: '1' },
          result,
          durationMs: 5,
        },
      })
    );
    expect(event).toMatchObject({
      kind: 'tool_call',
      tool: 'example.inspect',
      args: {
        operationId: 'operation-42',
        target: { id: 'item-7' },
        plugin: { name: 'sample', version: '1' },
        result,
      },
      result: { ok: true, durationMs: 5 },
    });
  });

  test('integration failure exposes its structured diagnostic', () => {
    const event = toRunEvent(
      raw({
        event_type: 'integration_operation',
        data: {
          integration: 'example',
          operation: 'inspect',
          result: { ok: false, error: { message: 'No credential configured' } },
        },
      })
    );
    expect(event).toMatchObject({ result: { ok: false, message: 'No credential configured' } });
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

describe('toRunEvent — deprecation notice (#2781)', () => {
  test('workflow_deprecation_notice renders data.notice as text', () => {
    const e = toRunEvent(
      raw({
        event_type: 'workflow_deprecation_notice',
        data: {
          workflowName: 'archon-fix',
          notice: 'This workflow is deprecated. Switch to the sdlc pack instead.',
        },
      })
    );
    expect(e.kind).toBe('text');
    if (e.kind !== 'text') throw new Error('unreachable');
    expect(e.content).toBe('This workflow is deprecated. Switch to the sdlc pack instead.');
  });

  test('a notice-less payload falls back to a generic line, never raw JSON', () => {
    const e = toRunEvent(
      raw({ event_type: 'workflow_deprecation_notice', data: { workflowName: 'archon-fix' } })
    );
    expect(e.kind).toBe('text');
    if (e.kind !== 'text') throw new Error('unreachable');
    expect(e.content).toBe('⚠️ This workflow is deprecated.');
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
  test('no nodes → 0/0', () => {
    expect(countTerminalNodes([])).toEqual({ completed: 0, total: 0 });
  });

  test('pending and running nodes are excluded from the total', () => {
    expect(
      countTerminalNodes([
        { node_id: 'a', state: 'pending' },
        { node_id: 'b', state: 'running' },
      ])
    ).toEqual({ completed: 0, total: 0 });
  });

  test('completed counts toward completed+total; failed/skipped only toward total', () => {
    expect(
      countTerminalNodes([
        { node_id: 'a', state: 'completed' },
        { node_id: 'b', state: 'failed' },
        { node_id: 'c', state: 'skipped' },
      ])
    ).toEqual({ completed: 1, total: 3 });
  });
});

describe('foldNodeRuns', () => {
  const at = (s: string): string => `2026-06-05T10:0${s}:00Z`;
  const node = (
    nodeId: string | null,
    eventType: string,
    over: { created_at?: string; data?: Record<string, unknown> } = {}
  ) => toRunEvent(raw({ event_type: eventType, step_name: nodeId, ...over }));
  const state = (node_id: string, nodeState: RunNodeState['state']): RunNodeState => ({
    node_id,
    state: nodeState,
  });

  test('no events → no runs', () => {
    expect(foldNodeRuns([], [state('plan', 'pending')])).toEqual([]);
  });

  test('a running node has no duration or end', () => {
    const runs = foldNodeRuns([node('plan', 'node_started')], [state('plan', 'running')]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      nodeId: 'plan',
      status: 'running',
      endedAt: null,
      durationMs: null,
    });
  });

  test('started + completed renders ONE completed run carrying duration + cost/turns/stop', () => {
    const runs = foldNodeRuns(
      [
        node('plan', 'node_started', { created_at: at('0') }),
        node('plan', 'node_completed', {
          created_at: at('5'),
          data: { duration_ms: 11370, cost_usd: 0.1399, num_turns: 3, stop_reason: 'end_turn' },
        }),
      ],
      [state('plan', 'completed')]
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      nodeId: 'plan',
      status: 'completed',
      startedAt: at('0'),
      endedAt: at('5'),
      durationMs: 11370,
      costUsd: 0.1399,
      numTurns: 3,
      stopReason: 'end_turn',
    });
  });

  // The engine's state wins over anything the transitions suggest: these are the
  // histories a client-side "ever completed wins" fold got wrong after a resume.
  test('a completed node reset on resume whose re-run failed shows failed', () => {
    const runs = foldNodeRuns(
      [
        node('prepare', 'node_completed', {
          created_at: at('1'),
          data: { duration_ms: 900, cost_usd: 0.05 },
        }),
        node('prepare', 'node_always_run_reset', { created_at: at('4') }),
        node('prepare', 'node_started', { created_at: at('5') }),
        node('prepare', 'node_failed', { created_at: at('8'), data: { duration_ms: 10 } }),
      ],
      [state('prepare', 'failed')]
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'failed',
      startedAt: at('1'),
      endedAt: at('8'),
      durationMs: 10,
      // Cost display keeps reading the node_completed transition.
      costUsd: 0.05,
    });
  });

  test('a completed node the engine reports pending shows pending, with no end', () => {
    const runs = foldNodeRuns(
      [node('prepare', 'node_completed', { data: { duration_ms: 900 } })],
      [state('prepare', 'pending')]
    );
    expect(runs[0]).toMatchObject({ status: 'pending', endedAt: null, durationMs: null });
  });

  test('a node replayed from a prior success shows completed', () => {
    const runs = foldNodeRuns(
      [node('plan', 'node_skipped_prior_success', { data: { reason: 'prior_success' } })],
      [state('plan', 'completed')]
    );
    expect(runs[0]?.status).toBe('completed');
  });

  test('a skipped node carries reason + expr and skipped status', () => {
    const runs = foldNodeRuns(
      [
        node('web-research', 'node_skipped', {
          data: { reason: 'when_condition', expr: "$classify.output.type != 'bug'" },
        }),
      ],
      [state('web-research', 'skipped')]
    );
    expect(runs[0]).toMatchObject({
      nodeId: 'web-research',
      status: 'skipped',
      skipReason: 'when_condition',
      skipExpr: "$classify.output.type != 'bug'",
    });
  });

  test('a retried node that completed takes duration/cost from the completion', () => {
    const runs = foldNodeRuns(
      [
        node('build', 'node_started', { created_at: at('0') }),
        node('build', 'node_failed', { created_at: at('2'), data: { duration_ms: 42 } }),
        node('build', 'node_completed', {
          created_at: at('8'),
          data: { duration_ms: 900, cost_usd: 0.05, num_turns: 2 },
        }),
      ],
      [state('build', 'completed')]
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'completed',
      durationMs: 900,
      costUsd: 0.05,
      numTurns: 2,
    });
  });

  test('multiple nodes are returned sorted by startedAt', () => {
    const runs = foldNodeRuns(
      [
        node('second', 'node_started', { created_at: at('5') }),
        node('first', 'node_started', { created_at: at('1') }),
      ],
      [state('second', 'running'), state('first', 'running')]
    );
    expect(runs.map(r => r.nodeId)).toEqual(['first', 'second']);
  });

  test('transitions for a node the engine does not list are not rendered', () => {
    expect(
      foldNodeRuns([node(null, 'node_completed'), node('ghost', 'node_completed')], [])
    ).toEqual([]);
  });

  test('non-node_transition events are ignored', () => {
    const runs = foldNodeRuns(
      [
        node('plan', 'node_completed'),
        toRunEvent(raw({ event_type: 'workflow_artifact', data: { label: 'pr' } })),
        toRunEvent(raw({ event_type: 'workflow_completed', data: {} })),
      ],
      [state('plan', 'completed')]
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.nodeId).toBe('plan');
  });
});

describe('toRunEvent — container lifecycle (DB rows)', () => {
  test('container_created → system event with the container id', () => {
    const e = toRunEvent(
      raw({
        event_type: 'container_created',
        step_name: 'container',
        data: { containerId: 'cabbc1f406f6abcdef' },
      })
    );
    expect(e.kind).toBe('system');
    if (e.kind === 'system') {
      expect(e.label).toBe('Container created');
      expect(e.detail).toBe('cabbc1f406f6'); // 12-char short id
    }
  });

  test('container_destroyed → system event', () => {
    const e = toRunEvent(
      raw({ event_type: 'container_destroyed', step_name: 'container', data: {} })
    );
    expect(e.kind).toBe('system');
    if (e.kind === 'system') expect(e.label).toBe('Container removed');
  });
});
