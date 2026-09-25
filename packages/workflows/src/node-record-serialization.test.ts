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
    declaredFields: ['verdict'],
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
        fan_out: true,
        identity: 'item-a',
        ordinal: 0,
        approval_decision: 'approve',
      },
    });
    expect(JSON.stringify(durable)).not.toContain('full runtime output');
    expect(JSON.stringify(durable)).not.toContain('sessionId');
    expect(serializeNodeTranscript(source)).toMatchObject({
      type: 'node_complete',
      duration_ms: 42,
      cost_usd: 0,
      tokens: { input: 0, output: 0 },
    });
    expect(serializeNodeEmitter(source)).toMatchObject({
      type: 'node_completed',
      duration: 42,
      costUsd: 0,
      stopReason: 'end_turn',
      numTurns: 1,
    });
    expect(serializeNodeOutput(source)).toMatchObject({
      state: 'completed',
      output: 'full runtime output',
      structuredOutput: { verdict: 'pass' },
      tokens: { input: 0, output: 0 },
      costUsd: 0,
      loopIterations: 3,
    });
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
