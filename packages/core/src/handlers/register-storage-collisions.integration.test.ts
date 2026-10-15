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
import { describe, test, expect, mock, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const { SqliteAdapter, sqliteDialect } = await import('../db/adapters/sqlite');
const db = new SqliteAdapter(':memory:');

mock.module('../db/connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const { registerFolder, registerRepository, ProjectRegistrationError } =
  await import('./sql-registration');
const { createCodebase, createManagedCodebase, findCodebaseByRepoUrl, getCodebase, listCodebases } =
  await import('../db/codebases');
const { getProjectStoragePaths, resolveProjectStorageKey } = await import('@archon/paths');
const { getWorktreeBase, toRepoPath } = await import('@archon/git');

const trackTempRoot = trackTempRoots();
const initialArchonHome = process.env.ARCHON_HOME;
afterEach(async () => {
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

  test('legacy duplicate remote owners are refused instead of picking one', async () => {
    const root = await makeHome();
    const first = await createCodebase({
      name: 'acme/one',
      default_cwd: join(root, 'first'),
      repository_url: 'git@github.com:acme/api.git',
    });
    const second = await createCodebase({
      name: 'acme/two',
      default_cwd: join(root, 'second'),
      repository_url: 'https://other.example/acme/api',
    });
    await db.query('UPDATE remote_agent_codebases SET repository_url = $1 WHERE id = $2', [
      'https://github.com/acme/api',
      second.id,
    ]);
    const error = await findCodebaseByRepoUrl('https://github.com/acme/api.git').catch(
      (error: unknown) => error
    );
    expect(error).toBeInstanceOf(ProjectRegistrationError);
    for (const project of [first, second]) {
      expect(error instanceof Error && error.message).toContain(project.name);
      expect(error instanceof Error && error.message).toContain(project.default_cwd);
    }
  });

  test('a persisted match does not hide a readable legacy duplicate', async () => {
    const root = await makeHome();
    const known = await createCodebase({
      name: 'acme/api',
      default_cwd: join(root, 'known'),
      repository_url: 'https://github.com/acme/api',
    });
    const legacy = await gitCheckout(join(root, 'legacy'), 'git@github.com:acme/api.git');
    await createCodebase({ name: 'Legacy', default_cwd: legacy });
    await createCodebase({ name: 'Unavailable', default_cwd: join(root, 'missing') });
    const error = await findCodebaseByRepoUrl('https://github.com/acme/api').catch(
      (error: unknown) => error
    );
    expect(error).toBeInstanceOf(ProjectRegistrationError);
    expect(error instanceof Error && error.message).toContain('Multiple projects');
    expect(error instanceof Error && error.message).toContain(known.default_cwd);
    expect(error instanceof Error && error.message).toContain(legacy);
  });

  test.each(['incoming', 'legacy'])(
    'ambiguous %s remotes cannot clear remote ownership',
    async side => {
      const root = await makeHome();
      const first = await gitCheckout(join(root, 'first'), 'https://github.com/acme/api.git');
      const second = await gitCheckout(join(root, 'second'), 'https://github.com/acme/api.git');
      const ambiguous = side === 'incoming' ? second : first;
      execFileSync('git', ['-C', ambiguous, 'remote', 'rename', 'origin', 'upstream']);
      execFileSync('git', [
        '-C',
        ambiguous,
        'remote',
        'add',
        'mirror',
        'https://mirror.example/acme/api.git',
      ]);
      await createCodebase({ name: 'Legacy API', default_cwd: first });
      await expect(registerRepository(second)).rejects.toThrow(first);
      expect(await listCodebases()).toHaveLength(1);
      if (side === 'incoming') {
        await db.query('DELETE FROM remote_agent_codebases');
        await expect(registerRepository(second)).rejects.toThrow('worktree.remote');
        expect(await listCodebases()).toHaveLength(0);
      }
    }
  );

  test.each(['incoming', 'legacy'])(
    'invalid %s config refuses registration with the original cause',
    async side => {
      const root = await makeHome();
      const first = await gitCheckout(join(root, 'first'), 'https://github.com/acme/api.git');
      const second = await gitCheckout(join(root, 'second'), 'https://github.com/acme/api.git');
      const broken = side === 'incoming' ? second : first;
      await mkdir(join(broken, '.archon'));
      await writeFile(join(broken, '.archon/config.yaml'), 'worktree: [');
      await createCodebase({ name: 'Legacy API', default_cwd: first });
      const error = await registerRepository(second).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error && error.cause).toBeInstanceOf(Error);
      expect(error instanceof Error && error.message).toContain(broken);
      if (side === 'legacy')
        await expect(findCodebaseByRepoUrl('https://github.com/acme/api')).rejects.toThrow();
      expect(await listCodebases()).toHaveLength(1);
    }
  );

  test.each(['missing', 'corrupt'])(
    'known remote lookup survives an unrelated %s legacy checkout',
    async state => {
      const root = await makeHome();
      const legacyPath = join(root, 'legacy');
      if (state === 'corrupt') {
        await gitCheckout(legacyPath);
        await mkdir(join(legacyPath, '.archon'));
        await writeFile(join(legacyPath, '.archon/config.yaml'), 'worktree: [');
      }
      await createCodebase({ name: 'Legacy', default_cwd: legacyPath });
      const known = await createCodebase({
        name: 'acme/api',
        default_cwd: join(root, 'known'),
        repository_url: 'https://github.com/acme/api',
      });
      expect((await findCodebaseByRepoUrl('git@github.com:acme/api.git'))?.id).toBe(known.id);
      await expect(
        createManagedCodebase({
          name: 'acme/new',
          default_cwd: join(root, 'new'),
          repository_url: 'https://github.com/acme/new',
        })
      ).rejects.toThrow(legacyPath);
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
      if (result.status === 'rejected') expect(String(result.reason)).toContain('storage');
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

  test('an unavailable legacy checkout cannot silently lose its remote ownership', async () => {
    const root = await makeHome();
    const missing = join(root, 'missing');
    await createCodebase({ name: 'Legacy API', default_cwd: missing });
    const second = await gitCheckout(join(root, 'second'), 'https://github.com/acme/api.git');
    const error = await registerRepository(second).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(error).toBeInstanceOf(ProjectRegistrationError);
    if (!(error instanceof ProjectRegistrationError))
      throw new Error('Expected registration refusal');
    expect(error.message).toContain('Legacy API');
    expect(error.message).toContain(missing);
    expect(error.cause).toBeInstanceOf(Error);
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

  test('a second clone of a registered remote is refused, naming the registered checkout', async () => {
    const root = await makeHome();
    const first = await gitCheckout(join(root, 'prod', 'app'), 'https://github.com/acme/app.git');
    const second = await gitCheckout(join(root, 'dev', 'app'), 'git@github.com:acme/app.git');
    const registered = await registerRepository(first);

    const error = await registerRepository(second).then(
      () => undefined,
      (err: unknown) => err as Error
    );

    expect(error?.message).toContain('"acme/app"');
    expect(error?.message).toContain(first);
    expect(error?.message).toContain('worktree');
    expect((await listCodebases()).map(codebase => codebase.id)).toEqual([registered.codebaseId]);
  });

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
    ['https://forge.example:8443/acme/api.git', 'https://forge.example:9443/acme/api.git'],
    ['https://forge.example/acme/API.git', 'https://forge.example/acme/api.git'],
  ])('distinct remotes keep separate identities (%s, %s)', async (aUrl, bUrl) => {
    const root = await makeHome();
    const a = await registerRepository(await gitCheckout(join(root, 'a'), aUrl));
    const b = await registerRepository(await gitCheckout(join(root, 'b'), bUrl));
    expect(b.codebaseId).not.toBe(a.codebaseId);
    expect(await storageRoot(b.codebaseId)).not.toBe(await storageRoot(a.codebaseId));
  });

  test('a linked worktree of the registered clone still resolves to its project', async () => {
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
    const registered = await registerRepository(primary);

    const again = await registerRepository(linked);

    expect(again.alreadyExisted).toBe(true);
    expect(again.codebaseId).toBe(registered.codebaseId);
  });
});
