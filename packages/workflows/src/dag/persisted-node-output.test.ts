import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { foldDagResumeSnapshot, type DagResumeEvent } from '../dag-resume-snapshot';
import { formatPersistedNodeOutput } from './node-output';

describe('persisted output event association', () => {
  let artifactsDir: string;
  const outputA = 'a'.repeat(40_000);
  const outputB = 'b'.repeat(40_000);

  beforeEach(async () => {
    artifactsDir = await mkdtemp(join(tmpdir(), 'persisted-node-output-'));
  });

  afterEach(async () => {
    await removeTempTree(artifactsDir);
  });

  function completion(output: ReturnType<typeof formatPersistedNodeOutput>): DagResumeEvent {
    return {
      step_name: 'group.emit',
      event_type: 'node_completed',
      data: {
        node_output: output.nodeOutput,
        node_output_truncated: output.truncated,
        node_output_original_bytes: output.originalBytes,
        node_output_spill_path: output.spillPath,
      },
    };
  }

  it('restores the durable output after an equal-length spill without a completion event', async () => {
    const first = formatPersistedNodeOutput(outputA, artifactsDir, 'group.emit');
    const durableEvents = [completion(first)];
    formatPersistedNodeOutput(outputB, artifactsDir, 'group.emit');

    const snapshot = await foldDagResumeSnapshot(durableEvents, 'run');
    expect(snapshot.completedNodeOutputs.get('group.emit')).toEqual({ output: outputA });
  });

  it('selects the full output by durable event order rather than spill write order', async () => {
    const first = completion(formatPersistedNodeOutput(outputA, artifactsDir, 'group.emit'));
    const second = completion(formatPersistedNodeOutput(outputB, artifactsDir, 'group.emit'));

    const forward = await foldDagResumeSnapshot([first, second], 'run');
    expect(forward.completedNodeOutputs.get('group.emit')).toEqual({ output: outputB });
    const reversed = await foldDagResumeSnapshot([second, first], 'run');
    expect(reversed.completedNodeOutputs.get('group.emit')).toEqual({ output: outputA });
  });
});
