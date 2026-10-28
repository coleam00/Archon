// @archon-test-isolated
import { afterAll, describe, expect, it, mock } from 'bun:test';
import { basename, join, sep } from 'path';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { removeTempTree } from '@archon/paths/test-utils';
import type { WorkflowDeps } from './deps';
import { resolveProjectPaths, resolveScopeArtifactsDir } from './run-paths';
import type { WorkflowDefinition } from './schemas';

const originalHome = process.env.ARCHON_HOME;
const testHome = await mkdtemp(join(tmpdir(), 'run-paths-home-'));
process.env.ARCHON_HOME = testHome;
afterAll(async () => {
  await removeTempTree(testHome);
  if (originalHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalHome;
});

const WS = join(process.env.ARCHON_HOME, 'workspaces');
function wsPath(...segments: string[]): string {
  return join(WS, ...segments);
}

const actualPaths = await import('@archon/paths');
const resolveProjectStorageKey = mock(actualPaths.resolveProjectStorageKey);
const warn = mock((_payload: Record<string, unknown>, _event: string) => {});
function cwdPath(cwd: string, ...segments: string[]): string {
  return join(
    actualPaths.getProjectStoragePaths(actualPaths.resolveProjectStorageKey(null, cwd)).root,
    ...segments
  );
}
mock.module('@archon/paths', () => ({
  ...actualPaths,
  createLogger: () => ({ warn, error: mock(() => {}) }),
  resolveProjectStorageKey,
  getProjectStoragePaths: mock(actualPaths.getProjectStoragePaths),
  getStoragePathsForRoot: mock(actualPaths.getStoragePathsForRoot),
  isInsideArchonHome: mock(actualPaths.isInsideArchonHome),
  getScopeArtifactsPath: mock(actualPaths.getScopeArtifactsPath),
}));
function makeStore(
  overrides: Partial<Pick<WorkflowDeps['store'], 'getCodebase'>> = {}
): Pick<WorkflowDeps['store'], 'getCodebase'> {
  return { getCodebase: mock(async () => null), ...overrides };
}
function makeDeps(store = makeStore()) {
  return { store };
}

describe('resolveProjectPaths', () => {
  const RUN_ID = 'run-xyz';

  it('routes folder projects to _folder/<slug>/ storage', async () => {
    const store = makeStore({
      getCodebase: mock(async () => ({
        id: 'cb-folder',
        name: 'My Platform',
        repository_url: null,
        default_cwd: '/tmp/platform',
        kind: 'folder' as const,
      })),
    });
    const deps = makeDeps(store);

    const paths = await resolveProjectPaths(deps, '/tmp/platform', RUN_ID, 'cb-folder');

    expect(paths.artifactsDir).toBe(
      wsPath('_folder', 'my-platform', 'artifacts', 'runs', 'run-xyz')
    );
    expect(paths.logDir).toBe(wsPath('_folder', 'my-platform', 'logs'));
    expect(paths.artifactsRoot).toBe(wsPath('_folder', 'my-platform', 'artifacts'));
    expect(paths.stateDir).toBe(wsPath('_folder', 'my-platform', 'state'));
    expect(paths.outputRoot).toBe(wsPath('_folder', 'my-platform'));
  });

  // #2304: a transient lookup fault used to drop the run onto `@cwd/<basename>-<digest>` and,
  // because `output_root` is write-once, pin it there for the run's whole life —
  // including its `$STATE_DIR`, so a stateful workflow silently read an empty state
  // directory. Asserting the RESOLVED PATH rather than the call count: the failure is
  // success-shaped (a valid location, no error), so only the destination proves it.
  it('retries a transient getCodebase fault instead of pinning the cwd fallback (#2304)', async () => {
    let calls = 0;
    const store = makeStore({
      getCodebase: mock(async () => {
        calls++;
        if (calls === 1) throw new Error('connection reset by peer');
        return {
          id: 'cb-repo',
          name: 'acme/widget',
          repository_url: 'https://github.com/acme/widget',
          default_cwd: '/repos/widget',
          kind: 'repo' as const,
        };
      }),
    });
    const deps = makeDeps(store);

    const result = await resolveProjectPaths(deps, '/repos/widget', RUN_ID, 'cb-repo');

    expect(calls).toBe(2);
    expect(result.artifactsDir).toBe(wsPath('acme', 'widget', 'artifacts', 'runs', 'run-xyz'));
    expect(result.stateDir).toBe(wsPath('acme', 'widget', 'state'));
    expect(result.outputRoot).toBe(wsPath('acme', 'widget'));
  });

  // The retry addresses the TRANSIENT case only. A sustained fault must still reach the
  // fallback rather than throwing — the fallback exists precisely so a registry outage
  // does not kill a run, and that trade was settled before #2304.
  it('still falls back to cwd storage when the fault persists across the retry', async () => {
    let calls = 0;
    const store = makeStore({
      getCodebase: mock(async () => {
        calls++;
        throw new Error('connection reset by peer');
      }),
    });
    const deps = makeDeps(store);

    const result = await resolveProjectPaths(deps, '/repos/widget', RUN_ID, 'cb-repo');

    expect(calls).toBe(2);
    expect(result.artifactsDir).toBe(cwdPath('/repos/widget', 'artifacts', 'runs', 'run-xyz'));
  });

  it('routes repo projects to owner/repo/ storage (unchanged)', async () => {
    const store = makeStore({
      getCodebase: mock(async () => ({
        id: 'cb-repo',
        name: 'acme/widget',
        repository_url: 'https://github.com/acme/widget',
        default_cwd: '/repos/widget',
        kind: 'repo' as const,
      })),
    });
    const deps = makeDeps(store);

    const result = await resolveProjectPaths(deps, '/repos/widget', RUN_ID, 'cb-repo');

    expect(result.artifactsDir).toBe(wsPath('acme', 'widget', 'artifacts', 'runs', 'run-xyz'));
    expect(result.logDir).toBe(wsPath('acme', 'widget', 'logs'));
    expect(result.artifactsRoot).toBe(wsPath('acme', 'widget', 'artifacts'));
    expect(result.stateDir).toBe(wsPath('acme', 'widget', 'state'));
    expect(result.outputRoot).toBe(wsPath('acme', 'widget'));
  });

  it('routes a no-remote local repo to _local/<basename> storage (#2132)', async () => {
    const paths = await import('@archon/paths');
    const store = makeStore({
      getCodebase: mock(async () => ({
        id: 'cb-local',
        name: 'workspace',
        repository_url: null,
        default_cwd: '/home/username/workspace',
        kind: 'repo' as const,
      })),
    });
    const deps = makeDeps(store);

    const result = await resolveProjectPaths(deps, '/home/username/workspace', RUN_ID, 'cb-local');

    // Delegates to the ONE shared resolver rather than re-deriving identity.
    expect(paths.resolveProjectStorageKey).toHaveBeenCalled();
    expect(result.artifactsDir).toBe(wsPath('_local', 'workspace', 'artifacts', 'runs', 'run-xyz'));
    expect(result.logDir).toBe(wsPath('_local', 'workspace', 'logs'));
    expect(result.stateDir).toBe(wsPath('_local', 'workspace', 'state'));
  });

  it('routes an unregistered cwd to @cwd/<basename>-<digest> UNDER ARCHON_HOME, never into the repo', async () => {
    const store = makeStore({ getCodebase: mock(async () => null) });
    const deps = makeDeps(store);

    const result = await resolveProjectPaths(deps, '/some/cwd', RUN_ID, 'missing-id');

    // Breaking change (#2200 A4): this used to be <cwd>/.archon/artifacts/...
    expect(result.artifactsDir).toBe(cwdPath('/some/cwd', 'artifacts', 'runs', 'run-xyz'));
    expect(result.logDir).toBe(cwdPath('/some/cwd', 'logs'));
    expect(result.stateDir).toBe(cwdPath('/some/cwd', 'state'));
    // Positive form: asserting only `!startsWith('/some/cwd')` passes trivially
    // on win32 (where the result is backslash-separated), so assert the path is
    // actually rooted in the workspace tree.
    expect(result.artifactsDir.startsWith(wsPath('@cwd'))).toBe(true);
  });

  it('routes to @cwd/<basename>-<digest> when no codebaseId is provided', async () => {
    const deps = makeDeps();

    const result = await resolveProjectPaths(deps, '/some/cwd', RUN_ID);

    expect(result.artifactsDir).toBe(cwdPath('/some/cwd', 'artifacts', 'runs', 'run-xyz'));
    expect(result.logDir).toBe(cwdPath('/some/cwd', 'logs'));
    expect(result.artifactsRoot).toBe(cwdPath('/some/cwd', 'artifacts'));
    expect(result.stateDir).toBe(cwdPath('/some/cwd', 'state'));
  });

  it('still returns all five paths when the codebase lookup throws', async () => {
    const store = makeStore({
      getCodebase: mock(() => Promise.reject(new Error('db down'))),
    });
    const deps = makeDeps(store);

    const result = await resolveProjectPaths(deps, '/some/cwd', RUN_ID, 'cb-boom');

    expect(result.artifactsDir).toBe(cwdPath('/some/cwd', 'artifacts', 'runs', 'run-xyz'));
    expect(result.stateDir).toBe(cwdPath('/some/cwd', 'state'));
    expect(result.outputRoot).toBe(cwdPath('/some/cwd'));
  });

  it('isolates state for same-named directories and leaves legacy shared state untouched', async () => {
    const legacyRoot = wsPath('_cwd', 'notes');
    await mkdir(join(legacyRoot, 'state'), { recursive: true });
    await writeFile(join(legacyRoot, 'state', 'memory.txt'), 'ambiguous memory');
    warn.mockClear();

    const firstCwd = join(testHome, 'a', 'notes');
    const secondCwd = join(testHome, 'b', 'notes');
    await mkdir(firstCwd, { recursive: true });
    await mkdir(secondCwd, { recursive: true });
    const first = await resolveProjectPaths(makeDeps(), firstCwd, 'run-a');
    const second = await resolveProjectPaths(makeDeps(), secondCwd, 'run-b');
    expect(first.stateDir).not.toBe(second.stateDir);
    for (const paths of [first, second]) {
      await mkdir(paths.stateDir, { recursive: true });
      expect(await readdir(paths.stateDir)).toEqual([]);
    }
    await writeFile(join(first.stateDir, 'memory.txt'), 'first directory');
    expect(await readdir(second.stateDir)).toEqual([]);
    expect(await readdir(firstCwd)).toEqual([]);
    expect(await readdir(secondCwd)).toEqual([]);
    expect(await readFile(join(legacyRoot, 'state', 'memory.txt'), 'utf8')).toBe(
      'ambiguous memory'
    );
    const notices = warn.mock.calls.filter(
      ([, event]) => event === 'workflow.legacy_cwd_storage_detected'
    );
    expect(notices).toHaveLength(2);
    expect(notices[0][0]).toMatchObject({ legacyPath: legacyRoot, newPath: first.outputRoot });
    expect(notices[0][0].message).toContain('manually move only state');
    expect(notices[1][0]).toMatchObject({ legacyPath: legacyRoot, newPath: second.outputRoot });

    warn.mockClear();
    await resolveProjectPaths(makeDeps(), firstCwd, 'run-a-again');
    expect(warn).not.toHaveBeenCalled();
    const resumed = await resolveProjectPaths(
      makeDeps(),
      join(testHome, 'a', 'notes'),
      'old-run',
      undefined,
      {
        persistedOutputRoot: legacyRoot,
      }
    );
    expect(resumed.stateDir).toBe(join(legacyRoot, 'state'));
    expect(warn).not.toHaveBeenCalled();
    await resolveProjectPaths(makeDeps(), join(testHome, 'a', 'fresh'), 'fresh-run');
    expect(warn).not.toHaveBeenCalled();
  });

  it('creates no legacy v2 notice from fresh output', async () => {
    await resolveProjectPaths(makeDeps(), join(testHome, 'ordinary'), 'ordinary-run');
    for (const name of ['v2', 'V2']) {
      warn.mockClear();
      await resolveProjectPaths(makeDeps(), join(testHome, name), `fresh-${name}`);
      expect(
        warn.mock.calls.filter(([, event]) => event === 'workflow.legacy_cwd_storage_detected')
      ).toHaveLength(0);
    }
  });

  it('keeps fresh output outside preserved legacy v2 and V2 trees', async () => {
    for (const name of ['v2', 'V2']) {
      const legacyRoot = wsPath('_cwd', name);
      await mkdir(join(legacyRoot, 'state'), { recursive: true });
      await writeFile(join(legacyRoot, 'state', 'memory.txt'), 'legacy memory');
      const before = await readdir(legacyRoot);
      warn.mockClear();
      const fresh = await resolveProjectPaths(makeDeps(), join(testHome, name), `upgrade-${name}`);
      expect(fresh.outputRoot.toLowerCase().startsWith(`${legacyRoot.toLowerCase()}${sep}`)).toBe(
        false
      );
      await mkdir(fresh.stateDir, { recursive: true });
      await writeFile(join(fresh.stateDir, 'memory.txt'), 'fresh memory');
      expect(await readdir(legacyRoot)).toEqual(before);
      expect(await readFile(join(legacyRoot, 'state', 'memory.txt'), 'utf8')).toBe('legacy memory');
      const notices = warn.mock.calls.filter(
        ([, event]) => event === 'workflow.legacy_cwd_storage_detected'
      );
      expect(notices).toHaveLength(1);
      expect(notices[0][0]).toMatchObject({ legacyPath: legacyRoot, newPath: fresh.outputRoot });
    }
  });

  it('does not adopt legacy state whose basename matches a new storage segment', async () => {
    const freshCwd = join(testHome, 'fresh', 'collision-notes');
    const newSegment = basename(cwdPath(freshCwd));
    const legacyCwd = join(testHome, 'legacy', newSegment);
    const legacyRoot = wsPath('_cwd', newSegment);
    await mkdir(freshCwd, { recursive: true });
    await mkdir(legacyCwd, { recursive: true });
    await mkdir(join(legacyRoot, 'state'), { recursive: true });
    await writeFile(join(legacyRoot, 'state', 'memory.txt'), 'belongs to legacy directory');

    const fresh = await resolveProjectPaths(makeDeps(), freshCwd, 'fresh-collision-run');
    const resumed = await resolveProjectPaths(
      makeDeps(),
      legacyCwd,
      'legacy-collision-run',
      undefined,
      {
        persistedOutputRoot: legacyRoot,
      }
    );

    expect(fresh.stateDir).not.toBe(resumed.stateDir);
    await mkdir(fresh.stateDir, { recursive: true });
    expect(await readdir(fresh.stateDir)).toEqual([]);
    await writeFile(join(fresh.stateDir, 'memory.txt'), 'fresh directory');
    expect(await readFile(join(resumed.stateDir, 'memory.txt'), 'utf8')).toBe(
      'belongs to legacy directory'
    );
    expect(resumed.outputRoot).toBe(legacyRoot);
  });

  it('a persisted output_root short-circuits identity resolution entirely', async () => {
    const paths = await import('@archon/paths');
    const getCodebase = mock(async () => ({
      id: 'cb-repo',
      name: 'acme/renamed-since',
      repository_url: null,
      default_cwd: '/repos/widget',
      kind: 'repo' as const,
    }));
    const deps = makeDeps(makeStore({ getCodebase }));
    resolveProjectStorageKey.mockClear();

    const result = await resolveProjectPaths(deps, '/repos/widget', RUN_ID, 'cb-repo', {
      persistedOutputRoot: wsPath('acme', 'original'),
    });

    // The codebase was renamed since the run started — the durable pointer wins
    // and the row is never even read (#1192 decoupling).
    expect(getCodebase).not.toHaveBeenCalled();
    expect(paths.resolveProjectStorageKey).not.toHaveBeenCalled();
    expect(result.outputRoot).toBe(wsPath('acme', 'original'));
    expect(result.artifactsDir).toBe(wsPath('acme', 'original', 'artifacts', 'runs', 'run-xyz'));
    expect(result.logDir).toBe(wsPath('acme', 'original', 'logs'));
    expect(result.stateDir).toBe(wsPath('acme', 'original', 'state'));
  });

  it('an output_root outside ARCHON_HOME is refused and re-derived', async () => {
    // The engine only ever persists an in-tree root, so this is corruption or a
    // hand edit. Acting on it would scatter artifacts AND shared state under the
    // server's cwd. Two shapes that both escape: absolute-elsewhere and relative.
    const store = makeStore({
      getCodebase: mock(async () => ({
        id: 'cb-repo',
        name: 'acme/widget',
        repository_url: null,
        default_cwd: '/repos/widget',
        kind: 'repo' as const,
      })),
    });
    const deps = makeDeps(store);

    for (const hostile of ['/etc', '   ', 'relative/path']) {
      const result = await resolveProjectPaths(deps, '/repos/widget', RUN_ID, 'cb-repo', {
        persistedOutputRoot: hostile,
      });
      expect(result.outputRoot).toBe(wsPath('acme', 'widget'));
      expect(result.stateDir).toBe(wsPath('acme', 'widget', 'state'));
    }
  });

  it('a null persisted output_root re-derives from identity', async () => {
    const store = makeStore({
      getCodebase: mock(async () => ({
        id: 'cb-repo',
        name: 'acme/widget',
        repository_url: null,
        default_cwd: '/repos/widget',
        kind: 'repo' as const,
      })),
    });
    const deps = makeDeps(store);

    const result = await resolveProjectPaths(deps, '/repos/widget', RUN_ID, 'cb-repo', {
      persistedOutputRoot: null,
    });

    expect(result.outputRoot).toBe(wsPath('acme', 'widget'));
  });

  // #2304: identityResolution is the row-level flag the persistence block reads to
  // decide whether to write `output_root` or stamp `metadata.identity_unresolved`.
  // The five cases below cover every branch in `resolveProjectPaths`:
  //   • registered repo / folder / _local  → 'resolved'
  //   • codebase row exists, no identity   → 'unregistered' (the WARN arm)
  //   • no codebaseId                      → 'unregistered' (no lookup attempted)
  //   • codebase lookup returns null       → 'unregistered' (no row)
  //   • both attempts throw                → 'faulted' (the ERROR arm)
  //   • persisted-output-root short-circuit → undefined (a resume, no fresh flag)
  describe('identityResolution (#2304)', () => {
    it('is "resolved" for a repo codebase', async () => {
      const store = makeStore({
        getCodebase: mock(async () => ({
          id: 'cb-repo',
          name: 'acme/widget',
          repository_url: 'https://github.com/acme/widget',
          default_cwd: '/repos/widget',
          kind: 'repo' as const,
        })),
      });
      const deps = makeDeps(store);

      const result = await resolveProjectPaths(deps, '/repos/widget', RUN_ID, 'cb-repo');

      expect(result.identityResolution).toBe('resolved');
    });

    it('is "resolved" for a folder codebase', async () => {
      const store = makeStore({
        getCodebase: mock(async () => ({
          id: 'cb-folder',
          name: 'My Platform',
          repository_url: null,
          default_cwd: '/tmp/platform',
          kind: 'folder' as const,
        })),
      });
      const deps = makeDeps(store);

      const result = await resolveProjectPaths(deps, '/tmp/platform', RUN_ID, 'cb-folder');

      expect(result.identityResolution).toBe('resolved');
    });

    it('is "unregistered" when the lookup returns a codebase row that resolves to a cwd key (WARN arm)', async () => {
      const store = makeStore({
        getCodebase: mock(async () => ({
          id: 'cb-noop',
          name: 'orphan',
          repository_url: null,
          default_cwd: '/tmp/.',
          kind: 'repo' as const,
        })),
      });
      const deps = makeDeps(store);

      const result = await resolveProjectPaths(deps, '/tmp/.', RUN_ID, 'cb-noop');

      expect(result.identityResolution).toBe('unregistered');
    });

    it('is "unregistered" when no codebaseId is provided (no lookup attempted)', async () => {
      const deps = makeDeps();

      const result = await resolveProjectPaths(deps, '/some/cwd', RUN_ID);

      expect(result.identityResolution).toBe('unregistered');
    });

    it('is "unregistered" when the lookup returns null (no codebase row)', async () => {
      const store = makeStore({ getCodebase: mock(async () => null) });
      const deps = makeDeps(store);

      const result = await resolveProjectPaths(deps, '/some/cwd', RUN_ID, 'missing-id');

      expect(result.identityResolution).toBe('unregistered');
    });

    it('is "faulted" when both getCodebase attempts throw (ERROR arm)', async () => {
      const store = makeStore({
        getCodebase: mock(async () => {
          throw new Error('db down');
        }),
      });
      const deps = makeDeps(store);

      const result = await resolveProjectPaths(deps, '/some/cwd', RUN_ID, 'cb-boom');

      expect(result.identityResolution).toBe('faulted');
    });

    it('is undefined on the persisted-output-root short-circuit (resume reading an existing row)', async () => {
      // A resume reads its `output_root` from the row and re-derives nothing; the
      // persistence block has nothing to flag on a branch that never resolved.
      const store = makeStore();
      const deps = makeDeps(store);

      const result = await resolveProjectPaths(deps, '/repos/widget', RUN_ID, 'cb-repo', {
        persistedOutputRoot: wsPath('acme', 'original'),
      });

      expect(result.identityResolution).toBeUndefined();
      // The resolved paths still come from the persisted root, not from a fresh lookup.
      expect(result.outputRoot).toBe(wsPath('acme', 'original'));
    });
  });
});

describe('resolveScopeArtifactsDir', () => {
  // join()-built: getScopeArtifactsPath composes with join(), so a template
  // literal expectation is forward-slashed and never matches on win32.
  const ROOT = join('/tmp', 'artifacts-root');
  const scopeDir = (wf: string, scope: string): string => join(ROOT, 'scopes', wf, scope);

  it('returns the scope dir for a workflow with a persist_session node', () => {
    const workflow = {
      name: 'feature-dev',
      nodes: [
        {
          id: 'planner',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'plan' },
          persist_session: true,
        },
      ] as WorkflowDefinition['nodes'],
    };
    expect(resolveScopeArtifactsDir(workflow, 'conv-1', ROOT)).toBe(
      scopeDir('feature-dev', 'conv-1')
    );
  });

  it('returns the scope dir for workflow-level persist_sessions', () => {
    const workflow = {
      name: 'feature-dev',
      persist_sessions: true,
      nodes: [
        { id: 'planner', kind: 'agent', source: { kind: 'inline', prompt: 'plan' } },
      ] as WorkflowDefinition['nodes'],
    };
    expect(resolveScopeArtifactsDir(workflow, 'conv-1', ROOT)).toBe(
      scopeDir('feature-dev', 'conv-1')
    );
  });

  it('returns undefined when the workflow uses no session persistence (opt-in)', () => {
    const workflow = {
      name: 'plain',
      nodes: [
        { id: 'a', kind: 'agent', source: { kind: 'inline', prompt: 'x' } },
      ] as WorkflowDefinition['nodes'],
    };
    expect(resolveScopeArtifactsDir(workflow, 'conv-1', ROOT)).toBeUndefined();
  });

  it('returns undefined when the only AI node opts out with context: fresh', () => {
    const workflow = {
      name: 'feature-dev',
      persist_sessions: true,
      nodes: [
        { id: 'a', kind: 'agent', source: { kind: 'inline', prompt: 'x' }, context: 'fresh' },
        { id: 'b', kind: 'exec', runtime: 'sh', script: 'echo hi' },
      ] as WorkflowDefinition['nodes'],
    };
    expect(resolveScopeArtifactsDir(workflow, 'conv-1', ROOT)).toBeUndefined();
  });

  it('returns undefined without a conversation scope (same guard as persistScopeKey)', () => {
    const workflow = {
      name: 'feature-dev',
      persist_sessions: true,
      nodes: [] as WorkflowDefinition['nodes'],
    };
    expect(resolveScopeArtifactsDir(workflow, null, ROOT)).toBeUndefined();
    expect(resolveScopeArtifactsDir(workflow, undefined, ROOT)).toBeUndefined();
  });
});
