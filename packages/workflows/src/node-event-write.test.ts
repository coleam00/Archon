// @archon-test-isolated
import { removeTempTree } from '@archon/paths/test-utils';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowEmitterEvent } from './event-emitter';
import {
  deriveEmitterEvent,
  deriveTranscriptEvent,
  NodeEventWriteError,
  persistNodeEvent,
  recordDerivedNodeState,
  recordNodeState,
} from './node-event-write';
import { serializeDeferredNodeUsage } from './node-record-serialization';
import type { NodeExecutionRecord } from './schemas/node-execution';
import type { NodeStateEventInput } from './store';

const completedRecord = (): NodeExecutionRecord => ({
  runId: 'run-1',
  path: 'group.build',
  node: { id: 'build', kind: 'exec', runtime: 'sh' },
  invocation: { id: 'inv-1', startedAt: '2026-09-22T10:00:00Z', loopPath: [] },
  attempt: { id: 'attempt-1', startedAt: '2026-09-22T10:00:00Z' },
  binding: {},
  timing: { startedAt: '2026-09-22T10:00:00Z', durationMs: 12 },
  spend: {
    tokens: { source: 'provider', value: { input: 0, output: 0 } },
    costUsd: { source: 'provider', value: 0 },
    stopReason: { source: 'unavailable', reason: 'not_applicable' },
    numTurns: { source: 'unavailable', reason: 'not_applicable' },
  },
  accounting: 'node',
  lifecycle: { status: 'completed' },
  output: { text: 'full output', persisted: { text: 'preview', truncated: true } },
});

describe('node-event-write', () => {
  it('propagates deferred accounting persistence rejection', async () => {
    const cause = new Error('database unavailable');
    const store = {
      persistWorkflowEvent: mock(async () => {
        throw cause;
      }),
    };
    await expect(
      persistNodeEvent(store, serializeDeferredNodeUsage(completedRecord()))
    ).rejects.toMatchObject({
      name: 'NodeEventWriteError',
      cause,
      message: expect.stringContaining('node_deferred_usage for group.build'),
    });
    expect(store.persistWorkflowEvent).toHaveBeenCalledTimes(1);
  });

  let logDir: string;
  beforeEach(async () => {
    logDir = join(tmpdir(), `node-event-write-${crypto.randomUUID()}`);
    await mkdir(logDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(logDir);
  });

  it('writes one canonical record to durable, transcript, emitter and runtime sinks', async () => {
    const durable: NodeStateEventInput[] = [];
    const emitted: WorkflowEmitterEvent[] = [];
    const store = {
      persistWorkflowEvent: mock(async (event: NodeStateEventInput) => {
        durable.push(event);
      }),
    };
    const emitter = { emit: mock((event: WorkflowEmitterEvent) => emitted.push(event)) };
    const result = await recordNodeState({ store, logDir, emitter }, completedRecord());

    expect(durable[0]).toMatchObject({
      workflow_run_id: 'run-1',
      step_name: 'group.build',
      event_type: 'node_completed',
      data: { node_output: 'preview', node_output_truncated: true, cost_usd: 0 },
    });
    const transcript = JSON.parse(await readFile(join(logDir, 'run-1.jsonl'), 'utf8'));
    expect(transcript).toMatchObject({ type: 'node_complete', step: 'build', duration_ms: 12 });
    expect(emitted[0]).toMatchObject({ type: 'node_completed', duration: 12, costUsd: 0 });
    expect(result).toMatchObject({ state: 'completed', output: 'full output', costUsd: 0 });
  });

  it('returns and persists the same nested contract on cache replay', async () => {
    const durable: NodeStateEventInput[] = [];
    const store = {
      persistWorkflowEvent: async (event: NodeStateEventInput) => {
        durable.push(event);
      },
    };
    const source = completedRecord();
    const paths = [['proposal'], ['proposal', 'action']];
    const result = await recordNodeState(
      { store, logDir },
      {
        runId: source.runId,
        path: source.path,
        node: source.node,
        cache: {
          action: 'replayed',
          output: { text: 'json', declaredOutputPaths: paths },
        },
      }
    );
    expect(result).toMatchObject({ state: 'completed', declaredOutputPaths: paths });
    expect(durable[0]?.data?.declared_output_paths).toEqual(paths);
  });

  it('stops after a durable write rejection and preserves the original failure', async () => {
    const cause = new Error('database unavailable');
    const store = { persistWorkflowEvent: mock(async () => Promise.reject(cause)) };
    const emitter = { emit: mock(() => {}) };
    const record = {
      ...completedRecord(),
      lifecycle: { status: 'failed' as const, error: 'child failed' },
    };
    await expect(recordNodeState({ store, logDir, emitter }, record)).rejects.toMatchObject({
      name: NodeEventWriteError.name,
      cause,
      message: expect.stringContaining('child failed'),
    });
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('names a packaged command node by its bare command name on the derived emitter path', () => {
    const packaged = '__archon_pack__installed:Wirasm.archon-video:make::pick';
    const node = {
      id: 'pick-node',
      kind: 'agent' as const,
      source: { kind: 'command' as const, name: packaged },
    };
    const event: NodeStateEventInput = {
      workflow_run_id: 'run-1',
      step_name: 'pick-node',
      event_type: 'node_completed',
      data: { node_output: 'approved' },
    };
    expect(deriveEmitterEvent(node, event)).toMatchObject({
      nodeId: 'pick-node',
      nodeName: 'pick',
    });
    expect(deriveTranscriptEvent(node, event)).toMatchObject({ content: packaged });
  });

  it('derives an old transactional wait completion without inventing metadata or duration', async () => {
    const waitNode = { id: 'wait-for-ci', kind: 'wait' as const, wait: { duration_ms: 1 } };
    const event: NodeStateEventInput = {
      workflow_run_id: 'old-run',
      step_name: 'wait-for-ci',
      event_type: 'node_completed',
      data: { node_output: '{"status":"satisfied"}', type: 'wait' },
    };
    expect(deriveTranscriptEvent(waitNode, event)).toEqual({
      type: 'node_complete',
      step: 'wait-for-ci',
      content: '<wait>',
    });
    expect(deriveEmitterEvent(waitNode, event)).toEqual({
      type: 'node_completed',
      runId: 'old-run',
      nodeId: 'wait-for-ci',
      nodeName: 'wait-for-ci',
    });

    const emitted: WorkflowEmitterEvent[] = [];
    await recordDerivedNodeState(
      { logDir, emitter: { emit: event => emitted.push(event) } },
      waitNode,
      event
    );
    expect(emitted[0]).not.toHaveProperty('execution');
    expect(emitted[0]).not.toHaveProperty('duration');
  });
});

it.each(
  (['child', 'fan-out', 'loop', 'agent'] as const).flatMap(kind =>
    [false, true].map(tokensUnknown => [kind, tokensUnknown] as const)
  )
)(
  'settles cumulative %s recovery usage once and preserves a separate paid execution',
  async (kind, tokensUnknown) => {
    const { foldDagResumeSnapshot } = await import('./dag-resume-snapshot');
    const { persistUnsettledNodeUsage } = await import('./node-event-write');
    const { serializeNodeStateRecord } = await import('./node-record-serialization');
    const events: import('./dag-resume-snapshot').DagResumeEvent[] = [];
    const store = {
      persistWorkflowEvent: async (event: import('./store').DurableNodeEventInput) => {
        events.push(event);
      },
    };
    const record = completedRecord();
    record.node =
      kind === 'loop'
        ? { id: 'build', kind: 'loop' }
        : kind === 'agent'
          ? { id: 'build', kind: 'agent', source: { kind: 'inline' } }
          : { id: 'build', kind: 'workflow', ...(kind === 'fan-out' ? { fanOut: true } : {}) };
    record.lifecycle = { status: 'started' };
    events.length = 0;
    const usage = {
      costUsd: 0.37,
      ...(tokensUnknown ? { tokensUnknown: true } : { tokens: { input: 100, output: 50 } }),
    };
    await persistUnsettledNodeUsage(store, record, usage);
    await persistUnsettledNodeUsage(store, record, usage);
    const pending = await foldDagResumeSnapshot(events, record.runId);
    expect(pending.costUsd).toBeCloseTo(0.37);
    expect(pending.tokensUnknown).toBe(tokensUnknown);
    const settled = structuredClone(record);
    settled.lifecycle = { status: 'completed' };
    settled.spend.costUsd = { source: 'provider', value: 0.47 };
    settled.spend.tokens = tokensUnknown
      ? { source: 'unavailable', reason: 'incomplete' }
      : { source: 'provider', value: { input: 110, output: 60 } };
    if (kind !== 'agent') settled.attempt.id = 'resumed-attempt';
    if (kind === 'loop') {
      const suspended = structuredClone(record);
      suspended.lifecycle = { status: 'suspended', point: 'interactive_loop' };
      suspended.spend.costUsd = { source: 'provider', value: 0.37 };
      suspended.spend.tokens = tokensUnknown
        ? { source: 'unavailable', reason: 'incomplete' }
        : { source: 'provider', value: { input: 100, output: 50 } };
      events.push(serializeNodeStateRecord(suspended));
      settled.attempt.continuedFrom = record.attempt.id;
    }
    events.push(serializeNodeStateRecord(settled));
    const snapshot = await foldDagResumeSnapshot(events, record.runId);
    expect(snapshot.costUsd).toBeCloseTo(0.47);
    expect(snapshot.tokensUnknown).toBe(tokensUnknown);
    expect(snapshot.tokens).toEqual(tokensUnknown ? undefined : { input: 110, output: 60 });
    const repeated = structuredClone(settled);
    repeated.invocation.id = kind === 'loop' ? record.invocation.id : 'inv-2';
    repeated.attempt = { id: 'attempt-2', startedAt: record.attempt.startedAt };
    repeated.timing.startedAt = '2026-09-22T11:00:00Z';
    events.push(serializeNodeStateRecord(repeated));
    expect((await foldDagResumeSnapshot(events, record.runId)).costUsd).toBeCloseTo(0.94);
  }
);

it('keeps paid loop attempts that replay the same gate separate from its continuation', async () => {
  const { foldDagResumeSnapshot } = await import('./dag-resume-snapshot');
  const { persistUnsettledNodeUsage } = await import('./node-event-write');
  const { serializeNodeStateRecord } = await import('./node-record-serialization');
  const events: import('./dag-resume-snapshot').DagResumeEvent[] = [];
  const store = {
    persistWorkflowEvent: async (event: import('./store').DurableNodeEventInput) => {
      events.push(event);
    },
  };
  const gate = completedRecord();
  gate.node = { id: 'build', kind: 'loop' };
  gate.lifecycle = { status: 'suspended', point: 'interactive_loop' };
  gate.spend.costUsd = { source: 'provider', value: 0.37 };
  gate.spend.tokens = {
    source: 'provider',
    value: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10 },
  };
  events.push(serializeNodeStateRecord(gate));
  const legacyCompletion = structuredClone(gate);
  legacyCompletion.attempt.id = 'legacy-completion';
  legacyCompletion.lifecycle = { status: 'completed' };
  legacyCompletion.spend.costUsd = { source: 'provider', value: 0.47 };
  expect(
    (
      await foldDagResumeSnapshot(
        [...events, serializeNodeStateRecord(legacyCompletion)],
        gate.runId
      )
    ).costUsd
  ).toBeCloseTo(0.47);
  const aborted = structuredClone(gate);
  aborted.attempt = { ...gate.attempt, id: 'aborted', continuedFrom: gate.attempt.id };
  await persistUnsettledNodeUsage(store, aborted, {
    costUsd: 0.47,
    tokens: { input: 110, output: 55, cacheRead: 22, cacheWrite: 11 },
  });
  expect((await foldDagResumeSnapshot(events, gate.runId)).costUsd).toBeCloseTo(0.47);
  const replayed = structuredClone(aborted);
  replayed.attempt.id = 'replayed';
  replayed.lifecycle = { status: 'completed' };
  replayed.spend.costUsd = { source: 'provider', value: 0.57 };
  replayed.spend.tokens = {
    source: 'provider',
    value: { input: 120, output: 60, cacheRead: 24, cacheWrite: 12 },
  };
  events.push(serializeNodeStateRecord(replayed));
  const result = await foldDagResumeSnapshot(events, gate.runId);
  expect(result.costUsd).toBeCloseTo(0.67);
  expect(result.tokens).toEqual({ input: 130, output: 65, cacheRead: 26, cacheWrite: 13 });
});
