// @archon-test-isolated
import { describe, expect, it } from 'bun:test';
import {
  nodeInvocationKey,
  parseNodeInvocationKey,
  readNodeRecordEvent,
  readDeferredNodeUsageEvent,
} from './node-record-reader';
import { NODE_STATE_EVENT_TYPES } from './store';
import { nodeExecutionMetadataPayloadSchema } from './schemas/node-execution';

const metadata = {
  node: { id: 'build', kind: 'exec' as const, runtime: 'sh' as const },
  invocation: { id: 'inv-1', startedAt: '2026-09-22T10:00:00Z', loopPath: [] },
  attempt: { id: 'attempt-1', startedAt: '2026-09-22T10:00:00Z' },
  binding: {},
  timing: { startedAt: '2026-09-22T10:00:00Z' },
  spend: {
    tokens: { source: 'unavailable' as const, reason: 'not_applicable' as const },
    costUsd: { source: 'unavailable' as const, reason: 'not_applicable' as const },
    stopReason: { source: 'unavailable' as const, reason: 'not_applicable' as const },
    numTurns: { source: 'unavailable' as const, reason: 'not_applicable' as const },
  },
  accounting: 'node' as const,
};

describe('readNodeRecordEvent', () => {
  it('rejects each missing required payload field and each malformed present field', () => {
    const envelope = {
      workflow_run_id: 'run-1',
      step_name: 'build',
      event_type: 'node_completed',
    };
    for (const [key, schema] of Object.entries(nodeExecutionMetadataPayloadSchema.shape)) {
      if (!schema.isOptional()) {
        const partial: Record<string, unknown> = { ...metadata };
        delete partial[key];
        expect(() => readNodeRecordEvent({ ...envelope, data: partial })).toThrow(
          'metadata is incomplete'
        );
      }
      expect(() =>
        readNodeRecordEvent({ ...envelope, data: { ...metadata, [key]: null } })
      ).toThrow();
    }
  });

  it('reconstructs envelope-owned metadata without exposing malformed legacy usage', () => {
    const record = readNodeRecordEvent({
      workflow_run_id: 'run-1',
      step_name: 'group.build',
      event_type: 'node_completed',
      data: {
        ...metadata,
        runId: 'spoofed-run',
        path: 'spoofed-path',
        lifecycle: { status: 'failed', error: 'spoofed failure' },
        node_output: 'done',
        tokens: 'bad',
      },
    });
    expect(record?.metadata).toMatchObject({
      runId: 'run-1',
      path: 'group.build',
      lifecycle: { status: 'completed' },
    });
    expect(record?.data.node_output).toBe('done');
    expect(record?.metadata).not.toHaveProperty('node_output');
    expect(record?.metadata).not.toHaveProperty('tokens');
    expect(record?.data.tokens).toBeUndefined();
    expect(record?.rawUsage.tokens).toBe('bad');
  });

  it('reads a failed row whose provider failure class is newer than this binary', () => {
    // A newer binary may persist a failure class this one does not know. The row still
    // reads with its failure kind, and only the unknown provider failure is dropped.
    const record = readNodeRecordEvent({
      workflow_run_id: 'run-1',
      step_name: 'build',
      event_type: 'node_failed',
      data: {
        ...metadata,
        error: 'provider could not start',
        failure_kind: 'fatal',
        provider_failure: { class: 'a_class_from_a_newer_binary', evidence: 'proxy_invalid' },
      },
    });
    expect(record?.metadata?.lifecycle).toEqual({
      status: 'failed',
      error: 'provider could not start',
      failureKind: 'fatal',
    });
  });

  it('does not fabricate metadata for historical or cache rows', () => {
    expect(
      readNodeRecordEvent({
        workflow_run_id: 'run-1',
        step_name: 'build',
        event_type: 'node_completed',
        data: { node_output: 'old' },
      })?.metadata
    ).toBeUndefined();
    expect(
      readNodeRecordEvent({
        workflow_run_id: 'run-1',
        step_name: 'build',
        event_type: 'node_skipped_prior_success',
        data: { node: metadata.node, node_output: 'cached' },
      })?.metadata
    ).toBeUndefined();
  });

  it('rejects partial typed metadata and keys invocations by loop lineage', () => {
    expect(() =>
      readNodeRecordEvent({
        workflow_run_id: 'run-1',
        step_name: 'build',
        event_type: 'node_started',
        data: { node: metadata.node },
      })
    ).toThrow('metadata is incomplete');
    expect(nodeInvocationKey('build', [{ groupId: 'loop', iteration: 2 }])).toBe(
      '["build",[{"groupId":"loop","iteration":2}]]'
    );
  });

  it('parses an invocation key back to its path and loop lineage', () => {
    const loopPath = [{ groupId: 'outer', iteration: 2 }];
    expect(parseNodeInvocationKey(nodeInvocationKey('outer.grp', loopPath))).toEqual({
      path: 'outer.grp',
      loopPath,
    });
    expect(() => parseNodeInvocationKey('{"path":"outer.grp"}')).toThrow();
  });
});

it('retains nested contracts and rejects malformed present authorization evidence', () => {
  const envelope = { workflow_run_id: 'r', step_name: 'p', event_type: 'node_completed' };
  expect(
    readNodeRecordEvent({ ...envelope, data: { declared_output_paths: [['a'], ['a', 'b']] } })?.data
      .declared_output_paths
  ).toEqual([['a'], ['a', 'b']]);
  expect(
    readNodeRecordEvent({ ...envelope, data: { declared_output_paths: [] } })?.data
      .declared_output_paths
  ).toEqual([]);
  for (const bad of [null, undefined, ['a'], [[]], [['a', 1]]]) {
    expect(() =>
      readNodeRecordEvent({ ...envelope, data: { declared_output_paths: bad } })
    ).toThrow();
  }
  expect(readNodeRecordEvent({ ...envelope, data: {} })?.data).not.toHaveProperty(
    'declared_output_paths'
  );
});

it('reads deferred accounting separately and retains malformed usage for diagnostics', () => {
  const envelope = {
    workflow_run_id: 'run-1',
    step_name: 'group.loop',
    event_type: 'node_deferred_usage',
    data: JSON.stringify({
      invocation: metadata.invocation,
      attempt: metadata.attempt,
      accounting: 'node',
      cost_usd: 'bad',
      tokens: { input: 1, output: 2, cacheRead: 3 },
      node_output: 'ignored',
    }),
  };
  const usage = readDeferredNodeUsageEvent(envelope);
  expect(usage?.path).toBe('group.loop');
  expect(usage?.data.tokens).toEqual({ input: 1, output: 2, cacheRead: 3 });
  expect(usage?.data.cost_usd).toBeUndefined();
  expect(usage?.rawUsage.costUsd).toBe('bad');
  expect(Object.keys(usage!.data).sort()).toEqual(['accounting', 'tokens']);
  expect(readNodeRecordEvent(envelope)).toBeUndefined();
  expect(readDeferredNodeUsageEvent({ ...envelope, event_type: 'node_started' })).toBeUndefined();
});

it.each([...NODE_STATE_EVENT_TYPES, 'node_deferred_usage'])(
  'rejects invalid present child attribution in %s',
  eventType => {
    const envelope = {
      workflow_run_id: 'parent',
      step_name: 'child',
      event_type: eventType,
      data: { child_usage: [{ childRunId: 'child', costUsd: 'bad' }] },
    };
    const read =
      eventType === 'node_deferred_usage' ? readDeferredNodeUsageEvent : readNodeRecordEvent;
    expect(() => read(envelope)).toThrow();
  }
);
