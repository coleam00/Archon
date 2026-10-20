import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { homedir, tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'fs';
import { mkdir, writeFile, lstat, readlink, symlink as fsSymlink } from 'fs/promises';
import { removeTempTree, usePathEnvSnapshot } from './test-utils';
import {
  canonicalizeProjectPath,
  toSafeNameSegment,
  parseOwnerRepo,
  resolveRepoProjectIdentity,
  getProjectRoot,
  getProjectSourcePath,
  getProjectWorktreesPath,
  getProjectArtifactsPath,
  getProjectLogsPath,
  sanitizeScopeSegment,
  resolveProjectStorageKey,
  getProjectStoragePaths,
  projectKeyForStorageRoot,
  projectKeyForCodebase,
  slugifyFolderName,
  getFolderProjectRoot,
  getFolderProjectArtifactsPath,
  getFolderProjectLogsPath,
  ProjectSourceOccupiedError,
  ensureProjectStructure,
  createProjectSourceSymlink,
} from './project-paths';
import { resolveRunStorageRoot, getFolderRunArtifactsPath } from './run-paths';

const isWindows = process.platform === 'win32';
const cwdDigest = (cwd: string): string => createHash('sha256').update(resolve(cwd)).digest('hex');

describe('project-paths', () => {
  usePathEnvSnapshot();

  describe('canonicalizeProjectPath', () => {
    let canonRoot: string;

    beforeEach(async () => {
      canonRoot = join(tmpdir(), `archon-canon-${String(Date.now())}-${String(Math.random())}`);
      await mkdir(canonRoot, { recursive: true });
    });

    afterEach(async () => {
      await removeTempTree(canonRoot);
    });

    test('collapses two spellings of one directory to a single string', async () => {
      // This is the whole job: exact-string lookups only find a row when the
      // path the reader holds and the path the writer held canonicalize alike.
      // `'junction'` is ignored on POSIX and is the Windows link type that
      // needs no elevated privileges.
      const target = join(canonRoot, 'project');
      const link = join(canonRoot, 'project-link');
      await mkdir(target);
      await fsSymlink(target, link, 'junction');

      expect(await canonicalizeProjectPath(link)).toBe(await canonicalizeProjectPath(target));
    });

    test('is idempotent', async () => {
      const once = await canonicalizeProjectPath(canonRoot);
      expect(await canonicalizeProjectPath(once)).toBe(once);
    });

    test('expands ~ and makes the result absolute', async () => {
      expect(await canonicalizeProjectPath('~')).toBe(await canonicalizeProjectPath(homedir()));
    });

    test('falls back to the absolute path instead of throwing when it cannot resolve', async () => {
      // Callers rely on always getting a string back: a reader needs a value to
      // miss its lookup with, and `registerFolder` reports the real errno from
      // its own `stat` rather than from here.
      const missing = join(canonRoot, 'no-such-dir');
      expect(await canonicalizeProjectPath(missing)).toBe(missing);
    });
  });

  describe('parseOwnerRepo', () => {
    test('parses owner/repo format', () => {
      expect(parseOwnerRepo('acme/widget')).toEqual({ owner: 'acme', repo: 'widget' });
    });

    test('returns null for bare name', () => {
      expect(parseOwnerRepo('widget')).toBeNull();
    });

    test('accepts any segment made safe by toSafeNameSegment', () => {
      expect(parseOwnerRepo(`_local/${toSafeNameSegment('org/team app~ü')}-2`)).toEqual({
        owner: '_local',
        repo: 'org-team-app---2',
      });
    });

    test('returns null for empty string', () => {
      expect(parseOwnerRepo('')).toBeNull();
    });

    test('returns null for trailing slash', () => {
      expect(parseOwnerRepo('acme/')).toBeNull();
    });

    test('returns null for leading slash', () => {
      expect(parseOwnerRepo('/widget')).toBeNull();
    });

    test('rejects nested paths with more than one slash', () => {
      const result = parseOwnerRepo('acme/nested/widget');
      expect(result).toBeNull();
    });

    test('rejects path traversal in owner', () => {
      expect(parseOwnerRepo('../etc/passwd')).toBeNull();
    });

    test('rejects path traversal in repo', () => {
      expect(parseOwnerRepo('acme/../../etc')).toBeNull();
    });

    test('rejects dot and dotdot segments', () => {
      expect(parseOwnerRepo('./widget')).toBeNull();
      expect(parseOwnerRepo('acme/..')).toBeNull();
      expect(parseOwnerRepo('../widget')).toBeNull();
      expect(parseOwnerRepo('.')).toBeNull();
    });

    test('accepts valid GitHub-style names with dots, hyphens, underscores', () => {
      expect(parseOwnerRepo('my-org/my_repo.js')).toEqual({
        owner: 'my-org',
        repo: 'my_repo.js',
      });
    });

    test('rejects names with spaces', () => {
      expect(parseOwnerRepo('my org/repo')).toBeNull();
    });

    test('rejects names with special characters', () => {
      expect(parseOwnerRepo('acme/repo;rm -rf')).toBeNull();
      expect(parseOwnerRepo('acme/$HOME')).toBeNull();
    });
  });

  describe('resolveRepoProjectIdentity', () => {
    test('returns parsed owner/repo for an owner/repo name', () => {
      expect(resolveRepoProjectIdentity('acme/widget', '/repos/widget')).toEqual({
        owner: 'acme',
        repo: 'widget',
      });
    });

    test('scopes a no-remote bare name under _local/<basename(cwd)>', () => {
      expect(resolveRepoProjectIdentity('workspace', '/home/username/workspace')).toEqual({
        owner: '_local',
        repo: 'workspace',
      });
    });

    test('derives the repo segment from cwd, not the name', () => {
      // Name and directory basename can differ; the on-disk tree registration
      // creates is keyed off the directory basename.
      expect(resolveRepoProjectIdentity('some-name', '/srv/projects/checkout')).toEqual({
        owner: '_local',
        repo: 'checkout',
      });
    });

    test('preserves a basename registration would have used verbatim (spaces allowed)', () => {
      expect(resolveRepoProjectIdentity('my app', '/home/u/my app')).toEqual({
        owner: '_local',
        repo: 'my app',
      });
    });

    test('returns null for a dotdot basename (no path escape)', () => {
      expect(resolveRepoProjectIdentity('workspace', '/home/u/..')).toBeNull();
    });

    test('returns null for a dot or empty basename', () => {
      expect(resolveRepoProjectIdentity('workspace', '/home/u/.')).toBeNull();
      expect(resolveRepoProjectIdentity('workspace', '/')).toBeNull();
    });
  });

  describe('resolveProjectStorageKey', () => {
    test('folder-kind codebase resolves to a slugified _folder key', () => {
      expect(
        resolveProjectStorageKey(
          { kind: 'folder', name: 'My Ops Folder', default_cwd: '/srv/ops' },
          '/srv/ops'
        )
      ).toEqual({ kind: 'folder', slug: 'my-ops-folder' });
    });

    test('owner/repo name resolves to a repo key', () => {
      expect(
        resolveProjectStorageKey(
          { kind: 'repo', name: 'acme/widget', default_cwd: '/repos/widget' },
          '/repos/widget'
        )
      ).toEqual({ kind: 'repo', owner: 'acme', repo: 'widget' });
    });

    test('bare-basename name resolves to the _local pseudo-owner', () => {
      expect(
        resolveProjectStorageKey(
          { kind: 'repo', name: 'workspace', default_cwd: '/home/u/workspace' },
          '/home/u/workspace'
        )
      ).toEqual({ kind: 'repo', owner: '_local', repo: 'workspace' });
    });

    test('absent kind (pre-column rows) is treated as repo-kind', () => {
      expect(
        resolveProjectStorageKey({ name: 'acme/widget', default_cwd: '/repos/widget' }, '/repos/w')
      ).toEqual({ kind: 'repo', owner: 'acme', repo: 'widget' });
      expect(
        resolveProjectStorageKey(
          { kind: null, name: 'acme/widget', default_cwd: '/repos/widget' },
          '/repos/w'
        )
      ).toEqual({ kind: 'repo', owner: 'acme', repo: 'widget' });
    });

    test('null / undefined codebase falls back to the cwd key', () => {
      expect(resolveProjectStorageKey(null, '/tmp/scratch')).toEqual({
        kind: 'cwd',
        cwd: '/tmp/scratch',
      });
      expect(resolveProjectStorageKey(undefined, '/tmp/scratch')).toEqual({
        kind: 'cwd',
        cwd: '/tmp/scratch',
      });
    });

    test('unresolvable repo identity falls back to the cwd key', () => {
      // `default_cwd` basename is `..`, so resolveRepoProjectIdentity returns null.
      expect(
        resolveProjectStorageKey(
          { kind: 'repo', name: 'workspace', default_cwd: '/home/u/..' },
          '/tmp/scratch'
        )
      ).toEqual({ kind: 'cwd', cwd: '/tmp/scratch' });
    });
  });

  describe('project keys', () => {
    beforeEach(() => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
    });

    test('each storage key kind yields its workspace-relative key', () => {
      expect(
        projectKeyForCodebase(
          { kind: 'repo', name: 'acme/widget', default_cwd: '/repos/widget' },
          '/repos/widget'
        )
      ).toBe('acme/widget');
      expect(
        projectKeyForCodebase(
          { kind: 'folder', name: 'My Ops Folder', default_cwd: '/srv/ops' },
          '/srv/ops'
        )
      ).toBe('_folder/my-ops-folder');
      expect(projectKeyForCodebase(null, '/home/u/scratch-repo')).toBe(
        `@cwd/scratch-repo-${cwdDigest('/home/u/scratch-repo')}`
      );
    });

    test('a storage root and the codebase it came from give the same key', () => {
      const codebase = { kind: 'repo', name: 'acme/widget', default_cwd: '/repos/widget' };
      const root = resolveRunStorageRoot({ output_root: null }, codebase);
      if (!root) throw new Error('Expected a storage root');
      expect(projectKeyForStorageRoot(root)).toBe(
        projectKeyForCodebase(codebase, codebase.default_cwd)
      );
    });

    test('a first segment that merely starts with two dots is still a key', () => {
      expect(projectKeyForStorageRoot(join('/custom/archon', 'workspaces', '..foo', 'bar'))).toBe(
        '..foo/bar'
      );
    });

    test('a root outside the workspaces directory has no key', () => {
      for (const root of ['/elsewhere/acme/widget', join('/custom/archon', 'workspaces')])
        expect(() => projectKeyForStorageRoot(root)).toThrow('not inside the workspaces directory');
    });
  });

  describe('getProjectStoragePaths', () => {
    beforeEach(() => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
    });

    test('repo key composes every root under owner/repo', () => {
      const root = join('/custom/archon', 'workspaces', 'acme', 'widget');
      expect(getProjectStoragePaths({ kind: 'repo', owner: 'acme', repo: 'widget' })).toEqual({
        root,
        artifactsRoot: join(root, 'artifacts'),
        logsDir: join(root, 'logs'),
        stateRoot: join(root, 'state'),
        workflowSourceRoot: join(root, 'workflow-source'),
      });
    });

    test('folder key composes every root under _folder/<slug>', () => {
      const root = join('/custom/archon', 'workspaces', '_folder', 'my-ops-folder');
      expect(getProjectStoragePaths({ kind: 'folder', slug: 'my-ops-folder' })).toEqual({
        root,
        artifactsRoot: join(root, 'artifacts'),
        logsDir: join(root, 'logs'),
        stateRoot: join(root, 'state'),
        workflowSourceRoot: join(root, 'workflow-source'),
      });
    });

    test('cwd key resolves UNDER ARCHON_HOME at @cwd/<basename>-<digest>, never into the repo', () => {
      const paths = getProjectStoragePaths({ kind: 'cwd', cwd: '/home/u/scratch-repo' });
      const root = join(
        '/custom/archon',
        'workspaces',
        '@cwd',
        `scratch-repo-${cwdDigest('/home/u/scratch-repo')}`
      );
      expect(paths).toEqual({
        root,
        artifactsRoot: join(root, 'artifacts'),
        logsDir: join(root, 'logs'),
        stateRoot: join(root, 'state'),
        workflowSourceRoot: join(root, 'workflow-source'),
      });
      // Build both expectations with join() — on Windows the separators differ
      // from the POSIX literals and a hard-coded '/custom/archon' never matches.
      expect(paths.root.startsWith(join('/custom/archon', 'workspaces'))).toBe(true);
      expect(paths.root).not.toContain(join('.archon', 'artifacts'));
    });

    test('cwd namespace cannot be a registered repo owner or a legacy cwd or folder root', () => {
      const root = getProjectStoragePaths({ kind: 'cwd', cwd: '/a/notes' }).root;
      const key = projectKeyForStorageRoot(root);
      const [owner] = key.split('/');
      expect(parseOwnerRepo(key)).toBeNull();
      expect(owner).toBe('@cwd');
      expect(owner).not.toBe('_cwd');
      expect(owner).not.toBe('_folder');
      expect(owner).not.toBe('_local');
    });

    test('same-basename directories and sanitization collisions have separate state', () => {
      const state = (cwd: string) =>
        getProjectStoragePaths(resolveProjectStorageKey(null, cwd)).stateRoot;
      expect(state('/a/notes')).not.toBe(state('/b/notes'));
      expect(state('/a/my notes')).not.toBe(state('/a/my_notes'));
      expect(state('/a/notes')).toBe(state('/a/other/../notes/'));
      expect(state('notes')).toBe(state(join(process.cwd(), 'notes')));
    });

    test('a long cwd basename leaves room for the digest in the filesystem segment', () => {
      const root = getProjectStoragePaths({ kind: 'cwd', cwd: join('/a', 'n'.repeat(255)) }).root;
      expect(basename(root).length).toBe(255);
      expect(basename(root)).toBe(`${'n'.repeat(190)}-${cwdDigest(join('/a', 'n'.repeat(255)))}`);
    });

    test('cwd basename is sanitised to a single traversal-safe segment', () => {
      expect(getProjectStoragePaths({ kind: 'cwd', cwd: '/home/u/my repo.v2' }).root).toBe(
        join(
          '/custom/archon',
          'workspaces',
          '@cwd',
          `my_repo_v2-${cwdDigest('/home/u/my repo.v2')}`
        )
      );
      // basename('/') is '' → the `_` fallback, not an empty segment.
      expect(getProjectStoragePaths({ kind: 'cwd', cwd: '/' }).root).toBe(
        join('/custom/archon', 'workspaces', '@cwd', `_-${cwdDigest('/')}`)
      );
    });

    test('agrees with the per-kind helpers it replaces', () => {
      expect(getProjectStoragePaths({ kind: 'repo', owner: 'acme', repo: 'widget' })).toMatchObject(
        {
          artifactsRoot: getProjectArtifactsPath('acme', 'widget'),
          logsDir: getProjectLogsPath('acme', 'widget'),
        }
      );
      expect(getProjectStoragePaths({ kind: 'folder', slug: 'ops' })).toMatchObject({
        artifactsRoot: getFolderProjectArtifactsPath('ops'),
        logsDir: getFolderProjectLogsPath('ops'),
      });
    });
  });

  describe('getProjectRoot', () => {
    test('returns path under workspaces', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      const result = getProjectRoot('acme', 'widget');
      expect(result).toBe(join(homedir(), '.archon', 'workspaces', 'acme', 'widget'));
    });

    test('respects ARCHON_HOME', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      expect(getProjectRoot('acme', 'widget')).toBe(
        join('/custom/archon', 'workspaces', 'acme', 'widget')
      );
    });

    test('works in Docker', () => {
      process.env.ARCHON_DOCKER = 'true';
      expect(getProjectRoot('acme', 'widget')).toBe(
        join('/', '.archon', 'workspaces', 'acme', 'widget')
      );
    });
  });

  describe('getProjectSourcePath', () => {
    test('appends source/ to project root', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getProjectSourcePath('acme', 'widget')).toBe(
        join(homedir(), '.archon', 'workspaces', 'acme', 'widget', 'source')
      );
    });
  });

  describe('getProjectWorktreesPath', () => {
    test('appends worktrees/ to project root', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getProjectWorktreesPath('acme', 'widget')).toBe(
        join(homedir(), '.archon', 'workspaces', 'acme', 'widget', 'worktrees')
      );
    });
  });

  describe('getProjectArtifactsPath', () => {
    test('appends artifacts/ to project root', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getProjectArtifactsPath('acme', 'widget')).toBe(
        join(homedir(), '.archon', 'workspaces', 'acme', 'widget', 'artifacts')
      );
    });
  });

  describe('getProjectLogsPath', () => {
    test('appends logs/ to project root', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getProjectLogsPath('acme', 'widget')).toBe(
        join(homedir(), '.archon', 'workspaces', 'acme', 'widget', 'logs')
      );
    });
  });

  describe('sanitizeScopeSegment', () => {
    test('keeps safe characters unchanged', () => {
      expect(sanitizeScopeSegment('my-workflow_v2')).toBe('my-workflow_v2');
      expect(sanitizeScopeSegment('550e8400-e29b-41d4-a716-446655440000')).toBe(
        '550e8400-e29b-41d4-a716-446655440000'
      );
    });

    test('replaces path separators and dots so a segment cannot escape', () => {
      expect(sanitizeScopeSegment('../../etc')).toBe('______etc');
      expect(sanitizeScopeSegment('a/b\\c')).toBe('a_b_c');
      expect(sanitizeScopeSegment('owner/repo#123')).toBe('owner_repo_123');
    });

    test('falls back to underscore for an empty input', () => {
      expect(sanitizeScopeSegment('')).toBe('_');
    });
  });

  describe('slugifyFolderName', () => {
    test('lowercases and keeps safe characters', () => {
      expect(slugifyFolderName('Platform')).toBe('platform');
      expect(slugifyFolderName('my_app.v2-beta')).toBe('my_app.v2-beta');
    });

    test('replaces spaces and unsafe runs with a single dash', () => {
      expect(slugifyFolderName('My App')).toBe('my-app');
      expect(slugifyFolderName('a  //  b')).toBe('a-b');
      expect(slugifyFolderName('ops client!!!folder')).toBe('ops-client-folder');
    });

    test('trims leading/trailing dashes', () => {
      expect(slugifyFolderName('  spaced  ')).toBe('spaced');
      expect(slugifyFolderName('***edge***')).toBe('edge');
    });

    test('falls back to "folder" for names that slugify to empty', () => {
      expect(slugifyFolderName('///')).toBe('folder');
      expect(slugifyFolderName('日本語')).toBe('folder');
      expect(slugifyFolderName('')).toBe('folder');
    });

    test('output always satisfies SAFE_NAME (via path helpers)', () => {
      // A slug that produces a valid single path segment (no separators)
      for (const name of ['My App', 'a/b/c', '  x  ', 'café résumé']) {
        const slug = slugifyFolderName(name);
        expect(slug).toMatch(/^[a-zA-Z0-9._-]+$/);
      }
    });
  });

  describe('folder-project paths', () => {
    function clearEnv(): void {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
    }

    test('getFolderProjectRoot returns _folder/<slug>/', () => {
      clearEnv();
      expect(getFolderProjectRoot('platform')).toBe(
        join(homedir(), '.archon', 'workspaces', '_folder', 'platform')
      );
    });

    test('getFolderProjectArtifactsPath returns _folder/<slug>/artifacts/', () => {
      clearEnv();
      expect(getFolderProjectArtifactsPath('platform')).toBe(
        join(homedir(), '.archon', 'workspaces', '_folder', 'platform', 'artifacts')
      );
    });

    test('getFolderProjectLogsPath returns _folder/<slug>/logs/', () => {
      clearEnv();
      expect(getFolderProjectLogsPath('platform')).toBe(
        join(homedir(), '.archon', 'workspaces', '_folder', 'platform', 'logs')
      );
    });

    test('getFolderRunArtifactsPath returns _folder/<slug>/artifacts/runs/{id}/', () => {
      clearEnv();
      expect(getFolderRunArtifactsPath('platform', 'run-123')).toBe(
        join(
          homedir(),
          '.archon',
          'workspaces',
          '_folder',
          'platform',
          'artifacts',
          'runs',
          'run-123'
        )
      );
    });

    test('respects ARCHON_HOME override', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = join('/', 'custom', 'archon');
      expect(getFolderRunArtifactsPath('ops', 'r1')).toBe(
        join('/', 'custom', 'archon', 'workspaces', '_folder', 'ops', 'artifacts', 'runs', 'r1')
      );
    });
  });
});

describe('ensureProjectStructure', () => {
  let tempArchonHome: string;
  usePathEnvSnapshot();

  beforeEach(async () => {
    delete process.env.WORKSPACE_PATH;
    delete process.env.ARCHON_DOCKER;
    tempArchonHome = join(
      tmpdir(),
      `archon-paths-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    process.env.ARCHON_HOME = tempArchonHome;
  });

  afterEach(async () => {
    await removeTempTree(tempArchonHome);
  });

  test('creates all four project subdirectories', async () => {
    await ensureProjectStructure('acme', 'widget');

    const sourcePath = getProjectSourcePath('acme', 'widget');
    const worktreesPath = getProjectWorktreesPath('acme', 'widget');
    const artifactsPath = getProjectArtifactsPath('acme', 'widget');
    const logsPath = getProjectLogsPath('acme', 'widget');

    // All directories should exist
    expect((await lstat(sourcePath)).isDirectory()).toBe(true);
    expect((await lstat(worktreesPath)).isDirectory()).toBe(true);
    expect((await lstat(artifactsPath)).isDirectory()).toBe(true);
    expect((await lstat(logsPath)).isDirectory()).toBe(true);
  });

  test('is idempotent - safe to call twice', async () => {
    await ensureProjectStructure('acme', 'widget');
    await ensureProjectStructure('acme', 'widget');

    const sourcePath = getProjectSourcePath('acme', 'widget');
    expect((await lstat(sourcePath)).isDirectory()).toBe(true);
  });

  test('reports a file at the source path as an occupied source', async () => {
    const sourcePath = getProjectSourcePath('acme', 'widget');
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, 'foreign');

    const error = await ensureProjectStructure('acme', 'widget').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProjectSourceOccupiedError);
    expect(error).toMatchObject({ sourcePath });
  });
});

describe('createProjectSourceSymlink', () => {
  let tempArchonHome: string;
  let tempTarget: string;
  usePathEnvSnapshot();

  beforeEach(async () => {
    delete process.env.WORKSPACE_PATH;
    delete process.env.ARCHON_DOCKER;
    tempArchonHome = join(
      tmpdir(),
      `archon-symlink-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    process.env.ARCHON_HOME = tempArchonHome;

    tempTarget = join(
      tmpdir(),
      `archon-target-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(tempTarget, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(tempArchonHome);
    await removeTempTree(tempTarget);
  });

  test.skipIf(isWindows)('creates a symlink pointing to the target', async () => {
    await ensureProjectStructure('acme', 'widget');
    await createProjectSourceSymlink('acme', 'widget', tempTarget);

    const linkPath = getProjectSourcePath('acme', 'widget');
    const stats = await lstat(linkPath);
    expect(stats.isSymbolicLink()).toBe(true);
    expect(await readlink(linkPath)).toBe(tempTarget);
  });

  test.skipIf(isWindows)('is a no-op if symlink already points to same target', async () => {
    await ensureProjectStructure('acme', 'widget');
    await createProjectSourceSymlink('acme', 'widget', tempTarget);
    // Call again - should not throw
    await createProjectSourceSymlink('acme', 'widget', tempTarget);

    const linkPath = getProjectSourcePath('acme', 'widget');
    expect(await readlink(linkPath)).toBe(tempTarget);
  });

  test.skipIf(isWindows)('throws when symlink points to a different target', async () => {
    await ensureProjectStructure('acme', 'widget');
    await createProjectSourceSymlink('acme', 'widget', tempTarget);

    const otherTarget = join(tmpdir(), 'other-target');
    await mkdir(otherTarget, { recursive: true });

    try {
      await expect(createProjectSourceSymlink('acme', 'widget', otherTarget)).rejects.toThrow(
        'already points to'
      );
    } finally {
      await removeTempTree(otherTarget);
    }
  });

  test('refuses a populated source belonging to another checkout', async () => {
    await ensureProjectStructure('acme', 'widget');

    // Put a file in the source dir to simulate a clone
    const sourcePath = getProjectSourcePath('acme', 'widget');
    await writeFile(join(sourcePath, 'README.md'), '# Hello');

    await expect(createProjectSourceSymlink('acme', 'widget', tempTarget)).rejects.toThrow(
      'already contains'
    );

    const stats = await lstat(sourcePath);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.isSymbolicLink()).toBe(false);
  });

  test('preserves a populated source when its requested target is missing', async () => {
    await ensureProjectStructure('acme', 'widget');
    const source = getProjectSourcePath('acme', 'widget');
    await writeFile(join(source, 'README.md'), 'foreign checkout');
    await expect(
      createProjectSourceSymlink('acme', 'widget', join(tempTarget, 'missing'))
    ).rejects.toThrow();
    expect(readFileSync(join(source, 'README.md'), 'utf8')).toBe('foreign checkout');
  });

  test('refuses a source path occupied by a regular file', async () => {
    const source = getProjectSourcePath('acme', 'widget');
    await mkdir(getProjectRoot('acme', 'widget'), { recursive: true });
    await writeFile(source, 'operator file');
    await expect(createProjectSourceSymlink('acme', 'widget', tempTarget)).rejects.toThrow(
      'already contains'
    );
    expect(readFileSync(source, 'utf8')).toBe('operator file');
  });

  test('keeps a populated source when registering that directory itself', async () => {
    await ensureProjectStructure('acme', 'widget');
    const source = getProjectSourcePath('acme', 'widget');
    await writeFile(join(source, 'README.md'), '# Hello');
    await createProjectSourceSymlink('acme', 'widget', source);
    expect((await lstat(source)).isDirectory()).toBe(true);
  });

  test.skipIf(isWindows)(
    'replaces empty directory with symlink (ensureProjectStructure case)',
    async () => {
      await ensureProjectStructure('acme', 'widget');

      // source/ is empty from ensureProjectStructure
      await createProjectSourceSymlink('acme', 'widget', tempTarget);

      const linkPath = getProjectSourcePath('acme', 'widget');
      const stats = await lstat(linkPath);
      expect(stats.isSymbolicLink()).toBe(true);
      expect(await readlink(linkPath)).toBe(tempTarget);
    }
  );

  test.skipIf(isWindows)('creates symlink when source path does not exist', async () => {
    // Only create the parent, not the source dir itself
    const projectRoot = getProjectRoot('acme', 'widget');
    await mkdir(projectRoot, { recursive: true });

    await createProjectSourceSymlink('acme', 'widget', tempTarget);

    const linkPath = getProjectSourcePath('acme', 'widget');
    const stats = await lstat(linkPath);
    expect(stats.isSymbolicLink()).toBe(true);
  });
});
