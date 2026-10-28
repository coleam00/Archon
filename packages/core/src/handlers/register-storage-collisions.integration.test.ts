// @archon-test-isolated
/**
 * Integration test: two folders never share one project storage folder (#1192).
 * Uses a REAL bun:sqlite database, real git checkouts and the real path helpers,
 * because the collision lives in how the stored row maps to a storage root.
 *
 * Runs in its own `bun test` invocation (declared by @archon-test-isolated) — it
 * mock.module's ../db/connection with a real adapter, which conflicts with the
 * fakes other files in this package install.
 */
import { describe, test, expect, mock, afterEach, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { createFileWorkflowHost } from '../workflows/file-host';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { trackTempRoots } from '@archon/paths/test-utils';
import { setLogSink, setLogLevel, getLogLevel, getProjectSourcePath } from '@archon/paths';

const { SqliteAdapter, sqliteDialect } = await import('../db/adapters/sqlite');
const db = new SqliteAdapter(':memory:');

mock.module('../db/connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

import * as git from '@archon/git';
import { cloneRepository, registerRepository as registerInStore } from './clone';

const { registerFolder, registerRepository, ProjectRegistrationError } = await import(
  './sql-registration'
);
const codebases = await import('../db/codebases');
const { createCodebase, createManagedCodebase, findCodebaseByRepoUrl, getCodebase, listCodebases } =
  codebases;
const { getProjectStoragePaths, resolveProjectStorageKey } = await import('@archon/paths');
const { getWorktreeBase, toRepoPath } = await import('@archon/git');

const trackTempRoot = trackTempRoots();
const initialArchonHome = process.env.ARCHON_HOME;
const initialLogLevel = getLogLevel();
afterEach(async () => {
  setLogSink(undefined);
  setLogLevel(initialLogLevel);
  if (initialArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = initialArchonHome;
  await db.query('DELETE FROM remote_agent_codebases');
});

/** A fresh ARCHON_HOME and a root for the operator's own checkouts. */
async function makeHome(): Promise<string> {
  const root = trackTempRoot(await realpath(await mkdtemp(join(tmpdir(), 'archon-collide-'))));
  process.env.ARCHON_HOME = join(root, '.archon');
  return root;
}

async function gitCheckout(path: string, remote?: string): Promise<string> {
  await mkdir(path, { recursive: true });
  execFileSync('git', ['-C', path, 'init', '-q']);
  if (remote) execFileSync('git', ['-C', path, 'remote', 'add', 'origin', remote]);
  return path;
}

async function storageRoot(codebaseId: string): Promise<string> {
  const codebase = await getCodebase(codebaseId);
  if (!codebase) throw new Error(`codebase ${codebaseId} missing`);
  return getProjectStoragePaths(resolveProjectStorageKey(codebase, codebase.default_cwd)).root;
}

describe('project storage collisions', () => {
  test.each([
    { backend: 'sql', entry: 'url' },
    { backend: 'sql', entry: 'path' },
    { backend: 'file', entry: 'url' },
    { backend: 'file', entry: 'path' },
  ] as const)(
    'saved remote ownership is verified on $entry reuse ($backend)',
    async ({ backend, entry }) => {
      const root = await makeHome();
      const store =
        backend === 'sql'
          ? codebases
          : (await createFileWorkflowHost(join(root, 'store'))).records.codebases;
      const path = await gitCheckout(join(root, 'api'), 'https://github.com/acme/api.git');
      const saved = await registerInStore(store, path);
      execFileSync('git', [
        '-C',
        path,
        'remote',
        'set-url',
        'origin',
        'https://github.com/foreign/api.git',
      ]);
      await expect(
        entry === 'url'
          ? cloneRepository(store, 'https://github.com/acme/api.git')
          : registerInStore(store, path)
      ).rejects.toThrow('/update-project');
      expect((await store.listCodebases()).map(row => row.id)).toEqual([saved.codebaseId]);
    }
  );

  test('a saved relative URL cannot prove ownership through a remote name on path reuse', async () => {
    const root = await makeHome();
    const store = codebases;
    const foreignUrl = 'https://foreign.invalid/other/repo.git';
    const path = await gitCheckout(join(root, 'api'), foreignUrl);
    const savedUrl = 'upstream.git';
    execFileSync('git', ['-C', path, 'remote', 'add', savedUrl, foreignUrl]);
    const saved = await store.createCodebase({
      name: 'local-api',
      default_cwd: path,
      repository_url: savedUrl,
    });
    await expect(registerInStore(store, path)).rejects.toThrow('/update-project');
    expect(await store.listCodebases()).toMatchObject([
      { id: saved.id, default_cwd: path, repository_url: savedUrl },
    ]);
    expect(await store.listCodebases()).toHaveLength(1);
  });

  test('a saved relative URL preserves Git rewrites on URL reuse', async () => {
    const root = await makeHome();
    const store = (await createFileWorkflowHost(join(root, 'store'))).records.codebases;
    const savedUrl = '../upstream.git';
    const path = await gitCheckout(getProjectSourcePath('owner', 'api'), savedUrl);
    const foreignUrl = 'https://foreign.invalid/other/repo.git';
    execFileSync('git', ['-C', path, 'remote', 'add', 'archon-ownership', foreignUrl]);
    const saved = await store.createCodebase({
      name: 'owner/api',
      default_cwd: path,
      repository_url: savedUrl,
    });
    const config = join(root, 'gitconfig');
    const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    await writeFile(config, '');
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    try {
      const reuse = () => cloneRepository(store, pathToFileURL(join(path, savedUrl)).href);
      expect(await reuse()).toMatchObject({ codebaseId: saved.id, alreadyExisted: true });
      const destination = 'https://rewrite.invalid/owner/repo.git';
      const rewriteKey = `url.${destination}.insteadOf`;
      execFileSync('git', ['config', '--global', rewriteKey, savedUrl]);
      expect(
        execFileSync('git', ['-C', path, 'remote', 'get-url', 'origin'], {
          encoding: 'utf8',
        }).trim()
      ).toBe(destination);
      expect(await reuse()).toMatchObject({ codebaseId: saved.id, alreadyExisted: true });
      execFileSync('git', ['config', '--global', '--unset', rewriteKey]);
      expect(await reuse()).toMatchObject({ codebaseId: saved.id, alreadyExisted: true });
      execFileSync('git', ['config', '--global', rewriteKey, savedUrl]);
      execFileSync('git', ['-C', path, 'remote', 'set-url', 'origin', foreignUrl]);
      await expect(reuse()).rejects.toThrow('/update-project');
      expect(await store.listCodebases()).toMatchObject([
        { id: saved.id, default_cwd: path, repository_url: savedUrl },
      ]);
      expect(await store.listCodebases()).toHaveLength(1);
      expect(
        execFileSync('git', ['-C', path, 'remote'], { encoding: 'utf8' }).trim().split('\n')
      ).toEqual(['archon-ownership', 'origin']);
    } finally {
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
      if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
    }
  });

  test.each([
    { backend: 'sql', scheme: 'https', entry: 'url' },
    { backend: 'sql', scheme: 'file', entry: 'path' },
    { backend: 'file', scheme: 'https', entry: 'path' },
    { backend: 'file', scheme: 'file', entry: 'url' },
  ] as const)(
    '$entry reuse preserves the requested $scheme URL across Git rewrites ($backend)',
    async ({ backend, scheme, entry }) => {
      const root = await makeHome();
      const store =
        backend === 'sql'
          ? codebases
          : (await createFileWorkflowHost(join(root, 'store'))).records.codebases;
      const upstream = join(root, 'bare upstream.git');
      const config = join(root, 'gitconfig');
      const requestedUrl =
        scheme === 'https'
          ? 'https://rewrite.invalid/owner/repo.git'
          : pathToFileURL(join(root, 'requested', 'repo.git')).href;
      const destination = pathToFileURL(upstream).href;
      const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
      const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
      await writeFile(config, '');
      process.env.GIT_CONFIG_GLOBAL = config;
      process.env.GIT_CONFIG_NOSYSTEM = '1';
      try {
        execFileSync('git', ['init', '--bare', '-q', upstream]);
        const rewriteKey = `url.${destination}.insteadOf`;
        execFileSync('git', ['config', '--global', rewriteKey, requestedUrl]);
        const saved = await cloneRepository(store, requestedUrl);
        expect(saved.alreadyExisted).toBe(false);
        const rows = await store.listCodebases();
        expect(rows).toHaveLength(1);
        const path = rows[0]!.default_cwd;
        expect(
          execFileSync('git', ['-C', path, 'config', '--get', 'remote.origin.url'], {
            encoding: 'utf8',
          }).trim()
        ).toBe(requestedUrl);
        expect(
          execFileSync('git', ['-C', path, 'remote', 'get-url', 'origin'], {
            encoding: 'utf8',
          }).trim()
        ).toBe(destination);
        const reuse = () =>
          entry === 'url' ? cloneRepository(store, requestedUrl) : registerInStore(store, path);
        expect(await reuse()).toMatchObject({ ...saved, alreadyExisted: true });
        if (scheme === 'file') {
          await mkdir(join(root, 'requested', 'repo.git'), { recursive: true });
          expect(await reuse()).toMatchObject({ ...saved, alreadyExisted: true });
        }
        expect(await store.listCodebases()).toMatchObject([
          { id: saved.codebaseId, default_cwd: path, repository_url: requestedUrl },
        ]);
        execFileSync('git', ['config', '--global', '--unset', rewriteKey]);
        expect(await reuse()).toMatchObject({
          codebaseId: saved.codebaseId,
          alreadyExisted: true,
        });
        execFileSync('git', ['config', '--global', rewriteKey, requestedUrl]);
        execFileSync('git', [
          '-C',
          path,
          'remote',
          'set-url',
          'origin',
          'https://foreign.invalid/other/repo.git',
        ]);
        await expect(reuse()).rejects.toThrow('/update-project');
        expect(await store.listCodebases()).toHaveLength(1);
        expect(await store.listCodebases()).toMatchObject([
          { id: saved.codebaseId, default_cwd: path, repository_url: requestedUrl },
        ]);
      } finally {
        if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
        if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
        else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
      }
    }
  );

  test.each(['url', 'path'] as const)(
    'a saved checkout whose config selects another remote is still reused on %s reuse',
    async entry => {
      const root = await makeHome();
      const path = await gitCheckout(join(root, 'api'), 'https://github.com/acme/api.git');
      // Registered before worktree.remote selected a different remote for new worktrees.
      const saved = await createCodebase({
        name: 'acme/api',
        default_cwd: path,
        repository_url: 'https://github.com/acme/api.git',
      });
      execFileSync('git', ['-C', path, 'remote', 'add', 'upstream', 'https://github.com/me/api']);
      await mkdir(join(path, '.archon'));
      await writeFile(join(path, '.archon/config.yaml'), 'worktree:\n  remote: upstream\n');

      const reused = await (entry === 'url'
        ? cloneRepository(codebases, 'https://github.com/acme/api')
        : registerRepository(path));

      expect(reused).toMatchObject({ codebaseId: saved.id, alreadyExisted: true });
    }
  );

  test.each(['checkout', 'file', 'link'] as const)(
    'local registration refuses a source path occupied by a foreign %s before inserting',
    async occupant => {
      const root = await makeHome();
      const path = await gitCheckout(join(root, 'api'), 'https://github.com/acme/api.git');
      const workspace = join(root, '.archon', 'workspaces', 'acme', 'api');
      const source = join(workspace, 'source');
      await mkdir(occupant === 'checkout' ? source : workspace, { recursive: true });
      if (occupant === 'checkout') await writeFile(join(source, 'foreign.txt'), 'foreign');
      else if (occupant === 'file') await writeFile(source, 'foreign');
      else
        await symlink(
          await gitCheckout(join(root, 'other')),
          source,
          process.platform === 'win32' ? 'junction' : 'dir'
        );

      const refusal = await registerRepository(path).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(ProjectRegistrationError);
      expect(refusal instanceof Error && refusal.message).toContain(source);
      expect(await listCodebases()).toHaveLength(0);
    }
  );

  test.each(['sql', 'file'] as const)(
    'relative local remotes retain checkout context (%s)',
    async backend => {
      const root = await makeHome();
      const store =
        backend === 'sql'
          ? codebases
          : (await createFileWorkflowHost(join(root, 'store'))).records.codebases;
      const firstPath = await gitCheckout(join(root, 'a', 'repo'), '../upstream.git');
      const sameRemote = await gitCheckout(join(root, 'a', 'nested', 'repo'), '../../upstream.git');
      const differentRemote = await gitCheckout(join(root, 'b', 'repo'), '../upstream.git');
      const legacy = await store.createCodebase({
        name: 'local-api',
        default_cwd: firstPath,
        repository_url: '../upstream.git',
      });
      const first = await registerInStore(store, firstPath);
      expect(first.codebaseId).toBe(legacy.id);
      await expect(registerInStore(store, sameRemote)).rejects.toThrow(firstPath);
      const second = await registerInStore(store, differentRemote);
      expect(second.codebaseId).not.toBe(first.codebaseId);
      await expect(
        store.createCodebase({
          name: 'bypass',
          default_cwd: sameRemote,
          repository_url: '../../upstream.git',
        })
      ).rejects.toThrow(firstPath);
      expect(await store.listCodebases()).toHaveLength(2);
    }
  );

  test.each(['sql', 'file'] as const)(
    'refuses two clones using physical and symlink paths to one local remote (%s)',
    async backend => {
      const root = await makeHome();
      const store =
        backend === 'sql'
          ? codebases
          : (await createFileWorkflowHost(join(root, 'store'))).records.codebases;
      const remote = join(root, 'upstream.git');
      execFileSync('git', ['init', '--bare', '-q', remote]);
      const alias = join(root, 'alias.git');
      await symlink(remote, alias);
      const firstPath = join(root, 'first');
      const secondPath = join(root, 'second');
      execFileSync('git', ['clone', '-q', remote, firstPath]);
      execFileSync('git', ['clone', '-q', alias, secondPath]);
      const first = await registerInStore(store, firstPath);
      const owner = await store.getCodebase(first.codebaseId);
      expect((await store.findCodebaseByRepoUrl(pathToFileURL(alias).href))?.id).toBe(
        first.codebaseId
      );
      await expect(registerInStore(store, secondPath)).rejects.toThrow(
        `Project "${owner?.name}" is already registered at ${firstPath}`
      );
      await expect(registerInStore(store, secondPath)).rejects.toThrow('worktrees');
      await expect(
        store.createCodebase({
          name: 'bypass',
          default_cwd: secondPath,
          repository_url: pathToFileURL(alias).href,
        })
      ).rejects.toThrow(firstPath);
      expect(await store.listCodebases()).toHaveLength(1);
    }
  );

  test.each(['sql', 'file', 'managed-sql'] as const)(
    'bundle remotes support insertion, lookup and duplicate refusal (%s)',
    async backend => {
      const root = await makeHome();
      const store =
        backend === 'file'
          ? (await createFileWorkflowHost(join(root, 'store'))).records.codebases
          : codebases;
      const upstream = await gitCheckout(join(root, 'upstream'));
      execFileSync('git', [
        '-C',
        upstream,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-qm',
        'Initial',
      ]);
      const bundle = join(root, 'upstream.bundle');
      execFileSync('git', ['-C', upstream, 'bundle', 'create', bundle, '--all']);
      const alias = join(root, 'alias.bundle');
      await symlink(bundle, alias);
      const firstPath = join(root, 'first');
      const secondPath = join(root, 'second');
      execFileSync('git', ['clone', '-q', bundle, firstPath]);
      execFileSync('git', ['clone', '-q', alias, secondPath]);
      const insert = backend === 'managed-sql' ? createManagedCodebase : store.createCodebase;
      const owner = await insert({
        name: 'acme/bundle',
        default_cwd: firstPath,
        repository_url: bundle,
      });
      expect((await store.findCodebaseByRepoUrl(pathToFileURL(alias).href))?.id).toBe(owner.id);
      await expect(registerInStore(store, secondPath)).rejects.toThrow(
        `Project "${owner.name}" is already registered at ${owner.default_cwd}`
      );
      await expect(registerInStore(store, secondPath)).rejects.toThrow('worktrees');
      await expect(
        insert({
          name: 'bypass',
          default_cwd: secondPath,
          repository_url: alias,
        })
      ).rejects.toThrow(owner.default_cwd);
      expect(await store.listCodebases()).toHaveLength(1);
    }
  );

  test.each(['sql', 'file'] as const)(
    'registers the first clone of a bundle remote (%s)',
    async backend => {
      const root = await makeHome();
      const store =
        backend === 'sql'
          ? codebases
          : (await createFileWorkflowHost(join(root, 'store'))).records.codebases;
      const upstream = await gitCheckout(join(root, 'upstream'));
      execFileSync('git', [
        '-C',
        upstream,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-qm',
        'Initial',
      ]);
      const bundle = join(root, 'upstream.bundle');
      execFileSync('git', ['-C', upstream, 'bundle', 'create', bundle, '--all']);
      const checkout = join(root, 'checkout');
      execFileSync('git', ['clone', '-q', bundle, checkout]);
      const result = await registerInStore(store, checkout);
      expect(result.defaultCwd).toBe(checkout);
      expect((await store.findCodebaseByRepoUrl(bundle))?.id).toBe(result.codebaseId);
      expect(await store.listCodebases()).toHaveLength(1);
    }
  );

  test.each(['sql', 'file'] as const)(
    'one local Git repository owns both root and metadata remote URLs (%s)',
    async backend => {
      const root = await makeHome();
      const store =
        backend === 'sql'
          ? codebases
          : (await createFileWorkflowHost(join(root, 'store'))).records.codebases;
      const remote = await gitCheckout(join(root, 'upstream'));
      execFileSync('git', [
        '-C',
        remote,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-qm',
        'Initial',
      ]);
      const firstPath = join(root, 'first');
      const secondPath = join(root, 'second');
      execFileSync('git', ['clone', '-q', remote, firstPath]);
      execFileSync('git', ['clone', '-q', join(remote, '.git'), secondPath]);
      const first = await registerInStore(store, firstPath);
      const owner = await store.getCodebase(first.codebaseId);
      await expect(registerInStore(store, secondPath)).rejects.toThrow(
        `Project "${owner?.name}" is already registered at ${firstPath}`
      );
      await expect(registerInStore(store, secondPath)).rejects.toThrow('worktrees');
      await expect(
        store.createCodebase({
          name: 'bypass',
          default_cwd: secondPath,
          repository_url: pathToFileURL(join(remote, '.git')).href,
        })
      ).rejects.toThrow(firstPath);
      expect(
        (await store.findCodebaseByRepoUrl(pathToFileURL(join(remote, '.git')).href))?.id
      ).toBe(first.codebaseId);
      expect(await store.listCodebases()).toHaveLength(1);
    }
  );

  test.each(['sql', 'file'] as const)(
    'lookup and registration isolate unreadable stored local remotes (%s)',
    async backend => {
      const root = await makeHome();
      const store =
        backend === 'sql'
          ? codebases
          : (await createFileWorkflowHost(join(root, 'store'))).records.codebases;
      const remote = join(root, 'upstream.git');
      execFileSync('git', ['init', '--bare', '-q', remote]);
      const broken = await store.createCodebase({
        name: 'broken',
        default_cwd: join(root, 'broken'),
        repository_url: remote,
      });
      const known = await store.createCodebase({
        name: 'acme/api',
        default_cwd: join(root, 'known'),
        repository_url: 'https://github.com/acme/api',
      });
      await rm(remote, { recursive: true });
      await symlink(remote, remote);
      const warnings: unknown[] = [];
      setLogLevel('warn');
      setLogSink(line => warnings.push(JSON.parse(line)));
      expect((await store.findCodebaseByRepoUrl('git@github.com:acme/api.git'))?.id).toBe(known.id);
      expect(warnings).toEqual([
        expect.objectContaining({
          err: expect.objectContaining({
            type: 'ProjectRegistrationError',
            message: expect.stringContaining(broken.default_cwd),
          }),
        }),
      ]);
      expect(await store.findCodebaseByRepoUrl('https://github.com/acme/unknown')).toBeNull();
      const candidate = await gitCheckout(join(root, 'candidate'), 'https://github.com/acme/new');
      const result = await registerInStore(store, candidate);
      expect(result.alreadyExisted).toBe(false);
      expect(await store.listCodebases()).toHaveLength(3);
    }
  );

  test.each([
    ['sql', false],
    ['file', false],
    ['sql', true],
    ['file', true],
  ] as const)(
    'restores a missing managed checkout at its persisted path (%s, empty directory: %s)',
    async (backend, emptyDirectory) => {
      const root = await makeHome();
      const store =
        backend === 'sql'
          ? codebases
          : (await createFileWorkflowHost(join(root, 'store'))).records.codebases;
      const path = join(root, '.archon/workspaces/acme/api-2/source');
      const url = 'https://github.com/acme/api.git';
      if (emptyDirectory) await mkdir(path, { recursive: true });
      const project = await store.createCodebase({
        name: 'acme/api-2',
        default_cwd: path,
        repository_url: url,
      });
      const clone = spyOn(git, 'cloneRepository').mockImplementation(async (_url, target) => {
        await gitCheckout(target, _url);
        return { ok: true, value: undefined };
      });
      const safe = spyOn(git, 'addSafeDirectory').mockResolvedValue(undefined);
      try {
        const result = await cloneRepository(store, url);
        expect(result.codebaseId).toBe(project.id);
        expect(result.defaultCwd).toBe(path);
        await access(join(path, '.git'));
        expect(clone).toHaveBeenCalledTimes(1);
        expect(await store.listCodebases()).toHaveLength(1);
        await cloneRepository(store, url);
        expect(clone).toHaveBeenCalledTimes(1);
      } finally {
        clone.mockRestore();
        safe.mockRestore();
      }
    }
  );

  test('refuses to recreate a missing operator-owned checkout', async () => {
    const root = await makeHome();
    const path = join(root, 'operator/repo');
    const url = 'https://github.com/acme/api.git';
    await createCodebase({ name: 'acme/api', default_cwd: path, repository_url: url });
    await expect(cloneRepository(codebases, url)).rejects.toThrow(path);
    await expect(access(path)).rejects.toThrow();
  });

  test('managed allocation preserves a local remote relative to the supplied checkout', async () => {
    const root = await makeHome();
    const path = join(root, 'a/repo');
    const project = await createManagedCodebase({
      name: 'acme/api',
      default_cwd: path,
      repository_url: '../upstream.git',
    });
    expect(project.repository_url).toBe(join(root, 'a/upstream.git'));
    expect(
      (await findCodebaseByRepoUrl(pathToFileURL(join(root, 'a/upstream.git')).href))?.id
    ).toBe(project.id);
    await expect(
      createManagedCodebase({
        name: 'other/api',
        default_cwd: join(root, 'a/nested/repo'),
        repository_url: '../../upstream.git',
      })
    ).rejects.toThrow(project.default_cwd);
    expect(await listCodebases()).toHaveLength(1);
  });

  test('forge registrations allocate distinct names, source paths and storage atomically', async () => {
    const root = await makeHome();
    const projects = await Promise.all([
      createManagedCodebase({
        name: 'acme/api',
        default_cwd: join(root, 'source'),
        repository_url: 'https://github.com/acme/api',
      }),
      createManagedCodebase({
        name: 'acme/api',
        default_cwd: join(root, 'source'),
        repository_url: 'https://gitlab.example/acme/api',
      }),
      createManagedCodebase({
        name: 'acme/api',
        default_cwd: join(root, 'source'),
        repository_url: 'https://gitea.example/acme/api',
      }),
    ]);
    expect(projects.map(project => project.name)).toEqual(['acme/api', 'acme/api-2', 'acme/api-3']);
    expect(new Set(projects.map(project => project.default_cwd)).size).toBe(3);
    expect(new Set(await Promise.all(projects.map(project => storageRoot(project.id)))).size).toBe(
      3
    );
  });

  test('nested forge namespaces register with distinct source and storage roots', async () => {
    const root = await makeHome();
    const projects = [];
    for (const host of ['gitlab.example', 'other.example']) {
      projects.push(
        await createManagedCodebase({
          name: 'org/team/subteam/project',
          default_cwd: join(root, '.archon/workspaces/org/team/subteam/project/source'),
          repository_url: `https://${host}/org/team/subteam/project`,
        })
      );
    }
    expect(new Set(projects.map(project => project.default_cwd)).size).toBe(2);
    expect(projects[0].name).toBe('org/team-subteam-project');
    expect(projects[0].default_cwd).toBe(
      join(root, '.archon/workspaces/org/team-subteam-project/source')
    );
    expect(await storageRoot(projects[1].id)).not.toBe(await storageRoot(projects[0].id));
    for (const project of projects) {
      const projectRoot = await storageRoot(project.id);
      expect(project.default_cwd).toBe(join(projectRoot, 'source'));
      expect(getWorktreeBase(toRepoPath(project.default_cwd), project.name).base).toBe(
        join(projectRoot, 'worktrees')
      );
    }
  });

  test.each(['github.com', 'gitlab.example', 'gitea.example'])(
    'forge lookup reuses SSH and URL-less registrations on %s',
    async host => {
      const root = await makeHome();
      const path = await gitCheckout(join(root, 'checkout'), `git@${host}:acme/api.git`);
      const project = await createCodebase({
        name: 'My API',
        default_cwd: path,
        repository_url: `git@${host}:acme/api.git`,
      });
      expect((await findCodebaseByRepoUrl(`https://${host}/acme/api`))?.id).toBe(project.id);
      await db.query('UPDATE remote_agent_codebases SET repository_url = NULL WHERE id = $1', [
        project.id,
      ]);
      expect((await findCodebaseByRepoUrl(`https://${host}/acme/api.git`))?.id).toBe(project.id);
      await expect(
        createManagedCodebase({
          name: 'acme/api',
          default_cwd: join(root, 'managed/source'),
          repository_url: `https://${host}/acme/api`,
        })
      ).rejects.toThrow(path);
      expect(await listCodebases()).toHaveLength(1);
    }
  );

  test.each(['sql', 'file'] as const)(
    '%s lookups route a remote that legacy rows share to the oldest row',
    async backend => {
      const root = await makeHome();
      const store =
        backend === 'sql'
          ? codebases
          : (await createFileWorkflowHost(join(root, 'store'))).records.codebases;
      const first = await store.createCodebase({
        name: 'acme/one',
        default_cwd: await gitCheckout(join(root, 'first'), 'git@github.com:acme/api.git'),
        repository_url: 'git@github.com:acme/api.git',
      });
      const second = await store.createCodebase({
        name: 'acme/two',
        default_cwd: await gitCheckout(join(root, 'second'), 'git@github.com:acme/api.git'),
        repository_url: 'https://other.example/acme/api',
      });
      // Older binaries registered a second clone of a remote as its own row.
      await store.updateCodebase(second, { repository_url: 'ssh://git@github.com/acme/api' });

      // Forge webhooks spell the remote differently from CLI-registered rows.
      for (const url of ['https://github.com/acme/api', 'https://github.com/acme/api.git']) {
        expect((await store.findCodebaseByRepoUrl(url))?.id).toBe(first.id);
      }
      expect((await store.findCodebaseByRepoUrl('ssh://git@github.com/acme/api'))?.id).toBe(
        second.id
      );
      const reused = await cloneRepository(store, 'https://github.com/acme/api');
      expect(reused).toMatchObject({ codebaseId: first.id, alreadyExisted: true });

      const refusal = await store
        .createCodebase({
          name: 'acme/api',
          default_cwd: join(root, 'third'),
          repository_url: 'https://github.com/acme/api.git',
        })
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ProjectRegistrationError);
      expect(refusal instanceof Error && refusal.message).toContain(first.default_cwd);
      expect(await store.listCodebases()).toHaveLength(2);
    }
  );

  test('a persisted match routes past a readable legacy duplicate', async () => {
    const root = await makeHome();
    const known = await createCodebase({
      name: 'acme/api',
      default_cwd: join(root, 'known'),
      repository_url: 'https://github.com/acme/api',
    });
    const legacy = await gitCheckout(join(root, 'legacy'), 'git@github.com:acme/api.git');
    // Listing order is by name, so 'Legacy' comes first; the older row still wins.
    await db.query(
      "INSERT INTO remote_agent_codebases (name, default_cwd, created_at) VALUES ($1, $2, datetime('now', '+1 minute'))",
      ['Legacy', legacy]
    );
    await createCodebase({ name: 'Unavailable', default_cwd: join(root, 'missing') });
    expect((await findCodebaseByRepoUrl('https://github.com/acme/api'))?.id).toBe(known.id);
    expect((await findCodebaseByRepoUrl('git@github.com:acme/api.git'))?.id).toBe(known.id);
  });

  test('an unrelated project with an invalid stored path does not block lookup or registration', async () => {
    const root = await makeHome();
    const known = await createCodebase({
      name: 'acme/api',
      default_cwd: await gitCheckout(join(root, 'known'), 'git@github.com:acme/api.git'),
      repository_url: 'git@github.com:acme/api.git',
    });
    // Rows written before default_cwd validation; reading one must fail only for its own project.
    for (const [name, path] of [
      ['Broken', 'projects/repo'],
      ['Empty', ''],
      ['Here', '.'],
    ]) {
      await db.query('INSERT INTO remote_agent_codebases (name, default_cwd) VALUES ($1, $2)', [
        name,
        path,
      ]);
    }
    // A relative stored path names no checkout, not even this process's directory.
    async function inDirectory<T>(path: string, run: () => Promise<T>): Promise<T> {
      const previous = process.cwd();
      process.chdir(path);
      try {
        return await run();
      } finally {
        process.chdir(previous);
      }
    }

    // Webhook routing: a spelling miss and an unknown remote.
    expect((await findCodebaseByRepoUrl('https://github.com/acme/api'))?.id).toBe(known.id);
    expect(await findCodebaseByRepoUrl('https://github.com/acme/new')).toBeNull();

    // Registration: a refusal, a new remote, the process's own remote, and a folder.
    await expect(
      registerRepository(await gitCheckout(join(root, 'second'), 'https://github.com/acme/api'))
    ).rejects.toThrow(known.default_cwd);
    const cwdCheckout = await gitCheckout(join(root, 'cwd'), 'https://github.com/acme/cwd');
    const own = await inDirectory(cwdCheckout, async () =>
      registerRepository(await gitCheckout(join(root, 'own'), 'https://github.com/acme/cwd'))
    );
    expect(own.alreadyExisted).toBe(false);
    await mkdir(join(root, 'notes'));
    expect((await registerFolder(join(root, 'notes'))).alreadyExisted).toBe(false);

    // Reuse of a linked worktree whose primary keeps its Git directory elsewhere.
    const primary = join(root, 'separate', 'primary');
    const linked = join(root, 'separate', 'linked');
    await mkdir(primary, { recursive: true });
    execFileSync('git', ['-C', primary, 'init', '-q', '--separate-git-dir', join(root, 'meta')]);
    execFileSync('git', ['-C', primary, 'commit', '-q', '--allow-empty', '-m', 'init'], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
    execFileSync('git', ['-C', primary, 'worktree', 'add', '-q', '-b', 'linked', linked]);
    const separate = await registerRepository(primary);
    expect(await inDirectory(primary, () => registerRepository(linked))).toMatchObject({
      codebaseId: separate.codebaseId,
      alreadyExisted: true,
    });

    // /clone: reuse of a registered remote and a fresh clone.
    expect(await cloneRepository(codebases, 'https://github.com/acme/api')).toMatchObject({
      codebaseId: known.id,
      alreadyExisted: true,
    });
    const clone = spyOn(git, 'cloneRepository').mockImplementation(async (_url, path) => {
      await gitCheckout(path, 'https://github.com/acme/new');
      return { ok: true, value: undefined };
    });
    try {
      expect((await cloneRepository(codebases, 'https://github.com/acme/new')).alreadyExisted).toBe(
        false
      );
    } finally {
      clone.mockRestore();
    }

    // Cleanup of an unowned checkout inside the process's directory.
    const stray = await gitCheckout(join(cwdCheckout, 'stray'));
    const remove = mock(async (detached: string) => fsPromises.rm(detached, { recursive: true }));
    await inDirectory(cwdCheckout, () => codebases.removeUnregisteredCheckout(stray, remove));
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test.each(['sql', 'file'] as const)(
    '%s insert-time storage conflicts are registration refusals',
    async backend => {
      const root = await makeHome();
      const store =
        backend === 'sql'
          ? codebases
          : (await createFileWorkflowHost(join(root, 'store'))).records.codebases;
      await store.createCodebase({ name: 'app', kind: 'folder', default_cwd: join(root, 'a') });
      const refusal = await store
        .createCodebase({ name: 'app', kind: 'folder', default_cwd: join(root, 'b') })
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ProjectRegistrationError);
      expect(refusal instanceof Error && refusal.message).toContain('storage');
    }
  );

  test('unreadable incoming remote configuration refuses registration', async () => {
    const root = await makeHome();
    const path = await gitCheckout(join(root, 'incoming'), 'https://github.com/acme/api.git');
    await mkdir(join(path, '.archon'));
    await writeFile(join(path, '.archon/config.yaml'), 'worktree: [');
    await expect(registerRepository(path)).rejects.toThrow(path);
    expect(await listCodebases()).toHaveLength(0);
  });

  test.each(['unowned', 'owned'] as const)(
    'a checkout with several remotes and no origin registers without a URL unless one is %s',
    async state => {
      const root = await makeHome();
      const owner =
        state === 'owned'
          ? await registerRepository(
              await gitCheckout(join(root, 'registered'), 'https://mirror.example/acme/api')
            )
          : null;
      const path = await gitCheckout(join(root, 'incoming'), 'https://github.com/acme/api.git');
      execFileSync('git', ['-C', path, 'remote', 'rename', 'origin', 'upstream']);
      execFileSync('git', [
        '-C',
        path,
        'remote',
        'add',
        'mirror',
        'https://mirror.example/acme/api',
      ]);
      if (owner) {
        await expect(registerRepository(path)).rejects.toThrow(owner.defaultCwd);
        expect(await listCodebases()).toHaveLength(1);
      } else {
        expect(await registerRepository(path)).toMatchObject({
          name: 'incoming',
          repositoryUrl: null,
          defaultCwd: path,
          alreadyExisted: false,
        });
      }
    }
  );

  test.each(['sql', 'file'] as const)(
    'direct %s registration refuses a readable legacy remote owner',
    async backend => {
      const root = await makeHome();
      const store =
        backend === 'sql'
          ? codebases
          : (await createFileWorkflowHost(join(root, 'store'))).records.codebases;
      const path = await gitCheckout(join(root, 'legacy'), 'git@gitlab.example:acme/api.git');
      await store.createCodebase({ name: 'Legacy API', default_cwd: path });
      await expect(
        store.createCodebase({
          name: 'acme/api',
          default_cwd: join(root, 'second'),
          repository_url: 'https://gitlab.example/acme/api',
        })
      ).rejects.toThrow(path);
      expect(await store.listCodebases()).toHaveLength(1);
    }
  );

  test.each([
    ['sql', 'persisted'],
    ['file', 'persisted'],
    ['sql', 'legacy'],
    ['file', 'legacy'],
  ] as const)(
    'direct %s URL-less registration refuses a %s remote owner',
    async (backend, owner) => {
      const root = await makeHome();
      const store =
        backend === 'sql'
          ? codebases
          : (await createFileWorkflowHost(join(root, 'store'))).records.codebases;
      const first = await store.createCodebase({
        name: 'Original API',
        default_cwd: await gitCheckout(join(root, 'first'), 'https://gitlab.example/acme/api'),
        repository_url: owner === 'persisted' ? 'https://gitlab.example/acme/api' : undefined,
      });
      const second = await gitCheckout(join(root, 'second'), 'git@gitlab.example:acme/api.git');
      const error = await store
        .createCodebase({ name: 'Another API', default_cwd: second })
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ProjectRegistrationError);
      expect(error instanceof Error && error.message).toContain(first.name);
      expect(error instanceof Error && error.message).toContain(first.default_cwd);
      expect(error instanceof Error && error.message).toContain('worktrees');
      expect((await store.listCodebases()).map(row => row.id)).toEqual([first.id]);
      expect((await store.findCodebaseByRepoUrl('https://gitlab.example/acme/api'))?.id).toBe(
        first.id
      );
    }
  );

  test.each([
    ['missing', 'persisted', 'sql'],
    ['missing', 'persisted', 'file'],
    ['corrupt', 'persisted', 'sql'],
    ['corrupt', 'persisted', 'file'],
    ['missing', 'legacy', 'sql'],
    ['missing', 'legacy', 'file'],
    ['corrupt', 'legacy', 'sql'],
    ['corrupt', 'legacy', 'file'],
    ['ambiguous', 'legacy', 'sql'],
    ['ambiguous', 'legacy', 'file'],
  ])(
    'remote reuse survives an unrelated %s checkout with a %s owner (%s)',
    async (state, owner, backend) => {
      const root = await makeHome();
      const store =
        backend === 'sql'
          ? codebases
          : (await createFileWorkflowHost(join(root, 'store'))).records.codebases;
      const legacyPath = join(root, 'legacy');
      if (state !== 'missing') {
        await gitCheckout(
          legacyPath,
          state === 'ambiguous' ? 'https://github.com/unknown/api' : undefined
        );
        await mkdir(join(legacyPath, '.archon'));
        if (state === 'corrupt')
          await writeFile(join(legacyPath, '.archon/config.yaml'), 'worktree: [');
        else {
          execFileSync('git', ['-C', legacyPath, 'remote', 'rename', 'origin', 'upstream']);
          execFileSync('git', [
            '-C',
            legacyPath,
            'remote',
            'add',
            'mirror',
            'https://mirror.example/api',
          ]);
        }
      }
      await store.createCodebase({ name: 'Legacy', default_cwd: legacyPath });
      const known = await store.createCodebase({
        name: 'acme/api',
        default_cwd: await gitCheckout(join(root, 'known'), 'https://github.com/acme/api.git'),
        repository_url: owner === 'persisted' ? 'https://github.com/acme/api' : undefined,
      });
      const warnings: unknown[] = [];
      setLogLevel('warn');
      setLogSink(line => warnings.push(JSON.parse(line)));
      expect((await store.findCodebaseByRepoUrl('git@github.com:acme/api.git'))?.id).toBe(known.id);
      // A checkout with several remotes and no origin owns none of them; it is not unreadable.
      if (state === 'ambiguous') {
        expect(await store.findCodebaseByRepoUrl('https://github.com/unknown/api')).toBeNull();
        expect(await store.findCodebaseByRepoUrl('https://mirror.example/api')).toBeNull();
        expect(warnings).toEqual([]);
      } else {
        expect(warnings).toEqual([
          expect.objectContaining({
            level: 40,
            module: 'registration.remote',
            msg: 'registration.lookup_legacy_unavailable',
            err: expect.objectContaining({
              type: 'ProjectRegistrationError',
              message: expect.stringContaining(legacyPath),
            }),
          }),
        ]);
        expect(warnings[0]).toMatchObject({
          err: {
            message: expect.stringContaining(
              state === 'corrupt'
                ? `Cannot read registration config at ${legacyPath}/.archon/config.yaml`
                : 'Remote error: Command failed: git'
            ),
          },
        });
      }
      expect(await store.findCodebaseByRepoUrl('https://github.com/acme/new')).toBeNull();
      const localPath = await gitCheckout(join(root, 'local'), 'https://github.com/acme/local');
      const local = await registerInStore(store, localPath);
      expect(local.alreadyExisted).toBe(false);
      const clone = spyOn(git, 'cloneRepository').mockImplementation(async (_url, path) => {
        await gitCheckout(path, 'https://github.com/acme/new');
        return { ok: true, value: undefined };
      });
      try {
        const reopened = await cloneRepository(store, 'https://github.com/acme/api.git');
        expect(reopened).toMatchObject({ codebaseId: known.id, alreadyExisted: true });
        expect(clone).not.toHaveBeenCalled();
        const fresh = await cloneRepository(store, 'https://github.com/acme/new');
        expect(fresh.alreadyExisted).toBe(false);
        expect(clone).toHaveBeenCalledTimes(1);
        expect(await store.listCodebases()).toHaveLength(4);
      } finally {
        clone.mockRestore();
      }
      if (backend === 'sql') {
        const managed = await createManagedCodebase({
          name: 'acme/managed',
          default_cwd: join(root, 'managed'),
          repository_url: 'https://github.com/acme/managed',
        });
        expect(managed.repository_url).toBe('https://github.com/acme/managed');
      }
    }
  );

  test.each(['remote', 'name'] as const)(
    'removes a new managed checkout when a concurrent %s claim rejects insertion, then retries',
    async claim => {
      const root = await makeHome();
      const url = 'https://github.com/acme/api.git';
      const target = join(root, '.archon', 'workspaces', 'acme', 'api', 'source');
      const ownerPath = join(root, 'other');
      const clone = spyOn(git, 'cloneRepository').mockImplementation(async (_url, path) => {
        await mkdir(join(path, '.git'), { recursive: true });
        return { ok: true, value: undefined };
      });
      const safeDirectory = spyOn(git, 'addSafeDirectory').mockResolvedValue(undefined);
      let insertionError: unknown;
      const racingStore = {
        ...codebases,
        createCodebase: async (input: Parameters<typeof createCodebase>[0]) => {
          await createCodebase({
            name: claim === 'name' ? input.name : 'Remote owner',
            repository_url: claim === 'remote' ? url : 'https://other.example/acme/api.git',
            default_cwd: ownerPath,
          });
          try {
            return await createCodebase(input);
          } catch (error) {
            insertionError = error;
            throw error;
          }
        },
      };
      try {
        const rejected = await cloneRepository(racingStore, url).catch((error: unknown) => error);
        expect(insertionError).toBeInstanceOf(Error);
        expect(rejected).toBe(insertionError);
        expect(String(rejected)).toContain(claim === 'remote' ? 'worktrees' : 'storage');
        await expect(access(target)).rejects.toThrow();
        const [owner] = await listCodebases();
        expect(owner?.default_cwd).toBe(ownerPath);
        expect(await listCodebases()).toHaveLength(1);

        if (claim === 'remote') await codebases.deleteCodebase(owner.id);
        const retried = await cloneRepository(codebases, url);
        const expectedPath = join(
          root,
          '.archon',
          'workspaces',
          'acme',
          claim === 'remote' ? 'api' : 'api-2',
          'source'
        );
        expect(retried.defaultCwd).toBe(expectedPath);
        expect((await getCodebase(retried.codebaseId))?.default_cwd).toBe(expectedPath);
        await access(join(expectedPath, '.git'));
        expect(clone).toHaveBeenCalledTimes(2);
      } finally {
        clone.mockRestore();
        safeDirectory.mockRestore();
      }
    }
  );

  test.each(['remote', 'name'] as const)(
    'a rejected clone preserves a checkout another request registered at its target through a %s claim',
    async claim => {
      const root = await makeHome();
      const url = 'https://github.com/acme/api.git';
      const target = join(root, '.archon', 'workspaces', 'acme', 'api', 'source');
      const clone = spyOn(git, 'cloneRepository').mockImplementation(async (_url, path) => {
        await gitCheckout(path, url);
        return { ok: true, value: undefined };
      });
      const safeDirectory = spyOn(git, 'addSafeDirectory').mockResolvedValue(undefined);
      let ownerId: string | undefined;
      const racingStore = {
        ...codebases,
        createCodebase: async (input: Parameters<typeof createCodebase>[0]) => {
          if (claim === 'remote') {
            ownerId = (await registerRepository(target)).codebaseId;
          } else {
            ownerId = (
              await createCodebase({ ...input, repository_url: 'https://other.example/acme/api' })
            ).id;
          }
          await writeFile(join(target, 'operator-work.txt'), 'keep my work');
          return createCodebase(input);
        },
      };
      try {
        await expect(cloneRepository(racingStore, url)).rejects.toThrow(
          claim === 'remote' ? 'worktrees' : 'storage'
        );
        expect(await readFile(join(target, 'operator-work.txt'), 'utf8')).toBe('keep my work');
        expect(await listCodebases()).toMatchObject([{ id: ownerId, default_cwd: target }]);
        expect(await listCodebases()).toHaveLength(1);
      } finally {
        clone.mockRestore();
        safeDirectory.mockRestore();
      }
    }
  );

  test.each(['sql', 'file'] as const)(
    '%s rejected clone removes its checkout when an independent repository owns the remote',
    async backend => {
      const root = await makeHome();
      const store =
        backend === 'sql'
          ? codebases
          : (await createFileWorkflowHost(join(root, 'store'))).records.codebases;
      const url = 'https://github.com/acme/api.git';
      const target = join(root, '.archon', 'workspaces', 'acme', 'api', 'source');
      const ownerPath = await gitCheckout(join(root, 'independent'), url);
      await writeFile(join(ownerPath, 'operator-work.txt'), 'keep my work');
      const clone = spyOn(git, 'cloneRepository').mockImplementation(async (_url, path) => {
        await gitCheckout(path, url);
        return { ok: true, value: undefined };
      });
      const racingStore = {
        ...store,
        createCodebase: async (input: Parameters<typeof createCodebase>[0]) => {
          await store.createCodebase({ ...input, name: 'Remote owner', default_cwd: ownerPath });
          return store.createCodebase(input);
        },
      };
      try {
        await expect(cloneRepository(racingStore, url)).rejects.toThrow(ownerPath);
        await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(ownerPath, 'operator-work.txt'), 'utf8')).toBe('keep my work');
        expect(
          execFileSync('git', ['-C', ownerPath, 'status', '--porcelain'], { encoding: 'utf8' })
        ).toContain('operator-work.txt');
        expect(await store.listCodebases()).toMatchObject([{ default_cwd: ownerPath }]);
        expect(await store.listCodebases()).toHaveLength(1);
      } finally {
        clone.mockRestore();
      }
    }
  );

  test.each(['sql', 'file'] as const)(
    '%s rejected clone preserves a registered linked worktree and its Git backing store',
    async backend => {
      const root = await makeHome();
      const store =
        backend === 'sql'
          ? codebases
          : (await createFileWorkflowHost(join(root, 'store'))).records.codebases;
      const url = 'https://github.com/acme/api.git';
      const worktree = join(root, 'linked');
      const clone = spyOn(git, 'cloneRepository').mockImplementation(async (_url, path) => {
        await gitCheckout(path, url);
        execFileSync('git', [
          '-C',
          path,
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.test',
          'commit',
          '--allow-empty',
          '-qm',
          'Initial',
        ]);
        return { ok: true, value: undefined };
      });
      const racingStore = {
        ...store,
        createCodebase: async (input: Parameters<typeof createCodebase>[0]) => {
          execFileSync('git', [
            '-C',
            input.default_cwd,
            'worktree',
            'add',
            '-qb',
            'linked',
            worktree,
          ]);
          await store.createCodebase({ ...input, default_cwd: worktree });
          await writeFile(join(worktree, 'operator-work.txt'), 'keep my work');
          return store.createCodebase(input);
        },
      };
      try {
        await expect(cloneRepository(racingStore, url)).rejects.toThrow('worktrees');
        expect(await readFile(join(worktree, 'operator-work.txt'), 'utf8')).toBe('keep my work');
        expect(
          execFileSync('git', ['-C', worktree, 'status', '--porcelain'], { encoding: 'utf8' })
        ).toContain('operator-work.txt');
        expect(await store.listCodebases()).toMatchObject([{ default_cwd: worktree }]);
        expect(await store.listCodebases()).toHaveLength(1);
      } finally {
        clone.mockRestore();
      }
    }
  );

  test.each([
    { backend: 'sql', code: 'ELOOP' },
    { backend: 'file', code: 'ELOOP' },
    { backend: 'sql', code: 'EACCES' },
    { backend: 'file', code: 'EACCES' },
  ] as const)(
    '$backend cleanup removes an unowned checkout past a project whose path fails with $code',
    async ({ backend, code }) => {
      // Windows has no chmod-based access denial, and root ignores it.
      if (code === 'EACCES' && (process.platform === 'win32' || process.getuid?.() === 0)) return;
      const root = await makeHome();
      const store =
        backend === 'sql'
          ? codebases
          : (await createFileWorkflowHost(join(root, 'store'))).records.codebases;
      const locked = join(root, 'locked');
      const unreadable =
        code === 'ELOOP' ? join(root, 'loop') : await gitCheckout(join(locked, 'project'));
      await store.createCodebase({ name: 'owner', kind: 'folder', default_cwd: unreadable });
      if (code === 'ELOOP')
        await fsPromises.symlink(
          unreadable,
          unreadable,
          process.platform === 'win32' ? 'junction' : 'dir'
        );
      else await fsPromises.chmod(locked, 0o000);
      const checkout = await gitCheckout(join(root, 'fresh'), 'https://github.com/acme/api.git');
      const remove = mock(async (detached: string) => {
        await fsPromises.rm(detached, { recursive: true });
      });
      const warnings: string[] = [];
      setLogSink(line => {
        warnings.push(line);
      });
      try {
        await store.removeUnregisteredCheckout(checkout, remove);
      } finally {
        if (code === 'EACCES') await fsPromises.chmod(locked, 0o755);
      }

      expect(remove).toHaveBeenCalledTimes(1);
      await expect(access(checkout)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(warnings.join('\n')).toContain('registration.checkout_identity_unavailable');
    }
  );

  test.each(['sql', 'file'] as const)(
    '%s cleanup removes an unowned checkout past a project with broken Git metadata',
    async backend => {
      const root = await makeHome();
      const store =
        backend === 'sql'
          ? codebases
          : (await createFileWorkflowHost(join(root, 'store'))).records.codebases;
      const broken = await gitCheckout(join(root, 'broken'), 'https://github.com/acme/broken.git');
      await store.createCodebase({ name: 'acme/broken', default_cwd: broken });
      await rm(join(broken, '.git'), { recursive: true });
      const checkout = await gitCheckout(join(root, 'fresh'), 'https://github.com/acme/api.git');
      const remove = mock(async (detached: string) => {
        await fsPromises.rm(detached, { recursive: true });
      });

      await store.removeUnregisteredCheckout(checkout, remove);

      expect(remove).toHaveBeenCalledTimes(1);
      await expect(access(checkout)).rejects.toMatchObject({ code: 'ENOENT' });
      await access(broken);
    }
  );

  test('concurrent folder claims cannot insert two owners of one storage root', async () => {
    const root = await makeHome();
    await mkdir(join(root, 'a'));
    await mkdir(join(root, 'b'));
    const results = await Promise.allSettled([
      registerFolder(join(root, 'a'), 'My App'),
      registerFolder(join(root, 'b'), 'my-app'),
    ]);
    const projects = await listCodebases();
    const roots = await Promise.all(projects.map(project => storageRoot(project.id)));
    expect(new Set(roots.map(root => root.toLowerCase())).size).toBe(projects.length);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(ProjectRegistrationError);
        expect(String(result.reason)).toContain('storage');
      }
    }
  });

  test('a sole upstream remote still belongs to its registered checkout', async () => {
    const root = await makeHome();
    const first = await gitCheckout(join(root, 'first'), 'https://github.com/acme/api.git');
    const second = await gitCheckout(join(root, 'second'), 'https://github.com/acme/api.git');
    for (const path of [first, second]) {
      execFileSync('git', ['-C', path, 'remote', 'rename', 'origin', 'upstream']);
    }
    await createCodebase({ name: 'Legacy API', default_cwd: first });
    await expect(registerRepository(second)).rejects.toThrow(`already registered at ${first}`);
    expect(await listCodebases()).toHaveLength(1);
  });

  test('legacy URL rewriting is resolved by Git before comparing remotes', async () => {
    const root = await makeHome();
    const first = await gitCheckout(join(root, 'first'), 'shortcut:acme/api.git');
    execFileSync('git', ['-C', first, 'config', 'url.https://github.com/.insteadOf', 'shortcut:']);
    const second = await gitCheckout(join(root, 'second'), 'https://github.com/acme/api.git');
    await createCodebase({ name: 'Legacy API', default_cwd: first });
    await expect(registerRepository(second)).rejects.toThrow(`already registered at ${first}`);
    expect(await listCodebases()).toHaveLength(1);
  });

  test('folder projects whose names slugify alike get separate storage', async () => {
    const root = await makeHome();
    const first = join(root, 'a');
    const second = join(root, 'b');
    await mkdir(first);
    await mkdir(second);

    const a = await registerFolder(first, 'My App');
    const b = await registerFolder(second, 'my-app');

    expect(b.codebaseId).not.toBe(a.codebaseId);
    expect(a.name).toBe('My App');
    expect(b.name).toBe('my-app-2');
    expect(await storageRoot(b.codebaseId)).not.toBe(await storageRoot(a.codebaseId));
  });

  test('a project name that differs only by case from another kind gets a suffix', async () => {
    const root = await makeHome();
    const repo = await registerRepository(await gitCheckout(join(root, 'repo')), {
      name: 'my-app',
    });
    await mkdir(join(root, 'folder'));
    const folder = await registerFolder(join(root, 'folder'), 'My-App');

    expect(folder.codebaseId).not.toBe(repo.codebaseId);
    expect(folder.name).toBe('My-App-2');
    await mkdir(join(root, 'other'));
    await expect(
      createCodebase({ name: 'MY-APP', default_cwd: join(root, 'other'), kind: 'folder' })
    ).rejects.toThrow('already owned by "my-app"');
  });

  test('repos without a remote that share a folder name get separate storage', async () => {
    const root = await makeHome();
    const work = await gitCheckout(join(root, 'work', 'api'));
    const personal = await gitCheckout(join(root, 'personal', 'api'));

    const a = await registerRepository(work);
    const b = await registerRepository(personal);

    expect(b.codebaseId).not.toBe(a.codebaseId);
    expect(a.name).toBe('api');
    expect(b.name).toBe('_local/api-2');
    expect(await storageRoot(b.codebaseId)).not.toBe(await storageRoot(a.codebaseId));
  });

  test('a repo whose owner/repo name is taken by another remote gets a suffixed name', async () => {
    const root = await makeHome();
    const github = await gitCheckout(join(root, 'gh', 'api'), 'https://github.com/acme/api.git');
    const gitlab = await gitCheckout(join(root, 'gl', 'api'), 'git@gitlab.example:acme/api.git');

    const a = await registerRepository(github);
    const b = await registerRepository(gitlab);

    expect(a.name).toBe('acme/api');
    expect(b.name).toBe('acme/api-2');
    expect(await storageRoot(b.codebaseId)).not.toBe(await storageRoot(a.codebaseId));
  });

  test.each(['https://github.com/acme/app.git', 'https://github.com/acme/app.git/'])(
    'a second clone of a registered remote is refused, naming the registered checkout: %s',
    async remote => {
      const root = await makeHome();
      const first = await gitCheckout(join(root, 'prod', 'app'), remote);
      const second = await gitCheckout(join(root, 'dev', 'app'), 'git@github.com:acme/app.git');
      const registered = await registerRepository(first);
      expect(registered.name).toBe('acme/app');

      const error = await registerRepository(second).then(
        () => undefined,
        (err: unknown) => err as Error
      );

      expect(error?.message).toContain('"acme/app"');
      expect(error?.message).toContain(first);
      expect(error?.message).toContain('worktree');
      expect((await listCodebases()).map(codebase => codebase.id)).toEqual([registered.codebaseId]);
    }
  );

  test('a remote already registered under a suffix is still refused', async () => {
    const root = await makeHome();
    const github = await gitCheckout(join(root, 'github'), 'https://github.com/acme/api.git');
    const gitlab = await gitCheckout(join(root, 'gitlab'), 'https://gitlab.example/acme/api.git');
    const second = await gitCheckout(join(root, 'second'), 'git@gitlab.example:acme/api.git');
    await registerRepository(github);
    const registered = await registerRepository(gitlab);

    await expect(registerRepository(second)).rejects.toThrow(
      `Project "${registered.name}" is already registered at ${gitlab}`
    );
    expect(await listCodebases()).toHaveLength(2);
  });

  test('a legacy chat registration with no recorded URL still owns its remote', async () => {
    const root = await makeHome();
    const first = await gitCheckout(join(root, 'first'), 'https://github.com/acme/api.git');
    const second = await gitCheckout(join(root, 'second'), 'git@github.com:acme/api.git');
    const existing = await createCodebase({ name: 'My API', default_cwd: first });
    await expect(registerRepository(second)).rejects.toThrow(
      `Project "My API" is already registered at ${first}`
    );
    expect((await getCodebase(existing.id))?.repository_url).toBeNull();
    expect(await listCodebases()).toHaveLength(1);
  });

  test('a managed remote refusal recommends worktrees and preserves the project', async () => {
    const root = await makeHome();
    const managed = await gitCheckout(
      join(root, '.archon', 'workspaces', 'acme', 'api', 'source'),
      'https://github.com/acme/api.git'
    );
    const local = await gitCheckout(join(root, 'local'), 'git@github.com:acme/api.git');
    const registered = await registerRepository(managed);

    await expect(registerRepository(local)).rejects.toThrow('worktrees');
    expect((await getCodebase(registered.codebaseId))?.default_cwd).toBe(managed);
    expect(await listCodebases()).toHaveLength(1);
  });

  test('a no-remote repo can take a free suffix when a managed row owns its basename', async () => {
    const root = await makeHome();
    const managed = join(root, '.archon', 'workspaces', '_local', 'api', 'source');
    const first = await createCodebase({ name: 'api', default_cwd: managed });
    const local = await gitCheckout(join(root, 'local', 'api'));
    const registered = await registerRepository(local);

    expect(registered.name).toBe('_local/api-2');
    expect(await storageRoot(registered.codebaseId)).not.toBe(await storageRoot(first.id));
  });

  test('suffix selection skips occupied names and storage and is stable on re-registration', async () => {
    const root = await makeHome();
    for (const name of ['a', 'b', 'c']) await mkdir(join(root, name));
    const first = await registerFolder(join(root, 'a'), 'My App');
    await registerFolder(join(root, 'b'), 'my-app-2');
    const third = await registerFolder(join(root, 'c'), 'my-app');
    expect(third.name).toBe('my-app-3');
    expect((await registerFolder(join(root, 'c'), 'other')).codebaseId).toBe(third.codebaseId);
    expect((await getCodebase(first.codebaseId))?.name).toBe('My App');
  });

  test('a custom repository name uses the same source and storage root and cannot bypass remote refusal', async () => {
    const root = await makeHome();
    const first = await gitCheckout(join(root, 'first', 'api'), 'https://github.com/acme/api.git');
    const second = await gitCheckout(join(root, 'second', 'api'), 'git@github.com:acme/api.git');
    const registered = await registerRepository(first, { name: 'My API' });
    const storage = await storageRoot(registered.codebaseId);
    expect(registered.name).toBe('My API');
    expect(await realpath(join(storage, 'source'))).toBe(first);
    await mkdir(join(storage, 'state'));
    const state = join(storage, 'state', 'ledger.txt');
    await writeFile(state, 'first project');
    await expect(registerRepository(second, { name: 'Different name' })).rejects.toThrow(
      `Project "My API" is already registered at ${first}`
    );
    expect(await readFile(state, 'utf8')).toBe('first project');
  });

  test.each([
    ['forge-a:acme/api.git', 'forge-b:acme/api.git'],
    ['https://forge.example:8443/acme/api.git', 'https://forge.example:9443/acme/api.git'],
    ['https://forge.example/acme/API.git', 'https://forge.example/acme/api.git'],
  ])('distinct remotes keep separate identities (%s, %s)', async (aUrl, bUrl) => {
    const root = await makeHome();
    const a = await registerRepository(await gitCheckout(join(root, 'a'), aUrl));
    const b = await registerRepository(await gitCheckout(join(root, 'b'), bUrl));
    expect(b.codebaseId).not.toBe(a.codebaseId);
    expect(await storageRoot(b.codebaseId)).not.toBe(await storageRoot(a.codebaseId));
  });

  test.each(['sql', 'file'] as const)(
    'username-free SCP remote supports equivalent lookup and refusal (%s)',
    async backend => {
      const root = await makeHome();
      const store =
        backend === 'sql'
          ? codebases
          : (await createFileWorkflowHost(join(root, 'store'))).records.codebases;
      const path = await gitCheckout(join(root, 'api'), 'forge-a:acme/api.git');
      const registered = await registerInStore(store, path);
      for (const url of ['git@forge-a:acme/api.git', 'https://forge-a/acme/api.git']) {
        expect((await store.findCodebaseByRepoUrl(url))?.id).toBe(registered.codebaseId);
        await expect(
          store.createCodebase({
            name: 'duplicate',
            default_cwd: join(root, 'other'),
            repository_url: url,
          })
        ).rejects.toThrow(path);
      }
    }
  );

  test.each([false, true])(
    'a linked worktree still resolves to its project (configured upstream: %s)',
    async configured => {
      const root = await makeHome();
      const primary = await gitCheckout(join(root, 'app'), 'https://github.com/acme/linked.git');
      execFileSync('git', ['-C', primary, 'commit', '-q', '--allow-empty', '-m', 'init'], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      });
      const linked = join(root, 'app-feature');
      execFileSync('git', ['-C', primary, 'worktree', 'add', '-q', '-b', 'feature', linked]);
      if (configured) {
        execFileSync('git', [
          '-C',
          primary,
          'remote',
          'add',
          'upstream',
          'https://github.com/acme/linked.git',
        ]);
        execFileSync('git', [
          '-C',
          primary,
          'remote',
          'set-url',
          'origin',
          'https://github.com/foreign/linked.git',
        ]);
        await mkdir(join(primary, '.archon'));
        await writeFile(join(primary, '.archon', 'config.yaml'), 'worktree:\n  remote: upstream\n');
      }
      const registered = await registerRepository(primary);

      const again = await registerRepository(linked);

      expect(again.alreadyExisted).toBe(true);
      expect(again.codebaseId).toBe(registered.codebaseId);
    }
  );
});
