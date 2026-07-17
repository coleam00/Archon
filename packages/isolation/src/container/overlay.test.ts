import { describe, test, expect } from 'bun:test';
import { summarizeOverlayChanges, applyOverlayChanges } from './overlay';
import type { DockerRunner, DockerExecResult } from './docker-exec';

const TARGET = { volume: 'archon-x-upper', hostRoot: '/tmp/ops', image: 'archon-runner:test' };

/** Build a DockerRunner that returns a fixed result (or throws) and records calls. */
function fakeDocker(
  result: DockerExecResult | (() => never)
): DockerRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = (async (args: string[]) => {
    calls.push(args);
    if (typeof result === 'function') return result();
    return result;
  }) as DockerRunner & { calls: string[][] };
  runner.calls = calls;
  return runner;
}

/** Encode NUL-delimited `<TAG>\t<path>` records the way the helper script emits them. */
function records(...recs: [string, string][]): string {
  return recs.map(([tag, path]) => `${tag}\t${path}`).join('\0') + (recs.length ? '\0' : '');
}

describe('summarizeOverlayChanges', () => {
  test('classifies adds / modifies / deletes from NUL-delimited records', async () => {
    const docker = fakeDocker({
      stdout: records(['A', 'new.md'], ['M', 'existing.txt'], ['D', 'gone.log']),
      stderr: '',
    });
    const summary = await summarizeOverlayChanges(docker, TARGET);
    expect(summary.added).toEqual(['new.md']);
    expect(summary.modified).toEqual(['existing.txt']);
    expect(summary.deleted).toEqual(['gone.log']);
    expect(summary.totalCount).toBe(3);
    expect(summary.truncated).toBe(false);
  });

  test('mounts the volume + host root read-only and runs bash on the runner image', async () => {
    const docker = fakeDocker({ stdout: '', stderr: '' });
    await summarizeOverlayChanges(docker, TARGET);
    const joined = docker.calls[0]?.join(' ') ?? '';
    expect(joined).toContain('run --rm');
    expect(joined).toContain('archon-x-upper:/upper:ro');
    expect(joined).toContain('/tmp/ops:/lower:ro');
    expect(joined).toContain('archon-runner:test');
    expect(joined).toContain('bash');
  });

  test('empty overlay → empty lists, totalCount 0, not truncated', async () => {
    const docker = fakeDocker({ stdout: '', stderr: '' });
    const summary = await summarizeOverlayChanges(docker, TARGET);
    expect(summary.totalCount).toBe(0);
    expect(summary.added).toEqual([]);
    expect(summary.truncated).toBe(false);
  });

  test('caps each list at 200 entries and flags truncated with the true totalCount', async () => {
    const recs: [string, string][] = [];
    for (let i = 0; i < 250; i++) recs.push(['A', `f${i}.txt`]);
    const docker = fakeDocker({ stdout: records(...recs), stderr: '' });
    const summary = await summarizeOverlayChanges(docker, TARGET);
    expect(summary.added.length).toBe(200);
    expect(summary.totalCount).toBe(250);
    expect(summary.truncated).toBe(true);
  });

  test('a docker failure is surfaced, not swallowed', async () => {
    const docker = fakeDocker(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });
    await expect(summarizeOverlayChanges(docker, TARGET)).rejects.toThrow(
      /inspect the overlay diff/
    );
  });
});

describe('applyOverlayChanges', () => {
  test('mounts the host root read-WRITE and counts written + deleted', async () => {
    const docker = fakeDocker({
      stdout: records(['W', 'a.txt'], ['W', 'b.txt'], ['D', 'c.txt']),
      stderr: '',
    });
    const summary = await applyOverlayChanges(docker, TARGET);
    expect(summary.filesApplied).toBe(2);
    expect(summary.filesDeleted).toBe(1);
    const joined = docker.calls[0]?.join(' ') ?? '';
    expect(joined).toContain('/tmp/ops:/dest'); // rw (no :ro suffix)
    expect(joined).not.toContain('/tmp/ops:/dest:ro');
  });

  test('a partial apply throws loudly, reporting how many paths landed', async () => {
    const err = Object.assign(new Error('cp: No space left on device'), {
      stdout: records(['W', 'a.txt'], ['W', 'b.txt']),
    });
    const docker = fakeDocker(() => {
      throw err;
    });
    await expect(applyOverlayChanges(docker, TARGET)).rejects.toThrow(
      /2 path\(s\) already applied/
    );
  });

  test('surfaces helper stderr as warnings', async () => {
    const docker = fakeDocker({
      stdout: records(['W', 'a.txt']),
      stderr: 'skipped opaque dir foo/',
    });
    const summary = await applyOverlayChanges(docker, TARGET);
    expect(summary.warnings).toEqual(['skipped opaque dir foo/']);
  });
});
