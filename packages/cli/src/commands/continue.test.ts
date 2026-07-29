/**
 * Tests for `archon continue`'s artifact-directory resolution (#2200).
 *
 * Before this change the helper had no `kind === 'folder'` branch at all, so a
 * folder project silently fell through to a cwd path that never exists. It now
 * delegates to the ONE shared identity→paths resolver, and prefers a run's
 * durable `output_root` over re-deriving from a codebase that may since have
 * been renamed.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const mockGetCodebase = mock(
  async (_id: string) => null as null | { kind: string; name: string; default_cwd: string }
);
mock.module('@archon/core/db/codebases', () => ({ getCodebase: mockGetCodebase }));

let archonHome: string;

// The real @archon/paths is used deliberately — this test is about delegating
// to it correctly, so a fake resolver would test nothing. ARCHON_HOME is
// redirected at the env level instead.
import { resolveArtifactsDir } from './continue';

beforeEach(async () => {
  mockGetCodebase.mockReset();
  archonHome = await mkdtemp(join(tmpdir(), 'archon-continue-'));
  process.env.ARCHON_HOME = archonHome;
});

afterEach(async () => {
  delete process.env.ARCHON_HOME;
  await rm(archonHome, { recursive: true, force: true });
});

describe('resolveArtifactsDir', () => {
  test('resolves a FOLDER project to _folder/<slug> storage (previously unreachable)', async () => {
    const dir = join(
      archonHome,
      'workspaces',
      '_folder',
      'my-ops-folder',
      'artifacts',
      'runs',
      'r1'
    );
    await mkdir(dir, { recursive: true });
    mockGetCodebase.mockImplementationOnce(async () => ({
      kind: 'folder',
      name: 'My Ops Folder',
      default_cwd: '/srv/ops',
    }));

    const result = await resolveArtifactsDir({ id: 'r1', output_root: null }, 'cb-1', '/srv/ops');

    expect(result).toBe(dir);
  });

  test('resolves a no-remote local repo to _local/<basename>', async () => {
    const dir = join(archonHome, 'workspaces', '_local', 'workspace', 'artifacts', 'runs', 'r2');
    await mkdir(dir, { recursive: true });
    mockGetCodebase.mockImplementationOnce(async () => ({
      kind: 'repo',
      name: 'workspace',
      default_cwd: '/home/u/workspace',
    }));

    const result = await resolveArtifactsDir(
      { id: 'r2', output_root: null },
      'cb-2',
      '/home/u/workspace'
    );

    expect(result).toBe(dir);
  });

  test('a persisted output_root is preferred over re-deriving from the codebase', async () => {
    const root = join(archonHome, 'workspaces', 'acme', 'original');
    const dir = join(root, 'artifacts', 'runs', 'r3');
    await mkdir(dir, { recursive: true });
    // The codebase resolves somewhere else entirely (renamed since the run).
    mockGetCodebase.mockImplementationOnce(async () => ({
      kind: 'repo',
      name: 'acme/renamed-since',
      default_cwd: '/repos/renamed',
    }));

    const result = await resolveArtifactsDir(
      { id: 'r3', output_root: root },
      'cb-3',
      '/repos/renamed'
    );

    expect(result).toBe(dir);
  });

  test('falls back to the legacy in-repo location for pre-#2200 runs', async () => {
    const workingPath = await mkdtemp(join(tmpdir(), 'archon-legacy-'));
    const legacy = join(workingPath, '.archon', 'artifacts', 'runs', 'r4');
    await mkdir(legacy, { recursive: true });
    mockGetCodebase.mockImplementationOnce(async () => null);
    try {
      const result = await resolveArtifactsDir(
        { id: 'r4', output_root: null },
        'cb-4',
        workingPath
      );
      expect(result).toBe(legacy);
    } finally {
      await rm(workingPath, { recursive: true, force: true });
    }
  });

  test('returns null when no candidate exists on disk', async () => {
    mockGetCodebase.mockImplementationOnce(async () => null);
    const result = await resolveArtifactsDir(
      { id: 'r5', output_root: null },
      'cb-5',
      '/nonexistent/path'
    );
    expect(result).toBeNull();
  });

  test('a codebase lookup failure still tries the remaining candidates', async () => {
    const workingPath = await mkdtemp(join(tmpdir(), 'archon-dberr-'));
    const legacy = join(workingPath, '.archon', 'artifacts', 'runs', 'r6');
    await mkdir(legacy, { recursive: true });
    mockGetCodebase.mockImplementationOnce(() => Promise.reject(new Error('db down')));
    try {
      const result = await resolveArtifactsDir(
        { id: 'r6', output_root: null },
        'cb-6',
        workingPath
      );
      expect(result).toBe(legacy);
    } finally {
      await rm(workingPath, { recursive: true, force: true });
    }
  });
});
