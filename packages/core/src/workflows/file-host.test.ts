import { afterEach, expect, expectTypeOf, test } from 'bun:test';
import type { z } from 'zod';
import type { IsolationEnvironmentRow } from '@archon/isolation';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';
import { toBranchName } from '@archon/git';
import { createFileWorkflowHost, isolationSchema } from './file-host';
import { FileStoreUnsupportedError, commit } from '@archon/workflows/file-store';
const roots = trackTempRoots();
// Restore the keys in place: assigning a new object to process.env drops
// Bun's case-insensitive Windows env, so later files read PATH as undefined.
const prior = Object.fromEntries(
  ['ARCHON_HOME', 'DATABASE_URL', 'GITHUB_APP_ID'].map(key => [key, process.env[key]])
);
afterEach(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
test('file isolation records conform to the isolation store row', () => {
  expectTypeOf<z.output<typeof isolationSchema>[number]>().toEqualTypeOf<IsolationEnvironmentRow>();
});
test('file host records persist across hosts and released worktrees fence pending claims', async () => {
  const home = roots(await mkdtemp(join(tmpdir(), 'file-host-')));
  process.env.ARCHON_HOME = home;
  process.env.DATABASE_URL = '';
  process.env.GITHUB_APP_ID = '';
  const root = join(home, 'store');
  const host = await createFileWorkflowHost(root);
  const codebase = await host.records.codebases.createCodebase({
    name: 'project',
    default_cwd: home,
  });
  const widerInput = {
    default_cwd: join(home, 'checkout'),
    repository_url: 'https://example.test/repo',
    default_branch: 'main',
    kind: 'folder' as const,
  };
  await host.records.codebases.updateCodebase(codebase, widerInput);
  expect(await host.records.codebases.getCodebase(codebase.id)).toMatchObject({
    ...widerInput,
    kind: 'repo',
  });
  await host.records.codebases.updateCodebase(codebase, {
    default_cwd: undefined,
    repository_url: null,
    default_branch: null,
  });
  expect(await host.records.codebases.getCodebase(codebase.id)).toMatchObject({
    default_cwd: widerInput.default_cwd,
    repository_url: null,
    default_branch: null,
    kind: 'repo',
  });
  const user = await host.records.users.findOrCreateUserByPlatformIdentity(
    'cli',
    'operator',
    'Operator'
  );
  expect(user).toMatchObject({ display_name: 'Operator' });
  expect(await host.records.users.findOrCreateUserByPlatformIdentity('cli', 'operator')).toEqual(
    user
  );
  await expect(
    host.records.conversations.getConversationById('conversation')
  ).rejects.toBeInstanceOf(FileStoreUnsupportedError);
  await host.records.codebases.updateCodebaseCommands(codebase.id, {
    test: { path: 'test.md', description: 'Test' },
  });
  await commit(root, [], async () => ({
    result: undefined,
    changes: {
      documents: {
        'host/codebases.json': [
          {
            ...codebase,
            commands: { test: { path: 'test.md', description: 'Test' } },
            envVars: { FILE_SETTING: 'value' },
          },
        ],
      },
    },
  }));
  const env = await host.records.isolation.create({
    codebase_id: codebase.id,
    workflow_type: 'task',
    workflow_id: 'run',
    working_path: join(home, 'checkout'),
    branch_name: toBranchName('feature'),
    created_by_user_id: 'first',
    metadata: { worktree_creation_id: 'proof', worktree_branch_created: true, adopted: false },
  });
  const upsert = await host.records.isolation.create({
    ...env,
    created_by_platform: env.created_by_platform ?? undefined,
    branch_name: toBranchName('other'),
    created_by_user_id: 'second',
  });
  expect(upsert.id).toBe(env.id);
  expect(upsert.created_by_user_id).toBe('first');
  await host.records.isolation.updateMetadata(upsert.id, { adopted: true });
  const reopened = await createFileWorkflowHost(root);
  expect(await reopened.records.users.getUserById(user!.id)).toEqual(user);
  expect(await reopened.deps.store.getCodebaseEnvVars(codebase.id)).toEqual({
    FILE_SETTING: 'value',
  });
  expect(
    await reopened.records.codebases.findCodebaseByPathPrefix(join(home, 'nested'))
  ).toMatchObject({ id: codebase.id, commands: { test: { path: 'test.md' } } });
  expect(await reopened.records.isolation.getById(env.id)).toMatchObject({
    id: env.id,
    branch_name: 'other',
    created_at: upsert.created_at,
    metadata: { worktree_creation_id: 'proof', worktree_branch_created: true, adopted: true },
  });
  expect(await reopened.records.isolation.countActiveByCodebase(codebase.id)).toBe(1);
  await reopened.records.isolation.updateStatus(env.id, 'destroyed');
  const run = await reopened.deps.store.createWorkflowRun({
    workflow_name: 'test',
    user_message: '',
    codebase_id: codebase.id,
    working_path: env.working_path,
  });
  expect(await reopened.deps.store.claimPendingWorkflowRun(run.id)).toBeNull();
  const recreated = await reopened.records.isolation.create({
    ...env,
    created_by_platform: env.created_by_platform ?? undefined,
    created_by_user_id: env.created_by_user_id ?? undefined,
    branch_name: toBranchName(env.branch_name),
  });
  expect(recreated.id).not.toBe(env.id);
  expect(await reopened.deps.store.claimPendingWorkflowRun(run.id)).toMatchObject({
    status: 'running',
  });
});

test('two file hosts cannot register owners of the same project storage', async () => {
  const home = roots(await mkdtemp(join(tmpdir(), 'file-host-storage-')));
  process.env.ARCHON_HOME = home;
  process.env.DATABASE_URL = '';
  process.env.GITHUB_APP_ID = '';
  const root = join(home, 'store');
  const first = await createFileWorkflowHost(root);
  const second = await createFileWorkflowHost(root);
  const results = await Promise.allSettled([
    first.records.codebases.createCodebase({
      name: 'My App',
      kind: 'folder',
      default_cwd: '/first',
    }),
    second.records.codebases.createCodebase({
      name: 'my-app',
      kind: 'folder',
      default_cwd: '/second',
    }),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(await first.records.codebases.listCodebases()).toHaveLength(1);
});

test('file host remote lookup reuses SSH and legacy checkout identities', async () => {
  const home = roots(await mkdtemp(join(tmpdir(), 'file-remote-')));
  process.env.ARCHON_HOME = home;
  execFileSync('git', ['-C', home, 'init', '-q']);
  execFileSync('git', [
    '-C',
    home,
    'remote',
    'add',
    'origin',
    'git@gitlab.example:org/team/app.git',
  ]);
  const host = await createFileWorkflowHost(join(home, 'store'));
  const project = await host.records.codebases.createCodebase({
    name: 'My App',
    default_cwd: home,
    repository_url: 'git@gitlab.example:org/team/app.git',
  });
  expect(
    (await host.records.codebases.findCodebaseByRepoUrl('https://gitlab.example/org/team/app'))?.id
  ).toBe(project.id);
  await host.records.codebases.updateCodebase(project, { repository_url: null });
  expect(
    (await host.records.codebases.findCodebaseByRepoUrl('https://gitlab.example/org/team/app.git'))
      ?.id
  ).toBe(project.id);
});

test.each(['persisted', 'legacy'])(
  'file lookup routes a %s owner past an unavailable legacy checkout',
  async owner => {
    const home = roots(await mkdtemp(join(tmpdir(), 'file-known-remote-')));
    process.env.ARCHON_HOME = home;
    const host = await createFileWorkflowHost(join(home, 'store'));
    await host.records.codebases.createCodebase({
      name: 'Legacy',
      default_cwd: join(home, 'missing'),
    });
    execFileSync('git', ['-C', home, 'init', '-q']);
    execFileSync('git', ['-C', home, 'remote', 'add', 'origin', 'https://github.com/acme/api']);
    const known = await host.records.codebases.createCodebase({
      name: 'acme/api',
      default_cwd: home,
      repository_url: owner === 'persisted' ? 'https://github.com/acme/api' : undefined,
    });
    expect(
      (await host.records.codebases.findCodebaseByRepoUrl('git@github.com:acme/api.git'))?.id
    ).toBe(known.id);
  }
);

test('file adoption metadata refuses a replaced registration, including the same path', async () => {
  const home = roots(await mkdtemp(join(tmpdir(), 'file-adoption-')));
  process.env.ARCHON_HOME = home;
  process.env.DATABASE_URL = '';
  process.env.GITHUB_APP_ID = '';
  const host = await createFileWorkflowHost(join(home, 'store'));
  const store = host.records.isolation;
  const input = {
    codebase_id: 'cb',
    workflow_type: 'task' as const,
    workflow_id: 'run',
    working_path: home,
    branch_name: toBranchName('task'),
  };
  for (const path of [home, join(home, 'other')]) {
    const observed = await store.create(input);
    const replacement = await store.create({ ...input, working_path: path });
    await expect(store.updateMetadata(observed.id, { adopted: true }, observed)).rejects.toThrow(
      'changed during adoption'
    );
    expect(await store.getById(observed.id)).toEqual(replacement);
    await store.updateMetadata(replacement.id, { adopted: true }, replacement);
    expect((await store.getById(replacement.id))?.metadata.adopted).toBe(true);
  }
});

test('file host refuses legacy tokenless replacements within its atomic adoption write', async () => {
  const home = roots(await mkdtemp(join(tmpdir(), 'legacy-adoption-')));
  process.env.ARCHON_HOME = home;
  process.env.DATABASE_URL = '';
  process.env.GITHUB_APP_ID = '';
  const root = join(home, 'store');
  const {
    records: { isolation: store },
  } = await createFileWorkflowHost(root);
  const created = await store.create({
    codebase_id: 'cb',
    workflow_type: 'task',
    workflow_id: 'run',
    working_path: home,
    branch_name: toBranchName('task'),
  });
  const observed = { ...created, metadata: {} };
  for (const replacement of [
    { ...observed, working_path: join(home, 'other') },
    { ...observed, branch_name: 'other' },
    { ...observed, created_at: new Date(0) },
    { ...observed, metadata: { legacy: true } },
  ]) {
    await commit(root, [], async () => ({
      result: undefined,
      changes: { documents: { 'host/isolation.json': [replacement] } },
    }));
    await expect(store.updateMetadata(observed.id, { adopted: true }, observed)).rejects.toThrow(
      'changed during adoption'
    );
    expect(await store.getById(created.id)).toEqual(replacement);
    await store.updateMetadata(replacement.id, { adopted: true }, replacement);
  }
});
