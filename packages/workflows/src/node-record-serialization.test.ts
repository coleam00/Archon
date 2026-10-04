import { finishNodeExecution, startNodeExecution, newNodeInvocation } from './node-execution';
import { readNodeRecordEvent } from './node-record-reader';
import { describe, expect, it } from 'bun:test';
import {
  serializeNodeEmitter,
  serializeNodeOutput,
  serializeNodeStateRecord,
  serializeNodeTranscript,
} from './node-record-serialization';
import type { NodeExecutionRecord } from './schemas/node-execution';

const record = (): NodeExecutionRecord => ({
  runId: 'run-1',
  path: 'group.review',
  node: { id: 'review', kind: 'agent', source: { kind: 'command', name: 'review-pr' } },
  invocation: { id: 'inv-1', startedAt: '2026-09-22T10:00:00Z', loopPath: [] },
  attempt: { id: 'attempt-1', startedAt: '2026-09-22T10:00:00Z' },
  binding: {
    provider: 'claude',
    model: {
      requested: 'large',
      resolved: { source: 'provider', value: 'claude-opus-4-1' },
    },
    tier: 'large',
    sessionPreview: '12345678',
    sessionOrigin: 'resumed',
  },
  timing: { startedAt: '2026-09-22T10:00:00Z', durationMs: 42 },
  spend: {
    tokens: { source: 'provider', value: { input: 0, output: 0 } },
    costUsd: { source: 'provider', value: 0 },
    stopReason: { source: 'provider', value: 'end_turn' },
    numTurns: { source: 'provider', value: 1 },
  },
  accounting: 'amendment',
  lifecycle: { status: 'completed' },
  output: {
    text: 'full runtime output',
    structured: { verdict: 'pass' },
    declaredOutputPaths: [['verdict']],
    persisted: { text: 'preview', truncated: true, originalBytes: 100, spillPath: '/spill' },
  },
  diagnostics: {
    iteration: 2,
    loopIterations: 3,
    command: 'review-pr',
    outputType: 'review',
    status: 'ok',
    maxIterations: 4,
    sessionSourceNodeId: 'draft',
    sessionForkRequested: true,
    sessionForked: true,
    backgroundTasksIncomplete: ['task-1'],
    childRunId: 'child-1',
    blockedOnChildRunId: 'child-2',
    fanOut: true,
    identity: 'item-a',
    ordinal: 0,
    approvalDecision: 'approve',
    expr: '$draft.output',
  },
});

describe('node record serializers', () => {
  it('invalid provider numbers cannot erase a completed output on JSON round trip', () => {
    const completed = finishNodeExecution(
      record(),
      { status: 'completed' },
      {
        costUsd: Number.NaN,
        numTurns: Number.POSITIVE_INFINITY,
        tokens: { input: Number.NaN, output: 0 },
      }
    );
    const event = serializeNodeStateRecord(completed);
    const restored = readNodeRecordEvent({ ...event, data: JSON.stringify(event.data) });
    expect(restored?.data.node_output).toBe('preview');
    expect(restored?.metadata?.spend.costUsd).toEqual({ source: 'unavailable', reason: 'invalid' });
    expect(restored?.metadata?.spend.tokens).toEqual({ source: 'unavailable', reason: 'invalid' });
    expect(restored?.data).not.toHaveProperty('cost_usd');
  });

  it('projects one canonical record truthfully through persistence, transcript, emitter and runtime', () => {
    const source = record();
    const durable = serializeNodeStateRecord(source);
    const { output: _output, diagnostics: _diagnostics, ...metadata } = source;
    expect(readNodeRecordEvent(durable)?.metadata).toEqual(metadata);
    expect(serializeNodeTranscript(source)?.execution).toEqual(metadata);
    const live = serializeNodeEmitter(source);
    expect(live && 'execution' in live ? live.execution : undefined).toEqual(metadata);
    expect(serializeNodeOutput(source).execution).toEqual(metadata);

    expect(durable).toMatchObject({
      workflow_run_id: 'run-1',
      step_name: 'group.review',
      event_type: 'node_completed',
      data: {
        aggregate: true,
        tokens: { input: 0, output: 0 },
        cost_usd: 0,
        model: 'large',
        model_usage: { requested: 'large', resolved: 'claude-opus-4-1' },
        node_output: 'preview',
        node_output_truncated: true,
        structured_output: { verdict: 'pass' },
        iteration: 2,
        command: 'review-pr',
        status: 'ok',
        maxIterations: 4,
        session_source_node_id: 'draft',
        session_fork_requested: true,
        session_forked: true,
        background_tasks_incomplete: ['task-1'],
        expr: '$draft.output',
        output_type: 'review',
        child_run_id: 'child-1',
        blocked_on_child_run_id: 'child-2',
        fan_out: true,
        identity: 'item-a',
        ordinal: 0,
        approval_decision: 'approve',
      },
    });
    expect(JSON.stringify(durable)).not.toContain('full runtime output');
    expect(JSON.stringify(durable)).not.toContain('sessionId');
    // The fixture amends an already-recorded attempt, so the transcript and the emitter
    // present no spend of its own (#3508). The durable row keeps every number beside the
    // `aggregate` marker, and the runtime result keeps the scope total the run total reads.
    expect(serializeNodeTranscript(source)).toMatchObject({
      type: 'node_complete',
      duration_ms: 42,
    });
    expect(serializeNodeTranscript(source)).not.toHaveProperty('cost_usd');
    expect(serializeNodeTranscript(source)).not.toHaveProperty('tokens');
    expect(serializeNodeEmitter(source)).toMatchObject({
      type: 'node_completed',
      duration: 42,
      stopReason: 'end_turn',
      numTurns: 1,
    });
    expect(serializeNodeEmitter(source)).not.toHaveProperty('costUsd');
    expect(serializeNodeOutput(source)).toMatchObject({
      state: 'completed',
      output: 'full runtime output',
      structuredOutput: { verdict: 'pass' },
      tokens: { input: 0, output: 0 },
      costUsd: 0,
      loopIterations: 3,
    });
  });

  it('reports spend as a node its own only for accounting: node (#3508)', () => {
    // The rule every sink shares, stated where a future `accounting` value is decided:
    // a restatement reaches the durable row (marked `aggregate`) and the runtime result
    // (which the run total reads), and nothing else.
    for (const accounting of ['aggregate', 'instance', 'amendment'] as const) {
      const source = { ...record(), accounting };
      const label = `accounting: ${accounting}`;
      const transcript = serializeNodeTranscript(source);
      const emitter = serializeNodeEmitter(source);
      expect({ [`${label} transcript`]: transcript && 'cost_usd' in transcript }).toEqual({
        [`${label} transcript`]: false,
      });
      expect({ [`${label} emitter`]: emitter && 'costUsd' in emitter }).toEqual({
        [`${label} emitter`]: false,
      });
      expect(serializeNodeStateRecord(source).data).toMatchObject({
        aggregate: true,
        cost_usd: 0,
        tokens: { input: 0, output: 0 },
      });
      expect(serializeNodeOutput(source)).toMatchObject({
        costUsd: 0,
        tokens: { input: 0, output: 0 },
      });
    }

    const source = { ...record(), accounting: 'node' as const };
    expect(serializeNodeTranscript(source)).toMatchObject({
      cost_usd: 0,
      tokens: { input: 0, output: 0 },
    });
    expect(serializeNodeEmitter(source)).toMatchObject({ costUsd: 0 });
    expect(serializeNodeStateRecord(source).data).not.toHaveProperty('aggregate');
  });

  it('names a node by its bare command name on progress surfaces and keeps the qualified reference durable', () => {
    const packaged = '__archon_pack__installed:Wirasm.archon-video:make::hooks';
    const nameOf = (node: NodeExecutionRecord['node']) => {
      const event = serializeNodeEmitter({ ...record(), node });
      return event && 'nodeName' in event ? event.nodeName : undefined;
    };

    expect(
      nameOf({ id: 'hooks-node', kind: 'agent', source: { kind: 'command', name: packaged } })
    ).toBe('hooks');
    expect(
      nameOf({ id: 'review', kind: 'agent', source: { kind: 'command', name: 'review-pr' } })
    ).toBe('review-pr');
    expect(nameOf({ id: 'build', kind: 'exec', runtime: 'sh' })).toBe('build');

    const source: NodeExecutionRecord = {
      ...record(),
      node: { id: 'hooks-node', kind: 'agent', source: { kind: 'command', name: packaged } },
      diagnostics: { command: packaged },
    };
    expect(serializeNodeStateRecord(source)).toMatchObject({
      step_name: 'group.review',
      data: { command: packaged },
    });
    expect(serializeNodeTranscript(source)).toMatchObject({
      step: 'hooks-node',
      content: packaged,
    });
  });

  it('writes the full session id to the durable row only, for completed and failed attempts', () => {
    const sessionId = '0123456789abcdef-full-session-id';
    const finished = [
      finishNodeExecution(record(), { status: 'completed' }, { sessionId }),
      finishNodeExecution(
        record(),
        { status: 'failed', error: 'boom', failureKind: 'transient' },
        { sessionId }
      ),
    ];
    for (const source of finished) {
      const durable = serializeNodeStateRecord(source);
      expect(durable.data.session_id).toBe(sessionId);
      // The reader exposes it from the stored JSON, as `workflow get` reads it.
      const restored = readNodeRecordEvent({ ...durable, data: JSON.stringify(durable.data) });
      expect(restored?.data.session_id).toBe(sessionId);
      expect(source.binding.sessionPreview).toBe('01234567');
      // Whole-output assertions, so a field added later cannot carry the id either.
      expect(JSON.stringify(serializeNodeTranscript(source))).not.toContain(sessionId);
      expect(JSON.stringify(serializeNodeEmitter(source))).not.toContain(sessionId);
      expect(JSON.stringify(restored?.metadata)).not.toContain(sessionId);
    }
    // The engine still threads the id to the next node through the node's output.
    expect(serializeNodeOutput(finished[0])).toMatchObject({ state: 'completed', sessionId });
  });

  it('only exposes a short provider session preview', () => {
    const started = startNodeExecution({
      runId: 'run',
      path: 'work',
      node: { id: 'work', kind: 'agent', source: { kind: 'inline', prompt: 'private prompt' } },
      invocation: newNodeInvocation(),
      provider: 'claude',
      sessionId: '12345678-private-session',
    });
    expect(started.binding.sessionPreview).toBe('12345678');
    expect(JSON.stringify(started)).not.toContain('private');
  });

  it('keeps unavailable measurements absent instead of turning them into zero', () => {
    const source = record();
    source.spend.tokens = { source: 'unavailable', reason: 'not_reported' };
    source.spend.costUsd = { source: 'unavailable', reason: 'unsupported' };
    source.timing = { startedAt: source.timing.startedAt };
    const durable = serializeNodeStateRecord(source);
    expect(durable.data).not.toHaveProperty('tokens');
    expect(durable.data).not.toHaveProperty('cost_usd');
    expect(serializeNodeTranscript(source)).not.toHaveProperty('duration_ms');
    expect(serializeNodeEmitter(source)).not.toHaveProperty('duration');
    expect(serializeNodeOutput(source)).not.toHaveProperty('tokens');
    expect(serializeNodeOutput(source)).not.toHaveProperty('costUsd');
  });
});

it('persists the path contract beside its legacy root fields and reads either shape', () => {
  const source = record();
  const paths = [['proposal'], ['proposal', 'action']];
  source.output = { text: '{"proposal":{"action":"add"}}', declaredOutputPaths: paths };
  expect(serializeNodeOutput(source)).toMatchObject({ declaredOutputPaths: paths });
  for (const event of [
    serializeNodeStateRecord(source),
    serializeNodeStateRecord({
      runId: source.runId,
      path: source.path,
      node: source.node,
      cache: { action: 'replayed', output: source.output },
    }),
  ]) {
    // Older binaries read only `declared_fields`, so every write still carries it.
    expect(event.data).toMatchObject({
      declared_fields: ['proposal'],
      declared_output_paths: paths,
    });
    expect(
      readNodeRecordEvent({ ...event, data: JSON.stringify(event.data) })?.data
        .declared_output_paths
    ).toEqual(paths);
    // A row an older binary wrote has only the root fields: they read as depth-1 paths.
    expect(
      readNodeRecordEvent({ ...event, data: { node_output: '{}', declared_fields: ['a', 'b'] } })
        ?.data.declared_output_paths
    ).toEqual([['a'], ['b']]);
  }
});
