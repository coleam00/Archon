import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { writeNodeArtifact } from './artifacts-index';
import { readRunOutputs } from './run-outputs';

const trackTempRoot = trackTempRoots();
const RUN = 'run-1';

async function makeDir(): Promise<string> {
  return trackTempRoot(await mkdtemp(join(tmpdir(), 'run-outputs-')));
}

function at(second: number): string {
  return `2026-06-03T00:00:0${String(second)}.000Z`;
}

describe('readRunOutputs', () => {
  test('returns every typed output in production order with its producer and value', async () => {
    const dir = await makeDir();
    const round = (iteration: number) => [{ groupId: 'rounds', iteration }];
    await writeNodeArtifact(
      dir,
      {
        nodeId: 'review',
        outputType: 'verdict',
        runId: RUN,
        producedAt: at(3),
        loopGroupPath: round(2),
      },
      '{"ready":true}'
    );
    await writeNodeArtifact(
      dir,
      { nodeId: 'plan', outputType: 'plan', runId: RUN, producedAt: at(1) },
      'a plan in prose'
    );
    await writeNodeArtifact(
      dir,
      {
        nodeId: 'review',
        outputType: 'verdict',
        runId: RUN,
        producedAt: at(2),
        loopGroupPath: round(1),
      },
      '{"ready":false}'
    );

    expect(await readRunOutputs(dir, RUN)).toEqual({
      artifacts: 'present',
      outputs: [
        { nodeId: 'plan', outputType: 'plan', producedAt: at(1), value: 'a plan in prose' },
        {
          nodeId: 'review',
          outputType: 'verdict',
          loopGroupPath: round(1),
          producedAt: at(2),
          value: { ready: false },
        },
        {
          nodeId: 'review',
          outputType: 'verdict',
          loopGroupPath: round(2),
          producedAt: at(3),
          value: { ready: true },
        },
      ],
      unreadable: [],
    });
  });

  test('narrows by exact type and by node id', async () => {
    const dir = await makeDir();
    for (const [nodeId, outputType, second] of [
      ['a', 'verdict', 1],
      ['b', 'verdict', 2],
      ['b2', 'Verdict', 3],
    ] as const) {
      await writeNodeArtifact(dir, { nodeId, outputType, runId: RUN, producedAt: at(second) }, '1');
    }
    const nodes = async (filter: Parameters<typeof readRunOutputs>[2]) => {
      const read = await readRunOutputs(dir, RUN, filter);
      return read.artifacts === 'present' ? read.outputs.map(output => output.nodeId) : read;
    };

    expect(await nodes({ type: 'verdict' })).toEqual(['a', 'b']);
    expect(await nodes({ nodeId: 'b' })).toEqual(['b']);
    expect(await nodes({ type: 'verdict', nodeId: 'b2' })).toEqual([]);
  });

  test('a run whose artifact directory is gone answers missing, and an empty one answers no outputs', async () => {
    const dir = await makeDir();

    expect(await readRunOutputs(join(dir, 'cleaned-up'), RUN)).toEqual({ artifacts: 'missing' });
    expect(await readRunOutputs(dir, RUN)).toEqual({
      artifacts: 'present',
      outputs: [],
      unreadable: [],
    });
  });

  test('reports an output it cannot read per entry, and keeps the readable ones', async () => {
    const dir = await makeDir();
    await writeNodeArtifact(
      dir,
      { nodeId: 'kept', outputType: 'verdict', runId: RUN, producedAt: at(1) },
      '{"ready":true}'
    );
    const lost = await writeNodeArtifact(
      dir,
      { nodeId: 'lost', outputType: 'verdict', runId: RUN, producedAt: at(2) },
      '{"ready":false}'
    );
    await rm(join(dir, lost.path));
    await writeNodeArtifact(
      dir,
      { nodeId: 'other-type', outputType: 'plan', runId: RUN, producedAt: at(3) },
      'x'
    ).then(written => rm(join(dir, written.path)));
    await writeNodeArtifact(
      dir,
      { nodeId: 'foreign', outputType: 'verdict', runId: 'another-run', producedAt: at(4) },
      '{}'
    );
    await mkdir(join(dir, 'nodes'), { recursive: true });
    await writeFile(join(dir, 'nodes', 'corrupt.meta.json'), '{not json');

    const read = await readRunOutputs(dir, RUN, { type: 'verdict' });

    expect(read).toEqual({
      artifacts: 'present',
      outputs: [
        { nodeId: 'kept', outputType: 'verdict', producedAt: at(1), value: { ready: true } },
      ],
      // A sidecar with no trustworthy type is reported for every selection; the other
      // type's missing content is not this selection's fault to report.
      unreadable: [
        { path: 'nodes/corrupt.meta.json', kind: 'invalid_metadata' },
        { path: 'nodes/foreign.meta.json', kind: 'foreign_run' },
        {
          path: lost.path,
          kind: 'missing_content',
          code: 'ENOENT',
          nodeId: 'lost',
          outputType: 'verdict',
          producedAt: at(2),
        },
      ],
    });
  });
});
