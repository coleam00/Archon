import { describe, expect, it } from 'bun:test';
import { nodeInvocationKey, readNodeRecordEvent } from './node-record-reader';

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
  it('reconstructs envelope-owned metadata without exposing malformed legacy usage', () => {
    const record = readNodeRecordEvent({
      workflow_run_id: 'run-1',
      step_name: 'group.build',
      event_type: 'node_completed',
      data: { ...metadata, node_output: 'done', tokens: 'bad' },
    });
    expect(record?.metadata).toMatchObject({
      runId: 'run-1',
      path: 'group.build',
      lifecycle: { status: 'completed' },
    });
    expect(record?.data.node_output).toBe('done');
    expect(record?.data.tokens).toBeUndefined();
    expect(record?.rawUsage.tokens).toBe('bad');
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
});
