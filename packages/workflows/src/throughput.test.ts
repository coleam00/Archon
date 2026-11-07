import { expect, it } from 'bun:test';
import { finishNodeExecution, newNodeInvocation, startNodeExecution } from './node-execution';
import { serializeNodeStateRecord } from './node-record-serialization';
import type { NodeExecutionRecord } from './schemas/node-execution';
import { runThroughput, throughputAcrossRuns } from './throughput';

function execution(output = 100, durationMs = 1000, model = 'large', provider = 'claude') {
  return finishNodeExecution(
    startNodeExecution({
      runId: 'one',
      path: 'group.work',
      node: { id: 'work', kind: 'agent', source: { kind: 'inline', prompt: 'work' } },
      invocation: newNodeInvocation(),
      provider,
      model,
    }),
    { status: 'completed' },
    { tokens: { input: 10, output }, durationMs, resolvedModel: 'resolved' }
  );
}
const row = (record: NodeExecutionRecord) => serializeNodeStateRecord(record);

it('pairs output with attempt duration, excludes waits and restated spend, and weights model totals', () => {
  const a = execution();
  const b = execution(900, 9000, 'small');
  const missing = execution(1, 300000);
  missing.spend.tokens = { source: 'unavailable', reason: 'incomplete' };
  const wait = finishNodeExecution(
    startNodeExecution({
      runId: 'one',
      path: 'ci',
      node: { id: 'ci', kind: 'wait', wait: { duration_ms: 300000 } },
      invocation: newNodeInvocation(),
    }),
    { status: 'completed' },
    { durationMs: 300000 }
  );
  const one = runThroughput('one', [
    row(a),
    row(b),
    row(missing),
    row(wait),
    { workflow_run_id: 'one', step_name: 'approval', event_type: 'approval_required', data: {} },
    ...(['aggregate', 'instance', 'amendment'] as const).map(accounting =>
      row({ ...a, accounting })
    ),
    row(a),
    serializeNodeStateRecord({
      runId: a.runId,
      path: a.path,
      node: a.node,
      cache: { action: 'replayed', output: { text: 'cached' } },
    }),
  ]);
  expect(one.summary).toEqual({
    outputTokens: 1000,
    durationMs: 10000,
    measuredExecutions: 2,
    nodesWithoutTokenData: 1,
    nodesWithoutDuration: 0,
    effectiveTokensPerSecond: 100,
  });
  expect(one.nodes.map(node => node.effectiveTokensPerSecond)).toEqual([100, 100, null]);
  const second = execution(900, 3000);
  second.runId = 'two';
  const two = runThroughput('two', [row(second)]);
  const combined = throughputAcrossRuns([one, two, runThroughput('empty', [])]);
  expect(combined.runCount).toBe(3);
  expect(combined.runIds).toEqual(['one', 'two', 'empty']);
  expect(combined.models.find(model => model.requestedModel === 'large')).toMatchObject({
    outputTokens: 1000,
    durationMs: 4000,
    effectiveTokensPerSecond: 250,
    nodesWithoutTokenData: 1,
  });
});

it('preserves exact provider/requested-model tuples and nullable binding components', () => {
  const absent = execution();
  absent.binding = {};
  const providerOnly = execution();
  providerOnly.binding = { provider: 'claude' };
  const report = throughputAcrossRuns([
    runThroughput(
      'one',
      [
        execution(),
        execution(100, 1000, 'large', 'pi'),
        execution(100, 1000, 'Large'),
        absent,
        providerOnly,
      ].map(row)
    ),
  ]);
  expect(report.models.map(({ provider, requestedModel }) => [provider, requestedModel])).toEqual([
    ['claude', 'large'],
    ['pi', 'large'],
    ['claude', 'Large'],
    [null, null],
    ['claude', null],
  ]);
});

it('counts failed retries, loop positions and new invocations independently, but ignores unfinished attempts', () => {
  const first = execution();
  first.lifecycle = { status: 'failed', error: 'retry' };
  const retry = execution();
  retry.invocation = first.invocation;
  const loopA = execution();
  loopA.invocation.loopPath = [{ groupId: 'group', iteration: 0 }];
  const loopB = execution();
  loopB.invocation.loopPath = [{ groupId: 'group', iteration: 1 }];
  const started = execution();
  started.lifecycle = { status: 'started' };
  const report = runThroughput('one', [first, retry, loopA, loopB, execution(), started].map(row));
  expect(report.summary.measuredExecutions).toBe(5);
  expect(new Set(report.nodes.map(node => node.attempt?.id)).size).toBe(5);
  expect(report.nodes[0]?.invocation?.id).toBe(report.nodes[1]?.invocation?.id);
});

it('distinguishes provider zero, absent tokens, unusable duration and unsourced historical tokens', () => {
  const zero = runThroughput('one', [row(execution(0))]);
  expect(zero.summary.effectiveTokensPerSecond).toBe(0);
  const missing = execution();
  missing.spend.tokens = { source: 'unavailable', reason: 'not_reported' };
  delete missing.timing.durationMs;
  const noDuration = execution();
  delete noDuration.timing.durationMs;
  const report = runThroughput('one', [
    row(missing),
    row(noDuration),
    row(execution(10, 0)),
    row(execution(10, -5)),
    row(execution(-1)),
    row(execution(1.5)),
    {
      workflow_run_id: 'one',
      event_type: 'node_completed',
      step_name: 'old',
      data: { type: 'agent', tokens: { input: 1, output: 100 } },
    },
    { workflow_run_id: 'one', event_type: 'node_completed', step_name: 'unknown', data: {} },
  ]);
  expect(report.summary).toEqual({
    outputTokens: 0,
    durationMs: 0,
    measuredExecutions: 0,
    nodesWithoutTokenData: 4,
    nodesWithoutDuration: 3,
    effectiveTokensPerSecond: null,
  });
  expect(throughputAcrossRuns([report]).models[0]?.effectiveTokensPerSecond).toBeNull();
  expect(JSON.stringify(report)).not.toContain('NaN');
});

it('rejects invalid typed metadata instead of reinterpreting it as unsourced history', () => {
  for (const change of [
    { invocation: undefined },
    { timing: { startedAt: 'bad' } },
    { timing: { startedAt: '2026-01-01T00:00:00Z', durationMs: Infinity } },
    {
      spend: {
        ...execution().spend,
        tokens: { source: 'provider', value: { input: 0, output: NaN } },
      },
    },
  ]) {
    const event = row(execution());
    expect(() =>
      runThroughput('one', [{ ...event, data: { ...event.data, ...change } }])
    ).toThrow();
  }
});
