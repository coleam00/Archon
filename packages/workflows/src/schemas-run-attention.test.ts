// @archon-test-isolated
import { describe, test, expect } from 'bun:test';
import { approvalContextSchema, continuablePause } from './schemas/workflow-run';
import { runAttention, isRunBlockedOnChild, isFanOutBlockReleased } from './schemas';
import type { RunAttentionInput, SuspendReason, WorkflowRunStatus } from './schemas';

describe('runAttention', () => {
  const pausedOn = (approval: unknown, overrides: Partial<RunAttentionInput> = {}) =>
    ({
      id: 'run-1',
      status: 'paused',
      metadata: { approval },
      completed_at: null,
      ...overrides,
    }) satisfies RunAttentionInput;

  const gate = (over: Record<string, unknown> = {}) => ({
    nodeId: 'review',
    message: 'Approve the plan.',
    ...over,
  });

  describe('still progressing under its own power', () => {
    test.each(['pending', 'running'] as const)('returns null for a %s run', status => {
      expect(runAttention({ id: 'run-1', status, metadata: {} })).toBeNull();
    });

    test('returns null for a resolved gate awaiting auto-resume', () => {
      expect(runAttention(pausedOn(gate({ resolved: 'approved' })))).toBeNull();
      expect(runAttention(pausedOn(gate({ resolved: 'rejected' })))).toBeNull();
    });

    test('returns null for a `wait:` pause — the clock owns it, not a person', () => {
      const run = {
        id: 'run-1',
        status: 'paused' as const,
        metadata: {
          wait: {
            owner: 'node',
            nodeId: 'hold',
            kind: 'time',
            waitingSince: '2026-08-28T10:00:00.000Z',
            resumeAt: '2026-08-28T11:00:00.000Z',
          },
        },
      };
      expect(runAttention(run)).toBeNull();
    });

    test('reads a legacy attention wait as the message form at its legacy occurrence', () => {
      const run = {
        id: 'run-1',
        status: 'paused' as const,
        metadata: {
          wait: {
            owner: 'loop_group' as const,
            nodeId: 'recover-ci',
            bodyWaitId: 'operator-action',
            iteration: 1,
            sessionId: null,
            sessionProvider: null,
            kind: 'attention' as const,
            waitingSince: '2026-08-28T10:00:00.000Z',
            message: 'Rerun the failing check, then resume.',
          },
        },
      };
      expect(runAttention(run)).toEqual({
        kind: 'attention',
        runId: 'run-1',
        nodeId: 'recover-ci.operator-action',
        occurrence: 'legacy:recover-ci.operator-action',
        message: 'Rerun the failing check, then resume.',
        form: 'message',
        options: [],
      });
    });

    test('reports an attention wait with its form, options and pause occurrence', () => {
      const wait = {
        owner: 'node' as const,
        nodeId: 'ask',
        kind: 'attention' as const,
        waitingSince: '2026-08-28T10:00:00.000Z',
        message: 'Which base?',
        pauseId: 'pause-1',
      };
      const attentionOf = (extra: Record<string, unknown>) =>
        runAttention({ id: 'run-1', status: 'paused', metadata: { wait: { ...wait, ...extra } } });
      expect(attentionOf({ form: 'select', options: [{ id: 'use-main', label: 'Main' }] })).toEqual(
        {
          kind: 'attention',
          runId: 'run-1',
          nodeId: 'ask',
          occurrence: 'pause-1',
          message: 'Which base?',
          form: 'select',
          options: [{ id: 'use-main', label: 'Main' }],
        }
      );
      expect(attentionOf({ form: 'approval' })).toMatchObject({
        form: 'approval',
        options: [{ id: 'approve' }, { id: 'reject' }],
      });
      // Answered, it waits on the continuation host, not on anyone.
      expect(
        attentionOf({
          form: 'approval',
          answer: { decision: 'reject', text: '' },
          answeredVia: 'cli',
          answeredAt: '2026-08-28T10:05:00.000Z',
        })
      ).toBeNull();
    });

    test('a resolved child_workflow gate is still nobody’s decision', () => {
      // Order matters: resolution is checked before the child redirect, so a gate
      // already resolved never re-addresses a human at the child.
      expect(
        runAttention(
          pausedOn(gate({ type: 'child_workflow', childRunId: 'kid', resolved: 'approved' }))
        )
      ).toBeNull();
    });
  });

  describe('terminal', () => {
    test.each(['completed', 'failed', 'cancelled'] as const)('reports %s with its time', status => {
      const at = new Date('2026-08-28T12:00:00.000Z');
      expect(runAttention({ id: 'run-1', status, metadata: {}, completed_at: at })).toEqual({
        kind: 'terminal',
        runId: 'run-1',
        status,
        at,
      });
    });

    test('carries a null time when the row has none', () => {
      const attention = runAttention({ id: 'run-1', status: 'failed', metadata: {} });
      expect(attention).toEqual({ kind: 'terminal', runId: 'run-1', status: 'failed', at: null });
    });

    test('a terminal status wins over leftover gate metadata', () => {
      const attention = runAttention({
        id: 'run-1',
        status: 'cancelled',
        metadata: { approval: gate() },
      });
      expect(attention?.kind).toBe('terminal');
    });
  });

  describe('awaiting a human', () => {
    // Every recognized reason EXCEPT child_workflow and fan_out, plus the legacy undefined.
    const humanReasons: (SuspendReason | undefined)[] = [
      'approval',
      'interactive_loop',
      'writeback',
      undefined,
    ];

    test.each(humanReasons)('addresses the decision at this run for type %s', type => {
      const approval = type === undefined ? gate() : gate({ type });
      expect(runAttention(pausedOn(approval))).toEqual({
        kind: 'awaiting_response',
        runId: 'run-1',
        respondTo: { runId: 'run-1', nodeId: 'review' },
        occurrence: 'legacy:review',
        message: 'Approve the plan.',
      });
    });
  });

  test.each(['approval', 'interactive_loop', 'writeback'] as const)(
    'uses the pause id for %s and changes on a re-ask',
    type => {
      expect(runAttention(pausedOn(gate({ type, pauseId: 'first' })))).toMatchObject({
        occurrence: 'first',
      });
      expect(runAttention(pausedOn(gate({ type, pauseId: 'second' })))).toMatchObject({
        occurrence: 'second',
      });
    }
  );

  describe('blocked on a child', () => {
    test('reports the block and never claims a human is needed', () => {
      // The parent row cannot tell "child on a gate" from "child still running",
      // so asserting awaiting_response here would wake a host for normal progress.
      const attention = runAttention(
        pausedOn(gate({ type: 'child_workflow', nodeId: 'sub', childRunId: 'kid' }))
      );
      expect(attention).toEqual({
        kind: 'blocked_on_child',
        runId: 'run-1',
        childRunId: 'kid',
        nodeId: 'sub',
      });
    });

    test('a block pointer with nothing to follow is unreadable, not a redirect', () => {
      for (const childRunId of [undefined, '']) {
        const attention = runAttention(
          pausedOn(gate({ type: 'child_workflow', nodeId: 'sub', childRunId }))
        );
        expect(attention).toMatchObject({ kind: 'unreadable', reason: 'child_pointer_missing' });
      }
    });
  });

  describe('blocked on fan-out children', () => {
    test('reports every child it waits on, never its own item', () => {
      const attention = runAttention(
        pausedOn(gate({ type: 'fan_out', nodeId: 'work', childRunIds: ['k0', 'k2'] }))
      );
      expect(attention).toEqual({
        kind: 'blocked_on_children',
        runId: 'run-1',
        nodeId: 'work',
        childRunIds: ['k0', 'k2'],
      });
    });

    test('a fan-out block with no children recorded is unreadable', () => {
      for (const childRunIds of [undefined, []]) {
        const attention = runAttention(
          pausedOn(gate({ type: 'fan_out', nodeId: 'work', childRunIds }))
        );
        expect(attention).toMatchObject({ kind: 'unreadable', reason: 'child_pointer_missing' });
      }
    });
  });

  describe('unreadable', () => {
    test.each([undefined, null, {}, { nodeId: 'x' }, 'garbage', 42])(
      'malformed gate metadata (%p) still needs a human',
      approval => {
        const attention = runAttention(pausedOn(approval));
        expect(attention).toMatchObject({
          kind: 'unreadable',
          runId: 'run-1',
          reason: 'malformed_gate',
        });
      }
    );

    test('an empty node id is no address at all', () => {
      expect(runAttention(pausedOn(gate({ nodeId: '' })))).toMatchObject({
        kind: 'unreadable',
        reason: 'malformed_gate',
      });
    });

    test('a gate type this build cannot resolve is unreadable', () => {
      const attention = runAttention(pausedOn(gate({ type: 'from_the_future' })));
      expect(attention).toMatchObject({
        kind: 'unreadable',
        reason: 'unrecognized_gate_type',
      });
      expect((attention as { detail: string }).detail).toContain('from_the_future');
    });

    test('a malformed gate is read before its type, so reject keeps tolerating it', () => {
      // assertRejectable tolerates unreadable gate metadata but must refuse an
      // unrecognized type. Ordering these the other way would flip that.
      expect(runAttention(pausedOn({ type: 'from_the_future' }))).toMatchObject({
        reason: 'malformed_gate',
      });
    });
  });

  test('a gate wins over a stale wait key, and neither is ever both', () => {
    // The write helpers strip each other's key (writeApprovalMetadata /
    // replaceWaitMetadata), so this pins the exclusivity rather than trusting it.
    const attention = runAttention({
      id: 'run-1',
      status: 'paused',
      metadata: {
        approval: gate(),
        wait: {
          owner: 'node',
          nodeId: 'hold',
          kind: 'time',
          waitingSince: '2026-08-28T10:00:00.000Z',
          resumeAt: '2026-08-28T11:00:00.000Z',
        },
      },
    });
    expect(attention?.kind).toBe('awaiting_response');
  });

  test('an attention wait wins over stale approval metadata', () => {
    const attention = runAttention({
      id: 'run-1',
      status: 'paused',
      metadata: {
        approval: gate(),
        wait: {
          owner: 'node',
          nodeId: 'recover',
          kind: 'attention',
          waitingSince: '2026-08-28T10:00:00.000Z',
          message: 'Recover the external dependency.',
        },
      },
    });
    expect(attention?.kind).toBe('attention');
  });

  test('an absent metadata bag on a paused run is unreadable, not silence', () => {
    const attention = runAttention({ id: 'run-1', status: 'paused' as WorkflowRunStatus });
    expect(attention).toMatchObject({ kind: 'unreadable', reason: 'malformed_gate' });
  });
});

describe('fan-out block predicates (#4044)', () => {
  const fanOutGate = (childRunIds: string[], unspawnedItems = 0) =>
    approvalContextSchema.parse({
      type: 'fan_out',
      nodeId: 'work',
      message: 'waiting',
      childRunIds,
      unspawnedItems,
    });
  const statuses =
    (map: Record<string, WorkflowRunStatus>) =>
    (id: string): WorkflowRunStatus | undefined =>
      map[id];

  test('isRunBlockedOnChild is true only for a listed child of a paused fan-out parent', () => {
    const parent = { status: 'paused' as const, metadata: { approval: fanOutGate(['a', 'b']) } };
    expect(isRunBlockedOnChild(parent, 'b')).toBe(true);
    expect(isRunBlockedOnChild(parent, 'c')).toBe(false);
    expect(isRunBlockedOnChild({ ...parent, status: 'running' }, 'b')).toBe(false);
  });

  test('released once every listed child is terminal', () => {
    const gate = fanOutGate(['a', 'b']);
    expect(isFanOutBlockReleased(gate, statuses({ a: 'completed', b: 'failed' }))).toBe(true);
    expect(isFanOutBlockReleased(gate, statuses({ a: 'completed', b: 'paused' }))).toBe(false);
  });

  test('a missing child row counts as finished', () => {
    expect(isFanOutBlockReleased(fanOutGate(['a', 'b']), statuses({ a: 'cancelled' }))).toBe(true);
  });

  test('with unspawned items, one finished child frees a slot', () => {
    const gate = fanOutGate(['a', 'b'], 3);
    expect(isFanOutBlockReleased(gate, statuses({ a: 'completed', b: 'paused' }))).toBe(true);
    expect(isFanOutBlockReleased(gate, statuses({ a: 'running', b: 'paused' }))).toBe(false);
  });

  test('never releases a gate of another type', () => {
    const gate = approvalContextSchema.parse({
      type: 'child_workflow',
      nodeId: 'sub',
      message: 'blocked',
      childRunId: 'a',
    });
    expect(isFanOutBlockReleased(gate, statuses({ a: 'completed' }))).toBe(false);
  });
});

describe('continuablePause', () => {
  const attentionWait = {
    owner: 'node' as const,
    nodeId: 'ask',
    kind: 'attention' as const,
    waitingSince: '2026-08-28T10:00:00.000Z',
    message: 'Which base?',
  };
  const gate = {
    nodeId: 'review',
    message: 'Review',
    type: 'approval' as const,
    pauseId: 'gate-1',
  };
  const paused = (metadata: Record<string, unknown>) => ({
    status: 'paused' as const,
    metadata,
  });

  test('covers gates and attention waits, answered or not', () => {
    expect(continuablePause(paused({ approval: gate }))).toEqual({
      nodeId: 'review',
      pauseId: 'gate-1',
      answered: false,
    });
    expect(continuablePause(paused({ approval: { ...gate, resolved: 'rejected' } }))).toEqual({
      nodeId: 'review',
      pauseId: 'gate-1',
      answered: true,
    });
    expect(continuablePause(paused({ wait: { ...attentionWait, pauseId: 'wait-1' } }))).toEqual({
      nodeId: 'ask',
      pauseId: 'wait-1',
      answered: false,
    });
    expect(
      continuablePause(
        paused({
          wait: {
            ...attentionWait,
            pauseId: 'wait-1',
            form: 'message',
            answer: { text: 'done' },
            answeredVia: 'api',
            answeredAt: '2026-08-28T10:05:00.000Z',
          },
        })
      )
    ).toEqual({ nodeId: 'ask', pauseId: 'wait-1', answered: true });
  });

  test('leaves out pauses the host cannot continue by itself', () => {
    // A wait from before pause identities has nothing to claim against; `resume` moves it.
    expect(continuablePause(paused({ wait: attentionWait }))).toBeUndefined();
    expect(
      continuablePause(
        paused({ isolation: 'container', wait: { ...attentionWait, pauseId: 'wait-1' } })
      )
    ).toBeUndefined();
    expect(
      continuablePause(paused({ approval: { ...gate, type: 'child_workflow', childRunId: 'c' } }))
    ).toBeUndefined();
    expect(
      continuablePause(
        paused({
          wait: {
            owner: 'node',
            nodeId: 'hold',
            kind: 'time',
            waitingSince: '2026-08-28T10:00:00.000Z',
            resumeAt: '2026-08-28T11:00:00.000Z',
          },
          approval: gate,
        })
      )
    ).toBeUndefined();
  });
});
