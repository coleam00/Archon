/**
 * Worktree creation against a real git repository.
 *
 * The unit suites' `worktree-test-fixture.ts` replaces `node:fs/promises` and
 * `@archon/paths` for its whole process, so this file gets its own `testGroups`
 * entry. Real Git is needed to prove failed-add ownership, cleanup, and
 * preservation of hidden changes.
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  spyOn,
} from 'bun:test';
import { existsSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  execFileAsync,
  hasUncommittedChangesStrict,
  resolveBashPath,
  toBranchName,
  toRepoPath,
  toWorktreePath,
} from '@archon/git';
import { setLogLevel } from '@archon/paths';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';

import * as gitModule from '@archon/git';

import { WorktreeProvider } from './worktree';
import { IsolationResolver } from '../resolver';
import type { IsolationRequest } from '../types';
import {
  classifyIsolationError,
  isKnownIsolationError,
  IsolationFailure,
  ExistingBranchDivergedError,
  MissingProjectDirectoryError,
  WorktreeUncommittedChangesError,
} from '../errors';

// The provider logs a full setup failure and its rollback. Both are expected here,
// and a child logger takes the level set before it is created.
setLogLevel('silent');

/** The rejection must be a typed failure that the resolver reports as blocked. */
async function typedFailure(attempt: Promise<unknown>): Promise<IsolationFailure> {
  const failure = await attempt.then(
    () => undefined,
    (error: unknown) => error
  );
  if (!(failure instanceof IsolationFailure))
    throw new Error(`expected IsolationFailure: ${failure}`);
  expect(isKnownIsolationError(failure)).toBe(true);
  return failure;
}

const CODEBASE_NAME = 'acme/widgets';
const TASK_BRANCH = 'feature/login';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr}`);
  }
  return stdout;
}

const trackConfigRoot = trackTempRoots();
let previousGlobalConfig: string | undefined;
beforeEach(async () => {
  previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
  const home = trackConfigRoot(await mkdtemp(join(tmpdir(), 'archon-worktree-config-')));
  process.env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig');
});
afterEach(() => {
  if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
});

describe('missing registered project directory', () => {
  const trackTempRoot = trackTempRoots();

  test.each([false, true])(
    'fails before config or directory creation (loader throws: %s)',
    async loaderThrows => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-missing-workspace-')));
      const repoPath = join(root, 'source');
      const provider = new WorktreeProvider(() => {
        if (loaderThrows) throw new Error('config must not load for a missing project');
        return Promise.resolve(null);
      });
      const error = await provider
        .create({
          codebaseId: 'cb-missing',
          codebaseName: CODEBASE_NAME,
          canonicalRepoPath: toRepoPath(repoPath),
          workflowType: 'issue',
          identifier: '1778',
        })
        .catch((error: unknown) => error);

      expect(error).toBeInstanceOf(MissingProjectDirectoryError);
      if (!(error instanceof MissingProjectDirectoryError)) {
        throw new Error('expected a missing-directory error');
      }
      expect(error.message).toContain(repoPath);
      expect(error.message).toContain(CODEBASE_NAME);
      expect(error.message).toContain('Restore');
      expect(error.message).toContain('re-register');
      expect(await readdir(root)).toEqual([]);
    }
  );

  test.each([
    ['is a regular file', 'source'],
    ['has a regular file as an ancestor', join('source', 'repo')],
  ])('treats a path that %s as missing', async (_shape, relativeRepoPath) => {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-missing-workspace-')));
    await writeFile(join(root, 'source'), 'not a directory');
    const repoPath = join(root, relativeRepoPath);
    const provider = new WorktreeProvider(() => {
      throw new Error('config must not load for a missing project');
    });
    const error = await provider
      .create({
        codebaseId: 'cb-missing',
        codebaseName: CODEBASE_NAME,
        canonicalRepoPath: toRepoPath(repoPath),
        workflowType: 'issue',
        identifier: '1778',
      })
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(MissingProjectDirectoryError);
    expect(await readdir(root)).toEqual(['source']);
  });
});

describe('WorktreeProvider against real git', () => {
  const trackTempRoot = trackTempRoots();
  const originalArchonHome = process.env.ARCHON_HOME;
  let root: string;
  let repoPath: string;
  let provider: WorktreeProvider;
  let request: IsolationRequest;
  let worktreePath: string;

  /** Register a submodule whose URL points at a path that was never created. */
  async function addUnreachableSubmodule(): Promise<void> {
    await git(repoPath, 'checkout', '-q', TASK_BRANCH);
    await writeFile(
      join(repoPath, '.gitmodules'),
      `[submodule "sub"]\n\tpath = sub\n\turl = ${join(root, 'missing.git').replaceAll('\\', '/')}\n`
    );
    await git(repoPath, 'add', '.gitmodules');
    const head = (await git(repoPath, 'rev-parse', 'HEAD')).trim();
    await git(repoPath, 'update-index', '--add', '--cacheinfo', `160000,${head},sub`);
    await git(repoPath, 'commit', '-qm', 'register a submodule that cannot be fetched');
    await git(repoPath, 'checkout', '-q', 'main');
  }

  /**
   * What git knows about each worktree it has registered, with the path in this
   * platform's own spelling: git prints forward slashes on Windows, so its raw
   * strings never compare equal to a path built with `join`.
   */
  const worktreeRecords = async (): Promise<{ path: string; attributes: string[] }[]> =>
    (await git(repoPath, 'worktree', 'list', '--porcelain'))
      .trim()
      .split('\n\n')
      .map(record => record.split('\n').map(line => line.trim()))
      .map(([first = '', ...attributes]) => ({
        path: resolve(first.slice('worktree '.length)),
        attributes,
      }));

  const registeredWorktrees = async (): Promise<string[]> =>
    (await worktreeRecords()).map(record => record.path);

  const lockReasonOf = async (path: string): Promise<string | null> => {
    const record = (await worktreeRecords()).find(entry => entry.path === resolve(path));
    const locked = record?.attributes.find(line => line.startsWith('locked'));
    return locked === undefined ? null : locked.slice('locked'.length).trim();
  };

  /**
   * What the worktree's lock file held while `git worktree add` was still
   * running, as recorded by the `post-checkout` hook installed below.
   */
  const lockSeenDuringAdd = async (): Promise<string> => {
    const adminDir = (await git(worktreePath, 'rev-parse', '--absolute-git-dir')).trim();
    try {
      return (await readFile(join(adminDir, 'locked-during-add'), 'utf-8')).trim();
    } catch {
      return 'the post-checkout hook recorded nothing';
    }
  };

  let templateRepo: string;

  beforeAll(async () => {
    templateRepo = await mkdtemp(join(tmpdir(), 'archon-worktree-template-'));
    await git(templateRepo, 'init', '-q', '-b', 'main');
    await git(templateRepo, 'config', 'user.email', 'test@example.com');
    await git(templateRepo, 'config', 'user.name', 'Archon Test');
    await git(templateRepo, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(templateRepo, 'README.md'), '# fixture\n');
    await git(templateRepo, 'add', 'README.md');
    // Detached maintenance can delete its lock file while a test copies this template.
    const { stderr: commitTrace } = await execFileAsync(
      'git',
      ['-c', 'maintenance.auto=false', 'commit', '-qm', 'initial commit'],
      {
        cwd: templateRepo,
        env: {
          ...process.env,
          GIT_TRACE: '1',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'maintenance.auto',
          GIT_CONFIG_VALUE_0: 'true',
        },
      }
    );
    expect(commitTrace).toContain('initial commit');
    expect(commitTrace).not.toContain('maintenance run --auto');
    await git(templateRepo, 'branch', TASK_BRANCH);
  });

  afterAll(async () => {
    if (templateRepo) await removeTempTree(templateRepo);
  });

  beforeEach(async () => {
    // realpath so the paths this test asserts on match the ones git reports:
    // macOS resolves /var to /private/var, and Windows expands the 8.3 short
    // component (`C:\Users\RUNNER~1\…`). `fs/promises.realpath` is the variant
    // whose short-name expansion this repo has verified — see
    // `canonicalizeProjectPath` in @archon/paths.
    root = trackTempRoot(await realpath(await mkdtemp(join(tmpdir(), 'archon-worktree-'))));
    process.env.ARCHON_HOME = join(root, 'archon-home');

    repoPath = join(root, 'repo');
    await cp(templateRepo, repoPath, { recursive: true });

    provider = new WorktreeProvider();
    request = {
      codebaseId: 'cb-1',
      codebaseName: CODEBASE_NAME,
      canonicalRepoPath: toRepoPath(repoPath),
      workflowType: 'task',
      identifier: 'login',
      taskBranch: { kind: 'existing', branch: toBranchName(TASK_BRANCH) },
    };
    worktreePath = provider.getWorktreePath(request, TASK_BRANCH);
  });

  afterEach(() => {
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
  });

  test.each(['workspace sync', 'repository sync', 'fork PR', 'remote refresh'] as const)(
    'recovers %s after real Git ref contention clears',
    async operation => {
      const remotePath = join(root, 'remote');
      await cp(templateRepo, remotePath, { recursive: true });
      await git(repoPath, 'remote', 'add', 'origin', remotePath);
      await git(remotePath, 'update-ref', 'refs/pull/42/head', 'HEAD');
      const ref =
        operation === 'fork PR'
          ? 'heads/pr-42-review'
          : `remotes/origin/${operation === 'remote refresh' ? TASK_BRANCH : 'main'}`;
      const lock = join(repoPath, '.git', 'refs', `${ref}.lock`);
      await mkdir(join(lock, '..'), { recursive: true });
      await writeFile(lock, '');
      const exec = gitModule.execFileAsync;
      let collisions = 0;
      const spy = spyOn(gitModule, 'execFileAsync').mockImplementation(
        async (cmd, args, options) => {
          try {
            return await exec(cmd, args, options);
          } catch (error) {
            if (args.includes('fetch') && existsSync(lock)) {
              collisions++;
              await rm(lock);
            }
            throw error;
          }
        }
      );
      try {
        if (operation === 'workspace sync') {
          await gitModule.syncWorkspace(toRepoPath(repoPath), toBranchName('main'), {
            mode: 'fetch-only',
          });
        } else if (operation === 'repository sync') {
          expect(
            await gitModule.syncRepository(toRepoPath(repoPath), toBranchName('main'))
          ).toEqual({ ok: true, value: undefined });
        } else {
          await provider.create(
            operation === 'fork PR'
              ? {
                  ...request,
                  workflowType: 'pr',
                  identifier: '42',
                  prBranch: toBranchName(TASK_BRANCH),
                  isForkPR: true,
                }
              : {
                  ...request,
                  workflowType: 'task',
                  baseBranch: toBranchName('main'),
                  taskBranch: { kind: 'new', branch: toBranchName(TASK_BRANCH) },
                }
          );
        }
        expect(collisions).toBe(1);
        expect((await git(repoPath, 'show-ref', '--verify', `refs/${ref}`)).trim()).not.toBe('');
      } finally {
        spy.mockRestore();
      }
    }
  );

  test.each(['existing task', 'same-repository PR', 'fork PR'])(
    'wrong-branch adoption blocks %s without changing its checkout',
    async kind => {
      const hints =
        kind === 'existing task'
          ? {
              workflowType: 'task' as const,
              workflowId: 'login',
              taskBranch: { kind: 'existing' as const, branch: toBranchName(TASK_BRANCH) },
            }
          : {
              workflowType: 'pr' as const,
              workflowId: '4271',
              prBranch: toBranchName(TASK_BRANCH),
              isForkPR: kind === 'fork PR',
            };
      const expectedRequest: IsolationRequest =
        hints.workflowType === 'task'
          ? request
          : {
              ...request,
              workflowType: 'pr',
              identifier: hints.workflowId,
              prBranch: hints.prBranch,
              isForkPR: hints.isForkPR,
            };
      const target = provider.getWorktreePath(
        expectedRequest,
        provider.generateBranchName(expectedRequest)
      );
      await mkdir(join(target, '..'), { recursive: true });
      await git(repoPath, 'worktree', 'add', '--detach', target, 'main');
      const head = await git(target, 'rev-parse', 'HEAD');
      const resolver = new IsolationResolver({
        provider,
        store: {
          getById: async () => null,
          findActiveByWorkflow: async () => null,
          countActiveByCodebase: async () => 0,
          listActive: async () => [],
          create: async () => {
            throw new Error('refused adoption must not create a row');
          },
          updateMetadata: async () => {
            throw new Error('refused adoption must not update a row');
          },
          updateStatus: async () => {
            throw new Error('refused adoption must not change status');
          },
          withWorktreeRegistration: async () => {
            throw new Error('Unexpected worktree removal');
          },
          markWorktreeDestroyed: async () => {
            throw new Error('refused adoption must not retire a row');
          },
        },
      });
      const result = await resolver.resolve({
        existingEnvId: null,
        codebase: { id: request.codebaseId, name: CODEBASE_NAME, defaultCwd: repoPath },
        hints,
        platformType: 'web',
      });
      expect(result.status).toBe('blocked');
      if (result.status !== 'blocked') throw new Error('expected blocked adoption');
      expect(result.reason).toBe('creation_failed');
      expect(result.userMessage).toContain('Refused to adopt');
      expect(await git(target, 'rev-parse', 'HEAD')).toBe(head);
      expect((await git(target, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('HEAD');
    }
  );

  test('new and reused checkouts work when Git requires explicit ownership trust', async () => {
    const config = process.env.GIT_CONFIG_GLOBAL;
    if (!config) throw new Error('Scratch global config missing');
    await writeFile(
      config,
      `[safe]\n directory = ${JSON.stringify(repoPath)}\n directory = ${JSON.stringify(worktreePath)}\n directory = \n directory = ${JSON.stringify(repoPath)}\n`
    );
    await writeFile(
      join(repoPath, '.git', 'hooks', 'post-checkout'),
      '#!/bin/sh\ngit status --porcelain >/dev/null\n',
      { mode: 0o755 }
    );
    const previousOwnerCheck = process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
    try {
      const created = await provider.create(request);
      expect(created.workingPath).toBe(worktreePath);
      const adopted = await provider.create(request);
      expect(adopted.metadata.adopted).toBe(true);
      expect(await provider.adopt(worktreePath)).not.toBeNull();
      const { stdout } = await execFileAsync('git', [
        'config',
        '--global',
        '--get-all',
        'safe.directory',
      ]);
      expect(stdout.trim().split('\n')).toEqual([repoPath, '', repoPath, worktreePath]);
    } finally {
      if (previousOwnerCheck === undefined) delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
      else process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = previousOwnerCheck;
    }
  });

  test('post-create sees copied files in a new checkout of an existing branch and skips reuse', async () => {
    await writeFile(join(repoPath, '.seed'), 'seed');
    let executions = 0;
    provider = new WorktreeProvider(
      async () => ({ copyFiles: ['.seed'], postCreate: ['test -f .seed'] }),
      async input => {
        executions++;
        expect(input.workingPath).toBe(worktreePath);
        expect(input.timeout).toBe(300000);
        expect(await readFile(join(input.workingPath, '.seed'), 'utf8')).toBe('seed');
        expect(await lockReasonOf(input.workingPath)).toContain('setup in progress');
      }
    );
    await provider.create(request);
    await provider.create(request);
    expect(executions).toBe(1);
    expect(await lockReasonOf(worktreePath)).toBeNull();
  });

  test.each([false, true])(
    'failed post-create preserves installer output when present (%s)',
    async writesOutput => {
      provider = new WorktreeProvider(
        async () => ({
          postCreate: [writesOutput ? 'echo valuable > installer-output; exit 7' : 'exit 7'],
        }),
        async input => {
          await execFileAsync(resolveBashPath(), ['-c', input.commands[0]], {
            cwd: input.workingPath,
          });
        }
      );
      await expect(provider.create(request)).rejects.toThrow();
      expect(existsSync(worktreePath)).toBe(writesOutput);
      if (writesOutput) {
        expect(await readFile(join(worktreePath, 'installer-output'), 'utf8')).toBe('valuable\n');
        expect(await lockReasonOf(worktreePath)).toContain('setup in progress');
        const failure = await typedFailure(provider.create(request));
        expect(failure.kind).toBe('setup_unfinished');
        expect(failure.message).toContain('its setup did not finish');
      }
    }
  );

  test('configured commands without an executor fail before adding a checkout', async () => {
    provider = new WorktreeProvider(async () => ({ postCreate: ['true'] }));
    await expect(provider.create(request)).rejects.toThrow('requires a worktree setup executor');
    expect(await registeredWorktrees()).toEqual([repoPath]);
  });

  test.each(
    [false, true].flatMap(force =>
      ['deleted', 'rejected', 'multiple', 'mixed'].map(outcome => ({ force, outcome }))
    )
  )(
    'remote destruction uses push destinations (force=$force, outcome=$outcome)',
    async ({ force, outcome }) => {
      const fetchPath = join(root, 'fetch.git');
      const pushPath = join(root, 'push.git');
      const otherPush = join(root, 'other.git');
      for (const destination of [fetchPath, pushPath, otherPush])
        await git(root, 'init', '--bare', '-q', destination);
      await git(repoPath, 'push', '-q', fetchPath, 'main');
      await git(fetchPath, 'symbolic-ref', 'HEAD', 'refs/heads/main');
      await git(repoPath, 'remote', 'add', 'origin', fetchPath);
      await git(repoPath, 'remote', 'set-url', '--push', 'origin', '../push.git');
      if (outcome === 'multiple' || outcome === 'mixed')
        await git(repoPath, 'remote', 'set-url', '--add', '--push', 'origin', otherPush);
      const created = await provider.create({
        ...request,
        workflowType: 'task',
        taskBranch: {
          kind: 'new',
          branch: toBranchName('cleanup'),
          fromBranch: toBranchName('main'),
        },
      });
      if (created.metadata.provenance !== 'created') throw new Error('Expected fresh creation');
      const ref = `refs/heads/${created.branchName}`;
      await git(repoPath, 'push', '-q', 'origin', created.branchName);
      const published = await git(repoPath, 'ls-remote', pushPath, ref);
      expect(published).toContain(ref);
      expect(await git(repoPath, 'ls-remote', fetchPath, ref)).toBe('');
      if (outcome === 'rejected' || outcome === 'mixed')
        await git(pushPath, 'config', 'receive.denyDeletes', 'true');
      const result = await provider.destroy(created.workingPath, {
        canonicalRepoPath: request.canonicalRepoPath,
        creationId: created.metadata.creationId,
        branchName: created.branchName,
        force,
        deleteRemoteBranch: true,
      });
      expect(result.worktreeRemoved).toBe(true);
      const rejected = outcome === 'rejected' || outcome === 'mixed';
      expect(result.remoteBranchDeleted).toBe(!rejected);
      expect(await git(root, 'ls-remote', pushPath, ref)).toBe(rejected ? published : '');
      if (outcome === 'multiple' || outcome === 'mixed')
        expect(await git(root, 'ls-remote', otherPush, ref)).toBe('');
      expect(result.warnings).toEqual(
        rejected
          ? [
              `Failed to delete remote branch '${created.branchName}': remote inspection or leased deletion failed`,
            ]
          : []
      );
    }
  );

  test.each([false, true])(
    'remote destruction preserves named services (force=%s)',
    async force => {
      const intended = join(root, 'service.git');
      const unrelated = join(root, 'url.git');
      for (const destination of [intended, unrelated])
        await git(root, 'init', '--bare', '-q', destination);
      await git(repoPath, 'remote', 'add', 'origin', unrelated);
      const created = await provider.create({
        ...request,
        workflowType: 'task',
        taskBranch: {
          kind: 'new',
          branch: toBranchName('cleanup'),
          fromBranch: toBranchName('main'),
        },
      });
      if (created.metadata.provenance !== 'created') throw new Error('Expected fresh creation');
      const ref = `refs/heads/${created.branchName}`;
      for (const destination of [intended, unrelated])
        await git(repoPath, 'push', '-q', destination, created.branchName);
      const published = await git(root, 'ls-remote', intended, ref);
      const servicePath = intended.replaceAll('\\', '/').replaceAll("'", "'\"'\"'");
      await git(
        repoPath,
        'config',
        'remote.origin.uploadpack',
        `git-upload-pack '${servicePath}' #`
      );
      await git(
        repoPath,
        'config',
        'remote.origin.receivepack',
        `git-receive-pack '${servicePath}' #`
      );
      expect(await git(repoPath, 'ls-remote', 'origin', ref)).toBe(published);
      await git(repoPath, 'push', '-q', 'origin', 'HEAD:refs/heads/native-probe');
      expect(await git(root, 'ls-remote', intended, 'refs/heads/native-probe')).toContain(
        'refs/heads/native-probe'
      );
      expect(await git(root, 'ls-remote', unrelated, 'refs/heads/native-probe')).toBe('');
      const result = await provider.destroy(created.workingPath, {
        canonicalRepoPath: request.canonicalRepoPath,
        creationId: created.metadata.creationId,
        branchName: created.branchName,
        force,
        deleteRemoteBranch: true,
      });
      expect(result.remoteBranchDeleted).toBe(true);
      expect(result.warnings).toEqual([]);
      expect(await git(root, 'ls-remote', intended, ref)).toBe('');
      expect(await git(root, 'ls-remote', unrelated, ref)).toBe(published);
    }
  );

  test.each(
    [false, true].flatMap(force =>
      ['uploadpack', 'receivepack'].map(service => ({ force, service }))
    )
  )(
    'remote destruction refuses a valueless service (force=$force, service=$service)',
    async ({ force, service }) => {
      const destination = join(root, 'remote.git');
      await git(root, 'init', '--bare', '-q', destination);
      await git(repoPath, 'remote', 'add', 'origin', destination);
      const created = await provider.create({
        ...request,
        workflowType: 'task',
        taskBranch: {
          kind: 'new',
          branch: toBranchName('cleanup'),
          fromBranch: toBranchName('main'),
        },
      });
      if (created.metadata.provenance !== 'created') throw new Error('Expected fresh creation');
      await git(repoPath, 'push', '-q', 'origin', created.branchName);
      const ref = `refs/heads/${created.branchName}`;
      const published = await git(root, 'ls-remote', destination, ref);
      const configPath = join(repoPath, '.git', 'config');
      await writeFile(
        configPath,
        `${await readFile(configPath, 'utf8')}\n[remote "origin"]\n${service}\n`
      );
      const result = await provider.destroy(created.workingPath, {
        canonicalRepoPath: request.canonicalRepoPath,
        creationId: created.metadata.creationId,
        branchName: created.branchName,
        force,
        deleteRemoteBranch: true,
      });
      expect(result.remoteBranchDeleted).toBe(false);
      expect(result.warnings).toEqual([
        `Failed to delete remote branch '${created.branchName}': could not resolve push destinations`,
      ]);
      expect(await git(root, 'ls-remote', destination, ref)).toBe(published);
    }
  );

  test.each(
    [false, true].flatMap(force =>
      [
        ...(process.platform === 'win32' ? [] : ['whitespace']),
        'embedded-whitespace',
        'equals',
        'pushInsteadOf',
        'insteadOf',
        'alias-insteadOf',
        'alias-pushInsteadOf',
        'alias-pushInsteadOf-pushurl',
        'empty',
        'mixed',
      ].map(kind => ({ force, kind }))
    )
  )(
    'remote destruction preserves endpoint identity (force=$force, kind=$kind)',
    async ({ force, kind }) => {
      const filenames = new Map<string, [string, string]>([
        ['whitespace', ['push.git ', 'push.git']],
        ['embedded-whitespace', ['push one.git', 'other.git']],
        ['equals', ['push=one.git', 'other.git']],
      ]);
      const [intendedName, unrelatedName] = filenames.get(kind) ?? ['push.git', 'other.git'];
      const intended = join(root, intendedName);
      const unrelated = join(root, unrelatedName);
      for (const destination of [intended, unrelated])
        await git(root, 'init', '--bare', '-q', destination);
      await git(repoPath, 'remote', 'add', 'origin', repoPath);
      const created = await provider.create({
        ...request,
        workflowType: 'task',
        taskBranch: {
          kind: 'new',
          branch: toBranchName('cleanup'),
          fromBranch: toBranchName('main'),
        },
      });
      if (created.metadata.provenance !== 'created') throw new Error('Expected fresh creation');
      const ref = `refs/heads/${created.branchName}`;
      for (const destination of [intended, unrelated])
        await git(repoPath, 'push', '-q', destination, created.branchName);
      const published = await git(root, 'ls-remote', intended, ref);
      const alias = new Map([
        ['alias-insteadOf', 'insteadOf'],
        ['alias-pushInsteadOf', 'pushInsteadOf'],
        ['alias-pushInsteadOf-pushurl', 'pushInsteadOf'],
      ]).get(kind);
      if (filenames.has(kind)) {
        await git(repoPath, 'remote', 'set-url', '--push', 'origin', intended);
      } else if (alias) {
        await git(repoPath, 'config', '--unset-all', 'remote.origin.url');
        await git(repoPath, 'config', `url.${intended}.${alias}`, 'origin');
        if (kind === 'alias-pushInsteadOf-pushurl') {
          await git(repoPath, 'config', 'remote.origin.pushurl', unrelated);
          expect(await git(repoPath, 'remote', 'get-url', '--push', '--all', 'origin')).toBe(
            `${unrelated}\n${intended}\n`
          );
        }
      } else if (kind === 'empty' || kind === 'mixed') {
        await git(repoPath, 'remote', 'set-url', 'origin', intended);
        await git(repoPath, 'config', 'url..pushInsteadOf', intended);
        if (kind === 'mixed') {
          await git(repoPath, 'config', '--add', 'remote.origin.url', 'cleanup-source:');
          await git(repoPath, 'config', `url.${intended}.pushInsteadOf`, 'cleanup-source:');
        }
      } else {
        await git(repoPath, 'remote', 'set-url', 'origin', 'cleanup-source:');
        await git(repoPath, 'config', `url.${intended}.${kind}`, 'cleanup-source:');
        await git(repoPath, 'config', `url.${unrelated}.${kind}`, intended);
      }
      const result = await provider.destroy(created.workingPath, {
        canonicalRepoPath: request.canonicalRepoPath,
        creationId: created.metadata.creationId,
        branchName: created.branchName,
        force,
        deleteRemoteBranch: true,
      });
      expect(result.worktreeRemoved).toBe(true);
      expect(result.remoteBranchDeleted).toBe(true);
      expect(result.warnings).toEqual([]);
      expect(await git(root, 'ls-remote', intended, ref)).toBe('');
      expect(await git(root, 'ls-remote', unrelated, ref)).toBe(
        kind === 'alias-pushInsteadOf-pushurl' ? '' : published
      );
    }
  );

  test
    .skipIf(process.platform === 'win32')
    .each([false, true].flatMap(force => ['pushurl', 'url'].map(kind => ({ force, kind }))))(
    'remote destruction refuses newline destinations (force=$force, kind=$kind)',
    async ({ force, kind }) => {
      const first = join(root, 'first.git');
      const second = join(root, 'second.git');
      const intended = `${first}\n${second}`;
      for (const destination of [first, second, intended])
        await git(root, 'init', '--bare', '-q', destination);
      await git(repoPath, 'remote', 'add', 'origin', repoPath);
      const created = await provider.create({
        ...request,
        workflowType: 'task',
        taskBranch: {
          kind: 'new',
          branch: toBranchName('cleanup'),
          fromBranch: toBranchName('main'),
        },
      });
      if (created.metadata.provenance !== 'created') throw new Error('Expected fresh creation');
      const ref = `refs/heads/${created.branchName}`;
      for (const destination of [first, second, intended])
        await git(repoPath, 'push', '-q', destination, created.branchName);
      if (kind === 'pushurl') {
        await git(repoPath, 'remote', 'set-url', '--push', 'origin', intended);
      } else {
        await git(repoPath, 'remote', 'set-url', 'origin', intended);
      }
      const result = await provider.destroy(created.workingPath, {
        canonicalRepoPath: request.canonicalRepoPath,
        creationId: created.metadata.creationId,
        branchName: created.branchName,
        force,
        deleteRemoteBranch: true,
      });
      expect(result.remoteBranchDeleted).toBe(false);
      expect(result.warnings).toEqual([
        `Failed to delete remote branch '${created.branchName}': could not resolve push destinations`,
      ]);
      for (const destination of [first, second, intended])
        expect(await git(root, 'ls-remote', destination, ref)).toContain(ref);
    }
  );

  test.each(['pushurl', 'url'] as const)(
    'remote destruction uses one configuration snapshot (%s)',
    async kind => {
      const first = join(root, 'first.git');
      const second = join(root, 'second.git');
      const intended = join(root, 'intended.git');
      for (const destination of [first, second, intended])
        await git(root, 'init', '--bare', '-q', destination);
      await git(repoPath, 'remote', 'add', 'origin', repoPath);
      const created = await provider.create({
        ...request,
        workflowType: 'task',
        taskBranch: {
          kind: 'new',
          branch: toBranchName('cleanup'),
          fromBranch: toBranchName('main'),
        },
      });
      if (created.metadata.provenance !== 'created') throw new Error('Expected fresh creation');
      const ref = `refs/heads/${created.branchName}`;
      for (const destination of [first, second, intended])
        await git(repoPath, 'push', '-q', destination, created.branchName);
      await git(repoPath, 'config', `remote.origin.${kind}`, intended);
      const originalExec = gitModule.execFileAsync;
      let changed = false;
      const exec = spyOn(gitModule, 'execFileAsync').mockImplementation(
        async (file, args, options) => {
          const result = await originalExec(file, args, options);
          if (args.includes('--null') && args.includes('--list')) {
            await originalExec('git', [
              '-C',
              repoPath,
              'config',
              `remote.origin.${kind}`,
              `${first}\n${second}`,
            ]);
            changed = true;
          }
          return result;
        }
      );
      try {
        const result = await provider.destroy(created.workingPath, {
          canonicalRepoPath: request.canonicalRepoPath,
          creationId: created.metadata.creationId,
          branchName: created.branchName,
          force: true,
          deleteRemoteBranch: true,
        });
        expect(changed).toBe(true);
        expect(result.remoteBranchDeleted).toBe(true);
        expect(result.warnings).toEqual([]);
      } finally {
        exec.mockRestore();
      }
      expect(await git(root, 'ls-remote', intended, ref)).toBe('');
      for (const destination of [first, second])
        expect(await git(root, 'ls-remote', destination, ref)).toContain(ref);
    }
  );

  describe('ordinary destruction status', () => {
    async function createOwned() {
      await git(repoPath, 'remote', 'add', 'origin', repoPath);
      const created = await provider.create({
        ...request,
        workflowType: 'task',
        taskBranch: {
          kind: 'new',
          branch: toBranchName('owned'),
          fromBranch: toBranchName('main'),
        },
      });
      if (created.metadata.provenance !== 'created') throw new Error('Expected fresh creation');
      return {
        created,
        options: {
          canonicalRepoPath: request.canonicalRepoPath,
          creationId: created.metadata.creationId,
          branchName: created.branchName,
        },
      };
    }

    test.each(['tracked', 'staged', 'untracked'])(
      'refuses %s changes without removing files or registration',
      async kind => {
        const { created, options } = await createOwned();
        const file = kind === 'untracked' ? 'new-file' : 'README.md';
        await writeFile(join(created.workingPath, file), 'valuable work');
        if (kind === 'staged') await git(created.workingPath, 'add', file);
        if (kind === 'untracked')
          await git(created.workingPath, 'config', 'status.showUntrackedFiles', 'no');

        expect(await hasUncommittedChangesStrict(toWorktreePath(created.workingPath))).toBe(true);

        await expect(provider.destroy(created.workingPath, options)).rejects.toBeInstanceOf(
          WorktreeUncommittedChangesError
        );

        expect(await readFile(join(created.workingPath, file), 'utf8')).toBe('valuable work');
        expect(await registeredWorktrees()).toContain(resolve(created.workingPath));
        expect(await git(repoPath, 'branch', '--list', created.branchName)).toContain(
          created.branchName
        );
      }
    );

    test.each([false, true])(
      'removes a clean checkout or explicitly forced dirty checkout (force: %s)',
      async force => {
        const { created, options } = await createOwned();
        expect(await hasUncommittedChangesStrict(toWorktreePath(created.workingPath))).toBe(false);
        if (force) await writeFile(join(created.workingPath, 'new-file'), 'discard by request');
        const result = await provider.destroy(created.workingPath, { ...options, force });
        expect(result.worktreeRemoved).toBe(true);
        expect(result.directoryClean).toBe(true);
        expect(existsSync(created.workingPath)).toBe(false);
        expect(await registeredWorktrees()).not.toContain(resolve(created.workingPath));
      }
    );

    test('a clean operator-locked checkout fails without claiming uncommitted changes', async () => {
      const { created, options } = await createOwned();
      await git(repoPath, 'worktree', 'lock', '--reason', 'operator lock', created.workingPath);
      const error = await provider
        .destroy(created.workingPath, options)
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(WorktreeUncommittedChangesError);
      expect(await registeredWorktrees()).toContain(resolve(created.workingPath));
      expect(await lockReasonOf(created.workingPath)).toBe('operator lock');
    });
  });

  test('ordinary destruction preserves a replacement clone', async () => {
    await git(repoPath, 'remote', 'add', 'origin', repoPath);
    const created = await provider.create({
      ...request,
      workflowType: 'task',
      taskBranch: {
        kind: 'new',
        branch: toBranchName('owned'),
        fromBranch: toBranchName('main'),
      },
    });
    if (created.metadata.provenance !== 'created') throw new Error('Expected fresh creation');
    await git(repoPath, 'worktree', 'remove', created.workingPath);
    await git(root, 'clone', '-q', repoPath, created.workingPath);
    await writeFile(join(created.workingPath, 'operator-file'), 'keep me');

    const error = await provider
      .destroy(created.workingPath, {
        canonicalRepoPath: request.canonicalRepoPath,
        creationId: created.metadata.creationId,
        branchName: created.branchName,
        force: true,
      })
      .catch((error: unknown) => error);

    expect(await readFile(join(created.workingPath, 'operator-file'), 'utf8')).toBe('keep me');
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('ownership');
    expect(await git(repoPath, 'branch', '--list', created.branchName)).toContain(
      created.branchName
    );
  });

  test.each([
    'missing proof',
    'changed proof',
    'missing marker',
    'new generation',
    'different clone',
    'unregistered',
    'plain directory',
  ])('ordinary destruction refuses %s even with force', async scenario => {
    await git(repoPath, 'remote', 'add', 'origin', repoPath);
    const freshRequest: IsolationRequest = {
      ...request,
      workflowType: 'task',
      taskBranch: {
        kind: 'new',
        branch: toBranchName('owned'),
        fromBranch: toBranchName('main'),
      },
    };
    const created = await provider.create(freshRequest);
    if (created.metadata.provenance !== 'created') throw new Error('Expected fresh creation');
    let creationId: string | undefined = created.metadata.creationId;
    if (scenario === 'missing proof') creationId = undefined;
    if (scenario === 'changed proof') creationId = 'different';
    const admin = (await git(created.workingPath, 'rev-parse', '--absolute-git-dir')).trim();
    if (scenario === 'missing marker') await rm(join(admin, 'archon-creation-id'));
    if (scenario === 'unregistered') await rm(admin, { recursive: true });
    if (
      scenario === 'new generation' ||
      scenario === 'different clone' ||
      scenario === 'plain directory'
    ) {
      await git(repoPath, 'worktree', 'remove', created.workingPath);
      if (scenario === 'new generation') {
        await git(repoPath, 'branch', '-D', created.branchName);
        await provider.create(freshRequest);
      }
      if (scenario === 'different clone') {
        const other = join(root, 'other');
        await git(root, 'clone', '-q', repoPath, other);
        await git(other, 'worktree', 'add', '-q', '--detach', created.workingPath);
      }
      if (scenario === 'plain directory') await mkdir(created.workingPath, { recursive: true });
    }
    await writeFile(join(created.workingPath, 'operator-file'), 'keep me');
    const destruction = provider.destroy(created.workingPath, {
      canonicalRepoPath: request.canonicalRepoPath,
      creationId,
      branchName: created.branchName,
      force: true,
    });
    if (scenario === 'missing proof') await expect(destruction).rejects.toThrow('ownership');
    else expect((await typedFailure(destruction)).kind).toBe('ownership_unverified');
    expect(await readFile(join(created.workingPath, 'operator-file'), 'utf8')).toBe('keep me');
    expect(await git(repoPath, 'branch', '--list', created.branchName)).toContain(
      created.branchName
    );
  });

  test('an existing repository with a failed fetch still receives network guidance', async () => {
    await git(repoPath, 'remote', 'add', 'origin', join(root, 'missing-remote.git'));

    await expect(
      provider.create({
        codebaseId: request.codebaseId,
        codebaseName: request.codebaseName,
        canonicalRepoPath: request.canonicalRepoPath,
        workflowType: 'issue',
        identifier: '1778',
        baseBranch: toBranchName('main'),
      })
    ).rejects.toThrow('Check your network connection and remote configuration.');

    expect(existsSync(repoPath)).toBe(true);
    expect(await registeredWorktrees()).toEqual([resolve(repoPath)]);
  });

  test('destroy does not report a removal git still tracks under a symlinked base', async () => {
    // Git lists the symlink-resolved path; the worktree is detached and locked, so
    // prune keeps its entry after the directory is gone.
    await mkdir(join(root, 'real-base'));
    await symlink(join(root, 'real-base'), join(root, 'link-base'));
    const linked = join(root, 'link-base', 'wt');
    await git(repoPath, 'worktree', 'add', '-q', '--detach', linked);
    await git(repoPath, 'worktree', 'lock', linked);
    await rm(linked, { recursive: true, force: true });

    const result = await provider.destroy(linked, { canonicalRepoPath: toRepoPath(repoPath) });

    expect(result.worktreeRemoved).toBe(false);
    expect(result.warnings.join(' ')).toContain('still registered');
  });

  test('a failing post-checkout hook rolls back its clean checkout and preserves the error', async () => {
    await writeFile(
      join(repoPath, '.git', 'hooks', 'post-checkout'),
      '#!/bin/sh\necho hook-failure-3477 >&2\nexit 42\n',
      { mode: 0o755 }
    );

    await expect(provider.create(request)).rejects.toThrow('hook-failure-3477');

    expect(existsSync(worktreePath)).toBe(false);
    expect(await registeredWorktrees()).not.toContain(resolve(worktreePath));
    expect((await git(repoPath, 'rev-parse', TASK_BRANCH)).trim()).toBe(
      (await git(repoPath, 'rev-parse', 'main')).trim()
    );
  });

  test.each(['assume-unchanged', 'skip-worktree'])(
    'preserves tracked edits hidden by %s',
    async flag => {
      await writeFile(
        join(repoPath, '.git', 'hooks', 'post-checkout'),
        `#!/bin/sh\ngit update-index --${flag} README.md\nprintf hidden-work > README.md\necho hidden-hook-failure >&2\nexit 42\n`,
        { mode: 0o755 }
      );
      await expect(provider.create(request)).rejects.toThrow('hidden-hook-failure');
      expect(await readFile(join(worktreePath, 'README.md'), 'utf-8')).toBe('hidden-work');
      expect(await lockReasonOf(worktreePath)).toMatch(/^archon: worktree setup in progress: .+/);
    }
  );

  test.each(['uninitialized', 'initialized-ignored'])(
    'preserves hidden files in an %s submodule',
    async kind => {
      await addUnreachableSubmodule();
      let submoduleSetup = 'mkdir -p sub\n';
      if (kind === 'initialized-ignored') {
        const subRepo = join(root, 'sub-repo');
        await mkdir(subRepo);
        await git(subRepo, 'init', '-q');
        await git(subRepo, 'config', 'user.email', 'test@example.com');
        await git(subRepo, 'config', 'user.name', 'Archon Test');
        await git(subRepo, 'config', 'commit.gpgsign', 'false');
        await writeFile(join(subRepo, '.gitignore'), 'hook-output\n');
        await git(subRepo, 'add', '.gitignore');
        await git(subRepo, 'commit', '-qm', 'ignore hook output');
        await git(repoPath, 'checkout', '-q', TASK_BRANCH);
        await writeFile(
          join(repoPath, '.gitmodules'),
          `[submodule "sub"]\n\tpath = sub\n\turl = ${subRepo.replaceAll('\\', '/')}\n`
        );
        const head = (await git(subRepo, 'rev-parse', 'HEAD')).trim();
        await git(repoPath, 'update-index', '--cacheinfo', `160000,${head},sub`);
        await git(repoPath, 'add', '.gitmodules');
        await git(repoPath, 'commit', '-qm', 'use local submodule');
        await git(repoPath, 'checkout', '-q', 'main');
        submoduleSetup = 'git -c protocol.file.allow=always submodule update --init || exit 99\n';
      }
      await writeFile(
        join(repoPath, '.git', 'hooks', 'post-checkout'),
        '#!/bin/sh\n' +
          submoduleSetup +
          'printf nested-work > sub/hook-output\necho nested-hook-failure >&2\nexit 42\n',
        { mode: 0o755 }
      );
      await expect(provider.create(request)).rejects.toThrow('nested-hook-failure');
      expect(await readFile(join(worktreePath, 'sub', 'hook-output'), 'utf-8')).toBe('nested-work');
      expect(await registeredWorktrees()).toContain(resolve(worktreePath));
    }
  );

  test('removes the owned registration when a failing hook removes its checkout', async () => {
    await writeFile(
      join(repoPath, '.git', 'hooks', 'post-checkout'),
      '#!/bin/sh\nrm -rf "$PWD"\necho vanished-hook-failure >&2\nexit 42\n',
      { mode: 0o755 }
    );
    const error = await provider.create(request).catch((error: unknown) => error);
    if (!(error instanceof Error)) throw new Error('Expected hook failure');
    expect(error.message).toContain('vanished-hook-failure');
    expect(classifyIsolationError(error)).not.toContain('was left behind');
    expect(await registeredWorktrees()).not.toContain(resolve(worktreePath));
    expect(existsSync(worktreePath)).toBe(false);
  });

  test.each(['another-attempt', 'unlocked'])(
    'preserves a missing checkout registration whose lock is %s',
    async reason => {
      const changeLock =
        reason === 'unlocked'
          ? 'rm "$gd/locked"'
          : 'printf "archon: worktree setup in progress: another-attempt" > "$gd/locked"';
      await writeFile(
        join(repoPath, '.git', 'hooks', 'post-checkout'),
        `#!/bin/sh\ngd=$(git rev-parse --absolute-git-dir)\n${changeLock}\nrm -rf "$PWD"\necho unowned-hook-failure >&2\nexit 42\n`,
        { mode: 0o755 }
      );
      const error = await provider.create(request).catch((error: unknown) => error);
      if (!(error instanceof Error)) throw new Error('Expected hook failure');
      expect(error.message).toContain('unowned-hook-failure');
      expect(classifyIsolationError(error)).toContain('not owned by this attempt');
      expect(await registeredWorktrees()).toContain(resolve(worktreePath));
      expect(await lockReasonOf(worktreePath)).toBe(
        reason === 'unlocked' ? null : 'archon: worktree setup in progress: another-attempt'
      );
    }
  );

  test.each([
    'existing-task',
    'new-task',
    'existing-new-task',
    'same-repo-pr',
    'existing-same-repo-pr',
    'fork-sha',
    'fork-no-sha',
  ])('failed adds preserve the error and ownership across %s', async kind => {
    const remotePath = join(root, 'remote.git');
    await git(root, 'init', '--bare', '-q', remotePath);
    await git(repoPath, 'remote', 'add', 'origin', remotePath);
    await git(
      repoPath,
      'push',
      '-q',
      'origin',
      'main',
      'main:refs/pull/42/head',
      'main:refs/heads/pr-feature'
    );
    if (kind === 'existing-new-task') await git(repoPath, 'branch', 'new-task');
    if (kind === 'existing-same-repo-pr') await git(repoPath, 'branch', 'pr-feature');
    const attempt: IsolationRequest = kind.includes('task')
      ? {
          ...request,
          workflowType: 'task',
          baseBranch: toBranchName('main'),
          taskBranch:
            kind === 'existing-task'
              ? { kind: 'existing', branch: toBranchName(TASK_BRANCH) }
              : { kind: 'new', branch: toBranchName('new-task') },
        }
      : {
          codebaseId: request.codebaseId,
          codebaseName: request.codebaseName,
          canonicalRepoPath: request.canonicalRepoPath,
          workflowType: 'pr',
          identifier: '42',
          baseBranch: toBranchName('main'),
          prBranch: toBranchName('pr-feature'),
          isForkPR: kind.startsWith('fork'),
          ...(kind === 'fork-sha'
            ? { prSha: (await git(repoPath, 'rev-parse', 'main')).trim() }
            : {}),
        };
    const path = provider.getWorktreePath(attempt, provider.generateBranchName(attempt));
    const marker = join(repoPath, '.git', 'hook-failed');
    await writeFile(
      join(repoPath, '.git', 'hooks', 'post-checkout'),
      `#!/bin/sh\nif test ! -f "${marker}"; then touch "${marker}"; echo 'hook-failure already exists' >&2; exit 42; fi\n`,
      { mode: 0o755 }
    );
    await expect(provider.create(attempt)).rejects.toThrow('hook-failure already exists');
    expect(await registeredWorktrees()).toEqual([resolve(repoPath)]);
    expect(existsSync(path)).toBe(false);

    await writeFile(
      join(repoPath, '.git', 'hooks', 'post-checkout'),
      '#!/bin/sh\ngit update-index --assume-unchanged README.md\nprintf hidden-work > README.md\necho hidden-hook-failure >&2\nexit 42\n',
      { mode: 0o755 }
    );
    await expect(provider.create(attempt)).rejects.toThrow('hidden-hook-failure');
    expect(await readFile(join(path, 'README.md'), 'utf-8')).toBe('hidden-work');
    expect(await registeredWorktrees()).toContain(resolve(path));
    expect(await lockReasonOf(path)).toMatch(/^archon: worktree setup in progress: .+/);
  });

  test.each(['tracked', 'untracked', 'ignored'])(
    'preserves %s changes left by a failing hook',
    async kind => {
      if (kind === 'ignored') {
        await writeFile(join(repoPath, '.git', 'info', 'exclude'), 'hook-output\n');
      }
      const filename = kind === 'tracked' ? 'README.md' : 'hook-output';
      await writeFile(
        join(repoPath, '.git', 'hooks', 'post-checkout'),
        `#!/bin/sh\nprintf hook-work > ${filename}\necho dirty-hook-failure >&2\nexit 42\n`,
        { mode: 0o755 }
      );
      const error = await provider.create(request).catch((error: unknown) => error);
      if (!(error instanceof Error)) throw new Error('Expected hook failure');
      expect(error.message).toContain('dirty-hook-failure');
      expect(classifyIsolationError(error)).toContain('contains changes');
      expect(await readFile(join(worktreePath, filename), 'utf-8')).toBe('hook-work');
      expect(await registeredWorktrees()).toContain(resolve(worktreePath));
      expect(await lockReasonOf(worktreePath)).toMatch(/^archon: worktree setup in progress: .+/);
      const failure = await typedFailure(provider.create(request));
      expect(failure.kind).toBe('setup_unfinished');
      expect(failure.message).toContain('its setup did not finish');
    }
  );

  test('a fork review-branch hook failure is preserved after a successful add', async () => {
    const remotePath = join(root, 'remote.git');
    await git(root, 'init', '--bare', '-q', remotePath);
    await git(repoPath, 'remote', 'add', 'origin', remotePath);
    await git(repoPath, 'push', '-q', 'origin', 'main', 'main:refs/pull/42/head');
    const attempt: IsolationRequest = {
      codebaseId: request.codebaseId,
      codebaseName: request.codebaseName,
      canonicalRepoPath: request.canonicalRepoPath,
      workflowType: 'pr',
      identifier: '42',
      baseBranch: toBranchName('main'),
      prBranch: toBranchName('pr-feature'),
      isForkPR: true,
      prSha: (await git(repoPath, 'rev-parse', 'main')).trim(),
    };
    const path = provider.getWorktreePath(attempt, provider.generateBranchName(attempt));
    await writeFile(
      join(repoPath, '.git', 'hooks', 'post-checkout'),
      '#!/bin/sh\nif test "$(git symbolic-ref --short -q HEAD)" = pr-42-review; then git update-index --skip-worktree README.md; printf hidden-work > README.md; echo "review-hook-failure already exists" >&2; exit 42; fi\n',
      { mode: 0o755 }
    );
    await expect(provider.create(attempt)).rejects.toThrow('review-hook-failure already exists');
    expect(await readFile(join(path, 'README.md'), 'utf-8')).toBe('hidden-work');
    expect(await registeredWorktrees()).toContain(resolve(path));
    expect(await lockReasonOf(path)).toMatch(/^archon: worktree setup in progress: .+/);
  });

  test('a fork add that created its checkout cannot succeed through another checkout', async () => {
    const remotePath = join(root, 'remote.git');
    await git(root, 'init', '--bare', '-q', remotePath);
    await git(repoPath, 'remote', 'add', 'origin', remotePath);
    await git(repoPath, 'push', '-q', 'origin', 'main', 'main:refs/pull/42/head');
    const attempt: IsolationRequest = {
      codebaseId: request.codebaseId,
      codebaseName: request.codebaseName,
      canonicalRepoPath: request.canonicalRepoPath,
      workflowType: 'pr',
      identifier: '42',
      baseBranch: toBranchName('main'),
      prBranch: toBranchName('pr-feature'),
      isForkPR: true,
    };
    const otherPath = join(root, 'other-checkout');
    const marker = join(repoPath, '.git', 'hook-started');
    await writeFile(
      join(repoPath, '.git', 'hooks', 'post-checkout'),
      `#!/bin/sh\nif test ! -f "${marker}"; then touch "${marker}"; git -C "${repoPath}" worktree add --force -q "${otherPath}" pr-42-review || exit 99; echo original-fork-add-failure >&2; exit 42; fi\n`,
      { mode: 0o755 }
    );
    await expect(provider.create(attempt)).rejects.toThrow('original-fork-add-failure');
    expect(await registeredWorktrees()).toContain(resolve(otherPath));
    expect(existsSync(otherPath)).toBe(true);
  });

  test.each(['unlocked', 'another-attempt'])(
    'a fork add that loses its setup lock (%s) preserves the original error',
    async reason => {
      const remotePath = join(root, 'remote.git');
      await git(root, 'init', '--bare', '-q', remotePath);
      await git(repoPath, 'remote', 'add', 'origin', remotePath);
      await git(repoPath, 'push', '-q', 'origin', 'main', 'main:refs/pull/42/head');
      const attempt: IsolationRequest = {
        codebaseId: request.codebaseId,
        codebaseName: request.codebaseName,
        canonicalRepoPath: request.canonicalRepoPath,
        workflowType: 'pr',
        identifier: '42',
        baseBranch: toBranchName('main'),
        prBranch: toBranchName('pr-feature'),
        isForkPR: true,
      };
      const path = provider.getWorktreePath(attempt, provider.generateBranchName(attempt));
      const changeLock =
        reason === 'unlocked' ? 'rm "$gd/locked"' : 'printf "operator lock" > "$gd/locked"';
      await writeFile(
        join(repoPath, '.git', 'hooks', 'post-checkout'),
        `#!/bin/sh\ngd=$(git rev-parse --absolute-git-dir)\n${changeLock}\necho lock-lost-hook-failure >&2\nexit 42\n`,
        { mode: 0o755 }
      );
      const error = await provider.create(attempt).catch((error: unknown) => error);
      if (!(error instanceof Error)) throw new Error('Expected hook failure');
      expect(error.message).toContain('lock-lost-hook-failure');
      expect(classifyIsolationError(error)).toContain('was left behind');
      expect(await registeredWorktrees()).toContain(resolve(path));
      expect(existsSync(path)).toBe(true);
      expect(await lockReasonOf(path)).toBe(reason === 'unlocked' ? null : 'operator lock');
    }
  );

  test('a dirty fork-PR hook failure keeps the original error through adoption fallback', async () => {
    const remotePath = join(root, 'remote.git');
    await git(root, 'init', '--bare', '-q', remotePath);
    await git(repoPath, 'remote', 'add', 'origin', remotePath);
    await git(repoPath, 'push', '-q', 'origin', 'main', 'main:refs/pull/42/head');
    const prRequest: IsolationRequest = {
      codebaseId: request.codebaseId,
      codebaseName: request.codebaseName,
      canonicalRepoPath: request.canonicalRepoPath,
      workflowType: 'pr',
      identifier: '42',
      prBranch: toBranchName('feature/review'),
      isForkPR: true,
      baseBranch: toBranchName('main'),
    };
    const prPath = provider.getWorktreePath(prRequest, provider.generateBranchName(prRequest));
    await writeFile(
      join(repoPath, '.git', 'hooks', 'post-checkout'),
      '#!/bin/sh\nprintf hook-work > hook-output\necho fork-hook-failure >&2\nexit 42\n',
      { mode: 0o755 }
    );
    const error = await provider.create(prRequest).catch((error: unknown) => error);
    if (!(error instanceof Error)) throw new Error('Expected fork hook failure');
    expect(error.message).toContain('fork-hook-failure');
    expect(classifyIsolationError(error)).toContain('contains changes');
    expect(await readFile(join(prPath, 'hook-output'), 'utf-8')).toBe('hook-work');
    expect(await registeredWorktrees()).toContain(resolve(prPath));
    expect(await lockReasonOf(prPath)).toMatch(/^archon: worktree setup in progress: .+/);
  });

  test('preserves a pre-existing worktree at the target path', async () => {
    await git(repoPath, 'worktree', 'add', '-q', worktreePath, TASK_BRANCH);
    await writeFile(join(worktreePath, 'user-work'), 'keep me');
    await writeFile(join(repoPath, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nexit 42\n', {
      mode: 0o755,
    });
    const adopted = await provider.create(request);
    expect(adopted.metadata.adopted).toBe(true);
    expect(await readFile(join(worktreePath, 'user-work'), 'utf-8')).toBe('keep me');
    expect(await registeredWorktrees()).toContain(resolve(worktreePath));
    expect(await lockReasonOf(worktreePath)).toBeNull();
  });

  test.each([false, true])('preserves a pre-existing directory (empty: %s)', async empty => {
    await mkdir(worktreePath, { recursive: true });
    if (!empty) await writeFile(join(worktreePath, 'user-work'), 'keep me');
    const failure = await typedFailure(provider.create(request));
    expect(failure.kind).toBe('path_exists');
    expect(failure.message).toContain(
      'a pre-existing directory occupies this path. It is not a worktree Archon created, so Archon leaves it intact; remove or move it, then retry.'
    );
    expect(existsSync(worktreePath)).toBe(true);
    if (!empty) expect(await readFile(join(worktreePath, 'user-work'), 'utf-8')).toBe('keep me');
  });

  test('a missing checkout registered by Git is refused with a typed kind', async () => {
    await git(repoPath, 'remote', 'add', 'origin', repoPath);
    const attempt: IsolationRequest = {
      codebaseId: request.codebaseId,
      codebaseName: request.codebaseName,
      canonicalRepoPath: request.canonicalRepoPath,
      workflowType: 'issue',
      identifier: '4271',
      baseBranch: toBranchName('main'),
    };
    const target = provider.getWorktreePath(attempt, provider.generateBranchName(attempt));
    await git(repoPath, 'worktree', 'add', '-q', '--detach', target);
    await git(repoPath, 'worktree', 'lock', '--reason', 'operator lock', target);
    await rm(target, { recursive: true });
    const failure = await provider.create(attempt).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IsolationFailure);
    if (!(failure instanceof IsolationFailure)) throw new Error('expected registration refusal');
    expect(failure.kind).toBe('worktree_registered');
    expect(isKnownIsolationError(failure)).toBe(true);
    expect(await registeredWorktrees()).toContain(resolve(target));
  });

  test('an add that creates nothing reports only the original failure', async () => {
    const missingBranchRequest: IsolationRequest = {
      ...request,
      workflowType: 'task',
      taskBranch: { kind: 'existing', branch: toBranchName('missing-branch') },
    };
    const error = await provider.create(missingBranchRequest).catch((error: unknown) => error);
    if (!(error instanceof Error)) throw new Error('Expected add failure');
    expect(error.message).toContain('missing-branch');
    expect(classifyIsolationError(error)).not.toContain('was left behind');
    expect(await registeredWorktrees()).toEqual([resolve(repoPath)]);
  });

  test('a setup failure preserves a checkout whose submodules can hide changes', async () => {
    await addUnreachableSubmodule();
    const branchHead = (await git(repoPath, 'rev-parse', TASK_BRANCH)).trim();
    const error = await provider.create(request).catch((error: unknown) => error);
    if (!(error instanceof Error)) throw new Error('Expected setup failure');
    expect(error.message).toContain('Submodule initialization failed');
    expect(classifyIsolationError(error)).toContain('submodules or index flags');
    expect(existsSync(worktreePath)).toBe(true);
    expect(await registeredWorktrees()).toContain(resolve(worktreePath));
    expect((await git(repoPath, 'rev-parse', TASK_BRANCH)).trim()).toBe(branchHead);
    await expect(provider.create(request)).rejects.toThrow('its setup did not finish');
  });

  test('a later setup failure preserves changes from a successful checkout hook', async () => {
    await addUnreachableSubmodule();
    await writeFile(
      join(repoPath, '.git', 'hooks', 'post-checkout'),
      '#!/bin/sh\nprintf hook-work > hook-output\n',
      { mode: 0o755 }
    );
    const error = await provider.create(request).catch((error: unknown) => error);
    if (!(error instanceof Error)) throw new Error('Expected submodule failure');
    expect(error.message).toContain('Submodule initialization failed');
    expect(classifyIsolationError(error)).toContain('contains changes');
    expect(await readFile(join(worktreePath, 'hook-output'), 'utf-8')).toBe('hook-work');
    expect(await lockReasonOf(worktreePath)).toMatch(/^archon: worktree setup in progress: .+/);
  });

  test('a worktree whose setup completed survives and is reused by the next run', async () => {
    const created = await provider.create(request);

    expect(created.workingPath).toBe(worktreePath);
    expect(existsSync(worktreePath)).toBe(true);
    expect(await registeredWorktrees()).toContain(resolve(worktreePath));
    // The setup lock is released, or nothing could adopt or clean up this checkout.
    expect(await lockReasonOf(worktreePath)).toBeNull();

    await writeFile(join(worktreePath, 'work-in-progress.txt'), 'from the first run\n');
    const reused = await provider.create(request);

    expect(reused.workingPath).toBe(worktreePath);
    expect(reused.metadata.adopted).toBe(true);
    // The same checkout, not a fresh one: the first run's file is still here.
    expect(existsSync(join(worktreePath, 'work-in-progress.txt'))).toBe(true);
  });

  test.each([
    'archon: worktree setup in progress',
    'archon: worktree setup in progress: previous-attempt',
  ])('refuses an unfinished checkout with lock %s', async reason => {
    // What a setup killed mid-flight leaves behind: the checkout git created,
    // still carrying the lock the run took before setting it up.
    await git(repoPath, 'worktree', 'add', '-q', worktreePath, TASK_BRANCH);
    await git(repoPath, 'worktree', 'lock', '--reason', reason, worktreePath);

    await expect(provider.create(request)).rejects.toThrow(/its setup did not finish/);

    // Refusing must not destroy it either: the operator decides, and a live run
    // may still own it.
    expect(existsSync(worktreePath)).toBe(true);
    expect(await lockReasonOf(worktreePath)).toBe(reason);
  });

  test('the checkout is marked unfinished from the moment git creates it', async () => {
    // `post-checkout` runs inside the new worktree before `git worktree add`
    // returns — the first moment the checkout exists on disk, and so the first
    // moment another run's `findExisting` could see it. Recording git's own lock
    // file there captures exactly what that run would have found.
    await writeFile(
      join(repoPath, '.git', 'hooks', 'post-checkout'),
      '#!/bin/sh\n' +
        'gd=$(git rev-parse --absolute-git-dir)\n' +
        'cp "$gd/locked" "$gd/locked-during-add" 2>/dev/null ||' +
        ' printf unlocked > "$gd/locked-during-add"\n',
      { mode: 0o755 }
    );

    await provider.create(request);

    // Taking the lock after `add` returned would leave this reading `unlocked`,
    // and a concurrent run adopting a checkout with no submodules and no
    // configured files. `--lock` on the add itself is what closes that window.
    const firstReason = await lockSeenDuringAdd();
    expect(firstReason).toMatch(/^archon: worktree setup in progress: .+/);
    await git(repoPath, 'worktree', 'remove', worktreePath);
    await provider.create(request);
    const secondReason = await lockSeenDuringAdd();
    expect(secondReason).toMatch(/^archon: worktree setup in progress: .+/);
    expect(secondReason).not.toBe(firstReason);
  });

  test("a checkout locked for someone else's reason is still adopted", async () => {
    await git(repoPath, 'worktree', 'add', '-q', worktreePath, TASK_BRANCH);
    await git(repoPath, 'worktree', 'lock', '--reason', 'on the external drive', worktreePath);

    const adopted = await provider.create(request);

    expect(adopted.workingPath).toBe(worktreePath);
    expect(adopted.metadata.adopted).toBe(true);
  });
  test('fresh creation stamps identity; adoption never grants it; recreation gets a new generation', async () => {
    await git(repoPath, 'remote', 'add', 'origin', repoPath);
    const freshRequest: IsolationRequest = {
      ...request,
      workflowType: 'task',
      taskBranch: { kind: 'new', branch: toBranchName('fresh'), fromBranch: toBranchName('main') },
    };
    const fresh = await provider.create(freshRequest);
    expect(fresh.metadata.adopted).toBe(false);
    expect(fresh.metadata.provenance).toBe('created');
    if (fresh.metadata.provenance !== 'created') throw new Error('expected fresh creation');
    const admin = (await git(fresh.workingPath, 'rev-parse', '--absolute-git-dir')).trim();
    expect(await readFile(join(admin, 'archon-creation-id'), 'utf8')).toBe(
      fresh.metadata.creationId
    );
    expect((await git(fresh.workingPath, 'status', '--porcelain')).trim()).toBe('');
    const observed = await provider.get(fresh.id);
    expect(observed?.metadata).toEqual({ provenance: 'observed', adopted: false });
    const listed = await provider.list(repoPath);
    expect(listed.find(env => env.id === fresh.id)?.metadata).toEqual({
      provenance: 'observed',
      adopted: false,
    });
    const adopted = await provider.create(freshRequest);
    expect(adopted.metadata.provenance).toBe('adopted');
    expect(adopted.metadata.adopted).toBe(true);
    expect(adopted.metadata).not.toHaveProperty('creationId');
    await git(repoPath, 'worktree', 'remove', fresh.workingPath);
    await git(repoPath, 'branch', '-D', fresh.branchName);
    const recreated = await provider.create(freshRequest);
    if (recreated.metadata.adopted) throw new Error('expected new generation');
    expect(recreated.metadata.creationId).not.toBe(fresh.metadata.creationId);
  });

  test('marker write failure rolls back the locked setup and retains trust', async () => {
    const config = process.env.GIT_CONFIG_GLOBAL;
    if (!config) throw new Error('Scratch global config missing');
    await writeFile(
      config,
      `[safe]\n directory = /workspace/other\n directory = ${JSON.stringify(repoPath)}\n`
    );
    await git(repoPath, 'remote', 'add', 'origin', repoPath);
    await writeFile(
      join(repoPath, '.git', 'hooks', 'post-checkout'),
      '#!/bin/sh\nmkdir "$(git rev-parse --absolute-git-dir)/archon-creation-id"\n',
      { mode: 0o755 }
    );
    const freshRequest: IsolationRequest = {
      ...request,
      workflowType: 'task',
      taskBranch: {
        kind: 'new',
        branch: toBranchName('marker-failure'),
        fromBranch: toBranchName('main'),
      },
    };
    const path = provider.getWorktreePath(freshRequest, 'marker-failure');
    const previousOwnerCheck = process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
    try {
      await expect(provider.create(freshRequest)).rejects.toThrow('archon-creation-id');
    } finally {
      if (previousOwnerCheck === undefined) delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
      else process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = previousOwnerCheck;
    }
    expect(existsSync(path)).toBe(false);
    expect(await registeredWorktrees()).not.toContain(resolve(path));
    expect(
      (await git(root, 'config', '--global', '--get-all', 'safe.directory')).trim().split('\n')
    ).toEqual(['/workspace/other', repoPath, path]);
  });

  describe('a new-branch request naming a branch that already exists', () => {
    const PR_BRANCH = 'feature/pr';
    let attempt: IsolationRequest;

    beforeEach(async () => {
      const remotePath = join(root, 'remote.git');
      await git(root, 'init', '--bare', '-q', remotePath);
      await git(repoPath, 'remote', 'add', 'origin', remotePath);
      await git(repoPath, 'push', '-q', 'origin', 'main');
      attempt = {
        ...request,
        workflowType: 'task',
        baseBranch: toBranchName('main'),
        taskBranch: { kind: 'new', branch: toBranchName(PR_BRANCH) },
      };
    });

    /** Commit a new file on `branch`, creating it from main if needed, and return the commit. */
    const commitOn = async (branch: string, file: string): Promise<string> => {
      const exists = (await git(repoPath, 'branch', '--list', branch)).trim() !== '';
      await git(repoPath, 'checkout', '-q', ...(exists ? [branch] : ['-b', branch]));
      await writeFile(join(repoPath, file), file);
      await git(repoPath, 'add', file);
      await git(repoPath, 'commit', '-qm', file);
      await git(repoPath, 'checkout', '-q', 'main');
      return (await git(repoPath, 'rev-parse', branch)).trim();
    };
    const localHead = async (): Promise<string> =>
      (await git(repoPath, 'rev-parse', `refs/heads/${PR_BRANCH}`)).trim();
    const remoteHead = async (): Promise<string> =>
      (await git(repoPath, 'ls-remote', 'origin', `refs/heads/${PR_BRANCH}`)).split('\t')[0];

    test.each(['no remote counterpart', 'remote counterpart behind'])(
      'an existing local branch ahead of base keeps its commits (%s)',
      async counterpart => {
        let tip = await commitOn(PR_BRANCH, 'one');
        if (counterpart === 'remote counterpart behind') {
          await git(repoPath, 'push', '-q', 'origin', PR_BRANCH);
          tip = await commitOn(PR_BRANCH, 'two');
        }

        const env = await provider.create(attempt);

        expect((await git(env.workingPath, 'rev-parse', 'HEAD')).trim()).toBe(tip);
        expect(await localHead()).toBe(tip);
        expect(env.metadata).toHaveProperty('branchCreated', false);
        expect(env.metadata).not.toHaveProperty('cutFromCommit');
      }
    );

    test('an existing branch containing timeout keeps its cause and is blocked', async () => {
      const branch = 'fix/timeout-retry';
      await git(repoPath, 'branch', branch);
      const error = await provider
        .create({
          ...attempt,
          workflowType: 'task',
          taskBranch: {
            kind: 'new',
            branch: toBranchName(branch),
            fromBranch: toBranchName('main'),
          },
        })
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error('expected existing-branch refusal');
      expect(classifyIsolationError(error)).toContain(`Branch "${branch}" already exists`);
      expect(classifyIsolationError(error)).not.toContain('Timed out');
      expect(isKnownIsolationError(error)).toBe(true);
      expect(error).toHaveProperty('kind', 'branch_exists');
    });

    test('an existing remote-only PR branch is checked out at its head', async () => {
      const tip = await commitOn(PR_BRANCH, 'one');
      await git(repoPath, 'push', '-q', 'origin', PR_BRANCH);
      await git(repoPath, 'branch', '-q', '-D', PR_BRANCH);
      await git(repoPath, 'update-ref', '-d', `refs/remotes/origin/${PR_BRANCH}`);

      const env = await provider.create(attempt);

      expect((await git(env.workingPath, 'rev-parse', 'HEAD')).trim()).toBe(tip);
      expect((await git(env.workingPath, 'rev-parse', '--abbrev-ref', '@{u}')).trim()).toBe(
        `origin/${PR_BRANCH}`
      );
      expect(env.metadata).toHaveProperty('branchCreated', true);
    });

    test.each([false, true])(
      'fast-forwards a local branch behind its remote (transient ref lock: %s)',
      async locked => {
        await commitOn(PR_BRANCH, 'one');
        const tip = await commitOn(PR_BRANCH, 'two');
        await git(repoPath, 'push', '-q', 'origin', PR_BRANCH);
        await git(repoPath, 'branch', '-f', PR_BRANCH, `${PR_BRANCH}~1`);
        const lock = join(repoPath, '.git', 'refs', 'heads', `${PR_BRANCH}.lock`);
        if (locked) await writeFile(lock, '');
        const exec = gitModule.execFileAsync;
        let collisions = 0;
        const spy = spyOn(gitModule, 'execFileAsync').mockImplementation(
          async (cmd, args, options) => {
            try {
              return await exec(cmd, args, options);
            } catch (error) {
              if (args.includes('fetch') && args.includes('.') && existsSync(lock)) {
                expect(args.at(-1)).toBe(
                  `refs/remotes/origin/${PR_BRANCH}:refs/heads/${PR_BRANCH}`
                );
                collisions++;
                await rm(lock);
              }
              throw error;
            }
          }
        );
        try {
          const env = await provider.create(attempt);
          expect(collisions).toBe(locked ? 1 : 0);
          expect((await git(env.workingPath, 'rev-parse', 'HEAD')).trim()).toBe(tip);
          expect(await localHead()).toBe(tip);
        } finally {
          spy.mockRestore();
        }
      }
    );

    test('diverged local and remote fail before any checkout', async () => {
      const shared = await commitOn(PR_BRANCH, 'shared');
      await git(repoPath, 'push', '-q', 'origin', PR_BRANCH);
      await git(repoPath, 'branch', 'elsewhere', shared);
      const remoteTip = await commitOn('elsewhere', 'remote-only');
      await git(repoPath, 'push', '-q', 'origin', `elsewhere:refs/heads/${PR_BRANCH}`);
      await git(repoPath, 'branch', '-q', '-D', 'elsewhere');
      const localTip = await commitOn(PR_BRANCH, 'local-only');

      const error = await provider.create(attempt).catch((error: unknown) => error);

      expect(error).toBeInstanceOf(ExistingBranchDivergedError);
      expect((error as Error).message).toContain(`Branch '${PR_BRANCH}' has diverged`);
      expect((error as Error).message).toContain(`'origin/${PR_BRANCH}'`);
      expect(await registeredWorktrees()).toEqual([resolve(repoPath)]);
      expect(await localHead()).toBe(localTip);
      expect(await remoteHead()).toBe(remoteTip);
    });
  });
});
