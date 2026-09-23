import { describe, test, expect } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';
import { nodeArtifactsListingSchema, type NodeArtifact } from './schemas/node-artifact';
import { writeNodeArtifact, readNodeArtifacts, writeNodeArtifactsListing } from './artifacts-index';

const trackTempRoot = trackTempRoots();

async function makeDir(): Promise<string> {
  return trackTempRoot(await mkdtemp(join(tmpdir(), 'artifacts-index-')));
}

/** Current-run read, the supported lookup a script or agent performs. */
function readCurrentRun(dir: string, runId = 'r') {
  return readNodeArtifacts(dir, { scope: 'current-run', runId });
}

/** Every artifact regardless of run, the whole-directory view the old reader returned. */
async function readAll(dir: string): Promise<NodeArtifact[]> {
  const { artifactsByType } = await readNodeArtifacts(dir, { scope: 'resolved-scope' });
  return Object.values(artifactsByType).flat();
}

describe('artifacts-index writes', () => {
  test('writeNodeArtifact writes the output file + metadata and returns the entry', async () => {
    const dir = await makeDir();
    const meta = await writeNodeArtifact(
      dir,
      {
        nodeId: 'planner',
        outputType: 'plan',
        runId: 'run-1',
        producedAt: '2026-06-03T00:00:00.000Z',
        sessionId: 'sess-1',
      },
      'the plan body'
    );

    expect(meta).toMatchObject({
      nodeId: 'planner',
      outputType: 'plan',
      path: join('nodes', 'planner.md'),
      runId: 'run-1',
      producedAt: '2026-06-03T00:00:00.000Z',
      sessionId: 'sess-1',
    });
    expect(meta.size).toBe(Buffer.byteLength('the plan body', 'utf8'));
    expect(await readFile(join(dir, 'nodes', 'planner.md'), 'utf8')).toBe('the plan body');
    const onDisk = JSON.parse(
      await readFile(join(dir, 'nodes', 'planner.meta.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(onDisk.outputType).toBe('plan');
  });

  test('writeNodeArtifact omits sessionId when not provided', async () => {
    const dir = await makeDir();
    const meta = await writeNodeArtifact(
      dir,
      { nodeId: 'n', outputType: 'findings', runId: 'r', producedAt: '2026-06-03T00:00:00.000Z' },
      'x'
    );
    expect('sessionId' in meta).toBe(false);
  });

  test('loop_group lineages produce distinct stable artifact identities', async () => {
    const dir = await makeDir();
    const first = await writeNodeArtifact(
      dir,
      {
        nodeId: 'review',
        outputType: 'findings',
        loopGroupPath: [
          { groupId: 'outer', iteration: 1 },
          { groupId: 'inner', iteration: 1 },
        ],
        runId: 'r',
        producedAt: '2026-06-03T00:00:00.000Z',
      },
      'first'
    );
    const second = await writeNodeArtifact(
      dir,
      {
        nodeId: 'review',
        outputType: 'findings',
        loopGroupPath: [
          { groupId: 'outer', iteration: 2 },
          { groupId: 'inner', iteration: 1 },
        ],
        runId: 'r',
        producedAt: '2026-06-03T01:00:00.000Z',
      },
      'second'
    );

    expect(basename(first.path)).toMatch(/^loop\.[0-9a-f]{64}__review\.md$/);
    expect(basename(second.path)).toMatch(/^loop\.[0-9a-f]{64}__review\.md$/);
    expect(first.path).not.toBe(second.path);
    expect(await readFile(join(dir, first.path), 'utf8')).toBe('first');
    expect(await readFile(join(dir, second.path), 'utf8')).toBe('second');
  });

  test('a node id with path separators is sanitized to a single safe segment', async () => {
    const dir = await makeDir();
    const meta = await writeNodeArtifact(
      dir,
      { nodeId: '../evil', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T00:00:00.000Z' },
      'x'
    );
    expect(meta.path).toBe(join('nodes', '___evil.md'));
    expect(meta.path).not.toContain('..');
    // The original id is preserved in metadata even though the filename is sanitized.
    expect(meta.nodeId).toBe('../evil');
  });

  test('two distinct node ids that collide on the same safe segment fail loudly (no silent overwrite)', async () => {
    const dir = await makeDir();
    await writeNodeArtifact(
      dir,
      { nodeId: 'a.b', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T00:00:00.000Z' },
      'first'
    );
    // `a.b` and `a_b` both sanitize to `a_b` — the second write must throw rather
    // than silently clobber the first node's artifact.
    await expect(
      writeNodeArtifact(
        dir,
        { nodeId: 'a_b', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T00:01:00.000Z' },
        'second'
      )
    ).rejects.toThrow(/collision/);
    // First writer wins; its artifact is intact.
    expect(await readFile(join(dir, 'nodes', 'a_b.md'), 'utf8')).toBe('first');
    expect((await readAll(dir)).map(e => e.nodeId)).toEqual(['a.b']);
  });

  test('loop owner digests distinguish group ids that sanitize alike', async () => {
    const dir = await makeDir();
    const first = await writeNodeArtifact(
      dir,
      {
        nodeId: 'review',
        outputType: 'findings',
        loopGroupPath: [{ groupId: 'a.b', iteration: 1 }],
        runId: 'r',
        producedAt: '2026-06-03T00:00:00.000Z',
      },
      'first'
    );

    const second = await writeNodeArtifact(
      dir,
      {
        nodeId: 'review',
        outputType: 'findings',
        loopGroupPath: [{ groupId: 'a_b', iteration: 1 }],
        runId: 'r',
        producedAt: '2026-06-03T01:00:00.000Z',
      },
      'second'
    );

    expect(first.path).not.toBe(second.path);
    expect(await readFile(join(dir, first.path), 'utf8')).toBe('first');
    expect(await readFile(join(dir, second.path), 'utf8')).toBe('second');
    expect(await readAll(dir)).toHaveLength(2);
  });

  test('loop owner digests distinguish body node ids that sanitize alike', async () => {
    const dir = await makeDir();
    const [first, second] = await Promise.all([
      writeNodeArtifact(
        dir,
        {
          nodeId: 'a.b',
          outputType: 'findings',
          loopGroupPath: [{ groupId: 'group', iteration: 1 }],
          runId: 'r',
          producedAt: '2026-06-03T00:00:00.000Z',
        },
        'first'
      ),
      writeNodeArtifact(
        dir,
        {
          nodeId: 'a_b',
          outputType: 'findings',
          loopGroupPath: [{ groupId: 'group', iteration: 1 }],
          runId: 'r',
          producedAt: '2026-06-03T00:01:00.000Z',
        },
        'second'
      ),
    ]);

    expect(first.path).not.toBe(second.path);
    expect(await readFile(join(dir, first.path), 'utf8')).toBe('first');
    expect(await readFile(join(dir, second.path), 'utf8')).toBe('second');
    expect(new Set((await readAll(dir)).map(entry => entry.nodeId))).toEqual(
      new Set(['a.b', 'a_b'])
    );
  });

  test('loop owner namespace cannot alias valid top-level or delimiter-shaped loop ids', async () => {
    const dir = await makeDir();
    const topLevel = await writeNodeArtifact(
      dir,
      {
        nodeId: 'group-iteration-1__leaf',
        outputType: 'findings',
        runId: 'r',
        producedAt: '2026-06-03T00:00:00.000Z',
      },
      'top-level'
    );
    const loop = await writeNodeArtifact(
      dir,
      {
        nodeId: 'leaf',
        outputType: 'findings',
        loopGroupPath: [{ groupId: 'group', iteration: 1 }],
        runId: 'r',
        producedAt: '2026-06-03T00:01:00.000Z',
      },
      'loop'
    );
    const [nested, delimiterShaped] = await Promise.all([
      writeNodeArtifact(
        dir,
        {
          nodeId: 'leaf',
          outputType: 'findings',
          loopGroupPath: [
            { groupId: 'outer', iteration: 1 },
            { groupId: 'inner', iteration: 2 },
          ],
          runId: 'r',
          producedAt: '2026-06-03T00:02:00.000Z',
        },
        'nested'
      ),
      writeNodeArtifact(
        dir,
        {
          nodeId: 'inner-iteration-2__leaf',
          outputType: 'findings',
          loopGroupPath: [{ groupId: 'outer', iteration: 1 }],
          runId: 'r',
          producedAt: '2026-06-03T00:03:00.000Z',
        },
        'delimiter-shaped'
      ),
    ]);

    expect(new Set([topLevel.path, loop.path, nested.path, delimiterShaped.path]).size).toBe(4);
    expect(await readAll(dir)).toHaveLength(4);
  });

  test('writeNodeArtifact rejects invalid loop_group frames before creating sidecars', async () => {
    const dir = await makeDir();
    await expect(
      writeNodeArtifact(
        dir,
        {
          nodeId: 'empty-path',
          outputType: 'plan',
          loopGroupPath: [],
          runId: 'r',
          producedAt: '2026-06-03T00:00:00.000Z',
        },
        'invalid'
      )
    ).rejects.toThrow();
    await expect(
      writeNodeArtifact(
        dir,
        {
          nodeId: 'zero-iteration',
          outputType: 'plan',
          loopGroupPath: [{ groupId: 'group', iteration: 0 }],
          runId: 'r',
          producedAt: '2026-06-03T00:00:00.000Z',
        },
        'invalid'
      )
    ).rejects.toThrow();

    expect(await readdir(dir)).toEqual([]);
  });

  test('re-writing the SAME node id (e.g. on resume) overwrites without a collision error', async () => {
    const dir = await makeDir();
    await writeNodeArtifact(
      dir,
      { nodeId: 'planner', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T00:00:00.000Z' },
      'v1'
    );
    await writeNodeArtifact(
      dir,
      { nodeId: 'planner', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T01:00:00.000Z' },
      'v2'
    );
    expect(await readFile(join(dir, 'nodes', 'planner.md'), 'utf8')).toBe('v2');
  });

  test('re-writing the same loop owner uses value equality and keeps one current artifact', async () => {
    const dir = await makeDir();
    const first = await writeNodeArtifact(
      dir,
      {
        nodeId: 'review',
        outputType: 'findings',
        loopGroupPath: [{ groupId: 'group', iteration: 2 }],
        runId: 'r',
        producedAt: '2026-06-03T00:00:00.000Z',
      },
      'v1'
    );
    const second = await writeNodeArtifact(
      dir,
      {
        nodeId: 'review',
        outputType: 'findings',
        loopGroupPath: [{ groupId: 'group', iteration: 2 }],
        runId: 'r',
        producedAt: '2026-06-03T01:00:00.000Z',
      },
      'v2'
    );

    expect(second.path).toBe(first.path);
    expect(await readFile(join(dir, first.path), 'utf8')).toBe('v2');
    expect(await readAll(dir)).toEqual([second]);
  });

  test('non-ENOENT prior-owner read failures reject without replacing output', async () => {
    const dir = await makeDir();
    await writeNodeArtifact(
      dir,
      { nodeId: 'a.b', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T00:00:00.000Z' },
      'first'
    );
    const metaPath = join(dir, 'nodes', 'a_b.meta.json');
    await rm(metaPath);
    // A directory where the sidecar file should be: reading it fails with EISDIR,
    // which is not "no prior owner", so the write must refuse rather than clobber.
    await mkdir(metaPath);

    await expect(
      writeNodeArtifact(
        dir,
        { nodeId: 'a_b', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T01:00:00.000Z' },
        'second'
      )
    ).rejects.toThrow();
    expect(await readFile(join(dir, 'nodes', 'a_b.md'), 'utf8')).toBe('first');
  });
});

describe('artifacts-index read', () => {
  test('a directory with no artifacts yet is an empty result, not an error', async () => {
    const dir = await makeDir();
    expect(await readCurrentRun(dir)).toEqual({ artifactsByType: {}, errors: [] });
  });

  test('groups by the exact, case-sensitive output type and keeps arbitrary labels', async () => {
    const dir = await makeDir();
    for (const [nodeId, outputType] of [
      ['a', 'plan'],
      ['b', 'Plan'],
      ['c', 'green-gate'],
      ['d', 'weird type/with punctuation'],
    ] as const) {
      await writeNodeArtifact(
        dir,
        { nodeId, outputType, runId: 'r', producedAt: '2026-06-03T00:00:00.000Z' },
        nodeId
      );
    }

    const { artifactsByType, errors } = await readCurrentRun(dir);
    expect(errors).toEqual([]);
    expect(Object.keys(artifactsByType).sort()).toEqual([
      'Plan',
      'green-gate',
      'plan',
      'weird type/with punctuation',
    ]);
    expect(artifactsByType.plan?.map(e => e.nodeId)).toEqual(['a']);
  });

  test('orders each type by numeric timestamp, then a deterministic path tie-break', async () => {
    const dir = await makeDir();
    // The first two are the same instant written in different string forms; the
    // reader must sort them numerically and break the tie by path, never by the
    // lexicographic order of the timestamp string.
    await writeNodeArtifact(
      dir,
      { nodeId: 'same-b', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T00:00:00Z' },
      'b'
    );
    await writeNodeArtifact(
      dir,
      { nodeId: 'same-a', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T00:00:00.000Z' },
      'a'
    );
    await writeNodeArtifact(
      dir,
      { nodeId: 'later', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T00:00:01.000Z' },
      'later'
    );

    const { artifactsByType } = await readCurrentRun(dir);
    expect(artifactsByType.plan?.map(e => e.nodeId)).toEqual(['same-a', 'same-b', 'later']);
  });

  test('current-run lookup excludes foreign-run sidecars but reports them', async () => {
    const dir = await makeDir();
    await writeNodeArtifact(
      dir,
      { nodeId: 'mine', outputType: 'plan', runId: 'mine', producedAt: '2026-06-03T00:00:00.000Z' },
      'mine'
    );
    await writeNodeArtifact(
      dir,
      {
        nodeId: 'theirs',
        outputType: 'plan',
        runId: 'theirs',
        producedAt: '2026-06-03T01:00:00.000Z',
      },
      'theirs'
    );

    const { artifactsByType, errors } = await readCurrentRun(dir, 'mine');
    expect(artifactsByType.plan?.map(e => e.nodeId)).toEqual(['mine']);
    expect(errors).toEqual([{ path: 'nodes/theirs.meta.json', kind: 'foreign_run' }]);
  });

  test('groups an output_type that names an Object.prototype key without throwing', async () => {
    const dir = await makeDir();
    for (const [nodeId, outputType] of [
      ['proto', '__proto__'],
      ['ctor', 'constructor'],
      ['stringer', 'toString'],
    ] as const) {
      await writeNodeArtifact(
        dir,
        { nodeId, outputType, runId: 'r', producedAt: '2026-06-03T00:00:00.000Z' },
        nodeId
      );
    }

    const { artifactsByType, errors } = await readCurrentRun(dir);
    expect(errors).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(artifactsByType, '__proto__')?.value).toHaveLength(1);
    expect(artifactsByType['constructor']?.map(e => e.nodeId)).toEqual(['ctor']);
    expect(artifactsByType['toString']?.map(e => e.nodeId)).toEqual(['stringer']);
  });

  test('a malformed or schema-invalid sidecar is reported while valid records survive', async () => {
    const dir = await makeDir();
    await writeNodeArtifact(
      dir,
      { nodeId: 'good', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T00:00:00.000Z' },
      'ok'
    );
    await writeFile(join(dir, 'nodes', 'malformed.meta.json'), '{ not valid json', 'utf8');
    await writeFile(join(dir, 'nodes', 'wrong.meta.json'), JSON.stringify({ foo: 'bar' }), 'utf8');

    const { artifactsByType, errors } = await readCurrentRun(dir);
    expect(artifactsByType.plan?.map(e => e.nodeId)).toEqual(['good']);
    expect(errors).toEqual([
      { path: 'nodes/malformed.meta.json', kind: 'invalid_metadata' },
      { path: 'nodes/wrong.meta.json', kind: 'invalid_metadata' },
    ]);
  });

  test('rejects invalid loop_group frame metadata as an error, not a silent omission', async () => {
    const dir = await makeDir();
    await writeNodeArtifact(
      dir,
      { nodeId: 'good', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T00:00:00.000Z' },
      'ok'
    );
    await writeFile(
      join(dir, 'nodes', 'empty-loop.meta.json'),
      JSON.stringify({
        nodeId: 'empty-loop',
        outputType: 'plan',
        loopGroupPath: [],
        path: 'nodes/empty-loop.md',
        runId: 'r',
        producedAt: '2026-06-03T00:00:00.000Z',
        size: 1,
      }),
      'utf8'
    );

    const { artifactsByType, errors } = await readCurrentRun(dir);
    expect(artifactsByType.plan?.map(e => e.nodeId)).toEqual(['good']);
    expect(errors).toEqual([{ path: 'nodes/empty-loop.meta.json', kind: 'invalid_metadata' }]);
  });

  test('a missing nodes directory is empty; an unusable nodes path is a directory error', async () => {
    const emptyDir = await makeDir();
    expect(await readCurrentRun(emptyDir)).toEqual({ artifactsByType: {}, errors: [] });

    const brokenDir = await makeDir();
    // A regular file where `nodes/` is expected makes readdir fail with ENOTDIR.
    await writeFile(join(brokenDir, 'nodes'), 'not a directory', 'utf8');
    const { artifactsByType, errors } = await readCurrentRun(brokenDir);
    expect(artifactsByType).toEqual({});
    expect(errors).toEqual([{ path: 'nodes', kind: 'unreadable_directory', code: 'ENOTDIR' }]);
  });

  test('an escaped content path yields no pointer and keeps valid neighbors', async () => {
    const dir = await makeDir();
    await writeNodeArtifact(
      dir,
      { nodeId: 'good', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T00:00:00.000Z' },
      'ok'
    );
    const outside = join(dir, '..', `escaped-${basename(dir)}.md`);
    await writeFile(outside, 'secret', 'utf8');
    await writeFile(
      join(dir, 'nodes', 'escape.meta.json'),
      JSON.stringify({
        nodeId: 'escape',
        outputType: 'plan',
        path: `../${basename(outside)}`,
        runId: 'r',
        producedAt: '2026-06-03T00:00:00.000Z',
        size: 6,
      }),
      'utf8'
    );

    const { artifactsByType, errors } = await readCurrentRun(dir);
    expect(artifactsByType.plan?.map(e => e.nodeId)).toEqual(['good']);
    expect(errors).toEqual([{ path: 'nodes/escape.meta.json', kind: 'unsafe_path' }]);
    await rm(outside, { force: true });
  });

  test('a content symlink out of the run is rejected, while a missing body keeps its metadata', async () => {
    const dir = await makeDir();
    await mkdir(join(dir, 'nodes'), { recursive: true });
    const outside = join(dir, '..', `outside-${basename(dir)}.md`);
    await writeFile(outside, 'outside', 'utf8');
    await symlink(outside, join(dir, 'nodes', 'escape.md'));
    await writeFile(
      join(dir, 'nodes', 'escape.meta.json'),
      JSON.stringify({
        nodeId: 'escape',
        outputType: 'plan',
        path: 'nodes/escape.md',
        runId: 'r',
        producedAt: '2026-06-03T00:00:00.000Z',
        size: 7,
      }),
      'utf8'
    );
    await writeNodeArtifact(
      dir,
      { nodeId: 'gone', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T00:00:00.000Z' },
      'body'
    );
    // Remove the body after the sidecar exists: the metadata is still a usable
    // description, so it is returned alongside the diagnostic.
    await rm(join(dir, 'nodes', 'gone.md'));

    const { artifactsByType, errors } = await readCurrentRun(dir);
    expect(artifactsByType.plan?.map(e => e.nodeId)).toEqual(['gone']);
    expect(errors).toEqual([
      { path: 'nodes/escape.meta.json', kind: 'unsafe_path' },
      { path: 'nodes/gone.meta.json', kind: 'missing_content', code: 'ENOENT' },
    ]);
    await rm(outside, { force: true });
  });

  test('a symlink-loop content pointer is an unreadable-content diagnostic', async () => {
    const dir = await makeDir();
    await mkdir(join(dir, 'nodes'), { recursive: true });
    await symlink(join(dir, 'nodes', 'loop.md'), join(dir, 'nodes', 'loop.md'));
    await writeFile(
      join(dir, 'nodes', 'loop.meta.json'),
      JSON.stringify({
        nodeId: 'loop',
        outputType: 'plan',
        path: 'nodes/loop.md',
        runId: 'r',
        producedAt: '2026-06-03T00:00:00.000Z',
        size: 0,
      }),
      'utf8'
    );

    const { artifactsByType, errors } = await readCurrentRun(dir);
    expect(artifactsByType.plan?.map(e => e.nodeId)).toEqual(['loop']);
    expect(errors).toEqual([
      { path: 'nodes/loop.meta.json', kind: 'unreadable_content', code: 'ELOOP' },
    ]);
  });

  test('preserves complete loop provenance on a grouped artifact', async () => {
    const dir = await makeDir();
    await writeNodeArtifact(
      dir,
      {
        nodeId: 'review',
        outputType: 'findings',
        loopGroupPath: [
          { groupId: 'outer', iteration: 2 },
          { groupId: 'inner', iteration: 1 },
        ],
        runId: 'r',
        producedAt: '2026-06-03T00:00:00.000Z',
        sessionId: 'sess',
      },
      'body'
    );

    const { artifactsByType } = await readCurrentRun(dir);
    expect(artifactsByType.findings?.[0]).toMatchObject({
      nodeId: 'review',
      loopGroupPath: [
        { groupId: 'outer', iteration: 2 },
        { groupId: 'inner', iteration: 1 },
      ],
      sessionId: 'sess',
    });
  });
});

describe('artifacts-index listing', () => {
  test('writes a schema-valid, unique listing for the current run only', async () => {
    const dir = await makeDir();
    await writeNodeArtifact(
      dir,
      {
        nodeId: 'gate',
        outputType: 'green-gate',
        runId: 'r',
        producedAt: '2026-06-03T00:00:00.000Z',
      },
      JSON.stringify({ red_cause: 'inherited' })
    );
    await writeNodeArtifact(
      dir,
      {
        nodeId: 'other',
        outputType: 'plan',
        runId: 'other',
        producedAt: '2026-06-03T01:00:00.000Z',
      },
      'x'
    );

    const firstPath = await writeNodeArtifactsListing(dir, 'r');
    const secondPath = await writeNodeArtifactsListing(dir, 'r');
    expect(firstPath).not.toBe(secondPath);
    // The listing lives outside `nodes/`, so the reader never reads one as input.
    expect(firstPath.startsWith(join(dir, 'nodes'))).toBe(false);

    const listing = nodeArtifactsListingSchema.parse(JSON.parse(await readFile(firstPath, 'utf8')));
    expect(listing.runId).toBe('r');
    expect(listing.artifactsByType['green-gate']?.map(e => e.nodeId)).toEqual(['gate']);
    expect(listing.artifactsByType.plan).toBeUndefined();
    expect(listing.errors).toEqual([{ path: 'nodes/other.meta.json', kind: 'foreign_run' }]);
  });
});
